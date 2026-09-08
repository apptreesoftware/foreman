import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "./exec.ts";
import {
  GitHub,
  modelOf,
  parseChecks,
  parseClosesIssue,
  parseDependsOn,
  parseTouches,
  phaseOf,
  sizeOf,
  touchesOverlap,
} from "./github.ts";
import type { Issue } from "./types.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "../test/fixtures", n), "utf8");

interface GqlNode {
  number: number;
}
const gqlNodes = (): GqlNode[] =>
  (
    JSON.parse(fx("issues-graphql.json")) as {
      data: { repository: { issues: { nodes: GqlNode[] } } };
    }
  ).data.repository.issues.nodes;

/** The value of the `-f`/`-F` argument named `k`, as `gh api graphql` would receive it. */
function gqlVar(args: string[], k: string): string | null {
  const i = args.findIndex((a) => a.startsWith(`${k}=`));
  return i === -1 ? null : (args[i] as string).slice(k.length + 1);
}

function fakeExec(calls: string[][]): Exec {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    if (args[1] === "graphql") {
      const query = gqlVar(args, "query") ?? "";
      if (query.includes("issues("))
        return { code: 0, stdout: fx("issues-graphql.json"), stderr: "" };
      if (query.includes("issue(number:")) {
        const n = Number(gqlVar(args, "number"));
        const one = gqlNodes().find((i) => i.number === n) ?? null;
        return {
          code: 0,
          stdout: JSON.stringify({ data: { repository: { issue: one } } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (a.startsWith("pr list")) return { code: 0, stdout: fx("prs.json"), stderr: "" };
    if (a.startsWith("project field-list"))
      return { code: 0, stdout: fx("fields.json"), stderr: "" };
    if (a.startsWith("project view"))
      return { code: 0, stdout: '{"id":"PVT_kwHOAIlXYM4BiXbz"}', stderr: "" };
    if (a.includes("/sub_issues"))
      return { code: 0, stdout: '[{"number":125},{"number":126}]', stderr: "" };
    if (a.includes("/actions/runs?head_sha=")) return { code: 0, stdout: "77\n", stderr: "" };
    if (a.startsWith("api user"))
      return { code: 0, stdout: '{"login":"matthewtsmith"}', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}
const cfg = { repo: "matthewtsmith/tone_tonic", owner: "matthewtsmith", project: 2 };

/** A minimal issue node in the shape the GraphQL query asks for. */
function node(number: number, projectItems: unknown[] = []) {
  return {
    number,
    title: `t${number}`,
    body: "",
    state: "OPEN",
    updatedAt: "2026-09-08T00:00:00Z",
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { nodes: [] },
    projectItems: { nodes: projectItems },
  };
}

function page(nodes: unknown[], endCursor: string | null): string {
  return JSON.stringify({
    data: {
      repository: { issues: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
    },
  });
}

const oneIssue = (projectItems: unknown[]): Exec => {
  return async () => ({ code: 0, stdout: page([node(1, projectItems)], null), stderr: "" });
};

const offBoardExec = (): Exec => oneIssue([]);

const otherProjectExec = (): Exec =>
  oneIssue([
    { id: "PVTI_other", project: { number: 7 }, fieldValueByName: { name: "In Progress" } },
  ]);

function pagedExec(calls: string[][]): Exec {
  const pages = [page([node(1)], "c1"), page([node(2)], "c2"), page([node(3)], null)];
  let n = 0;
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: pages[n++] as string, stderr: "" };
  };
}

/** The GraphQL query text a read sends, for asserting on the shape of the request itself. */
async function pickQuery(
  c: typeof cfg,
  run: (g: GitHub) => Promise<unknown> = (g) => g.listIssues(),
): Promise<string> {
  const calls: string[][] = [];
  await run(new GitHub(c, fakeExec(calls), false));
  const call = calls.find((x) => x[2] === "graphql") as string[];
  return gqlVar(call, "query") ?? "";
}

describe("pure parsers", () => {
  it("parseChecks", () => {
    expect(parseChecks([])).toBe("none");
    expect(parseChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("success");
    expect(
      parseChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending");
    expect(
      parseChecks([
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("failure");
    expect(parseChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("success");
  });
  it("parseClosesIssue", () => {
    expect(parseClosesIssue("Closes #142\n\n## What")).toBe(142);
    expect(parseClosesIssue("closes: #7")).toBe(7);
    expect(parseClosesIssue("Fixes #9")).toBe(9);
    expect(parseClosesIssue("no ref")).toBeNull();
  });
  it("parseTouches reads the comma-separated Touches section", () => {
    expect(
      parseTouches("## Touches\n\napps/web, tools/foreman, CLAUDE.md\n\n## Depends on"),
    ).toEqual(["apps/web", "tools/foreman", "CLAUDE.md"]);
    expect(parseTouches("## Touches\n- `packages/db/migrations`\n- apps/api/src\n")).toEqual([
      "packages/db/migrations",
      "apps/api/src",
    ]);
    expect(parseTouches("## Touches\nNone\n\n## Spec")).toEqual([]);
    expect(parseTouches("no section")).toEqual([]);
  });
  it("touchesOverlap is true when either path contains the other", () => {
    expect(touchesOverlap(["tools/foreman"], ["tools/foreman/src/loop.ts"])).toBe(true);
    expect(touchesOverlap(["tools/foreman/src/loop.ts"], ["tools/foreman"])).toBe(true);
    expect(touchesOverlap(["tools/foreman"], ["tools/foreman-web"])).toBe(false);
    expect(touchesOverlap(["apps/web"], ["apps/api"])).toBe(false);
    expect(touchesOverlap([], ["apps/api"])).toBe(false);
  });
  it("parseDependsOn", () => {
    expect(parseDependsOn("## Depends on\n#12, #14\n\n## Spec\nx")).toEqual([12, 14]);
    expect(parseDependsOn("## Depends on\nNone\n\n## Spec")).toEqual([]);
    expect(parseDependsOn("no section")).toEqual([]);
  });
  it("phaseOf and sizeOf", () => {
    expect(phaseOf(["epic", "phase:3"])).toBe(3);
    expect(phaseOf(["size:M"])).toBeNull();
    expect(sizeOf(["size:M"])).toBe("M");
    expect(sizeOf([])).toBeNull();
  });
  it("modelOf reads a model:<name> label and ignores anything that is not a plain model name", () => {
    expect(modelOf(["phase:1", "model:sonnet"])).toBe("sonnet");
    expect(modelOf(["model:claude-haiku-4-5-20251001"])).toBe("claude-haiku-4-5-20251001");
    // It reaches `claude` as argv, so a label that is not a plain name is treated as absent.
    expect(modelOf(["model:--dangerously-skip-permissions"])).toBeNull();
    expect(modelOf(["model:"])).toBeNull();
    expect(modelOf(["size:M"])).toBeNull();
  });
});

describe("GitHub reads", () => {
  it("lists issues with the board status and item id from their own project items", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    const issues = await gh.listIssues();
    expect(issues.length).toBeGreaterThan(0);
    const withStatus = issues.find((i) => i.status !== null);
    expect(withStatus?.itemId).toMatch(/^PVTI_/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
  });
  it("never reads the whole project board (#387)", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    await gh.listIssues();
    await gh.getIssue(93);
    await gh.listIssues("all");
    expect(calls.some((c) => c[2] === "item-list")).toBe(false);
  });
  it("keeps the ledger window gh itself used, so no comment is lost", async () => {
    const q = await pickQuery(cfg);
    expect(q).toContain("comments(last: 100)");
    expect(q).toContain("labels(first: 100)");
    expect(q).toContain("assignees(first: 100)");
    expect(q).toContain("orderBy: { field: CREATED_AT, direction: DESC }");
  });
  it("asks for open issues only, unless asked for all", async () => {
    expect(await pickQuery(cfg, (g) => g.listIssues())).toContain("states: OPEN");
    expect(await pickQuery(cfg, (g) => g.listIssues("all"))).not.toContain("states:");
  });
  it("an issue with no item on this board reads as off the board", async () => {
    const gh = new GitHub(cfg, offBoardExec(), false);
    const [i] = await gh.listIssues();
    expect(i?.status).toBeNull();
    expect(i?.itemId).toBeNull();
  });
  it("ignores a project item belonging to a different project", async () => {
    const gh = new GitHub(cfg, otherProjectExec(), false);
    const [i] = await gh.listIssues();
    expect(i?.status).toBeNull();
    expect(i?.itemId).toBeNull();
  });
  it("pages until GitHub says there is no next page", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, pagedExec(calls), false);
    expect((await gh.listIssues()).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(3);
    expect(gqlVar(calls[0] as string[], "cursor")).toBeNull();
    expect(gqlVar(calls[1] as string[], "cursor")).toBe("c1");
    expect(gqlVar(calls[2] as string[], "cursor")).toBe("c2");
  });
  it("stops paging when hasNextPage is true but the cursor is empty", async () => {
    const exec: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [node(1)] },
          },
        },
      }),
      stderr: "",
    });
    expect(await new GitHub(cfg, exec, false).listIssues()).toHaveLength(1);
  });
  it("lists PRs with parsed checks and issue", async () => {
    const gh = new GitHub(cfg, fakeExec([]), false);
    const prs = await gh.listOpenPRs();
    for (const pr of prs) {
      expect(["success", "pending", "failure", "none"]).toContain(pr.checks);
      expect(pr.issue === null || Number.isInteger(pr.issue)).toBe(true);
    }
    // GitHub's own verdict, so a conflicting branch gets a rebase job instead of a merge (#237).
    expect(prs[0]?.mergeable).toBe("CONFLICTING");
    // The head commit: a CI rerun is budgeted per sha (#362).
    expect(prs[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);
  });
  it("resolves status option ids from field-list", async () => {
    const gh = new GitHub(cfg, fakeExec([]), false);
    const f = await gh.statusField();
    expect(f.fieldId).toMatch(/^PVTSSF_/);
    expect(Object.keys(f.options)).toEqual(
      expect.arrayContaining(["Backlog", "Ready", "In Progress", "In Review", "Done"]),
    );
  });
  it("getIssue reads one issue, not the whole repo, and carries its board status", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    const fromList = (await gh.listIssues()).find((x) => x.number === 93) as Issue;
    calls.length = 0;
    const i = await gh.getIssue(93);
    expect(i.number).toBe(93);
    expect(i.itemId).toBe(fromList.itemId);
    expect(i.status).toBe(fromList.status);
    expect(calls).toHaveLength(1);
    expect(gqlVar(calls[0] as string[], "query")).toContain("issue(number:");
  });
  it("getIssue says which issue is missing rather than returning a blank one", async () => {
    const exec: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify({ data: { repository: { issue: null } } }),
      stderr: "",
    });
    await expect(new GitHub(cfg, exec, false).getIssue(4242)).rejects.toThrow("#4242");
  });
  it("every read is live, so a hand board edit is seen by the next one (#249)", async () => {
    const statuses = ["Backlog", "Ready"];
    let n = 0;
    const exec: Exec = async () => ({
      code: 0,
      stdout: page(
        [
          node(1, [
            { id: "PVTI_1", project: { number: 2 }, fieldValueByName: { name: statuses[n++] } },
          ]),
        ],
        null,
      ),
      stderr: "",
    });
    const gh = new GitHub(cfg, exec, false);
    expect((await gh.listIssues())[0]?.status).toBe("Backlog");
    expect((await gh.listIssues())[0]?.status).toBe("Ready");
  });
  it("reads sub-issues", async () => {
    const gh = new GitHub(cfg, fakeExec([]), false);
    expect(await gh.subIssues(124)).toEqual([125, 126]);
  });
});

