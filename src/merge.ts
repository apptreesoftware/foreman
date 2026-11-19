import { fixRound, openClaim } from "./ledger.ts";
import { offTargetBlockReason, targetOf } from "./phase.ts";
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
  const spent: Action[] = pairs(s)
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
  return [...spent, ...offTargetBlocks(s)];
}

/**
 * A task In Review whose only open PR is aimed at another branch, or comes from a protected one,
 * is blocked with the fix named. The snapshot pairs no PR with it, so nothing would review,
 * rebase or merge it, nothing would say why, and its phase could never close. This catches a
 * builder that left out `--base` when its base could not be read at `pr_opened`, and PRs already
 * open when a repository switched target. The `blocked` label it adds is what stops it repeating.
 */
function offTargetBlocks(s: Snapshot): Action[] {
  const target = targetOf(s);
  const workable = new Set(s.prs.map((p) => p.issue));
  const out: Action[] = [];
  for (const pr of [...(s.offTargetPRs ?? [])].sort((a, b) => a.number - b.number)) {
    if (pr.issue === null || workable.has(pr.issue)) continue;
    if (out.some((a) => a.type === "block" && a.issue === pr.issue)) continue;
    const issue = s.issues.find((i) => i.number === pr.issue);
    if (
      issue?.state !== "OPEN" ||
      issue.status !== "In Review" ||
      issue.labels.includes("blocked") ||
      issue.labels.includes("epic") ||
      openClaim(issue.comments)
    )
      continue;
    const reason = offTargetBlockReason(pr, target);
    if (reason) out.push({ type: "block", issue: issue.number, reason });
  }
  return out;
}
