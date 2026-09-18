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

describe("mergeDecision on a conflicting branch (#237)", () => {
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
  it("blockActions ends the line for a PR whose CI stays red (#362)", () => {
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
