import { describe, expect, it } from "vitest";
import type { Board, PhaseProgress, PipelineRow } from "./state-file.ts";
import { applyTaskEffort, applyTaskEffortToBoard } from "./task-effort.ts";

function fakeGh() {
  const calls: string[] = [];
  return {
    calls,
    gh: {
      addLabels: async (kind: string, n: number, labels: string[]) => {
        calls.push(`add ${kind} ${n} ${labels.join(",")}`);
      },
      removeLabels: async (kind: string, n: number, labels: string[]) => {
        calls.push(`remove ${kind} ${n} ${labels.join(",")}`);
      },
    },
  };
}

const phase = (over: Partial<PhaseProgress> = {}): PhaseProgress => ({
  epic: 10,
  phase: 1,
  title: "Phase 1",
  tasksDone: 0,
  tasksTotal: 2,
  spendUsd: 0,
  sessions: 0,
  medianMergeMinutes: null,
  mergedTasks: 0,
  tasks: [
    { issue: 101, title: "One", status: "Ready", closed: false, model: null, effort: null },
    { issue: 102, title: "Two", status: "In Progress", closed: false, model: null, effort: "low" },
  ],
  ...over,
});

const row = (over: Partial<PipelineRow> = {}): PipelineRow => ({
  issue: 102,
  title: "Two",
  phase: 1,
  status: "In Progress",
  pr: null,
  stages: { build: "active", review: "pending", validate: "pending", ci: "none", merge: "pending" },
  claim: null,
  fixRound: 1,
  blocked: false,
  model: null,
  effort: "low",
  ...over,
});

const board = (over: Partial<Board> = {}): Board => ({
  at: "2026-09-05T10:00:00Z",
  waiting: [],
  pipeline: [row()],
  owner: [],
  needsYou: [],
  phases: [phase()],
  issues: [],
  groups: [],
  explain: [],
  prs: [],
  ...over,
});

describe("applyTaskEffort", () => {
  it("removes the label it is replacing before adding the new one", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyTaskEffort(gh, { issue: 102, current: "low" }, "max");
    expect(calls).toEqual(["remove issue 102 effort:low", "add issue 102 effort:max"]);
    expect(msg).toContain("#102");
    expect(msg).toContain("max");
  });
  it("only adds when there was no label", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskEffort(gh, { issue: 101, current: null }, "low");
    expect(calls).toEqual(["add issue 101 effort:low"]);
  });
  it("choosing high removes the label, since no label means high", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyTaskEffort(gh, { issue: 102, current: "max" }, "high");
    expect(calls).toEqual(["remove issue 102 effort:max"]);
    expect(msg).toContain("default");
  });
  it("choosing high on an unlabelled task touches GitHub not at all", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskEffort(gh, { issue: 101, current: null }, "high");
    expect(calls).toEqual([]);
  });
  it("setting the effort it already has touches GitHub not at all", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskEffort(gh, { issue: 102, current: "low" }, "low");
    expect(calls).toEqual([]);
  });
  it("`default` only removes, and says the default effort is back in charge", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyTaskEffort(gh, { issue: 102, current: "low" }, "default");
    expect(calls).toEqual(["remove issue 102 effort:low"]);
    expect(msg).toContain("default high");
  });
  it("`default` with nothing to remove touches GitHub not at all", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskEffort(gh, { issue: 101, current: null }, "default");
    expect(calls).toEqual([]);
  });
});

describe("applyTaskEffortToBoard", () => {
  it("updates the task row and the matching pipeline row so the page reflects the click now", () => {
    const b = applyTaskEffortToBoard(board(), 102, "max");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 102)?.effort).toBe("max");
    expect(b.pipeline[0]?.effort).toBe("max");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 101)?.effort).toBeNull();
  });
  it("high clears the label too, since no label means high", () => {
    const b = applyTaskEffortToBoard(board(), 102, "high");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 102)?.effort).toBeNull();
    expect(b.pipeline[0]?.effort).toBeNull();
  });
  it("`default` clears the label", () => {
    const b = applyTaskEffortToBoard(board(), 102, "default");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 102)?.effort).toBeNull();
    expect(b.pipeline[0]?.effort).toBeNull();
  });
});
