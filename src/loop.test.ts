import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import type { Spawner } from "./dispatch.ts";
import { type Exec, realExec } from "./exec.ts";
import type { GitHubApi } from "./github.ts";
import { fmt } from "./ledger.ts";
import {
  ACTIVITY_FLUSH_MS,
  type Ctx,
  ensureLogin,
  execute,
  idleSeconds,
  MAX_BACKOFF_SECONDS,
  MAX_IDLE_SECONDS,
  modelFor,
  runForever,
  runOnce,
  snapshotFingerprint,
  type TickOutcome,
} from "./loop.ts";
import type { LabelledIssue, NotifyEvent, NotifyPort } from "./notify.ts";
import { defaultRepoConfig } from "./repo-config.ts";
import type { Issue } from "./types.ts";

const cfg = parseConfig(
  JSON.stringify({
    repo: "o/r",
    project: 2,
    host: "mac-a",
    repoDir: "/repo",
    workDir: "/work",
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
    rerunFailedChecks: async (sha: string) => {
      calls.push(`rerunFailedChecks ${sha}`);
      return 99;
    },
    createIssue: async () => 999,
    addSubIssue: rec("addSubIssue"),
    viewerLogin: async () => "matthewtsmith",
    defaultBranch: async () => "main",
  };
  return { gh, calls };
}

/** Epic #200 plus #190, the task a half-finished earlier apply already created for it (#223). */
const reusePlanIssues = () => [
  issue({
    number: 200,
    labels: ["epic", "phase:2", "plan-approved"],
    body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
  }),
  issue({
    number: 190,
    title: "t2",
    body: "## Goal\n…\n\nParent epic: #200",
    labels: ["phase:2"],
    status: "Backlog",
  }),
];

const reusePlanCtx: Partial<Ctx> = {
  planFiles: async () => ["docs/superpowers/plans/2026-09-10-phase-02-plan.issues.json"],
  readPlanFile: async () =>
    JSON.stringify({
      epic: 200,
      tasks: [{ title: "t2", body: "b2", labels: ["phase:2", "size:M"] }],
    }),
};

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

function recordNotify() {
  const events: NotifyEvent[] = [];
  const parked: (string | null)[] = [];
  const decisions: number[][] = [];
  const port: NotifyPort = {
    send: async (e) => {
      events.push(e);
    },
    syncParked: async (r) => {
      parked.push(r);
    },
    syncDecisions: async (issues: LabelledIssue[]) => {
      decisions.push(issues.map((i) => i.number));
    },
  };
  const kinds = () => events.map((e) => e.kind);
  return { events, parked, decisions, port, kinds };
}

function ctx(over: Partial<Ctx>): Ctx {
  const { gh } = fakeGh([]);
  return {
    cfg,
    gh,
    notify: recordNotify().port,
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
    repo: defaultRepoConfig(),
    defaultBranch: "main",
    instance: "widgets",
    hookLog: () => {},
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
  it("adopt: adds the issue to the board, sets Ready, and says so on the issue (#249)", async () => {
    const i = issue({ number: 7, itemId: null, status: null });
    const { gh, calls } = fakeGh([i]);
    const r = await execute({ type: "adopt", issue: 7 }, ctx({ gh }), snapshot({ issues: [i] }));
    expect(r).toBe("continue");
    expect(calls).toEqual([
      "setStatus PVTI_new Ready",
      `comment issue 7 ${fmt.adopted("foreman@mac-a")}`,
    ]);
  });
  it("ci_rerun: reruns the failed jobs and records the sha, starting no session (#362)", async () => {
    const sha = "1111111111111111111111111111111111111111";
    const i = issue({ number: 1, status: "In Review" });
    const { gh, calls } = fakeGh([i]);
    const r = await execute(
      { type: "ci_rerun", pr: 9, issue: 1, sha },
      ctx({ gh }),
      snapshot({ issues: [i] }),
    );
    // "noop": nothing spends a claude session here, and the checks stay pending for minutes, so
    // the tick must not treat the rerun as work worth an immediate re-tick.
    expect(r).toBe("noop");
    expect(calls).toEqual([
      `rerunFailedChecks ${sha}`,
      `comment issue 1 ${fmt.ciRerun("mac-a", sha)}`,
    ]);
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
  it("merge: records the claim→merge span in merges.log", async () => {
    const i = issue({
      number: 1,
      status: "In Review",
      comments: [
        comment(
          "claimed by mac-a at 2026-09-03T10:00:00Z role=builder round=1",
          "2026-09-03T10:00:00Z",
        ),
      ],
    });
    const { gh } = fakeGh([i]);
    const dir = mkdtempSync(join(tmpdir(), "tt-loop-"));
    await execute(
      { type: "merge", pr: 9, issue: 1 },
      ctx({ gh, stateDir: dir }),
      snapshot({ issues: [i] }),
    );
    expect(JSON.parse(readFileSync(join(dir, "merges.log"), "utf8").trim())).toEqual({
      issue: 1,
      pr: 9,
      host: "mac-a",
      claimedAt: "2026-09-03T10:00:00Z",
      mergedAt: "2026-09-03T12:00:00Z",
    });
  });
  it("claim: a rebase round keeps the issue In Review and hands the builder the rebase notes (#237)", async () => {
    const i = issue({ number: 1, status: "In Review" });
    const { gh, calls } = fakeGh([i]);
    const inputs: string[] = [];
    const spawn: Spawner = async (_cmd, _args, opts) => {
      inputs.push(opts.input);
      return okSpawn({ outcome: "pr_opened", pr: 9, notes: "" })("", [], opts);
    };
    const r = await execute(
      { type: "claim", issue: 1, role: "builder", pr: 9, round: 2, rebase: true },
      ctx({ gh, spawn }),
    );
    expect(r).toBe("stop");
    expect(calls[0]).toMatch(/^comment issue 1 claimed by mac-a at \S+ role=builder round=2$/);
    expect(calls).not.toContain("setStatus PVTI_1 In Progress");
    expect(inputs[0]).toContain("rebase round");
    expect(inputs[0]).not.toContain("fix round");
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
  it("runs the served repo's session hooks around the session, wiring env and prompt lines into the dispatch", async () => {
    const fixtureRepo = join(import.meta.dirname, "../test/fixtures/repo");
    const wt = mkdtempSync(join(tmpdir(), "tt-hooks-wt-"));
    const seen: { env?: NodeJS.ProcessEnv; input?: string } = {};
    const spawn: Spawner = async (_c, _a, opts) => {
      seen.env = opts.env;
      seen.input = opts.input;
      return {
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
          structured_output: { outcome: "pr_opened", pr: 9, notes: "" },
        }),
      };
    };
    const i = issue({ number: 1 });
    const { gh } = fakeGh([i]);
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        cfg: { ...cfg, repoDir: fixtureRepo },
        // Real exec so the fixture hooks actually run; the spawn double stands in for `claude`.
        exec: realExec,
        spawn,
        ensureWorktree: async () => wt,
      }),
    );
    expect(existsSync(join(wt, ".before-ran"))).toBe(true);
    expect(existsSync(join(wt, ".after-ran"))).toBe(true);
    expect(seen.env?.APP_PORT).toBe("8182");
    expect(seen.input).toContain("Local URLs");
  });
  it("still runs after-session when the dispatch itself throws", async () => {
    const fixtureRepo = join(import.meta.dirname, "../test/fixtures/repo");
    const wt = mkdtempSync(join(tmpdir(), "tt-hooks-throw-"));
    const spawn: Spawner = async () => {
      throw new Error("boom: claude never started");
    };
    const i = issue({ number: 1 });
    const { gh } = fakeGh([i]);
    await expect(
      execute(
        { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
        ctx({
          gh,
          cfg: { ...cfg, repoDir: fixtureRepo },
          exec: realExec,
          spawn,
          ensureWorktree: async () => wt,
        }),
      ),
    ).rejects.toThrow("boom: claude never started");
    expect(existsSync(join(wt, ".before-ran"))).toBe(true);
    expect(existsSync(join(wt, ".after-ran"))).toBe(true);
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
    // "noop": nothing was written, so the tick must not count this as work and re-tick at once.
    expect(r).toBe("noop");
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
          return { didWork: false, action: null };
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

describe("idle backoff (#387)", () => {
  // Drives runForever with a scripted sequence of outcomes, recording the sleep before each.
  async function delaysFor(outcomes: Array<TickOutcome | "fail">): Promise<number[]> {
    const seconds: number[] = [];
    let n = 0;
    const stop = new Error("stop");
    await expect(
      runForever(ctx({}), {
        iterate: async () => {
          const o = outcomes[n++];
          if (o === "fail") throw new Error("gh: boom");
          return o as TickOutcome;
        },
        sleep: async (ms) => {
          seconds.push(ms / 1000);
          if (n >= outcomes.length) throw stop;
        },
      }),
    ).rejects.toThrow("stop");
    return seconds;
  }
  const quiet = (fingerprint: string): TickOutcome => ({
    didWork: false,
    action: null,
    fingerprint,
  });

  it("doubles the wait while nothing on GitHub has moved", async () => {
    expect(await delaysFor([quiet("a"), quiet("a"), quiet("a"), quiet("a")])).toEqual(
      [300, 600, 1200, 2400].map((s) => Math.min(s, MAX_IDLE_SECONDS)),
    );
  });

  it("caps the wait so work that arrives is still picked up the same half hour", async () => {
    const d = await delaysFor(Array.from({ length: 8 }, () => quiet("a")));
    expect(d.at(-1)).toBe(MAX_IDLE_SECONDS);
    expect(MAX_IDLE_SECONDS).toBeLessThanOrEqual(1800);
  });

  it("returns to the poll interval as soon as GitHub changes", async () => {
    expect(await delaysFor([quiet("a"), quiet("a"), quiet("b"), quiet("b")])).toEqual([
      300, 600, 300, 600,
    ]);
  });

  it("ticks again at once after work, and restarts the streak rather than resuming it", async () => {
    const worked: TickOutcome = { didWork: true, action: "merge", fingerprint: "b" };
    // The fourth delay is 600 (streak restarted at one), not the 1200 it had reached before.
    expect(await delaysFor([quiet("a"), quiet("a"), worked, quiet("b")])).toEqual([
      300, 600, 0, 600,
    ]);
  });

  it("leaves the failure backoff in charge, and restarts the streak after it", async () => {
    expect(await delaysFor([quiet("a"), quiet("a"), "fail", quiet("a")])).toEqual([
      300, 600, 600, 600,
    ]);
  });

  it("keeps polling at the plain interval while parked, so un-parking is noticed", async () => {
    // preflight failure returns before a snapshot exists, so there is no fingerprint to compare.
    const parked: TickOutcome = { didWork: false, action: null };
    expect(await delaysFor([parked, parked, parked])).toEqual([300, 300, 300]);
  });

  it("idleSeconds doubles from the poll interval and stops at the cap", () => {
    expect(idleSeconds(300, 0)).toBe(300);
    expect(idleSeconds(300, 1)).toBe(600);
    expect(idleSeconds(300, 3)).toBe(1800);
    expect(idleSeconds(300, 99)).toBe(MAX_IDLE_SECONDS);
  });
});

describe("snapshotFingerprint (#387)", () => {
  it("is stable when nothing changed", () => {
    const s = snapshot({ issues: [issue({ number: 1 })], prs: [pr({ number: 9, issue: 1 })] });
    expect(snapshotFingerprint(s)).toBe(snapshotFingerprint(snapshot({ ...s })));
  });
  it("moves when an issue is touched", () => {
    const a = snapshot({ issues: [issue({ number: 1 })] });
    const b = snapshot({ issues: [issue({ number: 1, updatedAt: "2026-09-09T00:00:00Z" })] });
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });
  it("moves when only the board Status changed, which does not touch updatedAt", () => {
    const a = snapshot({ issues: [issue({ number: 1, status: "Backlog" })] });
    const b = snapshot({ issues: [issue({ number: 1, status: "Ready" })] });
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });
  it("moves when a PR's checks go green", () => {
    const a = snapshot({ prs: [pr({ number: 9, issue: 1, checks: "pending" })] });
    const b = snapshot({ prs: [pr({ number: 9, issue: 1, checks: "success" })] });
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });
  it("moves when a reviewer's label lands", () => {
    const a = snapshot({ prs: [pr({ number: 9, issue: 1, labels: [] })] });
    const b = snapshot({ prs: [pr({ number: 9, issue: 1, labels: ["reviewer:approved"] })] });
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });
  it("ignores the clock, so a tick is not made noisy by its own timestamp", () => {
    const a = snapshot({ issues: [issue({ number: 1 })], now: "2026-09-08T00:00:00Z" });
    const b = snapshot({ issues: [issue({ number: 1 })], now: "2026-09-08T09:00:00Z" });
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
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
    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
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
          return o === "dispatched"
            ? { didWork: true, action: "claim" }
            : { didWork: false, action: null };
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
        return { didWork: true, action: "claim" };
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
    expect(JSON.parse(line)).toMatchObject({
      outcome: "aborted",
      // Recorded on an interrupt too, so an aborted session's spend is still comparable (#226).
      model: "opus",
      turns: 0,
      subtype: "interrupted",
    });
  });
  it("sessions.log records the model, turns, duration, denials and subtype", async () => {
    const i = issue({ number: 1 });
    const { gh } = fakeGh([i]);
    const dir = mkdtempSync(join(tmpdir(), "tt-loop-"));
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        stateDir: dir,
        spawn: async (...a) => {
          const r = await okSpawn({ outcome: "pr_opened", pr: 5, notes: "" })(...a);
          return {
            ...r,
            stdout: r.stdout.replace('"duration_ms":100', '"duration_ms":222000'),
          };
        },
      }),
    );
    // No stream events reach the fake spawner, so `model` falls back to the dispatched name.
    expect(JSON.parse(readFileSync(join(dir, "sessions.log"), "utf8").trim())).toMatchObject({
      model: "opus",
      turns: 2,
      durationMinutes: 3.7,
      denials: 0,
      subtype: "success",
    });
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
        return { didWork: false, action: null };
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
        return { didWork: false, action: null };
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
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
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
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
    });
    await runOnce(
      ctx({ gh, exec, state: m.store, stateDir: mkdtempSync(join(tmpdir(), "tt-loop-")) }),
    );
    const board = m.get().board as { waiting: Array<{ kind: string }>; pipeline: unknown[] };
    expect(board.waiting.map((w) => w.kind)).toEqual(["ci"]);
    expect(board.pipeline).toHaveLength(1);
  });

  it("runOnce stores phase progress computed from the snapshot and the local logs", async () => {
    const issues = [
      issue({ number: 10, title: "Phase 1", labels: ["epic", "phase:1", "plan-approved"] }),
      issue({ number: 1, status: "In Review", body: "## Goal\n\nParent epic: #10" }),
    ];
    const { gh } = fakeGh(issues);
    gh.listOpenPRs = async () => [pr({ number: 11, issue: 1, checks: "pending" })];
    const m = memState();
    const dir = mkdtempSync(join(tmpdir(), "tt-loop-"));
    writeFileSync(
      join(dir, "sessions.log"),
      `${JSON.stringify({ t: "2026-09-03T11:00:00Z", host: "mac-a", role: "builder", issue: 1, sessionId: "s", attempt: 1, costUsd: 2.5, outcome: "pr_opened" })}\n`,
    );
    const exec: Exec = async () => ({
      code: 0,
      stderr: "",
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
    });
    await runOnce(ctx({ gh, exec, state: m.store, stateDir: dir }));
    const board = m.get().board as { phases: Array<Record<string, unknown>> };
    expect(board.phases).toEqual([
      {
        epic: 10,
        phase: 1,
        title: "Phase 1",
        tasksDone: 0,
        tasksTotal: 1,
        spendUsd: 2.5,
        sessions: 1,
        medianMergeMinutes: null,
        mergedTasks: 0,
        tasks: [{ issue: 1, title: "Task 1", status: "In Review", closed: false, model: null }],
      },
    ]);
  });
});

