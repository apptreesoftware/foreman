import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import {
  blockActions,
  mergeActions,
  mergeDecision,
  skipValidatorActions,
  validatorRequired,
} from "./merge.ts";
import { defaultRepoConfig } from "./repo-config.ts";
import { plan } from "./state.ts";

const ready = ["reviewer:approved", "validator:passed"];
const inReview = (over = {}) =>
  issue({ number: 20, status: "In Review", labels: ["phase:1", "area:web"], ...over });
const INFRA_EXEMPT_SKIP = ["area:infra", "area:db", "area:shared"];
const INFRA_EXEMPT = { ...defaultRepoConfig(), validator: { skipLabels: INFRA_EXEMPT_SKIP } };

describe("validatorRequired", () => {
  it("is false only when the skip list names every area", () => {
    expect(validatorRequired(["area:infra"], INFRA_EXEMPT_SKIP)).toBe(false);
    expect(validatorRequired(["area:db", "area:shared"], INFRA_EXEMPT_SKIP)).toBe(false);
    expect(validatorRequired(["area:db", "area:web"], INFRA_EXEMPT_SKIP)).toBe(true);
    expect(validatorRequired(["size:S"], INFRA_EXEMPT_SKIP)).toBe(true);
  });
  it("is true for every area with the default empty skip list", () => {
    expect(validatorRequired(["area:infra"], [])).toBe(true);
  });
});

describe("mergeDecision on a PR aimed at another branch", () => {
  it("refuses a PR whose base is not the target, naming both", () => {
    const p = pr({ issue: 20, labels: ready, baseRefName: "main" });
    expect(mergeDecision(p, inReview(), "v2")).toEqual({
      ok: false,
      reason: "targets main, not v2",
    });
    expect(mergeDecision({ ...p, baseRefName: "v2" }, inReview(), "v2").ok).toBe(true);
    // No target named is today's: main.
    expect(mergeDecision(p, inReview()).ok).toBe(true);
  });
  it("names the target when the branch conflicts with it", () => {
    const p = pr({ issue: 20, labels: ready, baseRefName: "v2", mergeable: "CONFLICTING" });
    expect(mergeDecision(p, inReview(), "v2")).toEqual({ ok: false, reason: "conflicts with v2" });
  });
  it("mergeActions merges only PRs on the snapshot's target", () => {
    const s = snapshot({
      targetBranch: "v2",
      issues: [inReview(), inReview({ number: 21 })],
      prs: [
        pr({ number: 5, issue: 20, labels: ready, baseRefName: "v2" }),
        pr({ number: 6, issue: 21, labels: ready, baseRefName: "main" }),
      ],
    });
    expect(mergeActions(s)).toEqual([{ type: "merge", pr: 5, issue: 20 }]);
  });
});

