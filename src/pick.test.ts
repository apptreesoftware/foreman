import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import { buildCandidates, jobCandidates, pick, prioritize } from "./pick.ts";

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
        issue({ number: 14, body: "## Depends on\n#5\n\n## Spec\nx" }),
        issue({ number: 15, body: "## Depends on\n#999\n\n## Spec\nx" }),
        issue({ number: 16, comments: [comment(fmt.claimed("mac-b", hoursAgo(1), "builder", 1))] }),
      ],
    });
    expect(
      buildCandidates(s)
        .map((c) => c.issue)
        .sort((a, b) => a - b),
    ).toEqual([5, 10, 15]);
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
      { kind: "review", issue: 20, pr: s.prs[0]?.number, phase: 1, size: null, round: 1 },
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

describe("prioritize / pick", () => {
  it("orders by phase, then jobs before builds, then size", () => {
    const out = prioritize([
      { kind: "build", issue: 1, pr: null, phase: 2, size: "S", round: 1 },
      { kind: "build", issue: 2, pr: null, phase: 1, size: "L", round: 1 },
      { kind: "review", issue: 3, pr: 9, phase: 1, size: null, round: 1 },
      { kind: "build", issue: 4, pr: null, phase: 1, size: "S", round: 1 },
      { kind: "fix", issue: 5, pr: 8, phase: 1, size: "M", round: 2 },
    ]);
    expect(out.map((c) => c.issue)).toEqual([3, 5, 4, 2, 1]);
  });
  it("pick returns null on an empty snapshot", () => expect(pick(snapshot())).toBeNull());
});
