import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialState, readState, StateStore, statePath, writeState } from "./state-file.ts";

const base = () =>
  initialState({
    pid: 123,
    host: "mac-a",
    configPath: "/c/foreman.json",
    dryRun: false,
    startedAt: "2026-09-03T12:00:00.000Z",
  });

describe("state file", () => {
  it("round-trips through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    writeState(dir, base());
    expect(readState(dir)).toEqual(base());
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
  });
  it("a torn temp file never replaces the good file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    writeState(dir, base());
    writeFileSync(`${statePath(dir)}.tmp`, "{not json, torn write");
    expect(readState(dir)).toEqual(base());
  });
  it("returns null when missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    expect(readState(dir)).toBeNull();
    writeFileSync(statePath(dir), "{not json");
    expect(readState(dir)).toBeNull();
    writeFileSync(statePath(dir), JSON.stringify({ version: 2 }));
    expect(readState(dir)).toBeNull();
  });
  it("a state file written before the model override parses with model null", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    const { model: _absent, ...old } = base();
    writeFileSync(statePath(dir), JSON.stringify(old));
    expect(readState(dir)?.model).toBeNull();
  });
  it("a stored board whose rows predate per-task effort parses with effort null", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    const stages = {
      build: "done",
      review: "pending",
      validate: "pending",
      ci: "none",
      merge: "pending",
    };
    const board = {
      at: "2026-09-03T12:00:00.000Z",
      waiting: [],
      pipeline: [
        {
          issue: 1,
          title: "t",
          phase: 1,
          status: null,
          pr: null,
          stages,
          claim: null,
          fixRound: 1,
          blocked: false,
          model: null,
        },
      ],
      phases: [
        {
          epic: 9,
          phase: 1,
          title: "p",
          tasksDone: 0,
          tasksTotal: 1,
          spendUsd: 0,
          sessions: 0,
          medianMergeMinutes: null,
          mergedTasks: 0,
          tasks: [{ issue: 1, title: "t", status: null, closed: false, model: null }],
        },
      ],
      explain: [],
      prs: [],
    };
    writeFileSync(statePath(dir), JSON.stringify({ ...base(), board }));
    const s = readState(dir);
    expect(s).not.toBeNull();
    expect(s?.board?.pipeline[0]?.effort).toBeNull();
    expect(s?.board?.phases[0]?.tasks[0]?.effort).toBeNull();
    // Written before the Board tab: no issues or groups, which read as empty.
    expect(s?.board?.issues).toEqual([]);
    expect(s?.board?.groups).toEqual([]);
  });
  it("StateStore.patch merges and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    const store = new StateStore(dir, base());
    store.patch({ lastPlan: ["plan#10"], consecutiveFailures: 2 });
    expect(store.get().lastPlan).toEqual(["plan#10"]);
    const onDisk = JSON.parse(readFileSync(statePath(dir), "utf8"));
    expect(onDisk.consecutiveFailures).toBe(2);
    expect(onDisk.pid).toBe(123);
  });
  it("initialState has every field the readers expect", () => {
    const s = base();
    expect(s).toMatchObject({
      version: 1,
      exitedAt: null,
      lastTickAt: null,
      nextTickAt: null,
      consecutiveFailures: 0,
      lastPreflight: null,
      lastPlan: null,
      current: null,
      stopping: null,
      unfinished: null,
    });
  });
});

describe("schema v1 additions", () => {
  it("reads a pre-#178 state file: activity and board default to null", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-state-"));
    const old = {
      ...initialState({
        pid: 1,
        host: "h",
        configPath: "/c",
        dryRun: false,
        startedAt: "2026-09-04T00:00:00.000Z",
      }),
      current: {
        issue: 1,
        title: "t",
        role: "builder",
        pr: null,
        round: 1,
        attempt: 1,
        sessionId: "s",
        resume: false,
        worktree: "/w",
        branch: "b",
        childPid: null,
        startedAt: "2026-09-04T00:00:00.000Z",
        deadlineAt: "2026-09-04T01:00:00.000Z",
      },
    } as Record<string, unknown>;
    delete old.board;
    writeFileSync(join(dir, "state.json"), JSON.stringify(old));
    const s = readState(dir);
    expect(s?.board).toBeNull();
    expect(s?.current?.activity).toBeNull();
  });
});
