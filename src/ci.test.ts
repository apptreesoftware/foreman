import { describe, expect, it } from "vitest";
import { comment, epic, issue, pr, snapshot } from "../test/helpers.ts";
import { ciActions } from "./ci.ts";
import { fmt } from "./ledger.ts";
import { jobCandidates, MAX_CI_RERUNS } from "./pick.ts";

const SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const approved = ["reviewer:approved", "validator:passed"];

/** The shape that stalled #344: approved, validated, in review, and CI red. */
function stalled(over: { issueOver?: object; prOver?: object } = {}) {
  const i = issue({
    number: 20,
    status: "In Review",
    labels: ["phase:1", "area:web"],
    ...over.issueOver,
  });
  const p = pr({
    number: 90,
    issue: 20,
    labels: approved,
    checks: "failure",
    headSha: SHA,
    ...over.prOver,
  });
  return snapshot({ issues: [i], prs: [p], epics: [epic({ phase: 1 })] });
}

describe("ciActions", () => {
  it("reruns a red PR's failed jobs once, and the rerun costs no session", () => {
    expect(ciActions(stalled())).toEqual([{ type: "ci_rerun", pr: 90, issue: 20, sha: SHA }]);
  });

  it("spends the budget once per head sha", () => {
    const spent = stalled({
      issueOver: { comments: [comment(fmt.ciRerun("mac-a", SHA))] },
    });
    expect(ciActions(spent)).toEqual([]);
    expect(MAX_CI_RERUNS).toBe(1);
  });

  it("starts the budget over on a new push, because the sha is the key", () => {
    const pushed = stalled({
      issueOver: { comments: [comment(fmt.ciRerun("mac-a", OTHER_SHA))] },
      prOver: { headSha: SHA },
    });
    expect(ciActions(pushed)).toEqual([{ type: "ci_rerun", pr: 90, issue: 20, sha: SHA }]);
  });

  it("leaves green, pending and check-less PRs alone", () => {
    for (const checks of ["success", "pending", "none"] as const)
      expect(ciActions(stalled({ prOver: { checks } }))).toEqual([]);
  });

  it("does not rerun under an open claim, a block, a pause, a draft or off In Review", () => {
    expect(
      ciActions(
        stalled({ issueOver: { comments: [comment(fmt.claimed("mac-a", "x", "builder", 1))] } }),
      ),
    ).toEqual([]);
    expect(ciActions(stalled({ issueOver: { labels: ["phase:1", "blocked"] } }))).toEqual([]);
    expect(ciActions(stalled({ issueOver: { status: "In Progress" } }))).toEqual([]);
    expect(ciActions(stalled({ prOver: { isDraft: true } }))).toEqual([]);
    const paused = stalled();
    expect(
      ciActions({
        ...paused,
        epics: [epic({ phase: 1, labels: ["epic", "phase:1", "foreman:pause"] })],
      }),
    ).toEqual([]);
  });

  it("skips a PR whose head sha GitHub did not report", () => {
    expect(ciActions(stalled({ prOver: { headSha: "" } }))).toEqual([]);
  });
});

describe("jobCandidates on red CI (#362)", () => {
  it("queues nothing while the rerun is still owed — that is the cheaper answer", () => {
    expect(jobCandidates(stalled())).toEqual([]);
  });

  it("queues a builder fix round once the rerun is spent and CI is still red", () => {
    const spent = stalled({ issueOver: { comments: [comment(fmt.ciRerun("mac-a", SHA))] } });
    expect(jobCandidates(spent)).toEqual([
      { kind: "fix", round: 2, issue: 20, pr: 90, phase: 1, size: null, contended: false },
    ]);
  });

  it("puts the fix round ahead of a review the branch is not ready for", () => {
    const unreviewed = stalled({
      issueOver: { comments: [comment(fmt.ciRerun("mac-a", SHA))] },
      prOver: { labels: [] },
    });
    expect(jobCandidates(unreviewed).map((c) => c.kind)).toEqual(["fix"]);
  });
});
