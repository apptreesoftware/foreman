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
const REF = "origin/main";

describe("listPlanFilesOnMain", () => {
  it("lists only *.issues.json tracked on the given ref", async () => {
    const { exec, calls } = fakeExec(() => ({
      code: 0,
      stdout:
        "docs/superpowers/plans/2026-09-04-phase-01-plan.md\ndocs/superpowers/plans/2026-09-04-phase-01-plan.issues.json\n",
    }));
    expect(await listPlanFilesOnMain(exec, "/repo", PLAN_DIR, REF)).toEqual([
      "docs/superpowers/plans/2026-09-04-phase-01-plan.issues.json",
    ]);
    expect(calls[0]).toContain(REF);
  });
  it("is empty when git fails", async () => {
    const { exec } = fakeExec(() => ({ code: 1 }));
    expect(await listPlanFilesOnMain(exec, "/repo", PLAN_DIR, REF)).toEqual([]);
  });
  it("passes the ref through raw, without adding an origin/ prefix of its own", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "" }));
    await listPlanFilesOnMain(exec, "/repo", PLAN_DIR, "origin/trunk");
    expect(calls[0]).toContain("origin/trunk");
    expect(calls[0]).not.toContain("origin/origin/trunk");
  });
});

describe("readPlanFileOnMain", () => {
  it("reads the file content at the given ref", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: '{"epic":1}' }));
    expect(await readPlanFileOnMain(exec, "/repo", "docs/p.issues.json", REF)).toBe('{"epic":1}');
    expect(calls[0]).toEqual(["-C", "/repo", "show", `${REF}:docs/p.issues.json`]);
  });
  it("is null when the path is not at that ref", async () => {
    const { exec } = fakeExec(() => ({ code: 128 }));
    expect(await readPlanFileOnMain(exec, "/repo", "docs/p.issues.json", REF)).toBeNull();
  });
  it("passes a non-origin ref through raw", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: "x" }));
    await readPlanFileOnMain(exec, "/repo", "docs/p.issues.json", "origin/trunk");
    expect(calls[0]).toEqual(["-C", "/repo", "show", "origin/trunk:docs/p.issues.json"]);
  });
});
