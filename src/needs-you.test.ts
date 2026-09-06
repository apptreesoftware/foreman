import { describe, expect, it } from "vitest";
import { epic, hoursAgo, issue, snapshot } from "../test/helpers.ts";
import { applyUnblock, applyUnblockToBoard, needsYouItems, type UnblockGh } from "./needs-you.ts";
import type { Board } from "./state-file.ts";

const board = (over: Partial<Board> = {}): Board => ({
  at: "2026-09-03T12:00:00Z",
  waiting: [],
  pipeline: [],
  owner: [],
  needsYou: [],
  phases: [],
  explain: [],
  prs: [],
  ...over,
});

describe("needsYouItems", () => {
  it("lists open non-epic needs-owner, decision and blocked issues, oldest first", () => {
    const s = snapshot({
      issues: [
        issue({ number: 171, labels: ["needs-owner"], updatedAt: hoursAgo(2) }),
        issue({
          number: 165,
          title: "Decision: who owns .claude/**",
          labels: ["decision", "needs-owner"],
          updatedAt: hoursAgo(30),
        }),
        issue({ number: 5, labels: ["phase:1", "blocked"], updatedAt: hoursAgo(9) }),
        // Not waiting on a human at all.
        issue({ number: 6, labels: ["phase:1", "agent-ready"] }),
        // Epics have their own card; they must not appear twice.
        issue({ number: 10, labels: ["epic", "phase:1", "needs-owner"] }),
        // A closed issue is nobody's problem any more.
        issue({ number: 7, state: "CLOSED", labels: ["needs-owner"], updatedAt: hoursAgo(40) }),
      ],
      epics: [epic({ number: 10, phase: 1, labels: ["epic", "phase:1", "needs-owner"] })],
    });
    expect(needsYouItems(s)).toEqual([
      {
        issue: 165,
        title: "Decision: who owns .claude/**",
        labels: ["decision", "needs-owner"],
        since: hoursAgo(30),
        itemId: "PVTI_165",
      },
      { issue: 5, title: "Task 5", labels: ["blocked"], since: hoursAgo(9), itemId: "PVTI_5" },
      {
        issue: 171,
        title: "Task 171",
        labels: ["needs-owner"],
        since: hoursAgo(2),
        itemId: "PVTI_171",
      },
    ]);
  });
  it("carries a null itemId for an issue that is not on the project board", () => {
    const s = snapshot({ issues: [issue({ number: 8, labels: ["blocked"], itemId: null })] });
    expect(needsYouItems(s)[0]).toMatchObject({ issue: 8, itemId: null });
  });
});

describe("applyUnblock", () => {
  function fakeGh() {
    const calls: string[] = [];
    const gh: UnblockGh = {
      removeLabels: async (kind, n, labels) => {
        calls.push(`removeLabels ${kind} ${n} ${labels.join(",")}`);
      },
      comment: async (kind, n, body) => {
        calls.push(`comment ${kind} ${n} ${body}`);
      },
      setStatus: async (itemId, status) => {
        calls.push(`setStatus ${itemId} ${status}`);
      },
      addToProject: async (n) => {
        calls.push(`addToProject ${n}`);
        return `PVTI_new_${n}`;
      },
    };
    return { gh, calls };
  }

  it("drops the label, sets Status Ready and leaves a ledger comment", async () => {
    const { gh, calls } = fakeGh();
    const message = await applyUnblock(gh, { issue: 5, itemId: "PVTI_5", host: "mac-a" });
    expect(calls).toEqual([
      "removeLabels issue 5 blocked",
      "setStatus PVTI_5 Ready",
      "comment issue 5 unblocked by owner via foreman@mac-a",
    ]);
    expect(message).toContain("#5");
  });
  it("adds an off-board issue to the project first", async () => {
    const { gh, calls } = fakeGh();
    await applyUnblock(gh, { issue: 8, itemId: null, host: "mac-a" });
    expect(calls).toContain("addToProject 8");
    expect(calls).toContain("setStatus PVTI_new_8 Ready");
  });
});

describe("applyUnblockToBoard", () => {
  it("drops the row, its blocked wait item and the pipeline flag, and leaves the rest alone", () => {
    const b = board({
      needsYou: [
        { issue: 5, title: "Task 5", labels: ["blocked"], since: hoursAgo(9), itemId: "PVTI_5" },
        {
          issue: 171,
          title: "Task 171",
          labels: ["needs-owner"],
          since: hoursAgo(2),
          itemId: null,
        },
      ],
      waiting: [
        { kind: "human", subject: "#5", detail: "#5 blocked: migration conflicts", since: null },
        { kind: "human", subject: "#5", detail: "#5 needs owner: Task 5", since: null },
        { kind: "human", subject: "#171", detail: "#171 needs owner: Task 171", since: null },
      ],
      pipeline: [
        {
          issue: 5,
          title: "Task 5",
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
          blocked: true,
          model: null,
        },
      ],
    });
    const after = applyUnblockToBoard(b, 5);
    expect(after.needsYou.map((n) => n.issue)).toEqual([171]);
    expect(after.waiting.map((w) => w.detail)).toEqual([
      "#5 needs owner: Task 5",
      "#171 needs owner: Task 171",
    ]);
    expect(after.pipeline[0]?.blocked).toBe(false);
  });
  it("is a no-op for an issue the board does not list", () => {
    const b = board({ needsYou: [] });
    expect(applyUnblockToBoard(b, 5)).toBe(b);
  });
});
