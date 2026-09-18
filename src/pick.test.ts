import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import { buildCandidates, heldPhases, jobCandidates, pick, prioritize } from "./pick.ts";
import { defaultRepoConfig } from "./repo-config.ts";

const INFRA_EXEMPT = {
  ...defaultRepoConfig(),
  validator: { skipLabels: ["area:infra", "area:db", "area:shared"] },
};

describe("buildCandidates", () => {
  it("requires Ready + agent-ready + no open claim + deps closed + not blocked", () => {
    const dep = issue({ number: 5, state: "OPEN" });
    const s = snapshot({
      issues: [
        dep,
        issue({ number: 10 }),
        issue({ number: 11, status: "Backlog" }),
        issue({ number: 12, labels: ["phase:1", "size:S"] }),
        issue({ number: 13, labels: ["phase:1", "agent-ready", "blocked"] }),
        issue({ number: 14, body: "## Depends on\n#5\n\n## Spec\nx\n\nParent epic: #1" }),
        issue({ number: 15, body: "## Depends on\n#999\n\n## Spec\nx\n\nParent epic: #1" }),
        issue({ number: 16, comments: [comment(fmt.claimed("mac-b", hoursAgo(1), "builder", 1))] }),
      ],
    });
    expect(
      buildCandidates(s)
        .map((c) => c.issue)
        .sort((a, b) => a - b),
    ).toEqual([5, 10, 15]);
  });
  it("ignores an issue whose body has no `Parent epic:` line", () => {
    const s = snapshot({
      issues: [
        issue({ number: 20 }),
        issue({ number: 21, body: "## Depends on\nNone\n\n## Spec\ndocs/x.md" }),
      ],
    });
    expect(buildCandidates(s).map((c) => c.issue)).toEqual([20]);
  });
  it("skips paused phases and phases behind an unsigned direction-critical epic", () => {
    const s = snapshot({
      epics: [
        epic({ phase: 1, labels: ["epic", "phase:1", "foreman:pause"] }),
        epic({ phase: 2, directionCritical: true, labels: ["epic", "phase:2", "plan-approved"] }),
        epic({ phase: 3, labels: ["epic", "phase:3", "plan-approved"] }),
      ],
      issues: [
        issue({ number: 1, labels: ["phase:1", "agent-ready"] }),
        issue({ number: 2, labels: ["phase:2", "agent-ready"] }),
        issue({ number: 3, labels: ["phase:3", "agent-ready"] }),
      ],
    });
    expect(buildCandidates(s).map((c) => c.issue)).toEqual([2]);
  });
  it("ignores epics themselves", () => {
    const s = snapshot({ issues: [issue({ labels: ["epic", "phase:1", "agent-ready"] })] });
    expect(buildCandidates(s)).toEqual([]);
  });
});

describe("jobCandidates", () => {
  const inReview = (over = {}) =>
    issue({ number: 20, status: "In Review", labels: ["phase:1", "area:web"], ...over });
  it("offers review when the PR has no reviewer label", () => {
    const s = snapshot({ issues: [inReview()], prs: [pr({ issue: 20 })] });
    expect(jobCandidates(s)).toEqual([
      {
        kind: "review",
        issue: 20,
        pr: s.prs[0]?.number,
        phase: 1,
        size: null,
        round: 1,
        contended: false,
      },
    ]);
  });
  it("offers validate after approval", () => {
    const s = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, labels: ["reviewer:approved"] })],
    });
    expect(jobCandidates(s)[0]?.kind).toBe("validate");
  });
  it("offers a fix round after changes or validator failure", () => {
    const s = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, labels: ["reviewer:changes"] })],
    });
    expect(jobCandidates(s)[0]).toMatchObject({ kind: "fix", round: 2 });
    const t = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, labels: ["reviewer:approved", "validator:failed"] })],
    });
    expect(jobCandidates(t)[0]).toMatchObject({ kind: "fix", round: 2 });
  });
  it("offers nothing past round 2 or while a claim is open", () => {
    const tired = inReview({
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(9), "builder", 2), hoursAgo(9)),
        comment(fmt.finished("x", "mac-a", "pr_opened", 1, 0, 1), hoursAgo(8)),
      ],
    });
    expect(
      jobCandidates(
        snapshot({ issues: [tired], prs: [pr({ issue: 20, labels: ["reviewer:changes"] })] }),
      ),
    ).toEqual([]);
    const busy = inReview({
      comments: [comment(fmt.claimed("mac-b", hoursAgo(1), "reviewer", 1))],
    });
    expect(jobCandidates(snapshot({ issues: [busy], prs: [pr({ issue: 20 })] }))).toEqual([]);
  });
  it("offers nothing when the PR is merged-ready (validator passed)", () => {
    const s = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, labels: ["reviewer:approved", "validator:passed"] })],
    });
    expect(jobCandidates(s)).toEqual([]);
  });
});

