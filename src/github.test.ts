import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "./exec.ts";
import {
  GitHub,
  parseChecks,
  parseClosesIssue,
  parseDependsOn,
  parseTouches,
  phaseOf,
  sizeOf,
  touchesOverlap,
} from "./github.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "../test/fixtures", n), "utf8");

function fakeExec(calls: string[][]): Exec {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    if (a.startsWith("issue list")) return { code: 0, stdout: fx("issues.json"), stderr: "" };
    if (a.startsWith("issue view")) {
      const n = Number(args[2]);
      const one = (JSON.parse(fx("issues.json")) as Array<{ number: number }>).find(
        (i) => i.number === n,
      );
      return one
        ? { code: 0, stdout: JSON.stringify(one), stderr: "" }
        : { code: 1, stdout: "", stderr: "not found" };
    }
    if (a.startsWith("pr list")) return { code: 0, stdout: fx("prs.json"), stderr: "" };
    if (a.startsWith("project item-list")) return { code: 0, stdout: fx("board.json"), stderr: "" };
    if (a.startsWith("project field-list"))
      return { code: 0, stdout: fx("fields.json"), stderr: "" };
    if (a.startsWith("project view"))
      return { code: 0, stdout: '{"id":"PVT_kwHOAIlXYM4BiXbz"}', stderr: "" };
    if (a.includes("/sub_issues"))
      return { code: 0, stdout: '[{"number":125},{"number":126}]', stderr: "" };
    if (a.startsWith("api user"))
      return { code: 0, stdout: '{"login":"matthewtsmith"}', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}
const cfg = { repo: "matthewtsmith/tone_tonic", owner: "matthewtsmith", project: 2 };

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
});

describe("GitHub reads", () => {
  it("lists issues merged with board status", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    const issues = await gh.listIssues();
    expect(issues.length).toBeGreaterThan(0);
    const withStatus = issues.find((i) => i.status !== null);
    expect(withStatus?.itemId).toMatch(/^PVTI_/);
    expect(calls.some((c) => c[1] === "issue" && c[2] === "list")).toBe(true);
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
  });
  it("resolves status option ids from field-list", async () => {
    const gh = new GitHub(cfg, fakeExec([]), false);
    const f = await gh.statusField();
    expect(f.fieldId).toMatch(/^PVTSSF_/);
    expect(Object.keys(f.options)).toEqual(
      expect.arrayContaining(["Backlog", "Ready", "In Progress", "In Review", "Done"]),
    );
  });
  it("getIssue reads one issue, not the whole repo", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    const board = await gh.listBoard();
    const onBoard = board.find((b) => b.issue === 93) as (typeof board)[number];
    const i = await gh.getIssue(93);
    expect(i.number).toBe(93);
    expect(i.itemId).toBe(onBoard.itemId);
    expect(calls.some((c) => c[1] === "issue" && c[2] === "list")).toBe(false);
    expect(calls.some((c) => c[1] === "issue" && c[2] === "view")).toBe(true);
  });
  it("fetches the board once and reuses it", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    await gh.listIssues();
    await gh.listIssues();
    await gh.listBoard();
    expect(calls.filter((c) => c[2] === "item-list")).toHaveLength(1);
  });
  it("re-reads the board after a status write", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    await gh.listBoard();
    await gh.setStatus("PVTI_x", "Ready");
    await gh.listBoard();
    expect(calls.filter((c) => c[2] === "item-list")).toHaveLength(2);
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
  it("setStatus edits the project item with the option id", async () => {
    const calls: string[][] = [];
    const gh = new GitHub(cfg, fakeExec(calls), false);
    await gh.setStatus("PVTI_x", "In Review");
    const edit = calls.find((c) => c[2] === "item-edit");
    expect(edit).toContain("--single-select-option-id");
    expect(edit).toContain("PVTI_x");
  });
});
