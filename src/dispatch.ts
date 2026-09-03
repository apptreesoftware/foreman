import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ForemanConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { log } from "./log.ts";
import { FORBIDDEN_ENV } from "./preflight.ts";
import type { Role } from "./types.ts";

export const OUTCOME_KINDS = [
  "pr_opened",
  "approved",
  "changes_requested",
  "passed",
  "failed",
  "blocked",
  "phase_closed",
  "plan_drafted",
] as const;
export const OutcomeSchema = z.object({
  outcome: z.enum(OUTCOME_KINDS),
  pr: z.number().int().nullable(),
  notes: z.string(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;
export const OUTCOME_JSON_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: [...OUTCOME_KINDS] },
    pr: { type: ["integer", "null"] },
    notes: { type: "string" },
  },
  required: ["outcome", "pr", "notes"],
  additionalProperties: false,
};

export const MAX_ATTEMPTS = 3;
export const WEB_URL = "http://localhost:8082";
export const API_URL = "http://localhost:3005";

export interface DispatchRequest {
  role: Role;
  issue: number;
  pr: number | null;
  title: string;
  specPath: string | null;
  worktree: string;
  branch: string;
  sessionId: string;
  resume: boolean;
  attempt: number;
  round: number;
  notes: string;
}

export interface SessionResult {
  sessionId: string;
  subtype: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  durationMs: number;
  outcome: Outcome | null;
  resultText: string | null;
  denials: number;
  timedOut: boolean;
  stderr: string;
}

export function slugify(title: string): string {
  return title
    .replace(/^\[[^\]]*\]\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function branchFor(issue: number, title: string): string {
  return `feat/${issue}-${slugify(title)}`;
}

export function transcriptPath(worktree: string, sessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    worktree.replace(/[/._]/g, "-"),
    `${sessionId}.jsonl`,
  );
}

export function trustWorktree(
  worktree: string,
  claudeJson = join(homedir(), ".claude.json"),
): void {
  const j = existsSync(claudeJson)
    ? (JSON.parse(readFileSync(claudeJson, "utf8")) as Record<string, unknown>)
    : {};
  const projects = (j.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[worktree] = { ...(projects[worktree] ?? {}), hasTrustDialogAccepted: true };
  writeFileSync(claudeJson, JSON.stringify({ ...j, projects }, null, 2));
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forbidden = new Set<string>(FORBIDDEN_ENV);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!forbidden.has(k)) out[k] = v;
  }
  return out;
}

export function buildArgs(req: DispatchRequest, cfg: ForemanConfig): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(OUTCOME_JSON_SCHEMA),
    "--max-turns",
    String(cfg.maxTurns),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "user,project",
    // Project-wide deny/allow rules used to live in .claude/settings.json, but that also bound
    // interactive sessions (see PR #152). They now live in .claude/headless-settings.json, and
    // `claude -p --settings <file>` applies that file's allow+deny rules even in an untrusted
    // directory. trustWorktree() below is still needed so the project's .mcp.json servers load.
    "--settings",
    join(req.worktree, ".claude", "headless-settings.json"),
    "--append-system-prompt-file",
    join(req.worktree, ".claude", "roles", `${req.role}.md`),
    ...(req.resume ? ["--resume", req.sessionId] : ["--session-id", req.sessionId]),
    ...(cfg.model ? ["--model", cfg.model] : []),
  ];
}

export function buildPrompt(req: DispatchRequest, cfg: ForemanConfig): string {
  const lines = [
    `Role: ${req.role}. Repository: ${cfg.repo}. Host: ${cfg.host}. Session: ${req.sessionId}.`,
    `Task issue: #${req.issue} — ${req.title}.`,
    req.pr ? `Pull request: #${req.pr}.` : "Pull request: none yet.",
    `Worktree (your cwd): ${req.worktree}. Branch: ${req.branch}. Never touch main.`,
    `Spec: ${req.specPath ?? "see the issue body"}.`,
    `Local URLs: web ${WEB_URL}, api ${API_URL}, Supabase API http://127.0.0.1:55321 (project tone_tonic).`,
    `Slack owner handle: ${cfg.slackUser}.`,
  ];
  if (req.round > 1)
    lines.push(
      `This is fix round ${req.round}. Address the reviewer/validator feedback on the PR before anything else.`,
    );
  if (req.notes) lines.push(`Notes from the previous step:\n${req.notes}`);
  if (req.resume)
    lines.push(
      "You are resuming interrupted work. Read your last Progress comment on the issue and `git log origin/main..HEAD`, then continue from there. Do not redo finished steps.",
    );
  lines.push(
    "When completely done, return the outcome object required by the output schema. Do not return it early.",
  );
  return lines.join("\n");
}

function lastResultLine(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.startsWith("{") && line.includes('"type":"result"')) return line;
  }
  return undefined;
}

