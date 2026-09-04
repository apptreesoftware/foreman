import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const STATE_DIR = join(homedir(), ".tone_tonic");
export const DEFAULT_CONFIG_PATH = join(STATE_DIR, "foreman.json");

export const ConfigSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  project: z.number().int().positive(),
  host: z.string().min(1),
  repoDir: z.string().min(1),
  /** Where role worktrees live. Absent means `<repoDir>/.worktrees`, so they stay in the repo. */
  workDir: z.string().min(1).optional(),
  pollSeconds: z.number().int().min(10).default(300),
  maxSessionsPerDay: z.number().int().min(1).default(20),
  maxTurns: z.number().int().min(1).default(200),
  wallClockMinutes: z.number().int().min(1).default(90),
  slackUser: z.string().min(1),
  /**
   * Passed to every `claude -p`. Defaulted rather than optional so a session never silently
   * inherits whatever the interactive CLI default happens to be on this Mac (#210).
   */
  model: z.string().min(1).default("opus"),
  webPort: z.number().int().min(1).max(65535).default(8090),
  stallMinutes: z.number().int().min(1).default(5),
  /** Preflight refuses to start a tick with fewer GitHub GraphQL points left than this (#192). */
  minGraphqlPoints: z.number().int().min(0).default(500),
});
export type ForemanConfig = Omit<z.infer<typeof ConfigSchema>, "workDir"> & {
  owner: string;
  workDir: string;
};

/** Worktrees live inside the clone, so a checkout is self-contained; `.gitignore` hides them. */
export const WORKTREES_DIRNAME = ".worktrees";

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function parseConfig(json: string): ForemanConfig {
  const cfg = ConfigSchema.parse(JSON.parse(json));
  const owner = cfg.repo.slice(0, cfg.repo.indexOf("/"));
  const repoDir = expandHome(cfg.repoDir);
  return {
    ...cfg,
    owner,
    repoDir,
    workDir: cfg.workDir ? expandHome(cfg.workDir) : join(repoDir, WORKTREES_DIRNAME),
  };
}

export function loadConfig(path?: string): ForemanConfig {
  return parseConfig(
    readFileSync(path ?? process.env.TONE_FOREMAN_CONFIG ?? DEFAULT_CONFIG_PATH, "utf8"),
  );
}
