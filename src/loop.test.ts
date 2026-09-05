import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import type { Spawner } from "./dispatch.ts";
import type { Exec } from "./exec.ts";
import type { GitHubApi } from "./github.ts";
import { fmt } from "./ledger.ts";
import {
  ACTIVITY_FLUSH_MS,
  type Ctx,
  ensureLogin,
  execute,
  MAX_BACKOFF_SECONDS,
  runForever,
  runOnce,
} from "./loop.ts";
import type { Issue } from "./types.ts";

const cfg = parseConfig(
  JSON.stringify({
    repo: "o/r",
    project: 2,
    host: "mac-a",
    repoDir: "/repo",
    workDir: "/work",
    slackUser: "m",
    wallClockMinutes: 1,
  }),
);

function fakeGh(issues: Issue[]) {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push(`${name} ${a.map(String).join(" ")}`);
    };
  const gh: GitHubApi = {
    dryRun: false,
    listIssues: async () => issues,
    getIssue: async (n) => issues.find((i) => i.number === n) as Issue,
    listOpenPRs: async () => [],
    subIssues: async () => [],
    branchLastCommitAt: async () => null,
    setStatus: rec("setStatus"),
    addToProject: async () => "PVTI_new",
    comment: rec("comment"),
    addLabels: rec("addLabels"),
    removeLabels: rec("removeLabels"),
    assign: rec("assign"),
    unassign: rec("unassign"),
    editBody: rec("editBody"),
    closeIssue: rec("closeIssue"),
    mergePR: rec("mergePR"),
    createIssue: async () => 999,
    addSubIssue: rec("addSubIssue"),
    viewerLogin: async () => "matthewtsmith",
  };
  return { gh, calls };
}

const okSpawn =
  (outcome: object): Spawner =>
  async () => ({
    code: 0,
    timedOut: false,
    interrupted: false,
    stderr: "",
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.5,
      duration_ms: 100,
      session_id: "s",
      result: "x",
      structured_output: outcome,
    }),
  });

function ctx(over: Partial<Ctx>): Ctx {
  const { gh } = fakeGh([]);
  return {
    cfg,
    gh,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: okSpawn({ outcome: "pr_opened", pr: 5, notes: "" }),
    dryRun: false,
    stateDir: "/tmp/tt-test",
    readFile: () => null,
    planFiles: async () => [],
    readPlanFile: async () => null,
    login: "matthewtsmith",
    ensureWorktree: async () => "/work/1",
    removeWorktree: async () => {},
    transcriptExists: () => true,
    artifactsDir: "/tmp/tt-test/artifacts",
    copyDir: async () => {},
    now: () => "2026-09-03T12:00:00Z",
    signal: new AbortController().signal,
    stopMode: () => null,
    state: null,
    ...over,
  };
}

function memState() {
  let s: Record<string, unknown> = {};
  return {
    patches: [] as Partial<Record<string, unknown>>[],
    store: {
      get: () => s as never,
      patch: (p: Record<string, unknown>) => {
        s = { ...s, ...p };
        return s as never;
      },
    },
    get: () => s,
  };
}

// A worktree holding `.validation-artifacts/<pr>/<name>` and an empty artifacts destination,
// both under one temp dir the caller removes.
async function artifactFixture(pr: number, name: string) {
  const tmp = await mkdtemp(join(tmpdir(), "tt-artifacts-"));
  const worktree = join(tmp, "wt");
  const artifactsDir = join(tmp, "artifacts");
  await mkdir(join(worktree, ".validation-artifacts", String(pr)), { recursive: true });
  await writeFile(join(worktree, ".validation-artifacts", String(pr), name), "png");
  return { tmp, worktree, artifactsDir };
}

