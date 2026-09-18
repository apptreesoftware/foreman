import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ForemanConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { FeedEntry } from "./feed.ts";
import { log } from "./log.ts";
import { FORBIDDEN_ENV } from "./preflight.ts";
import { type Activity, emptyActivity, foldEvent } from "./stream.ts";
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
  /** The served repo's `session-env` hook output: extra child env and prompt lines. */
  env: Record<string, string>;
  promptLines: string[];
  /** A builder round that only merges origin/main into the PR branch (#237). */
  rebase: boolean;
}

/**
 * The rebase round's prompt, naming the repo's own checks rather than a hardcoded pnpm trio, and
 * the repo's own default branch rather than a hardcoded `main`.
 */
export function rebaseNotes(checks: string[], defaultBranch = "main"): string {
  const cmds = checks.map((c) => `\`${c}\``).join(", ");
  return `This is a rebase round: the PR is approved but its branch conflicts with ${defaultBranch}. Run \`git merge origin/${defaultBranch}\`, resolve every conflict keeping both sides' intent, run ${cmds}, commit the merge and push. Change nothing else, do not open a new PR, and return \`pr_opened\` with this PR's number.`;
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
  interrupted: boolean;
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

export function childEnv(
  env: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const forbidden = new Set<string>(FORBIDDEN_ENV);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!forbidden.has(k)) out[k] = v;
  }
  return { ...out, ...extra };
}

export function buildArgs(req: DispatchRequest, cfg: ForemanConfig): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
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
    // Always pinned: `cfg.model` is defaulted, so a session never inherits the interactive CLI
    // default on this Mac. `runRole` passes the live override through here when one is set (#210).
    "--model",
    cfg.model,
  ];
}

export function buildPrompt(
  req: DispatchRequest,
  cfg: ForemanConfig,
  checks: string[],
  defaultBranch = "main",
): string {
  const lines = [
    `Role: ${req.role}. Repository: ${cfg.repo}. Host: ${cfg.host}. Session: ${req.sessionId}.`,
    `Task issue: #${req.issue} — ${req.title}.`,
    req.pr ? `Pull request: #${req.pr}.` : "Pull request: none yet.",
    `Worktree (your cwd): ${req.worktree}. Branch: ${req.branch}. Never touch main.`,
    `Spec: ${req.specPath ?? "see the issue body"}.`,
    ...req.promptLines,
  ];
  if (req.rebase) lines.push(rebaseNotes(checks, defaultBranch));
  else if (req.round > 1)
    lines.push(
      `This is fix round ${req.round}. Address the reviewer/validator feedback on the PR before anything else.`,
    );
  if (req.notes) lines.push(`Notes from the previous step:\n${req.notes}`);
  if (req.resume)
    lines.push(
      `You are resuming interrupted work. Read your last Progress comment on the issue and \`git log origin/${defaultBranch}..HEAD\`, then continue from there. Do not redo finished steps.`,
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
    interrupted: false,
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
  setup: string | null = "pnpm install",
  defaultBranch = "main",
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
      await git(["worktree", "add", "-B", branch, dir, `origin/${defaultBranch}`]);
    }
  } else {
    const r = await exec("git", ["-C", dir, "pull", "--ff-only"]);
    if (r.code !== 0)
      log("warn", "worktree pull failed; continuing with local state", {
        dir,
        stderr: r.stderr.trim(),
      });
  }
  if (setup !== null) {
    const install = await exec("sh", ["-c", setup], { cwd: dir });
    if (install.code !== 0)
      throw new Error(`setup command failed in ${dir}: ${install.stderr.slice(-2000)}`);
  }
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
  /** True when the operator's abort signal killed the child. */
  interrupted: boolean;
}
export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onStdoutLine?: (line: string) => void;
}
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

export const KILL_GRACE_MS = 30_000;

