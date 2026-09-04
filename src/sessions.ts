import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "./preflight.ts";

export interface SessionLogEntry {
  t: string;
  host: string;
  role: string;
  issue: number;
  sessionId: string;
  attempt: number;
  costUsd: number;
  outcome: string;
}

export function appendSession(stateDir: string, entry: SessionLogEntry): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "sessions.log"), `${JSON.stringify(entry)}\n`);
}

export function readSessions(stateDir: string): SessionLogEntry[] {
  const file = join(stateDir, "sessions.log");
  if (!existsSync(file)) return [];
  const out: SessionLogEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Partial<SessionLogEntry>;
      if (typeof j.t === "string" && typeof j.issue === "number")
        out.push({
          t: j.t,
          host: String(j.host ?? ""),
          role: String(j.role ?? ""),
          issue: j.issue,
          sessionId: String(j.sessionId ?? ""),
          attempt: Number(j.attempt ?? 1),
          costUsd: Number(j.costUsd ?? 0),
          outcome: String(j.outcome ?? ""),
        });
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function todayStats(
  entries: SessionLogEntry[],
  now: Date,
): { count: number; spendUsd: number } {
  const today = localDate(now);
  const mine = entries.filter((e) => localDate(new Date(e.t)) === today);
  return { count: mine.length, spendUsd: mine.reduce((s, e) => s + e.costUsd, 0) };
}
