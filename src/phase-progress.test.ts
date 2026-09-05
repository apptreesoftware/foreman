import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, snapshot } from "../test/helpers.ts";
import { phaseProgress, taskNumbersOf } from "./phase-progress.ts";
import type { MergeRecord, SessionLogEntry } from "./sessions.ts";

const session = (over: Partial<SessionLogEntry> = {}): SessionLogEntry => ({
  t: hoursAgo(2),
  host: "mac-a",
  role: "builder",
  issue: 101,
  sessionId: "s",
  attempt: 1,
  costUsd: 1,
  outcome: "pr_opened",
  model: "claude-opus-5",
  turns: 30,
  durationMinutes: 20,
  denials: 0,
  subtype: "success",
  ...over,
});

const merge = (over: Partial<MergeRecord> = {}): MergeRecord => ({
  issue: 101,
  pr: 900,
  host: "mac-a",
  claimedAt: hoursAgo(4),
  mergedAt: hoursAgo(3),
  ...over,
});

describe("taskNumbersOf", () => {
  it("unions the epic's sub-issues with issues whose body names it as parent", () => {
    const e = epic({ number: 10, taskNumbers: [101, 102] });
    const issues = [
      issue({ number: 103, body: "## Goal\n…\n\nParent epic: #10" }),
      issue({ number: 104, body: "Parent epic: #11" }),
    ];
    expect([...taskNumbersOf(e, issues)]).toEqual([101, 102, 103]);
  });
});

describe("phaseProgress", () => {
  const e = epic({ number: 10, phase: 1, taskNumbers: [101, 102, 103, 104] });
  const epicIssue = issue({ number: 10, title: "Phase 1 — lessons", labels: ["epic", "phase:1"] });

  it("counts tasks done out of total from the snapshot's open issues", () => {
    // 101 and 102 are still open; 103 and 104 are gone from the snapshot, so they are closed.
    const s = snapshot({
      epics: [e],
      issues: [epicIssue, issue({ number: 101 }), issue({ number: 102 })],
    });
    const [p] = phaseProgress(s, [], []);
    expect(p).toMatchObject({
      epic: 10,
      phase: 1,
      title: "Phase 1 — lessons",
      tasksTotal: 4,
      tasksDone: 2,
    });
  });

  it("sums spend and session count over the epic's tasks only", () => {
    const s = snapshot({ epics: [e], issues: [epicIssue, issue({ number: 101 })] });
    const [p] = phaseProgress(
      s,
      [
        session({ issue: 101, costUsd: 1.25 }),
        session({ issue: 104, costUsd: 2.75, role: "reviewer" }),
        session({ issue: 999, costUsd: 100 }), // another phase's task: not counted
      ],
      [],
    );
    expect(p?.spendUsd).toBeCloseTo(4);
    expect(p?.sessions).toBe(2);
  });

  it("takes the median claim→merge time from merge records and snapshot comments", () => {
    // #102 is still open but already carries both ledger comments (a re-opened merge).
    const merged = issue({
      number: 102,
      comments: [
        comment("claimed by mac-a at 2026-09-03T00:00:00Z role=builder round=1", hoursAgo(12)),
        comment("session x finished on mac-a: outcome=pr_opened", hoursAgo(11)),
        comment("merged by foreman@mac-a", hoursAgo(9)),
      ],
    });
    const s = snapshot({ epics: [e], issues: [epicIssue, merged] });
    const [p] = phaseProgress(
      s,
      [],
      [
        merge({ issue: 101, claimedAt: hoursAgo(6), mergedAt: hoursAgo(5) }), // 60m
        merge({ issue: 103, claimedAt: hoursAgo(8), mergedAt: hoursAgo(3) }), // 300m
        merge({ issue: 999, claimedAt: hoursAgo(20), mergedAt: hoursAgo(1) }), // other phase
      ],
    );
    // samples: 60m (#101), 300m (#103), 180m (#102 from comments) → median 180
    expect(p?.mergedTasks).toBe(3);
    expect(p?.medianMergeMinutes).toBe(180);
  });

  it("averages the two middle samples on an even count and prefers the ledger over the record", () => {
    const merged = issue({
      number: 102,
      comments: [
        comment("claimed by mac-a at 2026-09-03T00:00:00Z role=builder round=1", hoursAgo(10)),
        comment("merged by foreman@mac-a", hoursAgo(9)),
      ],
    });
    const s = snapshot({ epics: [e], issues: [epicIssue, merged] });
    const [p] = phaseProgress(
      s,
      [],
      [
        merge({ issue: 101, claimedAt: hoursAgo(6), mergedAt: hoursAgo(4) }), // 120m
        merge({ issue: 102, claimedAt: hoursAgo(20), mergedAt: hoursAgo(1) }), // superseded by comments
      ],
    );
    expect(p?.mergedTasks).toBe(2);
    expect(p?.medianMergeMinutes).toBe(90); // (120 + 60) / 2
  });

  it("reports no median when nothing has merged yet", () => {
    const s = snapshot({ epics: [e], issues: [epicIssue, issue({ number: 101 })] });
    const [p] = phaseProgress(s, [], []);
    expect(p?.medianMergeMinutes).toBeNull();
    expect(p?.mergedTasks).toBe(0);
  });

  it("covers only open epics whose plan is approved, ordered by phase", () => {
    const two = epic({ number: 20, phase: 2, taskNumbers: [201] });
    const unapproved = epic({
      number: 30,
      phase: 3,
      labels: ["epic", "phase:3"],
      taskNumbers: [301],
    });
    const closed = epic({ number: 40, phase: 0, state: "CLOSED", taskNumbers: [401] });
    const s = snapshot({
      epics: [two, unapproved, closed, e],
      issues: [epicIssue, issue({ number: 20, title: "Phase 2" })],
    });
    expect(phaseProgress(s, [], []).map((p) => p.epic)).toEqual([10, 20]);
  });

  it("falls back to #<epic> as the title when the epic issue is not in the snapshot", () => {
    const s = snapshot({ epics: [e], issues: [] });
    expect(phaseProgress(s, [], [])[0]?.title).toBe("#10");
  });
});