export function parseResult(stdout: string, timedOut: boolean): SessionResult {
  const line = lastResultLine(stdout);
  const base: SessionResult = {
    sessionId: "",
    subtype: "no_result",
    isError: true,
    numTurns: 0,
    costUsd: 0,
    durationMs: 0,
    outcome: null,
    resultText: null,
    denials: 0,
    timedOut,
    stderr: "",
  };
  if (!line) return base;
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const parsed = OutcomeSchema.safeParse(j.structured_output);
    return {
      ...base,
      sessionId: String(j.session_id ?? ""),
      subtype: String(j.subtype ?? "unknown"),
      isError: Boolean(j.is_error),
      numTurns: Number(j.num_turns ?? 0),
      costUsd: Number(j.total_cost_usd ?? 0),
      durationMs: Number(j.duration_ms ?? 0),
      outcome: parsed.success ? parsed.data : null,
      resultText: typeof j.result === "string" ? j.result : null,
      denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
    };
  } catch {
    return base;
  }
}

export async function ensureWorktree(
  cfg: ForemanConfig,
  issue: number,
  branch: string,
  exec: Exec,
  exists: (p: string) => boolean = existsSync,
): Promise<string> {
  const dir = join(cfg.workDir, String(issue));
  const git = async (args: string[], cwd = cfg.repoDir) => {
    const r = await exec("git", ["-C", cwd, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  await git(["fetch", "origin", "--prune"]);
  if (!exists(dir)) {
    const remote = (await git(["ls-remote", "--heads", "origin", branch])).trim().length > 0;
    // -B (create-or-reset) survives a stale local branch left behind by a prior removeWorktree;
    // every checkpoint pushes the branch (spec §6), so resetting it to the remote/origin-main tip is safe.
    if (remote) {
      await git(["worktree", "add", "-B", branch, dir, `origin/${branch}`]);
      await exec("git", ["-C", dir, "branch", `--set-upstream-to=origin/${branch}`]);
    } else {
      await git(["worktree", "add", "-B", branch, dir, "origin/main"]);
    }
  } else {
    const r = await exec("git", ["-C", dir, "pull", "--ff-only"]);
    if (r.code !== 0)
      log("warn", "worktree pull failed; continuing with local state", {
        dir,
        stderr: r.stderr.trim(),
      });
  }
  const install = await exec("pnpm", ["install"], { cwd: dir });
  if (install.code !== 0)
    throw new Error(`pnpm install failed in ${dir}: ${install.stderr.slice(-2000)}`);
  trustWorktree(dir);
  return dir;
}

export async function removeWorktree(cfg: ForemanConfig, issue: number, exec: Exec): Promise<void> {
  const dir = join(cfg.workDir, String(issue));
  await exec("git", ["-C", cfg.repoDir, "worktree", "remove", "--force", dir]);
  await exec("git", ["-C", cfg.repoDir, "worktree", "prune"]);
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number },
) => Promise<SpawnResult>;

export const realSpawn: Spawner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 30_000).unref();
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.stdin.end(opts.input);
  });

export interface DispatchDeps {
  spawn: Spawner;
  onAttempt: (req: DispatchRequest) => Promise<void>;
}

export async function runSession(
  req: DispatchRequest,
  cfg: ForemanConfig,
  deps: DispatchDeps,
): Promise<SessionResult> {
  await deps.onAttempt(req);
  const r = await deps.spawn("claude", buildArgs(req, cfg), {
    cwd: req.worktree,
    env: childEnv(process.env),
    input: buildPrompt(req, cfg),
    timeoutMs: cfg.wallClockMinutes * 60_000,
  });
  const parsed = parseResult(r.stdout, r.timedOut);
  parsed.stderr = r.stderr.slice(-4000);
  if (!parsed.sessionId) parsed.sessionId = req.sessionId;
  log("info", "session finished", {
    issue: req.issue,
    role: req.role,
    attempt: req.attempt,
    subtype: parsed.subtype,
    turns: parsed.numTurns,
    cost: parsed.costUsd,
    denials: parsed.denials,
    timedOut: r.timedOut,
  });
  return parsed;
}

/** Attempt 1 as requested; later attempts resume the same session id. Stops on a valid outcome. */
export async function dispatchWithRetry(
  req: DispatchRequest,
  cfg: ForemanConfig,
  deps: DispatchDeps,
): Promise<SessionResult> {
  let last: SessionResult | null = null;
  for (let attempt = req.attempt; attempt < req.attempt + MAX_ATTEMPTS; attempt++) {
    const r = await runSession(
      { ...req, attempt, resume: req.resume || attempt > req.attempt },
      cfg,
      deps,
    );
    last = r;
    if (r.outcome) return r;
    log("warn", "session ended without outcome; retrying", {
      issue: req.issue,
      attempt,
      subtype: r.subtype,
      timedOut: r.timedOut,
    });
  }
  if (!last) throw new Error("dispatchWithRetry: MAX_ATTEMPTS must be at least 1");
  return last;
}
