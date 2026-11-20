# Target branch — design

Date: 2026-11-19
Status: approved by the owner 2026-11-19

## Problem

The foreman always works against the served repository's GitHub default branch. A project that
builds a rewrite on a long-lived branch (MC v2 on `v2`, while `main` keeps shipping v1) cannot be
served: builder and planner PRs open against `main`, the foreman merges them there, and any human PR
to `main` whose body says `Closes #N` for a foreman task is paired with that task and can be
reviewed, rebased or merged.

## Outcome

An optional `.foreman/config.json` key, `targetBranch`, names the branch the foreman builds into.
Absent, every repository behaves exactly as today (the GitHub default branch). Set, the foreman
works only on that branch and never touches PRs aimed anywhere else.

## Decisions

| Question | Decision |
|---|---|
| Key | `targetBranch: string` (optional, non-empty). Absent = `gh.defaultBranch()` as today. |
| Where the setup lives | A dedicated clone for the daemon, checked out on the target branch. `.foreman/` lives only on that branch; the default branch never sees it. Documented, not enforced. |
| PRs aimed elsewhere | Ignored entirely: filtered out of the snapshot before pairing, picking, CI reruns, plan-PR lookup and merging. A merge additionally refuses a PR whose base is not the target. |
| Session push protection | The composed session settings deny pushing, checking out, switching to and deleting the target branch, in addition to the static `main`/`master` denies, which stay. |
| Missing remote branch | A preflight check parks the daemon with a named reason when `origin/<target>` does not exist, instead of blocking every issue at worktree setup. |

## Changes

1. `src/repo-config.ts`: `targetBranch: z.string().min(1).optional()`. `init` scaffold does not write it.
2. Resolution: `src/cli/daemon.ts` and `src/cli/ctl.ts` use `repo.targetBranch ?? await gh.defaultBranch()`;
   rename `Ctx.defaultBranch` to `targetBranch` (default `"main"` in tests).
3. Prompts: a `{{targetBranch}}` placeholder in `src/prompts.ts` `fill`. `roles/builder.md` uses it
   for every `git merge origin/…` and `gh pr create --base {{targetBranch}}`; `roles/planner.md`'s
   plan PR names `--base {{targetBranch}}`; ground-rules, reviewer, planner and phase-closer say
   "the target branch (`{{targetBranch}}`)". The session header in `src/dispatch.ts` says
   "Never touch {{targetBranch}}" instead of "Never touch main".
4. Phase-closer: GitHub only records closing PRs for the default branch, so its merged-PR lookup
   uses the `gh pr list --state merged --base {{targetBranch}} --search "<n> in:body"` path first.
5. `src/github.ts` `listOpenPRs`: request `baseRefName`; `PullRequest.baseRefName`. The snapshot
   (`src/loop.ts` `buildSnapshot`) keeps only PRs whose base is the target. `planPR` (`src/phase.ts`)
   gets the same filter. `mergeDecision` (`src/merge.ts`) refuses a base mismatch.
6. `src/prompts.ts` `writeSessionFiles`: target-branch denies next to `worktreeDenies`, skipped when
   the target is `main` or `master` (already denied statically).
7. Preflight: `git ls-remote --exit-code --heads origin <target>` when `targetBranch` is set; failure
   parks with `target branch <name> not found on origin`.
8. `foreman epic new`: `fileOnDefaultBranch` takes a ref; it checks the spec on the target branch.
9. User-facing text that says "main" for the base branch (merge reasons, waiting text, plan logs,
   daemon fallback warning) names the actual target branch.
10. README: the config row, the dedicated-clone setup, and the CI note below.

## Known limits (README)

- The served repository's CI must run on PRs to the target branch; a workflow filtered to
  `branches: [main]` leaves task PRs at `checks none` (never merged) and plan PRs merging unchecked.
- `Closes #N` does not auto-close or link on a non-default base; the foreman closes the issue
  itself after a merge, as it already does.
- Branch protection on the target branch can refuse `gh pr merge`; that surfaces as a failed tick.

## Testing

Unit tests for each change: config parse (absent, set, empty refused); resolution precedence;
`fill` substitution and role text; PR base filtering in the snapshot, `planPR` and `mergeDecision`;
session denies for a non-main target and none extra for `main`; preflight park; `epic new` ref.
Existing tests keep passing unchanged where the key is absent. A `--dry-run` tick against the MC
repository's `v2` dedicated clone before any live run.
