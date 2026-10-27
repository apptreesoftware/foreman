import { describe, expect, it } from "vitest";
import { describeSessionHistory, parseRange } from "./session-history.ts";
import type { SessionLogEntry } from "./sessions.ts";

// Midday UTC, so the local date is the same day in every timezone the tests might run in.
const entry = (over: Partial<SessionLogEntry> = {}): SessionLogEntry => ({
  t: "2026-10-07T12:00:00.000Z",
  host: "h",
  role: "builder",
  issue: 1,
  sessionId: "s",
  attempt: 1,
  costUsd: 1,
  outcome: "pr_opened",
  model: "claude-opus-5-5",
  turns: 10,
  durationMinutes: 2,
  denials: 0,
  subtype: "success",
  ...over,
});
const all = { from: null, to: null };

describe("describeSessionHistory", () => {
  it("totals, daily, byRole and byIssue for the whole log", () => {
    const entries = [
      entry({ issue: 1, role: "builder", costUsd: 4, title: "One" }),
      entry({ issue: 1, role: "reviewer", costUsd: 1, t: "2026-10-08T12:00:00.000Z" }),
      entry({ issue: 2, role: "builder", costUsd: 2, t: "2026-10-08T13:00:00.000Z" }),
    ];
    const h = describeSessionHistory(entries, all, new Map());
    expect(h.totals).toEqual({ spendUsd: 7, sessions: 3, issues: 2 });
    expect(h.daily).toEqual([
      { date: "2026-10-07", spendUsd: 4, sessions: 1 },
      { date: "2026-10-08", spendUsd: 3, sessions: 2 },
    ]);
    expect(h.byRole).toEqual([
      { role: "builder", spendUsd: 6, sessions: 2 },
      { role: "reviewer", spendUsd: 1, sessions: 1 },
    ]);
    expect(
      h.byIssue.map((r) => [r.issue, r.title, r.roles, r.sessions, r.costUsd, r.lastAt]),
    ).toEqual([
      [1, "One", ["builder", "reviewer"], 2, 5, "2026-10-08T12:00:00.000Z"],
      [2, "#2", ["builder"], 1, 2, "2026-10-08T13:00:00.000Z"],
    ]);
    // Newest first inside a row.
    expect(h.byIssue[0]?.entries.map((e) => e.role)).toEqual(["reviewer", "builder"]);
  });

  it("fills zero days between the first and last entry", () => {
    const h = describeSessionHistory(
      [entry(), entry({ t: "2026-10-10T12:00:00.000Z" })],
      all,
      new Map(),
    );
    expect(h.daily.map((d) => [d.date, d.sessions])).toEqual([
      ["2026-10-07", 1],
      ["2026-10-08", 0],
      ["2026-10-09", 0],
      ["2026-10-10", 1],
    ]);
  });

  it("filters by an inclusive local-date range", () => {
    const entries = [
      entry({ t: "2026-10-06T12:00:00.000Z", costUsd: 1 }),
      entry({ t: "2026-10-07T12:00:00.000Z", costUsd: 2 }),
      entry({ t: "2026-10-09T12:00:00.000Z", costUsd: 4 }),
    ];
    const h = describeSessionHistory(entries, { from: "2026-10-07", to: "2026-10-09" }, new Map());
    expect(h.totals.spendUsd).toBe(6);
    expect(h.daily.map((d) => d.date)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(
      describeSessionHistory(entries, { from: "2026-10-08", to: null }, new Map()).totals.sessions,
    ).toBe(1);
  });

  it("takes a title from the newest titled line, then open titles, then #N", () => {
    const entries = [
      entry({ issue: 1, title: "Old name" }),
      entry({ issue: 1, title: "New name", t: "2026-10-09T12:00:00.000Z" }),
      entry({ issue: 2 }),
      entry({ issue: 3 }),
    ];
    // The range excludes the newest titled line; the title still comes from the whole log.
    const h = describeSessionHistory(
      entries,
      { from: null, to: "2026-10-08" },
      new Map([[2, "Open two"]]),
    );
    const titles = new Map(h.byIssue.map((r) => [r.issue, r.title]));
    expect(titles.get(1)).toBe("New name");
    expect(titles.get(2)).toBe("Open two");
    expect(titles.get(3)).toBe("#3");
  });

  it("is zeros and empty arrays for no entries", () => {
    expect(describeSessionHistory([], all, new Map())).toEqual({
      from: null,
      to: null,
      totals: { spendUsd: 0, sessions: 0, issues: 0 },
      daily: [],
      byRole: [],
      byIssue: [],
    });
  });
});

describe("parseRange", () => {
  it("accepts absent bounds and real dates in order", () => {
    expect(parseRange(null, null)).toEqual({ from: null, to: null });
    expect(parseRange("2026-10-01", "2026-10-26")).toEqual({
      from: "2026-10-01",
      to: "2026-10-26",
    });
    expect(parseRange("2026-10-26", "2026-10-26")).toEqual({
      from: "2026-10-26",
      to: "2026-10-26",
    });
  });

  it("rejects a malformed date, a non-date and from after to", () => {
    expect(parseRange("2026-13-01", null)).toBeNull();
    expect(parseRange("2026-02-30", null)).toBeNull();
    expect(parseRange("../etc", null)).toBeNull();
    expect(parseRange(null, "yesterday")).toBeNull();
    expect(parseRange("2026-10-27", "2026-10-01")).toBeNull();
  });
});