export const realSpawn: Spawner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (child.pid && opts.onSpawn) opts.onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let pending = "";
    const emit = (chunk: string) => {
      if (!opts.onStdoutLine) return;
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const p of parts) if (p.length > 0) opts.onStdoutLine(p);
    };
    child.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      emit(s);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      interrupted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (r: SpawnResult) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pending.length > 0 && opts.onStdoutLine) {
        opts.onStdoutLine(pending);
        pending = "";
      }
      resolve(r);
    };
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr, timedOut, interrupted }));
    child.on("error", (err) =>
      done({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, timedOut, interrupted }),
    );
    child.stdin.end(opts.input);
  });

export interface DispatchDeps {
  spawn: Spawner;
  onAttempt: (req: DispatchRequest) => Promise<void>;
  /** What a rebase round runs, named in the prompt in place of a hardcoded pnpm trio. */
  checks?: string[];
  /** The repo's default branch, named in the prompt in place of a hardcoded `main`. */
  defaultBranch?: string;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onActivity?: (activity: Activity, entries: FeedEntry[]) => void;
}

const DEFAULT_CHECKS = ["pnpm lint", "pnpm typecheck", "pnpm test"];

export async function runSession(
  req: DispatchRequest,
  cfg: ForemanConfig,
  deps: DispatchDeps,
): Promise<SessionResult> {
  await deps.onAttempt(req);
  let activity = emptyActivity();
  const r = await deps.spawn("claude", buildArgs(req, cfg), {
    cwd: req.worktree,
    env: childEnv(process.env, req.env),
    input: buildPrompt(req, cfg, deps.checks ?? DEFAULT_CHECKS, deps.defaultBranch ?? "main"),
    timeoutMs: cfg.wallClockMinutes * 60_000,
    signal: deps.signal,
    onSpawn: deps.onSpawn,
    onStdoutLine: (line) => {
      try {
        const f = foldEvent(activity, line, new Date().toISOString(), req.worktree);
        activity = f.activity;
        deps.onActivity?.(activity, f.entries);
      } catch (err) {
        log("warn", "stream fold failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
  const parsed = parseResult(r.stdout, r.timedOut);
  parsed.stderr = r.stderr.slice(-4000);
  parsed.interrupted = r.interrupted;
  if (r.interrupted && !parsed.outcome) parsed.subtype = "interrupted";
  if (!parsed.sessionId) parsed.sessionId = req.sessionId;
  deps.onActivity?.(activity, [
    {
      t: new Date().toISOString(),
      kind: "result",
      subtype: parsed.subtype,
      outcome: parsed.outcome?.outcome ?? null,
      turns: parsed.numTurns,
      costUsd: parsed.costUsd,
    },
  ]);
  log("info", "session finished", {
    issue: req.issue,
    role: req.role,
    attempt: req.attempt,
    subtype: parsed.subtype,
    turns: parsed.numTurns,
    cost: parsed.costUsd,
    denials: parsed.denials,
    timedOut: r.timedOut,
    interrupted: r.interrupted,
  });
  return parsed;
}

/** Attempt 1 as requested; later attempts resume the same session id. Stops on a valid outcome. */
export async function dispatchWithRetry(
  req: DispatchRequest,
  cfg: ForemanConfig,
  deps: DispatchDeps,
  attempts = 3,
): Promise<SessionResult> {
  let last: SessionResult | null = null;
  for (let attempt = req.attempt; attempt < req.attempt + attempts; attempt++) {
    // An abort landing between attempts (the first attempt always runs) must not post another
    // "session …" comment and spawn a child just to kill it.
    if (attempt > req.attempt && deps.signal?.aborted) break;
    const r = await runSession(
      { ...req, attempt, resume: req.resume || attempt > req.attempt },
      cfg,
      deps,
    );
    last = r;
    if (r.outcome) return r;
    if (r.interrupted) return r; // operator stop/abort: never retry
    log("warn", "session ended without outcome; retrying", {
      issue: req.issue,
      attempt,
      subtype: r.subtype,
      timedOut: r.timedOut,
    });
  }
  if (!last) throw new Error("dispatchWithRetry: attempts must be at least 1");
  return last;
}
