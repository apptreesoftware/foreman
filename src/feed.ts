import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FeedEntry =
  | { t: string; kind: "init"; model: string }
  | { t: string; kind: "tool"; name: string; summary: string; subagent: boolean }
  | { t: string; kind: "tool_error"; name: string }
  | { t: string; kind: "text"; text: string }
  | { t: string; kind: "rate_limit"; fiveHour: number; sevenDay: number }
  | {
      t: string;
      kind: "result";
      subtype: string;
      outcome: string | null;
      turns: number;
      costUsd: number;
    };

export const FEED_LIMIT_DEFAULT = 50;
export const FEED_LIMIT_MAX = 500;
const KINDS = new Set(["init", "tool", "tool_error", "text", "rate_limit", "result"]);

/** The id names a file under the state dir, so only a plain uuid shape is accepted. */
export function isSessionId(s: string): boolean {
  return /^[0-9a-f-]{36}$/.test(s);
}

export function feedPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "activity", `${sessionId}.jsonl`);
}

export function appendFeed(stateDir: string, sessionId: string, entry: FeedEntry): void {
  mkdirSync(join(stateDir, "activity"), { recursive: true });
  appendFileSync(feedPath(stateDir, sessionId), `${JSON.stringify(entry)}\n`);
}

/** Last `limit` entries, oldest first. Torn or foreign lines are skipped. */
export function readFeed(
  stateDir: string,
  sessionId: string,
  limit = FEED_LIMIT_DEFAULT,
): FeedEntry[] {
  const p = feedPath(stateDir, sessionId);
  if (!existsSync(p)) return [];
  const n = Math.max(1, Math.min(limit, FEED_LIMIT_MAX));
  const out: FeedEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Partial<FeedEntry>;
      if (typeof j.t === "string" && typeof j.kind === "string" && KINDS.has(j.kind))
        out.push(j as FeedEntry);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-n);
}
