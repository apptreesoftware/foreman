import { ciRerunCount, openClaim } from "./ledger.ts";
import { isPaused } from "./pick.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
import type { Action, Snapshot } from "./types.ts";

/**
 * The free half of the red-CI recovery.
 *
 * A failed check on an in-review PR used to produce nothing at all: `mergeDecision` refused the
 * merge on `checks failure` and `jobCandidates` had no branch for it, so an approved and
 * validated PR sat at `idle(nothing eligible)` until someone read the log. Most of those
 * failures are flakes, so the first answer is a rerun of the failed jobs, which
 * costs runner time and no model tokens. `pick.ts` handles the other half: when the rerun budget
 * for this head commit is spent and CI is still red, the PR gets a builder fix round.
 *
 * The budget is per head sha and counted from the issue ledger, so a push starts it over and a
 * daemon restart does not forget what it already tried.
 */
export function ciActions(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Action[] {
  const out: Action[] = [];
  for (const pr of s.prs) {
    if (pr.issue === null || pr.isDraft || pr.checks !== "failure" || !pr.headSha) continue;
    const i = s.issues.find((x) => x.number === pr.issue);
    if (!i || i.status !== "In Review" || i.labels.includes("blocked")) continue;
    // A session holding the issue is already looking at this branch; a rerun underneath it would
    // only race whatever it is about to push.
    if (openClaim(i.comments)) continue;
    if (isPaused(i, s.epics)) continue;
    if (ciRerunCount(i.comments, pr.headSha) >= repo.limits.ciReruns) continue;
    out.push({ type: "ci_rerun", pr: pr.number, issue: i.number, sha: pr.headSha });
  }
  return out;
}
