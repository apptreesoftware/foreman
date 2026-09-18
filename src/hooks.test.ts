import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realExec } from "./exec.ts";
import { hookPath, parsePreflight, parseSessionEnv, runHook } from "./hooks.ts";

const repoDir = join(import.meta.dirname, "../test/fixtures/repo");
const base = { instance: "widgets", stateDir: "/tmp/state", repoDir };

describe("runHook", () => {
  it("resolves <repoDir>/.foreman/hooks/<name>", () => {
    expect(hookPath("/r", "preflight")).toBe("/r/.foreman/hooks/preflight");
  });
  it("a missing hook is ran:false, code 0", async () => {
    const r = await runHook(
      "preflight",
      "/",
      { ...base, repoDir: mkdtempSync(join(tmpdir(), "nohooks-")) },
      realExec,
    );
    expect(r).toMatchObject({ ran: false, code: 0 });
  });
  it("passes FOREMAN_* in the environment and captures both streams", async () => {
    const r = await runHook("preflight", repoDir, base, realExec);
    expect(r.ran).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("warn: fixture warning");
  });
  it("session hooks see role, issue and worktree", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    const r = await runHook(
      "before-session",
      wt,
      { ...base, role: "builder", issue: 12, worktree: wt, pr: null, round: 1 },
      realExec,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(wt, ".before-ran"), "utf8").trim()).toBe(`builder 12 ${wt}`);
  });
  it("times out and reports it", async () => {
    const r = await runHook("preflight", repoDir, base, async () => new Promise(() => {}), {
      timeoutMs: 50,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
  it("logs one line per run when a logger is given", async () => {
    const lines: string[] = [];
    // ctx.worktree must exist: the fixture after-session hook writes to $FOREMAN_WORKTREE/.after-ran,
    // and a run that fails would log code!=0, defeating the point of this assertion.
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    await runHook("after-session", wt, { ...base, worktree: wt }, realExec, {
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("after-session") && l.includes("code=0"))).toBe(true);
  });
});

describe("parsePreflight", () => {
  it("exit 0 is ok, with warn: lines as warnings", () => {
    expect(
      parsePreflight({
        ran: true,
        code: 0,
        stdout: "warn: a\nnoise\nwarn: b\n",
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({ ok: true, warnings: ["a", "b"] });
  });
  it("non-zero parks with the last non-empty stderr line", () => {
    expect(
      parsePreflight({
        ran: true,
        code: 3,
        stdout: "",
        stderr: "first line\nfixture says no\n\n",
        timedOut: false,
      }),
    ).toEqual({ ok: false, reason: "fixture says no" });
  });
  it("non-zero with empty stderr still parks, naming the code", () => {
    expect(parsePreflight({ ran: true, code: 2, stdout: "", stderr: "", timedOut: false })).toEqual(
      { ok: false, reason: "preflight hook exited 2" },
    );
  });
  it("a missing hook is ok with no warnings", () => {
    expect(
      parsePreflight({ ran: false, code: 0, stdout: "", stderr: "", timedOut: false }),
    ).toEqual({ ok: true, warnings: [] });
  });
  it("a timeout parks", () => {
    expect(
      parsePreflight({ ran: true, code: 124, stdout: "", stderr: "", timedOut: true }).ok,
    ).toBe(false);
  });
});

describe("parseSessionEnv", () => {
  it("splits KEY=VALUE lines from prompt: lines and drops the rest", async () => {
    const r = await runHook(
      "session-env",
      repoDir,
      { ...base, role: "validator", issue: 1, worktree: "/w", pr: 2, round: 1 },
      realExec,
    );
    expect(parseSessionEnv(r)).toEqual({
      env: { APP_PORT: "8182", ROLE: "validator" },
      promptLines: ["Local URLs: web http://localhost:8182", "second line"],
    });
  });
  it("values may contain '='", () => {
    expect(
      parseSessionEnv({
        ran: true,
        code: 0,
        stdout: "URL=http://x?a=b\n",
        stderr: "",
        timedOut: false,
      }).env,
    ).toEqual({ URL: "http://x?a=b" });
  });
  it("a missing hook yields nothing", () => {
    expect(
      parseSessionEnv({ ran: false, code: 0, stdout: "", stderr: "", timedOut: false }),
    ).toEqual({ env: {}, promptLines: [] });
  });
});