describe("tick outcome (#223)", () => {
  // preflight only needs exec to succeed; this stdout keeps `claude auth status` happy.
  const okExec: Exec = async () => ({
    code: 0,
    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
    stderr: "",
  });
  const stateDir = () => mkdtempSync(join(tmpdir(), "tt-loop-tick-"));

  function mergeableBoard() {
    const i1 = issue({ number: 1, status: "In Review" });
    const p1 = pr({ number: 10, issue: 1, labels: ["reviewer:approved", "validator:passed"] });
    const { gh: base, calls } = fakeGh([]);
    const gh: GitHubApi = {
      ...base,
      listIssues: async () => [i1],
      getIssue: async () => i1,
      listOpenPRs: async () => [p1],
    };
    return { gh, calls };
  }

  it("a tick that only merged reports work, naming the action", async () => {
    const { gh } = mergeableBoard();
    const out = await runOnce(ctx({ gh, exec: okExec, stateDir: stateDir() }));
    expect(out).toMatchObject({ didWork: true, action: "merge" });
  });

  it("a tick that merged and then dispatched a session names the session, not the merge", async () => {
    const i1 = issue({ number: 1, status: "In Review" });
    const i2 = issue({ number: 2 });
    const p1 = pr({ number: 10, issue: 1, labels: ["reviewer:approved", "validator:passed"] });
    const { gh: base, calls } = fakeGh([i1, i2]);
    const gh: GitHubApi = { ...base, listOpenPRs: async () => [p1] };
    const out = await runOnce(ctx({ gh, exec: okExec, stateDir: stateDir() }));
    expect(calls.filter((c) => c.startsWith("mergePR"))).toEqual(["mergePR 10"]);
    expect(out).toMatchObject({ didWork: true, action: "claim" });
  });

  it("a tick that found nothing eligible reports no work", async () => {
    const { gh } = fakeGh([]);
    const out = await runOnce(ctx({ gh, exec: okExec, stateDir: stateDir() }));
    expect(out).toMatchObject({ didWork: false, action: null });
  });

  it("a dry-run merge tick reports no work, so dry-run never hot-loops", async () => {
    const { gh, calls } = mergeableBoard();
    const out = await runOnce(ctx({ gh, exec: okExec, stateDir: stateDir(), dryRun: true }));
    expect(calls.filter((c) => c.startsWith("mergePR"))).toEqual([]);
    expect(out).toMatchObject({ didWork: false, action: null });
  });

  it("an apply_plan tick whose plan is not on origin/main yet reports no work", async () => {
    const { gh } = fakeGh([
      issue({
        number: 200,
        labels: ["epic", "phase:2", "plan-approved"],
        body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
      }),
    ]);
    const out = await runOnce(
      ctx({ gh, exec: okExec, stateDir: stateDir(), planFiles: async () => [] }),
    );
    expect(out).toMatchObject({ didWork: false, action: null });
  });

  it("an apply_plan tick that applied the plan reports work", async () => {
    const { gh } = fakeGh([
      issue({
        number: 200,
        labels: ["epic", "phase:2", "plan-approved"],
        body: "## Spec\ndocs/superpowers/specs/2026-09-03-phase-02-x-design.md",
      }),
    ]);
    const file = JSON.stringify({
      epic: 200,
      tasks: [{ title: "t2", body: "b2", labels: ["phase:2", "size:M"] }],
    });
    const out = await runOnce(
      ctx({
        gh,
        exec: okExec,
        stateDir: stateDir(),
        planFiles: async () => ["docs/superpowers/plans/2026-09-10-phase-02-plan.issues.json"],
        readPlanFile: async () => file,
      }),
    );
    expect(out).toMatchObject({ didWork: true, action: "apply_plan" });
  });

  it("runForever ticks again immediately after a tick that did work, and says which action", async () => {
    const seconds: number[] = [];
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      lines.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    let n = 0;
    const stop = new Error("stop");
    try {
      await expect(
        runForever(ctx({}), {
          iterate: async () =>
            n++ === 0 ? { didWork: true, action: "merge" } : { didWork: false, action: null },
          sleep: async (ms) => {
            seconds.push(ms / 1000);
            if (n >= 2) throw stop;
          },
        }),
      ).rejects.toThrow("stop");
    } finally {
      process.stdout.write = orig;
    }
    expect(seconds).toEqual([0, 300]);
    const line = lines.map((l) => JSON.parse(l)).find((j) => j.msg === "ticking again immediately");
    expect(line).toMatchObject({ action: "merge" });
  });

  it("apply_plan reuses an open issue with the task's title under the epic instead of creating a second one", async () => {
    const { gh: base, calls } = fakeGh(reusePlanIssues());
    let created = 0;
    const gh: GitHubApi = {
      ...base,
      createIssue: async () => {
        created += 1;
        return 999;
      },
    };
    await execute({ type: "apply_plan", epic: 200 }, ctx({ ...reusePlanCtx, gh }));
    expect(created).toBe(0);
    expect(calls).toContain("editBody 190 b2");
    expect(calls).toContain("addLabels issue 190 phase:2,size:M,agent-ready");
    expect(calls).toContain("setStatus PVTI_190 Ready");
    expect(calls).not.toContain("addSubIssue 200 999");
  });

  it("apply_plan links a reused issue that the failed attempt never made a sub-issue of the epic", async () => {
    // The attempt that created #190 died between createIssue and addSubIssue, so the epic has
    // no sub-issues: phaseComplete would never see #190 and would close the phase around it.
    const { gh, calls } = fakeGh(reusePlanIssues());
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({ ...reusePlanCtx, gh: { ...gh, subIssues: async () => [] } }),
    );
    expect(calls).toContain("addSubIssue 200 190");
  });

  it("apply_plan leaves a reused issue the board has already moved on alone, but still links it", async () => {
    // The slow retry: #190 was created by the partial apply hours ago and is now In Review with
    // an approved PR. Re-arming it (agent-ready + Ready) would make mergeDecision reject that PR
    // forever and buildCandidates dispatch a second builder round on finished work.
    const issues = reusePlanIssues().map((i) =>
      i.number === 190 ? { ...i, status: "In Review" as const } : i,
    );
    const { gh, calls } = fakeGh(issues);
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({ ...reusePlanCtx, gh: { ...gh, subIssues: async () => [] } }),
    );
    expect(calls).toContain("addSubIssue 200 190");
    expect(calls).toContain("editBody 190 b2");
    expect(calls.filter((c) => c.startsWith("addLabels issue 190"))).toEqual([]);
    expect(calls).not.toContain("setStatus PVTI_190 Ready");
  });

  it("apply_plan does not re-link a reused issue that is already a sub-issue of the epic", async () => {
    // addSubIssue on an issue the epic already owns is a 422, which would fail the whole tick.
    const { gh, calls } = fakeGh(reusePlanIssues());
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({ ...reusePlanCtx, gh: { ...gh, subIssues: async () => [190] } }),
    );
    expect(calls).toContain("editBody 190 b2");
    expect(calls).not.toContain("addSubIssue 200 190");
  });

  it("apply_plan reads the epic's sub-issues from the snapshot rather than asking GitHub again", async () => {
    const issues = reusePlanIssues();
    const { gh, calls } = fakeGh(issues);
    let subIssueReads = 0;
    await execute(
      { type: "apply_plan", epic: 200 },
      ctx({
        ...reusePlanCtx,
        gh: {
          ...gh,
          subIssues: async () => {
            subIssueReads += 1;
            return [];
          },
        },
      }),
      snapshot({ issues, epics: [epic({ number: 200, taskNumbers: [190] })] }),
    );
    expect(subIssueReads).toBe(0);
    expect(calls).not.toContain("addSubIssue 200 190");
  });
});