describe("rebase jobs (#237)", () => {
  const inReview = (over = {}) =>
    issue({ number: 20, status: "In Review", labels: ["phase:1", "area:web"], ...over });
  const done = ["reviewer:approved", "validator:passed"];
  it("offers a rebase for an approved PR that conflicts with main, at the current round", () => {
    // Two fix rounds already spent: a rebase is not a third, so the round stays at 2.
    const tired = inReview({
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(9), "builder", 2), hoursAgo(9)),
        comment(fmt.finished("x", "mac-a", "pr_opened", 1, 0, 1), hoursAgo(8)),
      ],
    });
    const s = snapshot({
      issues: [tired],
      prs: [pr({ issue: 20, labels: done, mergeable: "CONFLICTING" })],
    });
    expect(jobCandidates(s)).toEqual([
      {
        kind: "rebase",
        issue: 20,
        pr: s.prs[0]?.number,
        phase: 1,
        size: null,
        round: 2,
        contended: false,
      },
    ]);
  });
  it("offers a rebase for an approved infra PR before the validator is skipped", () => {
    const infra = inReview({ labels: ["phase:1", "area:infra"] });
    const s = snapshot({
      issues: [infra],
      prs: [pr({ issue: 20, labels: ["reviewer:approved"], mergeable: "CONFLICTING" })],
    });
    expect(jobCandidates(s)[0]?.kind).toBe("rebase");
  });
  it("leaves a conflict to the fix round or the review when those are still due", () => {
    const changes = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, labels: ["reviewer:changes"], mergeable: "CONFLICTING" })],
    });
    expect(jobCandidates(changes)[0]).toMatchObject({ kind: "fix", round: 2 });
    const unreviewed = snapshot({
      issues: [inReview()],
      prs: [pr({ issue: 20, mergeable: "CONFLICTING" })],
    });
    expect(jobCandidates(unreviewed)[0]?.kind).toBe("review");
  });
  it("offers no rebase for a mergeable or unknown PR", () => {
    for (const mergeable of ["MERGEABLE", "UNKNOWN"] as const) {
      const s = snapshot({
        issues: [inReview()],
        prs: [pr({ issue: 20, labels: done, mergeable })],
      });
      expect(jobCandidates(s)).toEqual([]);
    }
  });
});

describe("blocked backpressure (#237)", () => {
  const blocked = (number: number, phase = 1) =>
    issue({ number, status: "Ready", labels: [`phase:${phase}`, "agent-ready", "blocked"] });
  it("holds new builds in a phase with MAX_BLOCKED_PER_PHASE blocked tasks", () => {
    const s = snapshot({
      issues: [
        blocked(1),
        blocked(2),
        issue({ number: 3, labels: ["phase:1", "agent-ready"] }),
        issue({ number: 4, labels: ["phase:2", "agent-ready"] }),
      ],
    });
    expect(defaultRepoConfig().limits.blockedPerPhase).toBe(2);
    expect(buildCandidates(s).map((c) => c.issue)).toEqual([4]);
    expect(heldPhases(s)).toEqual([1]);
  });
  it("one blocked task holds nothing; closed and epic issues do not count", () => {
    const s = snapshot({
      issues: [
        blocked(1),
        issue({ number: 2, state: "CLOSED", labels: ["phase:1", "blocked"] }),
        issue({ number: 9, labels: ["epic", "phase:1", "blocked"] }),
        issue({ number: 3, labels: ["phase:1", "agent-ready"] }),
      ],
    });
    expect(buildCandidates(s).map((c) => c.issue)).toEqual([3]);
    expect(heldPhases(s)).toEqual([]);
  });
  it("still offers review, fix and rebase jobs in a held phase", () => {
    const s = snapshot({
      issues: [
        blocked(1),
        blocked(2),
        issue({ number: 20, status: "In Review", labels: ["phase:1", "area:web"] }),
      ],
      prs: [pr({ issue: 20 })],
    });
    expect(jobCandidates(s)[0]?.kind).toBe("review");
  });
});

