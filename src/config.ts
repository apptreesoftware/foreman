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
  workDir: z.string().min(1),
  pollSeconds: z.number().int().min(10).default(120),
  maxSessionsPerDay: z.number().int().min(1).default(20),
  maxTurns: z.number().int().min(1).default(200),
  wallClockMinutes: z.number().int().min(1).default(90),
  slackUser: z.string().min(1),
  model: z.string().optional(),
  webPort: z.number().int().min(1).max(65535).default(8090),
});
export type ForemanConfig = z.infer<typeof ConfigSchema> & { owner: string };

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function parseConfig(json: string): ForemanConfig {
  const cfg = ConfigSchema.parse(JSON.parse(json));
  const owner = cfg.repo.slice(0, cfg.repo.indexOf("/"));
  return { ...cfg, owner, repoDir: expandHome(cfg.repoDir), workDir: expandHome(cfg.workDir) };
}

export function loadConfig(path?: string): ForemanConfig {
  return parseConfig(
    readFileSync(path ?? process.env.TONE_FOREMAN_CONFIG ?? DEFAULT_CONFIG_PATH, "utf8"),
  );
}
