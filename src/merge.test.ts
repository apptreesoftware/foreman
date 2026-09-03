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

const ready = ["reviewer:approved", "validator:passed"];
const inReview = (over = {}) =>
  issue({ number: 20, status: "In Review", labels: ["phase:1", "area:web"], ...over });

describe("validatorRequired", () => {
  it("is false only when every area is infra/db/shared", () => {
    expect(validatorRequired(["area:infra"])).toBe(false);
    expect(validatorRequired(["area:db", "area:shared"])).toBe(false);
    expect(validatorRequired(["area:db", "area:web"])).toBe(true);
    expect(validatorRequired(["size:S"])).toBe(true);
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
  it("skipValidatorActions marks infra-only PRs after approval", () => {
    const s = snapshot({
      issues: [inReview({ labels: ["phase:1", "area:infra"] })],
      prs: [pr({ number: 3, issue: 20, labels: ["reviewer:approved"] })],
    });
    expect(skipValidatorActions(s)).toEqual([{ type: "skip_validator", pr: 3, issue: 20 }]);
    expect(skipValidatorActions(snapshot({ issues: [inReview()], prs: s.prs }))).toEqual([]);
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
