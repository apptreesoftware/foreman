import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
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

export function hookPath(repoDir: string, name: HookName): string {
  return join(repoDir, REPO_DIRNAME, "hooks", name);
}

function executable(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
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
  if (!executable(path)) return { ran: false, code: 0, stdout: "", stderr: "", timedOut: false };
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
  opts.log?.(
    `${new Date().toISOString()} ${name} cwd=${cwd} code=${result.code}${result.timedOut ? " timed-out" : ""}\n${result.stdout}${result.stderr}`.trimEnd(),
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