describe("contended builds (#237)", () => {
  const touching = (number: number, touches: string, over = {}) =>
    issue({
      number,
      labels: ["phase:1", "agent-ready"],
      body: `## Touches\n\n${touches}\n\n## Depends on\nNone\n\n## Spec\ndocs/x.md\n\nParent epic: #1`,
      ...over,
    });
  it("marks a build whose Touches overlap an issue with an open PR", () => {
    const s = snapshot({
      issues: [
        touching(10, "tools/foreman/src, CLAUDE.md", { status: "In Review" }),
        touching(11, "tools/foreman"),
        touching(12, "apps/web/src/routes"),
        touching(13, "tools/foreman/src/loop.ts"),
      ],
      prs: [pr({ issue: 10 })],
    });
    const by = Object.fromEntries(buildCandidates(s).map((c) => [c.issue, c.contended]));
    expect(by).toEqual({ 11: true, 12: false, 13: true });
  });
  it("sorts uncontended builds first within a phase and kind, before size", () => {
    const out = prioritize([
      { kind: "build", issue: 1, pr: null, phase: 1, size: "S", round: 1, contended: true },
      { kind: "build", issue: 2, pr: null, phase: 1, size: "L", round: 1, contended: false },
      { kind: "rebase", issue: 3, pr: 9, phase: 1, size: null, round: 2, contended: false },
      { kind: "review", issue: 4, pr: 8, phase: 1, size: null, round: 1, contended: false },
    ]);
    expect(out.map((c) => c.issue)).toEqual([3, 4, 2, 1]);
  });
});

describe("prioritize / pick", () => {
  it("orders by phase, then jobs before builds, then size", () => {
    const out = prioritize([
      { kind: "build", issue: 1, pr: null, phase: 2, size: "S", round: 1, contended: false },
      { kind: "build", issue: 2, pr: null, phase: 1, size: "L", round: 1, contended: false },
      { kind: "review", issue: 3, pr: 9, phase: 1, size: null, round: 1, contended: false },
      { kind: "build", issue: 4, pr: null, phase: 1, size: "S", round: 1, contended: false },
      { kind: "fix", issue: 5, pr: 8, phase: 1, size: "M", round: 2, contended: false },
    ]);
    expect(out.map((c) => c.issue)).toEqual([3, 5, 4, 2, 1]);
  });
  it("pick returns null on an empty snapshot", () => expect(pick(snapshot())).toBeNull());
});

describe("jobCandidates respects validatorRequired", () => {
  it("offers no validate job for an approved PR on an infra-only issue whose skip list names it", () => {
    const infra = issue({ number: 30, status: "In Review", labels: ["phase:1", "area:infra"] });
    const s = snapshot({
      issues: [infra],
      prs: [pr({ issue: 30, labels: ["reviewer:approved"] })],
    });
    expect(jobCandidates(s, INFRA_EXEMPT)).toEqual([]);
  });
  it("with the default empty skip list, an infra-only issue still needs a validator", () => {
    const infra = issue({ number: 30, status: "In Review", labels: ["phase:1", "area:infra"] });
    const s = snapshot({
      issues: [infra],
      prs: [pr({ issue: 30, labels: ["reviewer:approved"] })],
    });
    expect(jobCandidates(s)[0]?.kind).toBe("validate");
  });
  it("still offers validate for an approved PR on a web issue", () => {
    const web = issue({ number: 31, status: "In Review", labels: ["phase:1", "area:web"] });
    const s = snapshot({ issues: [web], prs: [pr({ issue: 31, labels: ["reviewer:approved"] })] });
    expect(jobCandidates(s)[0]?.kind).toBe("validate");
  });
});
