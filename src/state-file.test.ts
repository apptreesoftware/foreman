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
