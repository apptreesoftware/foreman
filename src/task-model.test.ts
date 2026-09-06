import { describe, expect, it } from "vitest";
import type { Board, PhaseProgress, PipelineRow } from "./state-file.ts";
import { applyTaskModel, applyTaskModelToBoard, phaseTasks } from "./task-model.ts";

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
  tasksDone: 1,
  tasksTotal: 3,
  spendUsd: 0,
  sessions: 0,
  medianMergeMinutes: null,
  mergedTasks: 0,
  tasks: [
    { issue: 101, title: "One", status: "Ready", closed: false, model: null },
    { issue: 102, title: "Two", status: "In Progress", closed: false, model: "sonnet" },
    { issue: 103, title: "#103", status: null, closed: true, model: null },
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
  model: "sonnet",
  ...over,
});

const board = (over: Partial<Board> = {}): Board => ({
  at: "2026-09-05T10:00:00Z",
  waiting: [],
  pipeline: [row()],
  owner: [],
  needsYou: [],
  phases: [phase()],
  explain: [],
  prs: [],
  ...over,
});

describe("phaseTasks", () => {
  it("flattens the open tasks of every phase on the board; a closed task takes no label", () => {
    expect(phaseTasks(board()).map((t) => t.issue)).toEqual([101, 102]);
    expect(phaseTasks(null)).toEqual([]);
  });
});

describe("applyTaskModel", () => {
  it("removes the label it is replacing before adding the new one", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyTaskModel(gh, { issue: 102, current: "sonnet" }, "haiku");
    expect(calls).toEqual(["remove issue 102 model:sonnet", "add issue 102 model:haiku"]);
    expect(msg).toContain("#102");
    expect(msg).toContain("haiku");
  });
  it("only adds when there was no override", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskModel(gh, { issue: 101, current: null }, "sonnet");
    expect(calls).toEqual(["add issue 101 model:sonnet"]);
  });
  it("`default` only removes, and says the global model is back in charge", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyTaskModel(gh, { issue: 102, current: "sonnet" }, "default");
    expect(calls).toEqual(["remove issue 102 model:sonnet"]);
    expect(msg).toContain("global");
  });
  it("`default` with nothing to remove touches GitHub not at all", async () => {
    const { gh, calls } = fakeGh();
    await applyTaskModel(gh, { issue: 101, current: null }, "default");
    expect(calls).toEqual([]);
  });
});

describe("applyTaskModelToBoard", () => {
  it("updates the task row and the matching pipeline row so the page reflects the click now", () => {
    const b = applyTaskModelToBoard(board(), 102, "haiku");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 102)?.model).toBe("haiku");
    expect(b.pipeline[0]?.model).toBe("haiku");
    // Other rows are untouched.
    expect(b.phases[0]?.tasks.find((t) => t.issue === 101)?.model).toBeNull();
  });
  it("`default` clears the override", () => {
    const b = applyTaskModelToBoard(board(), 102, "default");
    expect(b.phases[0]?.tasks.find((t) => t.issue === 102)?.model).toBeNull();
    expect(b.pipeline[0]?.model).toBeNull();
  });
});