describe("execute", () => {
  it("reuses the tick's snapshot instead of re-reading the issue", async () => {
    const i = issue({ number: 1, status: "In Review" });
    const { gh } = fakeGh([i]);
    let reads = 0;
    const counting = {
      ...gh,
      getIssue: async (n: number) => {
        reads += 1;
        return gh.getIssue(n);
      },
    };
    await execute(
      { type: "merge", pr: 9, issue: 1 },
      ctx({ gh: counting }),
      snapshot({ issues: [i] }),
    );
    expect(reads).toBe(0);
    // Without a snapshot it still works, at the cost of one single-issue read.
    await execute({ type: "merge", pr: 9, issue: 1 }, ctx({ gh: counting }));
    expect(reads).toBe(1);
  });
  it("merge: merges, comments, closes, marks Done, removes worktree", async () => {
    const i = issue({ number: 1, status: "In Review" });
    const { gh, calls } = fakeGh([i]);
    let removed = false;
    const r = await execute(
      { type: "merge", pr: 9, issue: 1 },
      ctx({
        gh,
        removeWorktree: async () => {
          removed = true;
        },
      }),
    );
    expect(r).toBe("continue");
    expect(calls).toEqual(
      expect.arrayContaining([
        "mergePR 9",
        `comment issue 1 ${fmt.merged("mac-a")}`,
        "closeIssue 1",
        "setStatus PVTI_1 Done",
      ]),
    );
    expect(removed).toBe(true);
  });
  it("claim: comments, assigns, sets In Progress, dispatches, applies pr_opened", async () => {
    const i = issue({ number: 1 });
    const { gh, calls } = fakeGh([i]);
    const r = await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({ gh }),
    );
    expect(r).toBe("stop");
    expect(calls[0]).toMatch(/^comment issue 1 claimed by mac-a at \S+ role=builder round=1$/);
    expect(calls).toContain("assign 1 matthewtsmith");
    expect(calls).toContain("setStatus PVTI_1 In Progress");
    expect(
      calls.some((c) =>
        /^comment issue 1 session [0-9a-f-]{36} on mac-a role=builder attempt=1$/.test(c),
      ),
    ).toBe(true);
    expect(
      calls.some((c) =>
        c.startsWith("comment issue 1 session s finished on mac-a: outcome=pr_opened"),
      ),
    ).toBe(true);
    expect(calls).toContain("setStatus PVTI_1 In Review");
  });
  it("claim: releases on conflict with an alphabetically earlier host", async () => {
    const i = issue({
      number: 1,
      comments: [comment(fmt.claimed("mac-0", hoursAgo(0), "builder", 1))],
    });
    const { gh, calls } = fakeGh([i]);
    let spawned = false;
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        spawn: async () => {
          spawned = true;
          return { code: 1, stdout: "", stderr: "", timedOut: false, interrupted: false };
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(calls).toContain(`comment issue 1 ${fmt.released("mac-a", "conflict")}`);
    expect(calls).toContain("unassign 1 matthewtsmith");
  });
  it("outcomes map to labels", async () => {
    const cases: Array<[object, string[]]> = [
      [{ outcome: "approved", pr: 9, notes: "" }, ["addLabels pr 9 reviewer:approved"]],
      [{ outcome: "changes_requested", pr: 9, notes: "" }, ["addLabels pr 9 reviewer:changes"]],
      [{ outcome: "passed", pr: 9, notes: "" }, ["addLabels pr 9 validator:passed"]],
      [{ outcome: "failed", pr: 9, notes: "" }, ["addLabels pr 9 validator:failed"]],
      [
        { outcome: "blocked", pr: null, notes: "why" },
        ["addLabels issue 1 blocked", "unassign 1 matthewtsmith"],
      ],
    ];
    for (const [outcome, expected] of cases) {
      const { gh, calls } = fakeGh([issue({ number: 1, status: "In Review" })]);
      await execute(
        { type: "claim", issue: 1, role: "reviewer", pr: 9, round: 1 },
        ctx({ gh, spawn: okSpawn(outcome) }),
      );
      for (const e of expected) expect(calls, JSON.stringify(outcome)).toContain(e);
    }
  });
  it("copies the validator's worktree artifacts to the artifacts dir on passed and failed", async () => {
    for (const outcome of ["passed", "failed"] as const) {
      const { tmp, worktree, artifactsDir } = await artifactFixture(9, "01-health.png");
      const { gh, calls } = fakeGh([issue({ number: 1, status: "In Review" })]);
      await execute(
        { type: "claim", issue: 1, role: "validator", pr: 9, round: 1 },
        ctx({
          gh,
          spawn: okSpawn({ outcome, pr: 9, notes: "" }),
          ensureWorktree: async () => worktree,
          artifactsDir,
          copyDir: async (src, dest) => {
            await cp(src, dest, { recursive: true, force: true });
          },
        }),
      );
      expect(existsSync(join(artifactsDir, "9", "01-health.png")), outcome).toBe(true);
      expect(calls, outcome).toContain(`addLabels pr 9 validator:${outcome}`);
      await rm(tmp, { recursive: true, force: true });
    }
  });
  it("skips the artifact copy when the validator left no artifacts directory", async () => {
    const { gh } = fakeGh([issue({ number: 1, status: "In Review" })]);
    let copied = 0;
    await execute(
      { type: "claim", issue: 1, role: "validator", pr: 9, round: 1 },
      ctx({
        gh,
        spawn: okSpawn({ outcome: "passed", pr: 9, notes: "" }),
        ensureWorktree: async () => join(tmpdir(), "tt-does-not-exist"),
        copyDir: async () => {
          copied += 1;
        },
      }),
    );
    expect(copied).toBe(0);
  });
  it("fix round clears the request labels before dispatch", async () => {
    const { gh, calls } = fakeGh([issue({ number: 1, status: "In Review" })]);
    await execute({ type: "claim", issue: 1, role: "builder", pr: 9, round: 2 }, ctx({ gh }));
    expect(calls).toContain("removeLabels pr 9 reviewer:changes,validator:failed");
  });
  it("exhausted retries block the issue with a log excerpt", async () => {
    const { gh, calls } = fakeGh([issue({ number: 1 })]);
    const spawn: Spawner = async () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
      timedOut: true,
      interrupted: false,
    });
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({ gh, spawn }),
    );
    expect(calls).toContain("addLabels issue 1 blocked");
    expect(
      calls.some(
        (c) => c.startsWith("comment issue 1 blocked by foreman@mac-a") && c.includes("boom"),
      ),
    ).toBe(true);
  });
  it("resume uses the old session id when the transcript exists, else a new one", async () => {
    const seen: string[][] = [];
    const spawn: Spawner = async (_c, args) => {
      seen.push(args);
      return okSpawn({ outcome: "pr_opened", pr: 5, notes: "" })("claude", args, {
        cwd: "",
        env: {},
        input: "",
        timeoutMs: 1,
      });
    };
    const sid = "44444444-4444-4444-4444-444444444444";
    const { gh } = fakeGh([issue({ number: 1, status: "In Progress" })]);
    await execute(
      { type: "resume", issue: 1, role: "builder", sessionId: sid, pr: null },
      ctx({ gh, spawn, transcriptExists: () => true }),
    );
    expect(seen[0]?.join(" ")).toContain(`--resume ${sid}`);
    await execute(
      { type: "resume", issue: 1, role: "builder", sessionId: sid, pr: null },
      ctx({ gh, spawn, transcriptExists: () => false }),
    );
    expect(seen[1]?.join(" ")).not.toContain("--resume");
    expect(seen[1]?.join(" ")).toContain("--session-id");
  });
  it("plan claims the epic visibly: assign, In Progress, then hand it back to the owner", async () => {
    const { gh, calls } = fakeGh([
      issue({ number: 200, labels: ["epic", "phase:2", "agent-ready"], status: "Backlog" }),
    ]);
    await execute(
      { type: "plan", epic: 200 },
      ctx({ gh, spawn: okSpawn({ outcome: "plan_drafted", pr: 7, notes: "" }) }),
    );
    expect(calls).toContain("assign 200 matthewtsmith");
    expect(calls).toContain("setStatus PVTI_200 In Progress");
    expect(calls).toContain("setStatus PVTI_200 In Review");
    expect(calls).toContain("addLabels issue 200 needs-owner");
    expect(calls).toContain("removeLabels issue 200 agent-ready");
    expect(calls).toContain("unassign 200 matthewtsmith");
  });
  it("phase_close does not move the epic to In Progress", async () => {
    const { gh, calls } = fakeGh([
      issue({ number: 200, labels: ["epic", "phase:2", "plan-approved"], status: "In Progress" }),
    ]);
    await execute(
      { type: "phase_close", epic: 200 },
      ctx({ gh, spawn: okSpawn({ outcome: "phase_closed", pr: null, notes: "" }) }),
    );
    expect(calls).not.toContain("setStatus PVTI_200 In Progress");
    expect(calls).toContain("setStatus PVTI_200 In Review");
    expect(calls).toContain("addLabels issue 200 needs-owner");
  });
  it("apply_plan leaves the epic alone when the plan is not on origin/main yet", async () => {
    const { gh, calls } = fakeGh([
      issue({ number: 200, labels: ["epic", "phase:2", "plan-approved"] }),
    ]);
    const r = await execute(
      { type: "apply_plan", epic: 200 },
      ctx({ gh, planFiles: async () => [], readPlanFile: async () => null }),
    );
    expect(r).toBe("continue");
    // No `plan applied` comment: planApplied() would read it as done and the epic would never
    // get its tasks. The next tick retries instead (#189).
    expect(calls).toEqual([]);
  });
  it("apply_plan fetches origin before reading the plan", async () => {
    const gitCalls: string[][] = [];
    const { gh } = fakeGh([
      issue({
        number: 200,
        labels: ["epic", "phase:2", "plan-approved"],
        body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
      }),
    ]);
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({
        gh,
        exec: async (_c, args) => {
          gitCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
        planFiles: async () => [],
        readPlanFile: async () => null,
      }),
    );
    expect(gitCalls[0]).toEqual(["-C", "/repo", "fetch", "origin", "--prune"]);
  });
  it("apply_plan creates and updates tasks then labels them agent-ready", async () => {
    const existing = issue({ number: 201, labels: ["phase:2"], status: "Backlog" });
    const { gh, calls } = fakeGh([
      issue({
        number: 200,
        labels: ["epic", "phase:2", "plan-approved"],
        body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
      }),
      existing,
    ]);
    const file = JSON.stringify({
      epic: 200,
      tasks: [
        { number: 201, title: "t1", body: "b1", labels: ["phase:2", "size:S"] },
        { title: "t2", body: "b2", labels: ["phase:2", "size:M"] },
      ],
    });
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({
        gh,
        planFiles: async () => ["docs/superpowers/plans/2026-09-10-phase-02-plan.issues.json"],
        readPlanFile: async (p) => (p.endsWith("plan.issues.json") ? file : null),
      }),
    );
    expect(calls).toContain("editBody 201 b1");
    expect(calls).toContain("addLabels issue 201 phase:2,size:S,agent-ready");
    expect(calls).toContain("addSubIssue 200 999");
    expect(calls).toContain("addLabels issue 999 phase:2,size:M,agent-ready");
    expect(calls).toContain("setStatus PVTI_201 Ready");
    expect(calls).toContain(`comment issue 200 ${fmt.planApplied("mac-a")}`);
    expect(calls).toContain("removeLabels issue 200 needs-owner");
    expect(calls).toContain("setStatus PVTI_200 In Progress");
  });
  it("apply_plan reads the board once, not once per task", async () => {
    const { gh } = fakeGh([
      issue({
        number: 200,
        labels: ["epic", "phase:2", "plan-approved"],
        body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
      }),
      issue({ number: 201, labels: ["phase:2"] }),
      issue({ number: 202, labels: ["phase:2"] }),
      issue({ number: 203, labels: ["phase:2"] }),
    ]);
    let listCalls = 0;
    const counting = {
      ...gh,
      listIssues: async (...a: Parameters<typeof gh.listIssues>) => {
        listCalls += 1;
        return gh.listIssues(...a);
      },
    };
    const file = JSON.stringify({
      epic: 200,
      tasks: [201, 202, 203].map((n) => ({
        number: n,
        title: `t${n}`,
        body: `b${n}`,
        labels: ["phase:2"],
      })),
    });
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({
        gh: counting,
        planFiles: async () => ["docs/superpowers/plans/2026-09-10-phase-02-plan.issues.json"],
        readPlanFile: async () => file,
      }),
    );
    expect(listCalls).toBe(1);
  });
  it("dry-run writes nothing and does not spawn", async () => {
    const { gh, calls } = fakeGh([issue({ number: 1 })]);
    let spawned = false;
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        dryRun: true,
        spawn: async () => {
          spawned = true;
          return { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false };
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ensureLogin", () => {
  it("leaves login empty on failure, sets it on a later success, and never re-fetches once set", async () => {
    let calls = 0;
    const gh: GitHubApi = {
      ...fakeGh([]).gh,
      viewerLogin: async () => {
        calls++;
        if (calls === 1) throw new Error("not authenticated");
        return "matthewtsmith";
      },
    };
    const c = ctx({ gh, login: "" });

    await ensureLogin(c);
    expect(c.login).toBe("");
    expect(calls).toBe(1);

    await ensureLogin(c);
    expect(c.login).toBe("matthewtsmith");
    expect(calls).toBe(2);

    await ensureLogin(c);
    expect(c.login).toBe("matthewtsmith");
    expect(calls).toBe(2);
  });
});

describe("runForever backoff", () => {
  // Drives runForever with an injected sleep that records each delay and aborts the
  // otherwise-infinite loop once the iteration outcomes under test are exhausted.
  async function delaysFor(outcomes: ("ok" | "fail")[]): Promise<number[]> {
    const seconds: number[] = [];
    let n = 0;
    const stop = new Error("stop");
    await expect(
      runForever(ctx({}), {
        iterate: async () => {
          if (outcomes[n++] === "fail") throw new Error("gh: API rate limit exceeded");
          return { dispatched: false };
        },
        sleep: async (ms) => {
          seconds.push(ms / 1000);
          if (n >= outcomes.length) throw stop;
        },
      }),
    ).rejects.toThrow("stop");
    return seconds;
  }

  it("sleeps one poll interval between successful iterations", async () => {
    expect(await delaysFor(["ok", "ok"])).toEqual([300, 300]);
  });

  it("doubles the delay while iterations keep failing", async () => {
    expect(await delaysFor(["fail", "fail", "fail"])).toEqual([600, 900, 900]);
  });

  it("caps the backoff so a rate-limited foreman still retries within the hour", async () => {
    const d = await delaysFor(["fail", "fail", "fail", "fail", "fail", "fail"]);
    expect(d.slice(-3)).toEqual([MAX_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS]);
    // A GitHub lockout clears within the hour, so the cap must leave several attempts inside one.
    expect(MAX_BACKOFF_SECONDS).toBeLessThanOrEqual(3600 / 4);
  });

  it("returns to the poll interval after a success", async () => {
    expect(await delaysFor(["fail", "fail", "ok"])).toEqual([600, 900, 300]);
  });
});

describe("model", () => {
  // Captures the argv the dispatcher hands `claude`, then answers like a healthy session.
  function capturingSpawn(seen: string[][]): Spawner {
    const ok = okSpawn({ outcome: "pr_opened", pr: 5, notes: "" });
    return async (...a) => {
      seen.push(a[1]);
      return ok(...a);
    };
  }
  async function dispatchWith(model: string | null): Promise<string> {
    const seen: string[][] = [];
    const st = memState();
    st.store.patch({ model });
    const { gh } = fakeGh([issue({ number: 1, status: "In Progress" })]);
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        state: st.store,
        stateDir: mkdtempSync(join(tmpdir(), "tt-loop-model-")),
        spawn: capturingSpawn(seen),
      }),
    );
    return (seen[0] ?? []).join(" ");
  }

  it("dispatches with the config model when no override is set", async () => {
    expect(await dispatchWith(null)).toContain("--model opus");
  });

  it("dispatches with the live override the owner set, without a daemon restart", async () => {
    const argv = await dispatchWith("sonnet");
    expect(argv).toContain("--model sonnet");
    expect(argv).not.toContain("--model opus");
  });
});

