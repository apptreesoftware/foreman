import { accessSync, appendFileSync, constants, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import { log } from "./log.ts";
import { REPO_DIRNAME } from "./repo-config.ts";
import type { Role } from "./types.ts";

export type HookName = "preflight" | "session-env" | "before-session" | "after-session";
export const HOOK_NAMES: readonly HookName[] = [
  "preflight",
  "session-env",
  "before-session",
  "after-session",
];
export const HOOK_TIMEOUT_MS = 600_000;

export interface HookContext {
  instance: string;
  stateDir: string;
  repoDir: string;
  role?: Role;
  issue?: number;
  pr?: number | null;
  worktree?: string;
  round?: number;
}

export interface HookResult {
  /** False when the repository has no such hook (or it is not executable): a no-op, code 0. */
  ran: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Appends to `<stateDir>/logs/hooks.log`, the one file every hook run is recorded in. Guarded: the
 * daemon's copy of this runs inside `runRole`'s `finally`, where a full disk or a state directory
 * that went away would otherwise turn a logging failure into a lost session.
 */
export function fileHookLog(stateDir: string): (line: string) => void {
  const dir = join(stateDir, "logs");
  const file = join(dir, "hooks.log");
  let warned = false;
  return (line: string) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${line}\n`);
    } catch (err) {
      if (warned) return;
      warned = true;
      log("warn", "hook log append failed; continuing without it", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function hookPath(repoDir: string, name: HookName): string {
  return join(repoDir, REPO_DIRNAME, "hooks", name);
}

type Executable = "yes" | "missing" | "not-executable";

/**
 * `statSync` (not `existsSync` + `accessSync`) so a directory at the hook path is never treated
 * as runnable: `accessSync(X_OK)` succeeds on a directory, which would otherwise hand `exec` a
 * path it cannot run and surface as an opaque code-1 failure instead of a clear "not a hook".
 */
function executable(p: string): Executable {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "missing";
  try {
    accessSync(p, constants.X_OK);
    return "yes";
  } catch {
    return "not-executable";
  }
}

export function hookEnv(
  ctx: HookContext,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    FOREMAN_INSTANCE: ctx.instance,
    FOREMAN_STATE_DIR: ctx.stateDir,
    FOREMAN_REPO_DIR: ctx.repoDir,
  };
  if (ctx.role !== undefined) env.FOREMAN_ROLE = ctx.role;
  if (ctx.issue !== undefined) env.FOREMAN_ISSUE = String(ctx.issue);
  if (ctx.pr !== undefined) env.FOREMAN_PR = ctx.pr === null ? "" : String(ctx.pr);
  if (ctx.worktree !== undefined) env.FOREMAN_WORKTREE = ctx.worktree;
  if (ctx.round !== undefined) env.FOREMAN_ROUND = String(ctx.round);
  return env;
}

export async function runHook(
  name: HookName,
  cwd: string,
  ctx: HookContext,
  exec: Exec,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<HookResult> {
  const path = hookPath(ctx.repoDir, name);
  const state = executable(path);
  if (state !== "yes") {
    if (state === "not-executable") {
      const line = `${path} exists but is not executable (chmod +x)`;
      opts.log?.(line);
      log("warn", "hook exists but is not executable", { path });
    }
    return { ran: false, code: 0, stdout: "", stderr: "", timedOut: false };
  }
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  let timedOut = false;
  const timer = new Promise<HookResult>((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve({
        ran: true,
        code: 124,
        stdout: "",
        stderr: `${name} hook timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs).unref(),
  );
  const run = exec(path, [], { cwd, env: hookEnv(ctx), timeoutMs }).then(
    (r): HookResult => ({ ran: true, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut }),
  );
  const result = await Promise.race([run, timer]);
  // session-env's stdout is exactly the secrets it exists to inject (spec: KEY=VALUE lines meant
  // for the child's env). The log is a persistent file under stateDir, so it must never carry
  // that — only the exit code and stderr are safe to keep.
  const loggedStdout = name === "session-env" ? "" : result.stdout;
  opts.log?.(
    `${new Date().toISOString()} ${name} cwd=${cwd} code=${result.code}${result.timedOut ? " timed-out" : ""}\n${loggedStdout}${result.stderr}`.trimEnd(),
  );
  return result;
}

export function parsePreflight(
  r: HookResult,
): { ok: true; warnings: string[] } | { ok: false; reason: string } {
  if (!r.ran) return { ok: true, warnings: [] };
  if (r.code === 0)
    return {
      ok: true,
      warnings: r.stdout
        .split("\n")
        .filter((l) => l.startsWith("warn:"))
        .map((l) => l.slice(5).trim()),
    };
  const last = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  return { ok: false, reason: last ?? `preflight hook exited ${r.code}` };
}

export function parseSessionEnv(r: HookResult): {
  env: Record<string, string>;
  promptLines: string[];
} {
  const env: Record<string, string> = {};
  const promptLines: string[] = [];
  if (!r.ran) return { env, promptLines };
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("prompt:")) promptLines.push(line.slice(7).trim());
    else {
      const eq = line.indexOf("=");
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq)))
        env[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return { env, promptLines };
}
