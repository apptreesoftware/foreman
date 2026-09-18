import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetSample } from "./budget.ts";
import type { ForemanConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { parsePreflight, runHook } from "./hooks.ts";

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
  repoDir: string;
  instance: string;
  hookLog?: (line: string) => void;
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

/** True when GitHub refused the query because the hourly GraphQL budget is already spent. */
function isRateLimited(stdout: string): boolean {
  try {
    const errors = JSON.parse(stdout).errors as Array<{ type?: string; code?: string }> | undefined;
    return (errors ?? []).some((e) => e.type === "RATE_LIMIT" || e.code === "graphql_rate_limit");
  } catch {
    return false;
  }
}

/**
 * The remaining GitHub GraphQL points. The `rateLimit` query itself costs nothing, so this is
 * safe to run every tick; an unreadable answer returns null and never blocks the daemon (#192).
 *
 * An *exhausted* quota is not an unreadable answer. GitHub answers `rateLimit` itself with
 * `{"errors":[{"type":"RATE_LIMIT"}]}` and `gh` exits non-zero, which used to read as null and
 * so skipped the budget check entirely — preflight passed and the tick then died inside
 * `listIssues`, the very state the check exists to prevent (#387). Report it as zero instead.
 */
export async function graphqlBudget(exec: Exec): Promise<BudgetSample | null> {
  const r = await exec("gh", [
    "api",
    "graphql",
    "-f",
    "query={rateLimit{limit remaining resetAt}}",
  ]);
  // The reset time is not in the error, so it stays empty; `formatBudget` and the preflight
  // reason both tolerate that, and the next successful read fills it in.
  if (r.code !== 0)
    return isRateLimited(r.stdout) ? { remaining: 0, limit: 5000, resetAt: "" } : null;
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
  const scopes = /Token scopes: (.*)/.exec(`${gh.stdout}${gh.stderr}`)?.[1] ?? "";
  if (!/'project'/.test(scopes))
    return {
      ok: false,
      reason: "gh token lacks the project scope; run: gh auth refresh -s project,read:project",
    };

  const budget = await graphqlBudget(deps.exec);
  if (budget && budget.remaining < cfg.minGraphqlPoints)
    return {
      ok: false,
      reason: `GitHub GraphQL budget low: ${budget.remaining} points left${
        budget.resetAt ? `, resets ${budget.resetAt}` : ""
      }`,
    };

  const used = countSessionsToday(deps.stateDir, deps.now);
  if (used >= cfg.maxSessionsPerDay)
    return { ok: false, reason: `daily session cap reached (${used}/${cfg.maxSessionsPerDay})` };

  const hook = await runHook(
    "preflight",
    deps.repoDir,
    { instance: deps.instance, stateDir: deps.stateDir, repoDir: deps.repoDir },
    deps.exec,
    { log: deps.hookLog },
  );
  const verdict = parsePreflight(hook);
  if (!verdict.ok) return verdict;
  return { ok: true, warnings: verdict.warnings };
}