describe("daily cap override", () => {
  // preflight only needs exec to succeed; this stdout keeps `claude auth status` happy.
  const okExec: Exec = async () => ({
    code: 0,
    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
    stderr: "",
  });
  // A sessions.log already at the configured cap of 20 for the day the tick runs on.
  function stateDirAtCap(): string {
    const dir = mkdtempSync(join(tmpdir(), "tt-loop-cap-"));
    const t = new Date().toISOString();
    writeFileSync(
      join(dir, "sessions.log"),
      Array.from(
        { length: 20 },
        (_, i) =>
          `${JSON.stringify({ t, host: "mac-a", role: "builder", issue: i, sessionId: `s-${i}`, attempt: 1, costUsd: 1, outcome: "pr_opened" })}\n`,
      ).join(""),
    );
    return dir;
  }
  async function preflightReason(override: number | null): Promise<string | null> {
    const st = memState();
    st.store.patch({ maxSessionsPerDay: override });
    const { gh } = fakeGh([]);
    await runOnce(ctx({ gh, exec: okExec, stateDir: stateDirAtCap(), state: st.store }));
    const p = st.get().lastPreflight as { ok: boolean; reason: string | null } | undefined;
    return p?.ok ? null : (p?.reason ?? "no preflight recorded");
  }

  it("parks at the configured cap when no override is set", async () => {
    expect(await preflightReason(null)).toBe("daily session cap reached (20/20)");
  });

  it("un-parks on the next tick when the owner raises the cap, with no restart", async () => {
    expect(await preflightReason(50)).toBeNull();
  });
});

