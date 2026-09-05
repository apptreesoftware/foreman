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
  /** The model the session actually ran as: the init event's id, else the dispatched name. */
  model: string;
  turns: number;
  /** Wall-clock minutes from the session result, one decimal, so short sessions are not all 0. */
  durationMinutes: number;
  denials: number;
  /** The CLI's own result subtype (`success`, `error_max_turns`, …), kept next to the outcome. */
  subtype: string;
}

/**
 * One merged task, recorded at merge time from the issue the tick already had in hand. The
 * snapshot only carries open issues, so a merged task's ledger comments are gone from it by the
 * next tick — without this the phase card's cycle time would always be empty (#226).
 */
export interface MergeRecord {
  issue: number;
  pr: number;
  host: string;
  /** First `claimed by` comment on the issue; null when the ledger has none (a hand-made PR). */
  claimedAt: string | null;
  mergedAt: string;
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
          // Lines written before #226 have none of these; they read as "unknown", never NaN.
          model: String(j.model ?? ""),
          turns: Number(j.turns ?? 0),
          durationMinutes: Number(j.durationMinutes ?? 0),
          denials: Number(j.denials ?? 0),
          subtype: String(j.subtype ?? ""),
        });
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function appendMerge(stateDir: string, record: MergeRecord): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "merges.log"), `${JSON.stringify(record)}\n`);
}

export function readMerges(stateDir: string): MergeRecord[] {
  const file = join(stateDir, "merges.log");
  if (!existsSync(file)) return [];
  const out: MergeRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Partial<MergeRecord>;
      if (typeof j.issue === "number" && typeof j.mergedAt === "string")
        out.push({
          issue: j.issue,
          pr: Number(j.pr ?? 0),
          host: String(j.host ?? ""),
          claimedAt: typeof j.claimedAt === "string" ? j.claimedAt : null,
          mergedAt: j.mergedAt,
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
