import { describe, expect, it } from "vitest";
import { epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { describeBoard, overlayCurrent } from "./board.ts";
import type { Board, CurrentSession } from "./state-file.ts";

describe("describeBoard", () => {
  it("assembles waiting, pipeline, explain and prs from one snapshot", () => {
    const s = snapshot({
      issues: [issue({ number: 1, status: "In Review" })],
      prs: [pr({ number: 11, issue: 1, checks: "pending" })],
    });
    const b = describeBoard(s, {
      host: "mac-a",
      preflight: null,
      stopPresent: false,
      todayCount: 0,
      cap: 20,
    });
    expect(b.at).toBe(s.now);
    expect(b.waiting.map((w) => w.kind)).toEqual(["ci"]);
    expect(b.pipeline.map((r) => r.issue)).toEqual([1]);
    expect(b.prs[0]).toMatchObject({ pr: 11, reason: "checks pending" });
    expect(b.explain.length).toBeGreaterThan(0);
    // No logs passed: the phase card still lists the approved epic, at zero spend.
    expect(b.phases).toMatchObject([{ tasksTotal: 0, spendUsd: 0, medianMergeMinutes: null }]);
  });

  it("folds the local session and merge logs into the phase card", () => {
    const s = snapshot({
      epics: [epic({ number: 10, phase: 1, taskNumbers: [1, 2] })],
      issues: [issue({ number: 10, title: "Phase 1" }), issue({ number: 1 })],
    });
    const b = describeBoard(
      s,
      { host: "mac-a", preflight: null, stopPresent: false, todayCount: 0, cap: 20 },
      {
        sessions: [
          {
            t: hoursAgo(2),
            host: "mac-a",
            role: "builder",
            issue: 1,
            sessionId: "s",
            attempt: 1,
            costUsd: 3,
            outcome: "pr_opened",
            model: "claude-opus-5",
            turns: 10,
            durationMinutes: 5,
            denials: 0,
            subtype: "success",
          },
        ],
        merges: [
          {
            issue: 2,
            pr: 20,
            host: "mac-a",
            claimedAt: hoursAgo(5),
            mergedAt: hoursAgo(3),
          },
        ],
      },
    );
    expect(b.phases).toEqual([
      {
        epic: 10,
        phase: 1,
        title: "Phase 1",
        tasksDone: 1,
        tasksTotal: 2,
        spendUsd: 3,
        sessions: 1,
        medianMergeMinutes: 120,
        mergedTasks: 1,
        tasks: [
          { issue: 1, title: "Task 1", status: "Ready", closed: false, model: null },
          { issue: 2, title: "#2", status: null, closed: true, model: null },
        ],
      },
    ]);
  });
});

describe("overlayCurrent", () => {
  const current: CurrentSession = {
    issue: 1,
    title: "Task 1",
    role: "builder",
    pr: 11,
    round: 1,
    attempt: 1,
    sessionId: "33333333-3333-3333-3333-333333333333",
    resume: false,
    worktree: "/w/1",
    branch: "feat/1-x",
    childPid: 1234,
    startedAt: "2026-09-04T05:00:00.000Z",
    deadlineAt: "2026-09-04T06:30:00.000Z",
    activity: null,
  };
  const emptyBoard: Board = {
    at: "now",
    waiting: [],
    pipeline: [],
    owner: [],
    needsYou: [],
    phases: [],
    explain: [],
    prs: [],
  };

  it("marks the matching pipeline row's build stage active and sets the claim", () => {
    const board: Board = {
      ...emptyBoard,
      pipeline: [
        {
          issue: 1,
          title: "Task 1",
          phase: 1,
          status: "In Progress",
          pr: null,
          stages: {
            build: "pending",
            review: "pending",
            validate: "pending",
            ci: "none",
            merge: "pending",
          },
          claim: null,
          fixRound: 1,
          blocked: false,
          model: null,
        },
      ],
    };
    const r = overlayCurrent(board, current, "mac-a");
    expect(r.pipeline).toHaveLength(1);
    expect(r.pipeline[0]).toMatchObject({
      issue: 1,
      phase: 1, // the stored row is kept, not the synthesised default
      stages: { build: "active", review: "pending" },
      claim: { host: "mac-a", role: "builder", round: 1, at: current.startedAt },
    });
  });

  it("synthesises a pending row when the issue has no pipeline row yet", () => {
    const r = overlayCurrent(emptyBoard, current, "mac-a");
    expect(r.pipeline).toHaveLength(1);
    expect(r.pipeline[0]).toMatchObject({
      issue: 1,
      title: "Task 1",
      phase: 0,
      status: null,
      pr: 11,
      claim: { host: "mac-a", role: "builder", round: 1, at: current.startedAt },
      stages: {
        build: "active",
        review: "pending",
        validate: "pending",
        ci: "none",
        merge: "pending",
      },
      fixRound: 1,
      blocked: false,
    });
  });

  it("removes a review_cycle wait item for the current PR", () => {
    const board: Board = {
      ...emptyBoard,
      waiting: [
        {
          kind: "review_cycle",
          subject: "PR #11",
          detail: "PR #11 fix round 2 queued",
          since: null,
        },
        {
          kind: "human",
          subject: "epic #10",
          detail: "epic #10 awaits plan-approved",
          since: null,
        },
      ],
    };
    const r = overlayCurrent(board, current, "mac-a");
    expect(r.waiting.map((w) => w.kind)).toEqual(["human"]);
  });

  it("removes a dependency wait item for the current issue", () => {
    const board: Board = {
      ...emptyBoard,
      waiting: [{ kind: "dependency", subject: "#1", detail: "#1 waits on #9", since: null }],
    };
    const r = overlayCurrent(board, current, "mac-a");
    expect(r.waiting).toEqual([]);
  });

  it("planner leaves stages untouched and sets only the claim", () => {
    const planner: CurrentSession = { ...current, role: "planner", issue: 10, pr: null };
    const r = overlayCurrent(emptyBoard, planner, "mac-a");
    expect(r.pipeline[0]).toMatchObject({
      stages: {
        build: "pending",
        review: "pending",
        validate: "pending",
        ci: "none",
        merge: "pending",
      },
      claim: { host: "mac-a", role: "planner", round: 1, at: planner.startedAt },
    });
  });
});