describe("runForever after a session", () => {
  // Same driver as the backoff suite, but each iteration also reports whether it dispatched.
  async function delaysFor(outcomes: ("dispatched" | "quiet" | "fail")[]): Promise<number[]> {
    const seconds: number[] = [];
    let n = 0;
    const stop = new Error("stop");
    await expect(
      runForever(ctx({}), {
        iterate: async () => {
          const o = outcomes[n++];
          if (o === "fail") throw new Error("gh: API rate limit exceeded");
          return { dispatched: o === "dispatched" };
        },
        sleep: async (ms) => {
          seconds.push(ms / 1000);
          if (n >= outcomes.length) throw stop;
        },
      }),
    ).rejects.toThrow("stop");
    return seconds;
  }

  it("ticks again immediately after an iteration that started a session", async () => {
    expect(await delaysFor(["dispatched", "quiet"])).toEqual([0, 300]);
  });

  it("still sleeps the poll interval when nothing was eligible", async () => {
    expect(await delaysFor(["quiet", "quiet"])).toEqual([300, 300]);
  });

  it("keeps the failure backoff when an iteration after a dispatch throws", async () => {
    expect(await delaysFor(["dispatched", "fail"])).toEqual([0, 600]);
  });

  it("records the shortened wait in nextTickAt", async () => {
    const st = memState();
    const ac = new AbortController();
    await runForever(ctx({ signal: ac.signal, state: st.store }), {
      iterate: async () => {
        ac.abort();
        return { dispatched: true };
      },
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(Date.parse(st.get().nextTickAt as string)).toBe(
      Date.parse(st.get().lastTickAt as string),
    );
  });
});

describe("operator interrupt", () => {
  const interruptedSpawn: Spawner = async () => ({
    code: 143,
    stdout: "",
    stderr: "",
    timedOut: false,
    interrupted: true,
  });
  it("stop: posts the interrupted comment, no blocked label, no retry, clears current", async () => {
    const i = issue({ number: 1, status: "In Progress" });
    const { gh, calls } = fakeGh([i]);
    const ac = new AbortController();
    ac.abort();
    const st = memState();
    let spawns = 0;
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        signal: ac.signal,
        stopMode: () => "stop",
        state: st.store,
        stateDir: mkdtempSync(join(tmpdir(), "tt-loop-")),
        spawn: async (...a) => {
          spawns++;
          return interruptedSpawn(...a);
        },
      }),
    );
    expect(spawns).toBe(1);
    expect(calls.some((c) => c.includes("interrupted on mac-a"))).toBe(true);
    expect(calls.some((c) => c.includes("blocked"))).toBe(false);
    expect(calls.some((c) => c.startsWith("unassign"))).toBe(false);
    expect(st.get().current).toBeNull();
    expect(st.get().unfinished).toBeNull();
  });
  it("abort: releases, unassigns, resets Ready; sessions.log records aborted", async () => {
    const i = issue({ number: 1, status: "In Progress" });
    const { gh, calls } = fakeGh([i]);
    const ac = new AbortController();
    ac.abort();
    const dir = mkdtempSync(join(tmpdir(), "tt-loop-"));
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        signal: ac.signal,
        stopMode: () => "abort",
        stateDir: dir,
        spawn: interruptedSpawn,
      }),
    );
    expect(calls).toContain(`comment issue 1 ${fmt.aborted("mac-a")}`);
    expect(calls).toContain("unassign 1 matthewtsmith");
    expect(calls).toContain("setStatus PVTI_1 Ready");
    const line = readFileSync(join(dir, "sessions.log"), "utf8").trim();
    expect(JSON.parse(line).outcome).toBe("aborted");
  });
  it("records unfinished when the ledger write fails", async () => {
    const i = issue({ number: 1, status: "In Progress" });
    const { gh } = fakeGh([i]);
    // Only the ledger-interrupt write (the 3rd comment: claimed, session-started, then the
    // interrupt bookkeeping) fails — the earlier claim comments must still go through.
    let commentCalls = 0;
    gh.comment = async () => {
      commentCalls++;
      if (commentCalls > 2) throw new Error("gh: 502");
    };
    const ac = new AbortController();
    ac.abort();
    const st = memState();
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        signal: ac.signal,
        stopMode: () => "stop",
        state: st.store,
        stateDir: mkdtempSync(join(tmpdir(), "tt-loop-")),
        spawn: interruptedSpawn,
      }),
    );
    expect(st.get().current).toBeNull();
    expect((st.get().unfinished as { mode: string; issue: number }).mode).toBe("stop");
    expect((st.get().unfinished as { mode: string; issue: number }).issue).toBe(1);
  });
  it("runRole records current with the child pid while the session runs", async () => {
    const { gh } = fakeGh([issue({ number: 1 })]);
    const st = memState();
    let seenCurrent: unknown = null;
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        state: st.store,
        stateDir: mkdtempSync(join(tmpdir(), "tt-loop-")),
        spawn: async (_c, _a, opts) => {
          opts.onSpawn?.(4242);
          seenCurrent = st.get().current;
          return okSpawn({ outcome: "pr_opened", pr: 5, notes: "" })(_c, _a, opts);
        },
      }),
    );
    expect(seenCurrent).toMatchObject({ issue: 1, role: "builder", childPid: 4242, attempt: 1 });
    expect(st.get().current).toBeNull();
  });
});

