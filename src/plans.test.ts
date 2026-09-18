import { describe, expect, it } from "vitest";
import type { Exec } from "./exec.ts";
import { fetchOrigin, listPlanFilesOnMain, readPlanFileOnMain } from "./plans.ts";

function fakeExec(reply: (args: string[]) => { code: number; stdout?: string }): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const r = reply(args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("fetchOrigin", () => {
  it("fetches in the repo clone and reports success", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    expect(await fetchOrigin(exec, "/repo")).toBe(true);
    expect(calls[0]).toEqual(["-C", "/repo", "fetch", "origin", "--prune"]);
  });
  it("reports failure instead of throwing", async () => {
    const { exec } = fakeExec(() => ({ code: 128 }));
    expect(await fetchOrigin(exec, "/repo")).toBe(false);
  });
});

const PLAN_DIR = "docs/superpowers/plans";

describe("listPlanFilesOnMain", () => {
  it("lists only *.issues.json tracked on origin/main", async () => {
    const { exec, calls } = fakeExec(() => ({
      code: 0,
      stdout:
        "docs/superpowers/plans/2026-09-04-phase-01-plan.md\ndocs/superpowers/plans/2026-09-04-phase-01-plan.issues.json\n",
    }));
    expect(await listPlanFilesOnMain(exec, "/repo", PLAN_DIR, "origin/main")).toEqual([
      "docs/superpowers/plans/2026-09-04-phase-01-plan.issues.json",
    ]);
    expect(calls[0]).toContain("origin/main");
  });
  it("is empty when git fails", async () => {
    const { exec } = fakeExec(() => ({ code: 1 }));
    expect(await listPlanFilesOnMain(exec, "/repo", PLAN_DIR, "origin/main")).toEqual([]);
  });
});

describe("readPlanFileOnMain", () => {
  it("reads the file content from origin/main", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: '{"epic":1}' }));
    expect(await readPlanFileOnMain(exec, "/repo", "docs/p.issues.json", "origin/main")).toBe(
      '{"epic":1}',
    );
    expect(calls[0]).toEqual(["-C", "/repo", "show", "origin/main:docs/p.issues.json"]);
  });
  it("is null when the path is not on origin/main", async () => {
    const { exec } = fakeExec(() => ({ code: 128 }));
    expect(await readPlanFileOnMain(exec, "/repo", "docs/p.issues.json", "origin/main")).toBeNull();
  });
});
