import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSession, readSessions, todayStats } from "./sessions.ts";

describe("appendSession", () => {
  it("appends one JSON line per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendSession(dir, {
      t: "2026-09-03T10:00:00.000Z",
      host: "h",
      role: "builder",
      issue: 1,
      sessionId: "s",
      attempt: 1,
      costUsd: 0.5,
      outcome: "pr_opened",
    });
    appendSession(dir, {
      t: "2026-09-03T11:00:00.000Z",
      host: "h",
      role: "reviewer",
      issue: 1,
      sessionId: "t",
      attempt: 1,
      costUsd: 0.1,
      outcome: "approved",
    });
    const lines = readFileSync(join(dir, "sessions.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).role).toBe("reviewer");
  });
});

describe("readSessions / todayStats", () => {
  it("reads valid lines, skips garbage, and sums today's spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    const e = (t: string, costUsd: number) => ({
      t,
      host: "h",
      role: "builder",
      issue: 1,
      sessionId: "s",
      attempt: 1,
      costUsd,
      outcome: "pr_opened",
    });
    appendSession(dir, e("2026-09-03T10:00:00.000Z", 1.5));
    appendSession(dir, e("2026-09-02T10:00:00.000Z", 9));
    writeFileSync(join(dir, "sessions.log"), "{broken\n", { flag: "a" });
    appendSession(dir, e("2026-09-03T11:00:00.000Z", 0.25));
    const all = readSessions(dir);
    expect(all).toHaveLength(3);
    const today = todayStats(all, new Date("2026-09-03T12:00:00.000Z"));
    expect(today.count).toBe(2);
    expect(today.spendUsd).toBeCloseTo(1.75);
    expect(readSessions(mkdtempSync(join(tmpdir(), "tt-")))).toEqual([]);
  });
});
