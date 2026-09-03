import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