describe("runForever stop", () => {
  it("exits without sleeping once the signal is aborted", async () => {
    const ac = new AbortController();
    let iterations = 0;
    const st = memState();
    await runForever(ctx({ signal: ac.signal, state: st.store }), {
      iterate: async () => {
        iterations++;
        ac.abort();
        return { dispatched: false };
      },
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(iterations).toBe(1);
    expect(st.get().lastTickAt).toBeTruthy();
    expect(st.get().consecutiveFailures).toBe(0);
  });
  it("runs iterations through the lock when one is given", async () => {
    const ac = new AbortController();
    let locked = 0;
    await runForever(ctx({ signal: ac.signal }), {
      iterate: async () => {
        ac.abort();
        return { dispatched: false };
      },
      sleep: async () => {},
      lock: async (fn) => {
        locked++;
        return fn();
      },
    });
    expect(locked).toBe(1);
  });
});

describe("runOnce abort mid-plan", () => {
  it("stops between actions once the signal aborts, so a second mergeable PR is never merged", async () => {
    const i1 = issue({ number: 1, status: "In Review" });
    const i2 = issue({ number: 2, status: "In Review" });
    const p1 = pr({ number: 10, issue: 1, labels: ["reviewer:approved", "validator:passed"] });
    const p2 = pr({ number: 11, issue: 2, labels: ["reviewer:approved", "validator:passed"] });
    const ac = new AbortController();
    const merged: number[] = [];
    const { gh: baseGh } = fakeGh([]);
    const gh: GitHubApi = {
      ...baseGh,
      listIssues: async () => [i1, i2],
      getIssue: async (n) => (n === 1 ? i1 : i2),
      listOpenPRs: async () => [p1, p2],
      mergePR: async (prNumber) => {
        merged.push(prNumber);
        // Abort lands while this first merge is still in flight.
        ac.abort();
      },
    };
    // preflight only needs exec to succeed; the exact stdout keeps `claude auth status` happy.
    const exec: Exec = async () => ({
      code: 0,
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
      stderr: "",
    });
    const stateDir = mkdtempSync(join(tmpdir(), "tt-loop-abort-"));
    await runOnce(ctx({ gh, exec, signal: ac.signal, stateDir }));
    expect(merged).toEqual([10]);
  });
});

describe("live activity", () => {
  const toolLine = (id: string, file: string) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        content: [{ type: "tool_use", id: `t_${id}`, name: "Read", input: { file_path: file } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      timestamp: "2026-09-04T13:27:20.000Z",
    });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.5,
    duration_ms: 100,
    session_id: "s",
    result: "x",
    structured_output: { outcome: "pr_opened", pr: 5, notes: "" },
  });
  const streamingSpawn: Spawner = async (_c, _a, opts) => {
    for (let i = 0; i < 10; i++) opts.onStdoutLine?.(toolLine(`m${i}`, `/work/1/f${i}.ts`));
    opts.onStdoutLine?.(result);
    return { code: 0, stdout: result, stderr: "", timedOut: false, interrupted: false };
  };

  it("runRole writes activity into current (throttled) and appends the feed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tt-loop-"));
    const issues = [issue({ number: 1, status: "Ready" })];
    const { gh } = fakeGh(issues);
    const m = memState();
    const activityPatches: number[] = [];
    const store = {
      get: m.store.get,
      patch: (p: Record<string, unknown>) => {
        const cur = p.current as { activity?: { turns: number } } | null | undefined;
        if (cur?.activity) activityPatches.push(cur.activity.turns);
        return m.store.patch(p);
      },
    };
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({ gh, spawn: streamingSpawn, stateDir, state: store as never }),
    );
    expect(activityPatches.length).toBeLessThanOrEqual(2); // end-of-session flush, not one per line
    expect(activityPatches.at(-1)).toBe(10);
    const dir = join(stateDir, "activity");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0] as string), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(11); // 10 tool + 1 result
    expect(JSON.parse(lines[10] as string)).toMatchObject({ kind: "result", outcome: "pr_opened" });
    expect(ACTIVITY_FLUSH_MS).toBe(2000);
  });

  it("runOnce stores a board next to lastPlan", async () => {
    const issues = [issue({ number: 1, status: "In Review" })];
    const { gh } = fakeGh(issues);
    gh.listOpenPRs = async () => [pr({ number: 11, issue: 1, checks: "pending" })];
    const m = memState();
    // preflight only needs exec to succeed; this stdout keeps `claude auth status` happy.
    const exec: Exec = async () => ({
      code: 0,
      stderr: "",
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
    });
    await runOnce(
      ctx({ gh, exec, state: m.store, stateDir: mkdtempSync(join(tmpdir(), "tt-loop-")) }),
    );
    const board = m.get().board as { waiting: Array<{ kind: string }>; pipeline: unknown[] };
    expect(board.waiting.map((w) => w.kind)).toEqual(["ci"]);
    expect(board.pipeline).toHaveLength(1);
  });
});
