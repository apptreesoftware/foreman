import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import type { Spawner } from "./dispatch.ts";
import type { GitHubApi } from "./github.ts";
import { fmt } from "./ledger.ts";
import { type Ctx, execute } from "./loop.ts";
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
    login: "matthewtsmith",
    ensureWorktree: async () => "/work/1",
    removeWorktree: async () => {},
    transcriptExists: () => true,
    artifactsDir: "/tmp/tt-test/artifacts",
    copyDir: async () => {},
    now: () => "2026-09-03T12:00:00Z",
    ...over,
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
          return { code: 1, stdout: "", stderr: "", timedOut: false };
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
    const spawn: Spawner = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: true });
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
  it("apply_plan with no issues file just records plan applied", async () => {
    const { gh, calls } = fakeGh([
      issue({ number: 200, labels: ["epic", "phase:2", "plan-approved"] }),
    ]);
    const r = await execute({ type: "apply_plan", epic: 200 }, ctx({ gh, readFile: () => null }));
    expect(r).toBe("continue");
    expect(calls).toContain(`comment issue 200 ${fmt.planApplied("mac-a")} (no issues file)`);
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
        readFile: (p) => (p.endsWith("plan.issues.json") ? file : null),
        listPlanFiles: () => ["docs/superpowers/plans/2026-09-10-phase-02-plan.issues.json"],
      }),
    );
    expect(calls).toContain("editBody 201 b1");
    expect(calls).toContain("addLabels issue 201 phase:2,size:S,agent-ready");
    expect(calls).toContain("addSubIssue 200 999");
    expect(calls).toContain("addLabels issue 999 phase:2,size:M,agent-ready");
    expect(calls).toContain("setStatus PVTI_201 Ready");
    expect(calls).toContain(`comment issue 200 ${fmt.planApplied("mac-a")}`);
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
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(calls).toEqual([]);
  });
});
