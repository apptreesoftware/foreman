import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import {
  type DecisionGh,
  parseBlocks,
  planDecisionResumes,
  resumeSettledDecisions,
  settledAnswer,
} from "./decisions.ts";
import { fmt } from "./ledger.ts";
import type { ClosedDecision } from "./types.ts";

describe("parseBlocks", () => {
  it("reads the task from a `Blocks: #N` line", () => {
    expect(parseBlocks("## Question\nX?\n\n## Recommendation\nA\n\nBlocks: #57\n")).toBe(57);
  });
  it("tolerates indentation and trailing blanks around the line", () => {
    expect(parseBlocks("   Blocks: #57")).toBe(57);
    expect(parseBlocks("\tBlocks: #57 ")).toBe(57);
  });
  it("is null without the line, or when it is not on a line of its own", () => {
    expect(parseBlocks("Context: this blocks #57")).toBeNull();
    expect(parseBlocks("Blocks: #57 and #58")).toBeNull();
    expect(parseBlocks("")).toBeNull();
  });
});

describe("settledAnswer", () => {
  it("is the earliest `Settled:` first line, trimmed", () => {
    const cs = [
      comment("Settled: A — later answer", hoursAgo(1)),
      comment("Settled:  B — Use REST \nby Jane via decisions page", hoursAgo(2)),
      comment("I prefer B", hoursAgo(3)),
    ];
    expect(settledAnswer(cs)).toBe("B — Use REST");
  });
  it("is null when nobody settled through the page", () => {
    expect(settledAnswer([comment("go with B")])).toBeNull();
  });
  it("caps a very long answer at 500 characters", () => {
    expect(settledAnswer([comment(`Settled: ${"x".repeat(900)}`)])?.length).toBe(500);
  });
});

const blockedTask = (over: Parameters<typeof issue>[0] = {}) =>
  issue({
    number: 5,
    labels: ["phase:1", "blocked"],
    comments: [comment("blocked by builder: see #40", hoursAgo(4))],
    ...over,
  });

const closed = (over: Partial<ClosedDecision> = {}): ClosedDecision => ({
  number: 40,
  body: "## Question\nX?\n\nBlocks: #5",
  stateReason: "COMPLETED",
  createdAt: hoursAgo(5),
  closedAt: hoursAgo(1),
  comments: [comment("Settled: B — Use REST", hoursAgo(1))],
  ...over,
});

describe("planDecisionResumes", () => {
  it("resumes the blocked task with the settled answer and its PR", () => {
    const s = snapshot({ issues: [blockedTask()], prs: [pr({ number: 77, issue: 5 })] });
    expect(planDecisionResumes(s, [closed()])).toEqual([
      { task: 5, itemId: "PVTI_5", pr: 77, decisions: [{ number: 40, answer: "B — Use REST" }] },
    ]);
  });

  it("resumes with no answer when the decision was closed by hand", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ comments: [] })])[0]?.decisions).toEqual([
      { number: 40, answer: null },
    ]);
  });

  it("does nothing for a decision closed as not planned", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ stateReason: "NOT_PLANNED" })])).toEqual([]);
  });

  it("keeps the task blocked when one decision is completed and another not planned", () => {
    const s = snapshot({ issues: [blockedTask()] });
    const notPlanned = closed({ number: 41, stateReason: "NOT_PLANNED", comments: [] });
    expect(planDecisionResumes(s, [closed(), notPlanned])).toEqual([]);
  });

  it("lets a not-planned decision from before the last unblock go, so the completed one counts", () => {
    const task = blockedTask({
      comments: [
        comment("unblocked by owner via foreman@mac-a", hoursAgo(6)),
        comment("blocked by builder: see #40", hoursAgo(4)),
      ],
    });
    const stale = closed({
      number: 39,
      stateReason: "NOT_PLANNED",
      createdAt: hoursAgo(8),
      closedAt: hoursAgo(7),
      comments: [],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [stale, closed()])).toEqual([
      { task: 5, itemId: "PVTI_5", pr: null, decisions: [{ number: 40, answer: "B — Use REST" }] },
    ]);
  });

  it("ignores a decision closed as a duplicate", () => {
    const s = snapshot({ issues: [blockedTask()] });
    const dup = closed({ number: 41, stateReason: "DUPLICATE", comments: [] });
    expect(planDecisionResumes(s, [closed(), dup])).toHaveLength(1);
  });

  it("does nothing without a Blocks line", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ body: "Options A/B, see #5" })])).toEqual([]);
  });

  it("does nothing when the task is not blocked, or not open in the snapshot", () => {
    expect(
      planDecisionResumes(snapshot({ issues: [blockedTask({ labels: ["phase:1"] })] }), [closed()]),
    ).toEqual([]);
    expect(planDecisionResumes(snapshot({ issues: [] }), [closed()])).toEqual([]);
  });

  it("waits while another open decision still blocks the same task", () => {
    const other = issue({ number: 41, labels: ["decision", "needs-owner"], body: "Blocks: #5" });
    const s = snapshot({ issues: [blockedTask(), other] });
    expect(planDecisionResumes(s, [closed()])).toEqual([]);
  });

  // The opened-after-last-unblock check also rejects this, so `decisionUnblocked` is the safety net.
  it("does not resume twice for the same decision", () => {
    const task = blockedTask({
      comments: [
        comment("blocked by builder: see #40", hoursAgo(4)),
        comment(fmt.decisionUnblocked("mac-a", 40, "B"), hoursAgo(0.5)),
      ],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });

  it("ignores a decision opened before the task was last unblocked", () => {
    // The owner pressed Unblock before settling; the task was later blocked for another reason.
    const task = blockedTask({
      comments: [
        comment("unblocked by owner via foreman@mac-a", hoursAgo(3)),
        comment("blocked by foreman@mac-a: fix rounds spent", hoursAgo(2)),
      ],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });

  it("resumes when the decision closed before the builder's session ended", () => {
    // The foreman writes `blocked by builder:` only when the session returns.
    const task = blockedTask({ comments: [comment("blocked by builder: see #40", hoursAgo(1))] });
    const d = closed({ createdAt: hoursAgo(3), closedAt: hoursAgo(2) });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [d])).toHaveLength(1);
  });

  it("waits while a role session still holds the claim on the blocked task", () => {
    const task = blockedTask({
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(4), "builder", 1), hoursAgo(4)),
        comment(
          fmt.session("11111111-1111-1111-1111-111111111111", "mac-a", "builder", 1),
          hoursAgo(4),
        ),
      ],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });

  it("folds two closed decisions for one task into one resume, lowest number first", () => {
    const s = snapshot({ issues: [blockedTask()] });
    const out = planDecisionResumes(s, [
      closed({ number: 42, comments: [comment("Settled: A")] }),
      closed(),
    ]);
    expect(out).toEqual([
      {
        task: 5,
        itemId: "PVTI_5",
        pr: null,
        decisions: [
          { number: 40, answer: "B — Use REST" },
          { number: 42, answer: "A" },
        ],
      },
    ]);
  });
});

