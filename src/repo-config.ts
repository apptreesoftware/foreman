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

/** `<dir>/.foreman/config.json`, or the defaults when there is none. A bad file throws. */
export function loadRepoConfig(dir: string): RepoConfig {
  const p = repoConfigPath(dir);
  if (!existsSync(p)) return defaultRepoConfig();
  return RepoConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}