describe("blockActions on a task whose only PR targets another branch", () => {
  const offTarget = (over = {}) =>
    pr({ number: 7, issue: 20, baseRefName: "main", headRefName: "feat/20-x", ...over });
  const reason =
    "PR #7 targets main, not v2; re-aim it (gh pr edit 7 --base v2), or drop the task from its body, and press Unblock";
  it("blocks an In Review task once, naming the base and the fix", () => {
    const s = snapshot({ targetBranch: "v2", issues: [inReview()], offTargetPRs: [offTarget()] });
    expect(blockActions(s)).toEqual([{ type: "block", issue: 20, reason }]);
    expect(plan(s).filter((a) => a.type === "block")).toEqual([
      { type: "block", issue: 20, reason },
    ]);
  });
  it("blocks once even when two off-target PRs name the task", () => {
    const s = snapshot({
      targetBranch: "v2",
      issues: [inReview()],
      offTargetPRs: [offTarget(), offTarget({ number: 8 })],
    });
    expect(blockActions(s)).toHaveLength(1);
  });
  it("says nothing once the task is blocked", () => {
    const s = snapshot({
      targetBranch: "v2",
      issues: [inReview({ labels: ["phase:1", "blocked"] })],
      offTargetPRs: [offTarget()],
    });
    expect(blockActions(s)).toEqual([]);
  });
  it("leaves a task alone that also has a PR on the target", () => {
    const s = snapshot({
      targetBranch: "v2",
      issues: [inReview()],
      prs: [pr({ number: 9, issue: 20, baseRefName: "v2" })],
      offTargetPRs: [offTarget()],
    });
    expect(blockActions(s)).toEqual([]);
  });
  it("treats a PR from main aimed at the target as off-target", () => {
    const s = snapshot({
      targetBranch: "v2",
      issues: [inReview()],
      offTargetPRs: [offTarget({ baseRefName: "v2", headRefName: "main" })],
    });
    const [a] = blockActions(s);
    expect(a).toMatchObject({ type: "block", issue: 20 });
    expect(a?.type === "block" && a.reason).toMatch(/^PR #7 comes from main, a protected branch/);
  });
  it("only touches a task the foreman has In Review, never an epic or a claimed one", () => {
    const at = (over: object) =>
      blockActions(
        snapshot({ targetBranch: "v2", issues: [inReview(over)], offTargetPRs: [offTarget()] }),
      );
    expect(at({ status: "Ready" })).toEqual([]);
    expect(at({ status: "Backlog" })).toEqual([]);
    expect(at({ labels: ["epic", "phase:1"] })).toEqual([]);
    expect(at({ comments: [comment(fmt.claimed("mac-b", hoursAgo(1), "reviewer", 1))] })).toEqual(
      [],
    );
  });
  it("without a target named, a PR aimed at a branch other than main blocks its task", () => {
    const s = snapshot({
      issues: [inReview()],
      offTargetPRs: [offTarget({ baseRefName: "release/1.2" })],
    });
    expect(blockActions(s)).toEqual([
      {
        type: "block",
        issue: 20,
        reason:
          "PR #7 targets release/1.2, not main; re-aim it (gh pr edit 7 --base main), or drop the task from its body, and press Unblock",
      },
    ]);
  });
});

describe("mergeDecision on a conflicting branch", () => {
  it("refuses with a reason the page can show, whatever the checks say", () => {
    const d = mergeDecision(pr({ issue: 20, labels: ready, mergeable: "CONFLICTING" }), inReview());
    expect(d).toEqual({ ok: false, reason: "conflicts with main" });
    expect(
      mergeDecision(pr({ issue: 20, labels: ready, mergeable: "UNKNOWN" }), inReview()).ok,
    ).toBe(true);
  });
});

describe("mergeDecision", () => {
  it("needs In Review, green checks, approval and validation", () => {
    expect(mergeDecision(pr({ issue: 20, labels: ready }), inReview()).ok).toBe(true);
    expect(
      mergeDecision(
        pr({ issue: 20, labels: ["reviewer:approved", "validator:skipped"] }),
        inReview(),
      ).ok,
    ).toBe(true);
    expect(mergeDecision(pr({ issue: 20, labels: ready, checks: "pending" }), inReview()).ok).toBe(
      false,
    );
    expect(mergeDecision(pr({ issue: 20, labels: ready, checks: "failure" }), inReview()).ok).toBe(
      false,
    );
    expect(mergeDecision(pr({ issue: 20, labels: ["reviewer:approved"] }), inReview()).ok).toBe(
      false,
    );
    expect(
      mergeDecision(pr({ issue: 20, labels: ready }), inReview({ status: "In Progress" })).ok,
    ).toBe(false);
    expect(mergeDecision(pr({ issue: 20, labels: ready, isDraft: true }), inReview()).ok).toBe(
      false,
    );
  });
});

describe("actions", () => {
  it("mergeActions lists every mergeable PR", () => {
    const s = snapshot({
      issues: [inReview(), inReview({ number: 21 })],
      prs: [
        pr({ number: 1, issue: 20, labels: ready }),
        pr({ number: 2, issue: 21, labels: ready, checks: "pending" }),
      ],
    });
    expect(mergeActions(s)).toEqual([{ type: "merge", pr: 1, issue: 20 }]);
  });
  it("skipValidatorActions marks infra-only PRs after approval, when the skip list names infra", () => {
    const s = snapshot({
      issues: [inReview({ labels: ["phase:1", "area:infra"] })],
      prs: [pr({ number: 3, issue: 20, labels: ["reviewer:approved"] })],
    });
    expect(skipValidatorActions(s, INFRA_EXEMPT)).toEqual([
      { type: "skip_validator", pr: 3, issue: 20 },
    ]);
    expect(
      skipValidatorActions(snapshot({ issues: [inReview()], prs: s.prs }), INFRA_EXEMPT),
    ).toEqual([]);
  });
  it("skipValidatorActions offers nothing with the default empty skip list", () => {
    const s = snapshot({
      issues: [inReview({ labels: ["phase:1", "area:infra"] })],
      prs: [pr({ number: 3, issue: 20, labels: ["reviewer:approved"] })],
    });
    expect(skipValidatorActions(s)).toEqual([]);
  });
  it("blockActions ends the line for a PR whose CI stays red", () => {
    const sha = "1111111111111111111111111111111111111111";
    const tired = inReview({
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(9), "builder", 2), hoursAgo(9)),
        comment(fmt.finished("x", "mac-a", "pr_opened", 1, 0, 1), hoursAgo(8)),
        comment(fmt.ciRerun("mac-a", sha), hoursAgo(7)),
      ],
    });
    const red = pr({ issue: 20, labels: ready, checks: "failure" as const, headSha: sha });
    expect(blockActions(snapshot({ issues: [tired], prs: [red] }))).toEqual([
      { type: "block", issue: 20, reason: "CI still red after a rerun and 2 fix rounds" },
    ]);
    // Still owed its free rerun: the foreman reruns rather than blocks.
    const owed = inReview({ comments: tired.comments.slice(0, 2) });
    expect(blockActions(snapshot({ issues: [owed], prs: [red] }))).toEqual([]);
  });

  it("blockActions blocks a task that needs a third fix round", () => {
    const tired = inReview({
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(9), "builder", 2), hoursAgo(9)),
        comment(fmt.finished("x", "mac-a", "pr_opened", 1, 0, 1), hoursAgo(8)),
      ],
    });
    const s = snapshot({ issues: [tired], prs: [pr({ issue: 20, labels: ["reviewer:changes"] })] });
    expect(blockActions(s)).toEqual([
      {
        type: "block",
        issue: 20,
        reason: "reviewer/validator requested changes after 2 fix rounds",
      },
    ]);
  });
});
