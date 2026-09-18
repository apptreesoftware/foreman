import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Where a repository keeps what the foreman needs to know about it (spec §5). */
export const REPO_DIRNAME = ".foreman";

const LimitsSchema = z
  .object({
    fixRounds: z.number().int().min(1).default(2),
    ciReruns: z.number().int().min(0).default(1),
    blockedPerPhase: z.number().int().min(1).default(2),
    staleHours: z.number().int().min(1).default(2),
    attempts: z.number().int().min(1).default(3),
  })
  .strict();

export const RepoConfigSchema = z
  .object({
    /** Run once when a worktree is created; null skips it. */
    setup: z.string().nullable().default("pnpm install"),
    /** What a rebase round runs, and what the base builder prompt calls "the checks". */
    checks: z.array(z.string()).default(["pnpm lint", "pnpm typecheck", "pnpm test"]),
    plans: z
      .object({
        dir: z.string().default("docs/superpowers/plans"),
        specGlob: z.string().default("docs/**/*.md"),
      })
      .strict()
      .prefault({}),
    validator: z
      .object({ skipLabels: z.array(z.string()).default([]) })
      .strict()
      .prefault({}),
    limits: LimitsSchema.prefault({}),
    /** The page's model buttons and the accepted `model:<name>` labels. */
    models: z.array(z.string().min(1)).min(1).default(["opus", "sonnet", "haiku", "fable"]),
  })
  .strict();
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function defaultRepoConfig(): RepoConfig {
  return RepoConfigSchema.parse({});
}

export function repoConfigPath(dir: string): string {
  return join(dir, REPO_DIRNAME, "config.json");
}

/**
 * One line naming what is wrong: the first Zod issue's path and message, or a parse error. Used
 * to prefix every repo-config and repo-settings failure with the file it came from, because a
 * bare Zod blob on stderr never says which file the operator has to open.
 */
export function firstIssue(err: unknown): string {
  if (err instanceof z.ZodError) {
    const i = err.issues[0];
    if (i) return `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** `<dir>/.foreman/config.json`, or the defaults when there is none. A bad file throws. */
export function loadRepoConfig(dir: string): RepoConfig {
  const p = repoConfigPath(dir);
  if (!existsSync(p)) return defaultRepoConfig();
  try {
    return RepoConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch (err) {
    throw new Error(`${p}: ${firstIssue(err).replace(/\s+/g, " ")}`);
  }
}

/**
 * Never throws: a mistyped `config.json` must not brick `foreman status`, `stop` or `go`. The
 * caller decides what to do with `error` — ctl warns and carries on with the defaults, the
 * daemon refuses to start so the mistake is visible in `foreman.err.log` rather than silently
 * running a different process than the repository asked for.
 */
export function loadRepoConfigSafe(dir: string): { config: RepoConfig; error: string | null } {
  try {
    return { config: loadRepoConfig(dir), error: null };
  } catch (err) {
    return {
      config: defaultRepoConfig(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