describe("resumeSettledDecisions", () => {
  function fakeGh(closedDecisions: ClosedDecision[]) {
    const calls: string[] = [];
    const gh: DecisionGh = {
      listClosedDecisions: async (since) => {
        calls.push(`listClosedDecisions ${since}`);
        return closedDecisions;
      },
      removeLabels: async (kind, n, labels) => {
        calls.push(`removeLabels ${kind} ${n} ${labels.join(",")}`);
      },
      comment: async (kind, n, body) => {
        calls.push(`comment ${kind} ${n} ${body}`);
      },
      setStatus: async (itemId, status) => {
        calls.push(`setStatus ${itemId} ${status}`);
      },
      addToProject: async (n) => `PVTI_new_${n}`,
    };
    return { gh, calls };
  }

  it("reads nothing when no open issue is blocked", async () => {
    const { gh, calls } = fakeGh([closed()]);
    expect(await resumeSettledDecisions(gh, snapshot({ issues: [issue({ number: 5 })] }))).toEqual(
      [],
    );
    expect(calls).toEqual([]);
  });

  it("looks back seven days and unblocks with one ledger line per decision", async () => {
    const { gh, calls } = fakeGh([closed(), closed({ number: 42, comments: [] })]);
    const s = snapshot({ issues: [blockedTask()], prs: [pr({ number: 77, issue: 5 })] });
    expect(await resumeSettledDecisions(gh, s)).toEqual([5]);
    expect(calls).toEqual([
      "listClosedDecisions 2026-08-27",
      "comment issue 5 decision #40 settled: B — Use REST — unblocked by decision via foreman@mac-a",
      "comment issue 5 decision #42 closed; read it before continuing — unblocked by decision via foreman@mac-a",
      "removeLabels pr 77 reviewer:changes,validator:failed",
      "setStatus PVTI_5 Ready",
      "removeLabels issue 5 blocked",
    ]);
  });

  it("never removes `blocked` when setting Status Ready fails", async () => {
    const { gh, calls } = fakeGh([closed()]);
    const failingGh: DecisionGh = {
      ...gh,
      setStatus: async () => {
        throw new Error("gh rate limited");
      },
    };
    const s = snapshot({ issues: [blockedTask()], prs: [pr({ number: 77, issue: 5 })] });
    await expect(resumeSettledDecisions(failingGh, s)).rejects.toThrow("gh rate limited");
    expect(calls).toEqual([
      "listClosedDecisions 2026-08-27",
      "comment issue 5 decision #40 settled: B — Use REST — unblocked by decision via foreman@mac-a",
      "removeLabels pr 77 reviewer:changes,validator:failed",
    ]);
    expect(calls).not.toContain("removeLabels issue 5 blocked");
  });

  it("leaves the task blocked with the answer recorded when the unblock edits fail", async () => {
    const { gh, calls } = fakeGh([closed()]);
    const failingGh: DecisionGh = {
      ...gh,
      removeLabels: async () => {
        throw new Error("gh rate limited");
      },
    };
    const s = snapshot({ issues: [blockedTask()] });
    await expect(resumeSettledDecisions(failingGh, s)).rejects.toThrow("gh rate limited");
    expect(calls).toEqual([
      "listClosedDecisions 2026-08-27",
      "comment issue 5 decision #40 settled: B — Use REST — unblocked by decision via foreman@mac-a",
      "setStatus PVTI_5 Ready",
    ]);

    // The decision comment landed before the failed edits, so the task still carries the resume
    // line. A later tick must not resume it again from the same decision.
    const task = blockedTask({
      comments: [
        ...blockedTask().comments,
        comment(fmt.decisionUnblocked("mac-a", 40, "B — Use REST"), hoursAgo(0)),
      ],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });
});
