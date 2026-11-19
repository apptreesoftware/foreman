import { fixRound, openClaim } from "./ledger.ts";
import { targetOf } from "./phase.ts";
import { ciRerunsSpent, validatorRequired } from "./pick.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
import type { Action, Issue, PullRequest, Snapshot } from "./types.ts";

export { validatorRequired } from "./pick.ts";

export function mergeDecision(
  pr: PullRequest,
  issue: Issue,
  target = "main",
): { ok: true } | { ok: false; reason: string } {
  // The snapshot already drops PRs aimed elsewhere; this is the guard in depth at the merge.
  if (pr.baseRefName !== target)
    return { ok: false, reason: `targets ${pr.baseRefName || "an unknown base"}, not ${target}` };
  if (pr.isDraft) return { ok: false, reason: "draft" };
  if (issue.status !== "In Review") return { ok: false, reason: `issue status ${issue.status}` };
  if (pr.mergeable === "CONFLICTING") return { ok: false, reason: `conflicts with ${target}` };
  if (pr.checks !== "success") return { ok: false, reason: `checks ${pr.checks}` };
  if (!pr.labels.includes("reviewer:approved"))
    return { ok: false, reason: "no reviewer:approved" };
  if (!pr.labels.includes("validator:passed") && !pr.labels.includes("validator:skipped"))
    return { ok: false, reason: "no validator result" };
  return { ok: true };
}

function pairs(s: Snapshot): Array<{ pr: PullRequest; issue: Issue }> {
  return s.prs.flatMap((pr) => {
    const issue = s.issues.find((i) => i.number === pr.issue);
    return issue ? [{ pr, issue }] : [];
  });
}

export function mergeActions(s: Snapshot): Action[] {
  return pairs(s)
    .filter(({ pr, issue }) => mergeDecision(pr, issue, targetOf(s)).ok)
    .map(({ pr, issue }) => ({ type: "merge", pr: pr.number, issue: issue.number }));
}

export function skipValidatorActions(
  s: Snapshot,
  repo: RepoConfig = defaultRepoConfig(),
): Action[] {
  return pairs(s)
    .filter(
      ({ pr, issue }) =>
        issue.status === "In Review" &&
        pr.labels.includes("reviewer:approved") &&
        !pr.labels.some((l) => l.startsWith("validator:")) &&
        !validatorRequired(issue.labels, repo.validator.skipLabels),
    )
    .map(({ pr, issue }) => ({ type: "skip_validator", pr: pr.number, issue: issue.number }));
}

export function blockActions(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Action[] {
  const { fixRounds, ciReruns } = repo.limits;
  return pairs(s)
    .filter(
      ({ pr, issue }) =>
        issue.status === "In Review" &&
        !issue.labels.includes("blocked") &&
        !openClaim(issue.comments) &&
        (pr.labels.includes("reviewer:changes") ||
          pr.labels.includes("validator:failed") ||
          // Red CI that survived its rerun and its fix rounds ends here too, or the PR would sit
          // at idle for ever.
          (pr.checks === "failure" && ciRerunsSpent(pr, issue, ciReruns))) &&
        fixRound(issue.comments) >= fixRounds,
    )
    .map(({ pr, issue }) => ({
      type: "block",
      issue: issue.number,
      reason:
        pr.checks === "failure" && ciRerunsSpent(pr, issue, ciReruns)
          ? `CI still red after a rerun and ${fixRounds} fix rounds`
          : `reviewer/validator requested changes after ${fixRounds} fix rounds`,
    }));
}
