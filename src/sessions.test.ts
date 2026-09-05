import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMerge,
  appendSession,
  readMerges,
  readSessions,
  type SessionLogEntry,
  todayStats,
} from "./sessions.ts";

const entry = (over: Partial<SessionLogEntry> = {}): SessionLogEntry => ({
  t: "2026-09-03T10:00:00.000Z",
  host: "h",
  role: "builder",
  issue: 1,
  sessionId: "s",
  attempt: 1,
  costUsd: 0.5,
  outcome: "pr_opened",
  model: "claude-opus-5",
  turns: 42,
  durationMinutes: 12.5,
  denials: 0,
  subtype: "success",
  ...over,
});

describe("appendSession", () => {
  it("appends one JSON line per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendSession(dir, entry());
    appendSession(dir, entry({ t: "2026-09-03T11:00:00.000Z", role: "reviewer", sessionId: "t" }));
    const lines = readFileSync(join(dir, "sessions.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).role).toBe("reviewer");
  });

  it("records the model, turns, duration, denials and subtype of the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendSession(dir, entry({ model: "claude-sonnet-5", turns: 7, durationMinutes: 3.4 }));
    const [read] = readSessions(dir);
    expect(read).toMatchObject({
      model: "claude-sonnet-5",
      turns: 7,
      durationMinutes: 3.4,
      denials: 0,
      subtype: "success",
    });
  });
});

describe("readSessions / todayStats", () => {
  it("reads valid lines, skips garbage, and sums today's spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendSession(dir, entry({ t: "2026-09-03T10:00:00.000Z", costUsd: 1.5 }));
    appendSession(dir, entry({ t: "2026-09-02T10:00:00.000Z", costUsd: 9 }));
    writeFileSync(join(dir, "sessions.log"), "{broken\n", { flag: "a" });
    appendSession(dir, entry({ t: "2026-09-03T11:00:00.000Z", costUsd: 0.25 }));
    const all = readSessions(dir);
    expect(all).toHaveLength(3);
    const today = todayStats(all, new Date("2026-09-03T12:00:00.000Z"));
    expect(today.count).toBe(2);
    expect(today.spendUsd).toBeCloseTo(1.75);
    expect(readSessions(mkdtempSync(join(tmpdir(), "tt-")))).toEqual([]);
  });

  it("still parses a line written before model/turns/duration existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    writeFileSync(
      join(dir, "sessions.log"),
      `${JSON.stringify({
        t: "2026-09-01T10:00:00.000Z",
        host: "h",
        role: "builder",
        issue: 5,
        sessionId: "old",
        attempt: 1,
        costUsd: 2,
        outcome: "pr_opened",
      })}\n`,
    );
    expect(readSessions(dir)).toEqual([
      {
        t: "2026-09-01T10:00:00.000Z",
        host: "h",
        role: "builder",
        issue: 5,
        sessionId: "old",
        attempt: 1,
        costUsd: 2,
        outcome: "pr_opened",
        model: "",
        turns: 0,
        durationMinutes: 0,
        denials: 0,
        subtype: "",
      },
    ]);
  });
});

describe("appendMerge / readMerges", () => {
  it("records one claim→merge span per merged issue and skips torn lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendMerge(dir, {
      issue: 12,
      pr: 30,
      host: "h",
      claimedAt: "2026-09-03T08:00:00.000Z",
      mergedAt: "2026-09-03T10:00:00.000Z",
    });
    writeFileSync(join(dir, "merges.log"), "{broken\n", { flag: "a" });
    appendMerge(dir, {
      issue: 13,
      pr: 31,
      host: "h",
      claimedAt: null,
      mergedAt: "2026-09-03T11:00:00.000Z",
    });
    expect(readMerges(dir)).toEqual([
      {
        issue: 12,
        pr: 30,
        host: "h",
        claimedAt: "2026-09-03T08:00:00.000Z",
        mergedAt: "2026-09-03T10:00:00.000Z",
      },
      {
        issue: 13,
        pr: 31,
        host: "h",
        claimedAt: null,
        mergedAt: "2026-09-03T11:00:00.000Z",
      },
    ]);
    expect(readMerges(mkdtempSync(join(tmpdir(), "tt-")))).toEqual([]);
  });
});