// Each notification fires exactly once for its trigger, and carries only numbers, titles and the
// foreman's own reason strings — never the stderr excerpt that goes into the GitHub comment (#225).
describe("notifications", () => {
  // preflight only needs exec to succeed; this stdout keeps `claude auth status` happy.
  const okExec: Exec = async () => ({
    code: 0,
    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\nToken scopes: \'project\', \'repo\'\n',
    stderr: "",
  });
  const tmp = () => mkdtempSync(join(tmpdir(), "tt-notify-loop-"));

  it("merge fires one merged event naming the PR, the issue and its title", async () => {
    const i = issue({ number: 1, title: "feat(db): lessons", status: "In Review" });
    const { gh } = fakeGh([i]);
    const n = recordNotify();
    await execute(
      { type: "merge", pr: 9, issue: 1 },
      ctx({ gh, notify: n.port }),
      snapshot({ issues: [i] }),
    );
    expect(n.events).toEqual([{ kind: "merged", pr: 9, issue: 1, title: "feat(db): lessons" }]);
  });

  it("a block action fires one blocked event with the foreman's reason", async () => {
    const i = issue({ number: 1, title: "feat(db): lessons" });
    const { gh } = fakeGh([i]);
    const n = recordNotify();
    await execute(
      { type: "block", issue: 1, reason: "3 fix rounds without an approval" },
      ctx({ gh, notify: n.port }),
      snapshot({ issues: [i] }),
    );
    expect(n.events).toEqual([
      {
        kind: "blocked",
        issue: 1,
        title: "feat(db): lessons",
        reason: "3 fix rounds without an approval",
      },
    ]);
  });

  it("a blocked outcome fires one blocked event carrying the role's notes", async () => {
    const { gh } = fakeGh([issue({ number: 1, title: "feat(db): lessons" })]);
    const n = recordNotify();
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({
        gh,
        notify: n.port,
        stateDir: tmp(),
        spawn: okSpawn({ outcome: "blocked", pr: null, notes: "opened decision #99" }),
      }),
    );
    expect(n.events).toEqual([
      { kind: "blocked", issue: 1, title: "feat(db): lessons", reason: "opened decision #99" },
    ]);
  });

  it("exhausted retries fire one blocked event without the stderr excerpt", async () => {
    const { gh, calls } = fakeGh([issue({ number: 1, title: "feat(db): lessons" })]);
    const n = recordNotify();
    const spawn: Spawner = async () => ({
      code: 1,
      stdout: "",
      stderr: "boom /Users/matthew/.tone_tonic/foreman.json",
      timedOut: true,
      interrupted: false,
    });
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({ gh, notify: n.port, spawn, stateDir: tmp() }),
    );
    expect(n.events).toEqual([
      { kind: "blocked", issue: 1, title: "feat(db): lessons", reason: "timed out after retries" },
    ]);
    // The excerpt still reaches GitHub, where it belongs; it must not reach a phone.
    expect(calls.some((c) => c.includes("boom"))).toBe(true);
  });

  it("phase_closed fires once and links the review issue named in the notes", async () => {
    const { gh } = fakeGh([
      issue({ number: 200, title: "Phase 1", labels: ["epic", "phase:1", "plan-approved"] }),
    ]);
    const n = recordNotify();
    await execute(
      { type: "phase_close", epic: 200 },
      ctx({
        gh,
        notify: n.port,
        stateDir: tmp(),
        spawn: okSpawn({ outcome: "phase_closed", pr: null, notes: "review issue #55; DM sent" }),
      }),
    );
    expect(n.events).toEqual([{ kind: "phase_closed", epic: 200, title: "Phase 1", review: 55 }]);
  });

  it("phase_closed with no issue number in the notes falls back to the epic", async () => {
    const { gh } = fakeGh([
      issue({ number: 200, title: "Phase 1", labels: ["epic", "phase:1", "plan-approved"] }),
    ]);
    const n = recordNotify();
    await execute(
      { type: "phase_close", epic: 200 },
      ctx({
        gh,
        notify: n.port,
        stateDir: tmp(),
        spawn: okSpawn({ outcome: "phase_closed", pr: null, notes: "DM sent" }),
      }),
    );
    expect(n.events).toEqual([{ kind: "phase_closed", epic: 200, title: "Phase 1", review: null }]);
  });

  it("plan_drafted fires once with the plan PR", async () => {
    const { gh } = fakeGh([
      issue({ number: 200, title: "Phase 2", labels: ["epic", "phase:2", "agent-ready"] }),
    ]);
    const n = recordNotify();
    await execute(
      { type: "plan", epic: 200 },
      ctx({
        gh,
        notify: n.port,
        stateDir: tmp(),
        spawn: okSpawn({ outcome: "plan_drafted", pr: 7, notes: "" }),
      }),
    );
    expect(n.events).toEqual([{ kind: "plan_drafted", epic: 200, title: "Phase 2", pr: 7 }]);
  });

  it("a pr_opened outcome says nothing: the owner has nothing to do about it", async () => {
    const { gh } = fakeGh([issue({ number: 1 })]);
    const n = recordNotify();
    await execute(
      { type: "claim", issue: 1, role: "builder", pr: null, round: 1 },
      ctx({ gh, notify: n.port, stateDir: tmp() }),
    );
    expect(n.events).toEqual([]);
  });

  it("runOnce hands the tick's issues to syncDecisions and reports a healthy preflight", async () => {
    const issues = [issue({ number: 1 }), issue({ number: 40, labels: ["decision", "phase:1"] })];
    const { gh } = fakeGh(issues);
    const n = recordNotify();
    await runOnce(ctx({ gh, exec: okExec, notify: n.port, stateDir: tmp() }));
    expect(n.decisions).toEqual([[1, 40]]);
    expect(n.parked).toEqual([null]);
  });

  it("a failed preflight parks with its reason and skips the decision sync", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "STOP"), "");
    const { gh } = fakeGh([]);
    const n = recordNotify();
    await runOnce(ctx({ gh, exec: okExec, notify: n.port, stateDir: dir }));
    expect(n.parked).toEqual(["STOP file present"]);
    expect(n.decisions).toEqual([]);
  });
});

describe("modelFor", () => {
  it("prefers the issue's model label to the live override, and the override to foreman.json", () => {
    const st = memState();
    expect(modelFor(ctx({ state: null }), [])).toBe(cfg.model);
    st.store.patch({ model: "sonnet" });
    expect(modelFor(ctx({ state: st.store }), [])).toBe("sonnet");
    expect(modelFor(ctx({ state: st.store }), ["phase:1", "model:haiku"])).toBe("haiku");
    // A malformed label is no label: the override still applies.
    expect(modelFor(ctx({ state: st.store }), ["model:--flag"])).toBe("sonnet");
  });
});