describe("GitHub writes", () => {
  it("dry-run performs no gh write calls", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), true);
    await gh.comment("issue", 1, "hi");
    await gh.addLabels("pr", 2, ["reviewer:approved"]);
    await gh.mergePR(2);
    expect(calls).toEqual([]);
  });
  it("mergePR uses squash and deletes the branch", async () => {
    const calls: string[][] = [];
    await new GitHub(cfg, fakeExec(calls), false).mergePR(9);
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "merge",
      "9",
      "--repo",
      cfg.repo,
      "--squash",
      "--delete-branch",
    ]);
  });
  it("rerunFailedChecks posts to the newest run for the sha (#362)", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    const sha = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
    expect(await gh.rerunFailedChecks(sha)).toBe(77);
    expect(calls[0]).toEqual([
      "gh",
      "api",
      `repos/${cfg.repo}/actions/runs?head_sha=${sha}&per_page=1`,
      "--jq",
      ".workflow_runs[0].id // empty",
    ]);
    expect(calls[1]).toEqual([
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${cfg.repo}/actions/runs/77/rerun-failed-jobs`,
    ]);
  });
  it("rerunFailedChecks answers null when the commit has no run, and reruns nothing", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await new GitHub(cfg, exec, false).rerunFailedChecks("deadbeef")).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it("setStatus edits the project item with the option id", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    await gh.setStatus("PVTI_x", "In Review");
    const edit = calls.find((c) => c[2] === "item-edit");
    expect(edit).toContain("--single-select-option-id");
    expect(edit).toContain("PVTI_x");
  });
});
