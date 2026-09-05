import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetSample } from "./budget.ts";
import type { ForemanConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { log } from "./log.ts";
import { ROLE_SUPABASE_PROJECT } from "./ports.ts";

export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_AWS_API_KEY",
] as const;

export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  stateDir: string;
  now: Date;
}
export type PreflightResult = { ok: true; warnings: string[] } | { ok: false; reason: string };

export function checkEnv(env: NodeJS.ProcessEnv): string | null {
  for (const name of FORBIDDEN_ENV) if (env[name]) return name;
  return null;
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function countSessionsToday(stateDir: string, now: Date): number {
  const file = join(stateDir, "sessions.log");
  if (!existsSync(file)) return 0;
  const today = localDate(now);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => {
      try {
        return localDate(new Date(JSON.parse(l).t)) === today;
      } catch {
        return false;
      }
    }).length;
}

/**
 * The remaining GitHub GraphQL points. The `rateLimit` query itself costs nothing, so this is
 * safe to run every tick; an unreadable answer returns null and never blocks the daemon (#192).
 */
export async function graphqlBudget(exec: Exec): Promise<BudgetSample | null> {
  const r = await exec("gh", [
    "api",
    "graphql",
    "-f",
    "query={rateLimit{limit remaining resetAt}}",
  ]);
  if (r.code !== 0) return null;
  try {
    const l = JSON.parse(r.stdout).data?.rateLimit;
    return typeof l?.remaining === "number"
      ? {
          remaining: l.remaining,
          limit: typeof l.limit === "number" ? l.limit : 5000,
          resetAt: String(l.resetAt ?? ""),
        }
      : null;
  } catch {
    return null;
  }
}

/** The Supabase workdir the role stack runs from: `<stateDir>/val-stack/supabase/config.toml`. */
export function roleStackDir(stateDir: string): string {
  return join(stateDir, "val-stack");
}

export interface RoleStackDeps {
  exec: Exec;
  mkdirp?: (path: string) => void;
}

/**
 * Brings up the isolated `tone_tonic_val` stack role sessions use (#228), and leaves it up
 * between sessions the way the dev stack stays up.
 *
 * It runs from a copy of `packages/db/supabase` under the state dir with
 * `packages/db/scripts/role-config.sh` applied, so the clone itself is never rewritten and
 * `supabase start` here can never touch project `tone_tonic`. Returns a warning string instead of
 * throwing: a stack that will not start should not park the daemon, and a role session can start
 * it itself (`supabase stop` stays denied to sessions, `supabase start` does not).
 */
export async function ensureRoleStack(
  cfg: ForemanConfig,
  stateDir: string,
  deps: RoleStackDeps,
): Promise<string | null> {
  const dir = roleStackDir(stateDir);
  const supabase = join(dir, "supabase");
  const warn = (why: string) => {
    const message = `${ROLE_SUPABASE_PROJECT} stack unavailable: ${why}`;
    log("warn", "role Supabase stack unavailable", { dir, why });
    return message;
  };
  try {
    (deps.mkdirp ?? ((p: string) => mkdirSync(p, { recursive: true })))(supabase);
  } catch (err) {
    return warn(`cannot create ${supabase}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A mirror, not an additive copy: a migration deleted on `main` has to disappear here too, or
  // `supabase start` keeps applying it to the role stack long after it is gone from the repo. The
  // CLI's own scratch dirs are excluded in both directions — they belong to whichever stack owns
  // the directory, not to the repo.
  const copy = await deps.exec("rsync", [
    "-a",
    "--delete",
    "--exclude",
    ".branches",
    "--exclude",
    ".temp",
    `${join(cfg.repoDir, "packages", "db", "supabase")}/`,
    `${supabase}/`,
  ]);
  if (copy.code !== 0) return warn(`cannot copy the Supabase project: ${copy.stderr.trim()}`);
  const rewrite = await deps.exec("bash", [
    join(cfg.repoDir, "packages", "db", "scripts", "role-config.sh"),
    join(supabase, "config.toml"),
  ]);
  if (rewrite.code !== 0) return warn(`role-config.sh failed: ${rewrite.stderr.trim()}`);
  const status = await deps.exec("supabase", ["status", "-o", "env", "--workdir", dir]);
  if (status.code === 0) return null;
  log("info", "starting the role Supabase stack", { project: ROLE_SUPABASE_PROJECT, dir });
  const start = await deps.exec("supabase", ["start", "--workdir", dir]);
  if (start.code !== 0) return warn(`supabase start failed: ${start.stderr.trim()}`);
  return null;
}

function chromiumInstalled(): boolean {
  const dir = join(homedir(), "Library", "Caches", "ms-playwright");
  return existsSync(dir) && readdirSync(dir).some((d) => d.startsWith("chromium"));
}

export async function preflight(cfg: ForemanConfig, deps: PreflightDeps): Promise<PreflightResult> {
  const bad = checkEnv(deps.env);
  if (bad) return { ok: false, reason: `${bad} is set; refusing to run with API-key billing` };
  if (existsSync(join(deps.stateDir, "STOP"))) return { ok: false, reason: "STOP file present" };

  const auth = await deps.exec("claude", ["auth", "status"]);
  let status: { loggedIn?: boolean; authMethod?: string } = {};
  try {
    // `claude auth status` may pretty-print its JSON across multiple lines, so parse the
    // whole payload first and only fall back to brace-slicing for output with surrounding text.
    status = JSON.parse(auth.stdout);
  } catch {
    try {
      const start = auth.stdout.indexOf("{");
      const end = auth.stdout.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("no braces");
      status = JSON.parse(auth.stdout.slice(start, end + 1));
    } catch {
      return { ok: false, reason: "claude auth status returned no JSON" };
    }
  }
  if (auth.code !== 0 || !status.loggedIn) return { ok: false, reason: "claude is not logged in" };
  if (status.authMethod !== "claude.ai")
    return { ok: false, reason: `claude auth method is ${status.authMethod}, expected claude.ai` };

  const gh = await deps.exec("gh", ["auth", "status"]);
  if (gh.code !== 0) return { ok: false, reason: "gh is not authenticated" };

  const docker = await deps.exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (docker.code !== 0) return { ok: false, reason: "docker is not responding" };

  const budget = await graphqlBudget(deps.exec);
  if (budget && budget.remaining < cfg.minGraphqlPoints)
    return {
      ok: false,
      reason: `GitHub GraphQL budget low: ${budget.remaining} points left, resets ${budget.resetAt}`,
    };

  const used = countSessionsToday(deps.stateDir, deps.now);
  if (used >= cfg.maxSessionsPerDay)
    return { ok: false, reason: `daily session cap reached (${used}/${cfg.maxSessionsPerDay})` };

  const warnings: string[] = [];
  if (!chromiumInstalled()) warnings.push("playwright chromium not installed; validator will fail");
  const roleStack = await ensureRoleStack(cfg, deps.stateDir, { exec: deps.exec });
  if (roleStack) warnings.push(roleStack);
  return { ok: true, warnings };
}
