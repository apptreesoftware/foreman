import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetSample } from "./budget.ts";
import type { ForemanConfig } from "./config.ts";
import type { Exec } from "./exec.ts";

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
  return { ok: true, warnings };
}
