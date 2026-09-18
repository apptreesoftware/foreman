# foreman

[![npm](https://img.shields.io/npm/v/@apptreesoftware/foreman)](https://www.npmjs.com/package/@apptreesoftware/foreman)

```bash
npm i -g @apptreesoftware/foreman
```

## 1. What it is

The foreman is a small TypeScript daemon that runs a GitHub issue pipeline unattended. It shells
out to the `claude` CLI (`claude -p`) to run planner, builder, reviewer, validator and
phase-closer sessions against issues on a GitHub Projects v2 board, and does the deterministic
bookkeeping — labels, board status, claims, PR merges — in between. All judgment happens inside
the `claude -p` sessions; the foreman itself never decides anything more interesting than "whose
turn is it" and "did CI pass".

One daemon runs one repository. Several daemons run on one Mac, one per repository, each with its
own state directory, its own daily budget and its own web page. Everything the daemon needs to
know about a repository — how to install it, what the checks are, what a validator boots, what a
reviewer must check — is committed in that repository under `.foreman/`, so the tool itself stays
generic and a change to the process ships as a pull request like anything else.

The pipeline is fixed and always on: **epic → planner → tasks → builder → reviewer → validator →
merge → phase-closer**. The five roles are hardcoded, the label names and board statuses are
hardcoded, and the foreman only works tasks that its own planner created. Section 4 is the whole
process; section 5 is everything a repository gets to change about it.

Design: [`docs/2026-09-18-foreman-extraction-design.md`](docs/2026-09-18-foreman-extraction-design.md).

## 2. Install

On a Mac, with [Homebrew](https://brew.sh):

```bash
brew install gh node@22
npm i -g @apptreesoftware/foreman
foreman help
```

Node 22 is required (`"engines": { "node": ">=22.18 <23" }`). `launchd` is macOS-only; `foreman
run` works anywhere Node does.

Authenticate `gh` with the scopes the board needs:

```bash
gh auth login
gh auth refresh -s project,read:project
gh auth status          # must list 'project' under "Token scopes"
```

Install the `claude` CLI and log it in **once, interactively**, so that sessions run against a
Claude subscription rather than API billing:

```bash
claude                  # accept the trust dialog, then quit
claude auth status      # must show "authMethod":"claude.ai"
```

The daemon refuses to start a session if `claude auth status` is anything else, or if
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`ANTHROPIC_FOUNDRY_API_KEY` or `ANTHROPIC_AWS_API_KEY` is set in its environment. Check with:

```bash
env | grep -i -E 'anthropic|claude_code_use'    # must print nothing
```

Verify the billing once per Mac before you leave a daemon running unattended: run one session,
then confirm <https://platform.claude.com/settings/usage> shows **no** new API usage and
<https://claude.ai/settings/usage> shows the session that just ran.

## 3. Set up a repository

Four commands take a repository from nothing to a daemon working its first phase.

```bash
git clone git@github.com:acme/widgets.git ~/Projects/widgets
foreman add widgets --repo acme/widgets --repo-dir ~/Projects/widgets
foreman -p widgets init
```

`add` writes `~/.foreman/widgets/foreman.json` and picks the first free web port from 8090. `host`
defaults to this Mac's short hostname, lowercased — it is how ledger comments tell Macs apart, so
override it with `--host` if two Macs would collide. `--web-port` pins the port; `add` refuses one
another instance already holds.

`init` is idempotent and does four things, in order:

1. Checks the `gh` token has the `project` scope, and stops with the `gh auth refresh` line if not.
2. Creates any missing label: `epic`, `agent-ready`, `blocked`, `needs-owner`, `decision`,
   `plan-approved`, `signed-off`, `foreman:pause`, `sandbox`, `reviewer:approved`,
   `reviewer:changes`, `validator:passed`, `validator:failed`, `validator:skipped`, `size:S`,
   `size:M`, `size:L`, and `model:<m>` for each entry in `.foreman/config.json`'s `models`.
   `phase:N` and `area:*` labels are created later, by `epic new` and by the planner.
3. Creates a Projects v2 board, links it to the repository, sets the `Status` single-select
   options to exactly **Backlog, Ready, In Progress, In Review, Done**, and writes the project
   number back into `foreman.json`. If `project` is already set it verifies the field and reports
   drift instead of editing.
4. Scaffolds `.foreman/` in the clone if it is absent: `config.json` with the defaults,
   an empty `rules.md`, `settings.json` with empty `allow`/`deny`, and an empty `hooks/`.

Nothing in step 4 is committed. Review it, fill in `rules.md`, and commit it — the daemon reads
`.foreman/` **from the worktree at dispatch time**, so a PR that changes it applies to the
sessions that run on that branch:

```bash
cd ~/Projects/widgets
$EDITOR .foreman/config.json .foreman/rules.md
git add .foreman && git commit -m "chore: foreman config" && git push
```

Open the phase epic — the one human-made issue per phase, and the only entry point:

```bash
foreman -p widgets epic new --title "Phase 1: accounts" --phase 1 --spec docs/specs/accounts.md --agent-ready
```

The spec path must exist on the default branch and match `plans.specGlob`. The issue is created
with labels `epic`, `phase:1` and (with `--agent-ready`) `agent-ready`, body `## Spec\n<path>`, and
added to the board at **Backlog**. Without `--agent-ready` the planner will not touch it until you
add the label by hand — that is the go-ahead.

Dry-run one iteration, which reads GitHub and writes nothing:

```bash
foreman -p widgets run --once --dry-run
```

Expect a `preflight ok` line and a `plan` line. Then run it for real:

```bash
foreman -p widgets run --once      # one iteration in the foreground
foreman -p widgets start           # detach, log to ~/.foreman/widgets/logs/foreman.log
foreman -p widgets status --watch
foreman -p widgets page            # opens http://127.0.0.1:8090
```

Once you trust it, hand it to `launchd` so it starts at login and comes back after a crash:

```bash
foreman -p widgets launchd install
foreman -p widgets launchd status
foreman -p widgets launchd uninstall
```

`launchd install` writes `~/Library/LaunchAgents/com.apptreesoftware.foreman.widgets.plist` with
concrete paths and bootstraps it. The plist sets `KeepAlive`, `RunAtLoad` and `ThrottleInterval`
60 s, and unsets the API-billing environment variables.

## 4. The process

Every `pollSeconds` (default 300) the daemon wakes and runs one iteration:

1. **Preflight.** Refuses to run if an API-billing environment variable is set, if
   `~/.foreman/<name>/STOP` exists, if `claude auth status` is not a `claude.ai` login, if `gh auth
   status` fails or its token lacks the `project` scope, if GitHub reports fewer than
   `minGraphqlPoints` GraphQL points left, or if today's session count has reached
   `maxSessionsPerDay`. Then it runs the repository's `preflight` hook (§5).
2. **Resume check.** If an issue on the board is In Progress and claimed by this host, that
   session is resumed instead of anything new being picked.
3. **Merge sweep.** For every open, non-draft PR whose issue is In Review: if CI is green, the PR
   carries `reviewer:approved`, and it carries `validator:passed` or `validator:skipped`, the
   foreman squash-merges, closes the issue, sets Status Done and comments `merged by
   foreman@<host>`.
4. **CI rerun.** For every in-review PR whose checks are `failure`, with no open claim, no
   `blocked` label and no paused epic, the foreman reruns the failed jobs of the newest workflow
   run for the PR's head commit and comments `ci rerun by foreman@<host> for <sha>` on the issue.
   `limits.ciReruns` (1) per head sha, counted from that ledger comment, so a push starts the
   budget over and a daemon restart does not forget. This is the cheap half of red-CI recovery:
   most failures are flakes, and a rerun costs runner time and no model tokens. The expensive half
   is in the pick — a red PR whose rerun is spent gets a builder **fix** round, ahead of review and
   validation, bounded by `limits.fixRounds` like any other, and `blocked` after that.
5. **Pick.** Candidates are issues with Status Ready, label `agent-ready`, a `Parent epic: #N`
   line in the body, no open claim, every "Depends on" issue closed, and a phase epic that is not
   `foreman:pause`d. Open PRs needing review or validation are candidates too, and so is an
   approved PR whose branch GitHub reports as `CONFLICTING`: that gets a **rebase** round — a
   builder session that only merges the default branch, runs the checks and pushes — at the
   current fix-round number, so it never counts toward `limits.fixRounds`. Priority: lowest phase
   number, then rebase, review and validate jobs before fix rounds, then new builds; among builds,
   one whose **Touches** section overlaps an issue that already has an open PR sorts after one
   that does not, then `size:S` before `M` before `L`. A phase with `limits.blockedPerPhase` (2)
   or more open `blocked` tasks starts **no new builds** until the owner unblocks one — review,
   fix, validate and rebase jobs still run there — because every blocked task is owner work and
   stacking more branches on the same files only breeds conflicts.
6. **Claim.** The foreman comments `claimed by <host> at <iso> role=<role> round=<n>`, assigns
   itself, and (for a first-round build) sets Status In Progress. If another host's claim comment
   landed in the same window, the alphabetically first host keeps it; the others comment `released
   by <host>: conflict` and unassign. The ledger — issue comments, not the GitHub assignee — is
   authoritative, so two Macs can share one GitHub login.
7. **Dispatch.** Creates or reuses a git worktree at `<workDir>/<issue>` — by default
   `<repoDir>/.worktrees/<issue>`, so worktrees stay inside the clone — on branch
   `feat/<issue>-<slug>`, runs the repository's `setup` command, composes the role prompt and the
   headless settings from the worktree's `.foreman/` (§5), runs the `session-env` and
   `before-session` hooks, and invokes `claude -p` with the role prompt, the issue/PR/worktree/
   branch context, `--max-turns <maxTurns>`, `--model <model>` and a `wallClockMinutes` timeout.
   It posts `session <id> on <host> role=<role> attempt=<n>` before each attempt and runs
   `after-session` when the child ends, however it ends.
8. **Outcome.** Parses the session's structured JSON outcome —
   `{"outcome": ..., "pr": <number|null>, "notes": "..."}` — and applies the labels and Status in
   the table below. On a validator `passed`/`failed` it first copies
   `<worktree>/.validation-artifacts/<pr>/` to `~/.foreman/<name>/artifacts/<pr>/`, because a
   headless session cannot write outside its worktree and the worktree is removed at merge. A
   session that ends without a valid outcome is retried up to `limits.attempts` (3) times; if all
   fail, the issue is labelled `blocked` with a log excerpt and unassigned.
9. **Phase check.** If every task under a phase epic is closed, the phase-closer is dispatched.
   Then the planner, which is gated three ways: the epic must carry **`agent-ready`** (the owner's
   go-ahead — without it the foreman never plans anything), no approved phase may still be
   building, and no other epic's drafted plan may be waiting on the owner. When it dispatches, the
   epic is assigned and set In Progress so the hour-long session is visible on the board;
   `plan_drafted` then sets the epic In Review, adds `needs-owner`, removes `agent-ready` and
   unassigns. Labelling the epic `plan-approved` applies the plan, clears `needs-owner` and puts
   the epic back In Progress. Re-adding `agent-ready` asks for a re-plan. Applying a plan reads
   `<plans.dir>/<date>-phase-NN-plan.issues.json` from the default branch on `origin`, so merging
   the plan PR is enough — the clone never has to be pulled by hand. If the file is not there yet,
   the foreman logs and retries next tick rather than recording the plan as applied.

These run in order and stop after the first action that would start a `claude -p` session, so at
most one session runs per iteration per Mac.

An iteration that did work does **not** then sleep `pollSeconds`. Work is anything that changed
the board: a session started, a PR merged, a plan applied, a claim released, an issue blocked. A
CI rerun is deliberately **not** work — its checks stay pending for minutes. The next tick runs
immediately and the log says `ticking again immediately` with the action that earned it. An
iteration that found nothing eligible sleeps the full interval; a failed one backs off, doubling
per consecutive failure up to 15 minutes.

Applying a plan is idempotent: a task without a `number` is created only if no open issue already
carries its title and a `Parent epic: #<epic>` line, so a tick that failed halfway finishes the
plan on retry instead of duplicating it.

### Outcome → labels / status

| Role outcome | Labels / Status set by the foreman |
|---|---|
| builder `pr_opened` | issue → In Review |
| builder `blocked` | issue `blocked`, unassigned |
| reviewer `approved` / `changes_requested` | PR `reviewer:approved` / `reviewer:changes` |
| validator `passed` / `failed` | PR `validator:passed` / `validator:failed` |
| (foreman) issue carries a `validator.skipLabels` label | PR `validator:skipped` |
| (foreman) green CI + approved + validated | squash merge, issue closed → Done, `merged by foreman@<host>` |
| third change request | issue `blocked` |
| (foreman) approved PR `CONFLICTING` on GitHub | builder rebase round (merges the default branch, no fix-round bump) |
| (foreman) red CI, rerun budget unspent | rerun the failed jobs, `ci rerun by foreman@<host> for <sha>` (no session) |
| (foreman) red CI, rerun spent | builder fix round; `blocked` once `limits.fixRounds` are gone |
| phase-closer `phase_closed` | epic → In Review, `needs-owner` |
| planner `plan_drafted` | epic → In Review, `needs-owner`, `agent-ready` removed, unassigned; nothing else until `plan-approved`, which applies the plan (tasks `agent-ready` + Ready), clears `needs-owner` and returns the epic to In Progress |

### Labels

Fixed names; `foreman init` creates them all.

| Label | Meaning |
|---|---|
| `epic` | A phase's parent issue. |
| `agent-ready` | On an epic: plan it. On a task: the foreman may claim it. Only the planner's own tasks are ever claimed. |
| `phase:N` | Which phase an epic or task belongs to. Created by `epic new` and by the planner. |
| `area:*`, `size:S` / `size:M` / `size:L` | Set by the planner; `size` orders the pick, `area` can skip validation. |
| `blocked` | Cannot proceed; the reason is a comment. Owner work. |
| `needs-owner` | Waiting on the owner. |
| `decision` | A question a role session could not answer. |
| `plan-approved` | The owner approved the drafted plan; the next tick applies it. |
| `signed-off` | The owner signed the phase off. |
| `foreman:pause` | On an epic: no new claims under that phase, on any Mac. |
| `reviewer:approved` / `reviewer:changes` | The reviewer's verdict, on the PR. |
| `validator:passed` / `validator:failed` / `validator:skipped` | The validator's verdict, on the PR. |
| `model:<name>` | Pins every session on that issue to one model, outranking the live override and `foreman.json`. |
| `sandbox` | A throwaway issue for exercising the pipeline. |

### Board statuses

Exactly five, in this order: **Backlog** (an epic before planning) → **Ready** (a task the picker
may claim) → **In Progress** (claimed, a session running) → **In Review** (a PR is open, or an
epic is waiting on the owner) → **Done** (merged and closed).

### Issue body sections

The planner writes every task issue in this shape, and the picker depends on it:

```markdown
## Goal
One paragraph.
## Acceptance criteria
- [ ] Each one is something a validator can observe.
## Touches
src/thing.ts, docs/specs/accounts.md
## Depends on
#12, #13   (or None)
## Spec
docs/specs/accounts.md § 3

Parent epic: #7
```

`Depends on` gates the pick until those issues are closed. `Touches` orders the pick away from
conflicts. **`Parent epic: #N` is required** — an `agent-ready` issue without it is never claimed,
and `foreman status` reports it as waiting on a human. A hand-made issue is not a way into the
pipeline; `foreman epic new` is.

### Ledger comment grammar

Issue comments are the source of truth for who is doing what, so two Macs sharing one GitHub login
never collide and a restarted daemon picks up where it left off.

```
claimed by <host> at <iso> role=<role> round=<n>
session <id> on <host> role=<role> attempt=<n>
session <id> finished on <host>: outcome=<o> turns=<n> cost=$<n> duration=<n>m
session <id> interrupted on <host>: stopped by operator after <n>m
released by <host>: <reason>
released by <host>: aborted by operator
reclaimed from <host> by <host> at <iso>
merged by foreman@<host>
ci rerun by foreman@<host> for <sha>
unblocked by owner via foreman@<host>
```

`session … finished`, `released by`, `reclaimed from` and `merged by` are terminal: they close an
open claim.

## 5. `.foreman/`

Committed in the repository the foreman works on, and read from the worktree at dispatch, so a
pull request can change the process for the sessions that run on its own branch.

```
.foreman/
  config.json      process knobs
  rules.md         appended to every role prompt as "House rules"
  roles/<role>.md  optional, appended after rules.md for that role only
  settings.json    { "allow": [...], "deny": [...] } merged into the headless settings
  hooks/           preflight, session-env, before-session, after-session
```

### `config.json`

Every key is optional; the file may be `{}`. These are the defaults:

```json
{
  "setup": "pnpm install",
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "plans": { "dir": "docs/superpowers/plans", "specGlob": "docs/**/*.md" },
  "validator": { "skipLabels": [] },
  "limits": { "fixRounds": 2, "ciReruns": 1, "blockedPerPhase": 2, "staleHours": 2, "attempts": 3 },
  "models": ["opus", "sonnet", "haiku", "fable"]
}
```

| Key | Default | What it does |
|---|---|---|
| `setup` | `"pnpm install"` | Run once when a worktree is created. `null` skips it. |
| `checks` | `pnpm lint/typecheck/test` | What a rebase round runs, and what every role prompt means by "the checks". |
| `plans.dir` | `docs/superpowers/plans` | Where the planner writes `<date>-phase-NN-plan.md` and `.issues.json`, and where `apply_plan` looks on the default branch. |
| `plans.specGlob` | `docs/**/*.md` | What a `## Spec` path must match. `**` spans path segments, `*` stays inside one. |
| `validator.skipLabels` | `[]` | A PR whose issue carries one of these gets `validator:skipped` instead of a validator session. Use it for work with nothing to drive — infrastructure, schema, docs. |
| `limits.fixRounds` | 2 | Change requests before the issue is `blocked`. |
| `limits.ciReruns` | 1 | Failed-job reruns per head sha before a fix round. |
| `limits.blockedPerPhase` | 2 | Open `blocked` tasks in a phase before new builds stop. |
| `limits.staleHours` | 2 | Silence on an In Progress claim before another Mac may reclaim it. |
| `limits.attempts` | 3 | Dispatch attempts for one session before the issue is `blocked`. |
| `models` | opus, sonnet, haiku, fable | The page's model buttons, the `model:<name>` labels `init` creates, and the names `foreman model` accepts. |

A strict schema: an unknown key is an error, not a warning, so a typo fails loudly at the next
dispatch.

A repository with no application to install or run, for instance a docs repository:

```json
{ "setup": null, "checks": ["true"], "validator": { "skipLabels": ["area:docs"] } }
```

### `rules.md`

Appended to every role prompt under a `## House rules` heading, after the base prompt and before
any per-role section. The base prompts carry the pipeline's own contract — never `cd` out of the
worktree, never touch the default branch, never merge, idempotent GitHub writes, the ledger and
Progress comment formats, the fix-round rules, the PR body template, the outcome JSON. `rules.md`
carries what is true of *this* repository and nothing else:

```markdown
Run `pnpm install` once per worktree. The checks are `pnpm lint`, `pnpm typecheck`, `pnpm test`.

Bring the app up with `pnpm --filter @acme/serve start`; it serves http://localhost:8182 and the
API on http://localhost:3105. Seeded logins are in `docs/seed.md`. Stop it with `serve stop`
before you return, even on a failure.

Never run `docker stop` or touch a container this repository did not start.
```

Sessions also read the repository's `CLAUDE.md` as any Claude Code session does, so `rules.md` is
for what the *roles* need beyond that.

### `roles/<role>.md`

Optional, one per role (`builder`, `reviewer`, `validator`, `planner`, `phase-closer`), appended
after `rules.md` under `## <role> rules`. A repository appends; it never replaces a base prompt.
Use it for a reviewer checklist that is specific to the stack, or the exact boot sequence a
validator follows.

### `settings.json`

Merged into the base Claude Code headless settings that ship with the package:

```json
{
  "allow": ["Bash(pnpm *)", "Bash(docker *)", "Bash(npx playwright *)", "mcp__playwright__*"],
  "deny": ["Bash(docker stop*)", "Bash(orb *)"]
}
```

Base and repository `allow` lists are concatenated and deduplicated, and so are the `deny` lists;
then anything on the combined deny list is removed from the allow list. **A repository rule can
add to either list but can never remove a base deny.** The base file denies `gh pr merge`, `gh pr
close`, `gh api`, pushes to the default branch, force pushes, `git worktree remove`, `sudo`, `rm
-rf` of home, and reads of `~/.ssh`, `~/.aws` and `~/.claude*`. Anything stack-specific — `pnpm`,
`docker`, a browser MCP — is not in the base file; add it here.

### Hooks

Four optional executables in `.foreman/hooks/`, any language, no rebuild. A missing hook is a
no-op; one that exists but is not executable is a logged no-op (`chmod +x` it). Each gets a
10-minute timeout, and its stdout and stderr are appended to
`~/.foreman/<name>/logs/hooks.log` — except `session-env`'s stdout, which is the secrets it exists
to inject and is never logged.

| Variable | Set for |
|---|---|
| `FOREMAN_INSTANCE`, `FOREMAN_STATE_DIR`, `FOREMAN_REPO_DIR` | all hooks |
| `FOREMAN_ROLE`, `FOREMAN_ISSUE`, `FOREMAN_PR`, `FOREMAN_WORKTREE`, `FOREMAN_ROUND` | session hooks (`FOREMAN_PR` is empty when there is none) |

| Hook | Runs | Contract |
|---|---|---|
| `preflight` | every tick, from `repoDir`, after the built-in checks | Exit 0: ok. Non-zero: the daemon parks and the last non-empty stderr line is the reason. Stdout lines starting `warn:` become preflight warnings. |
| `session-env` | before each `claude -p`, from the worktree | Stdout `KEY=VALUE` lines enter the child's environment. Stdout lines starting `prompt:` are appended, in order, to the session prompt. A non-zero exit fails the attempt. |
| `before-session` | after `session-env`, from the worktree | A non-zero exit fails the attempt and counts toward `limits.attempts`. |
| `after-session` | always, from the worktree: after the child exits, is killed, or the daemon is interrupted; and again before the next session on the same worktree | The exit code is logged and never fatal. |

Debug one by hand against the instance's `repoDir`:

```bash
foreman -p widgets hooks run preflight
```

#### A worked example of each

`.foreman/hooks/preflight` — park the daemon when the database it needs is down, and warn (but
carry on) when the browser the validator wants is missing:

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not responding; start OrbStack" >&2
  exit 1
fi

if ! docker compose -f "$FOREMAN_REPO_DIR/docker-compose.yml" up -d db >/dev/null 2>&1; then
  echo "could not start the db container" >&2
  exit 1
fi

if [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo "warn: no Playwright browser installed; validator sessions will fail"
fi
```

`.foreman/hooks/session-env` — give the three roles that run the app their own ports, and tell the
session where to find it. Everything on stdout that is not a `prompt:` line must be `KEY=VALUE`:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${FOREMAN_ROLE:-}" in
  builder|reviewer|validator) ;;
  *) exit 0 ;;
esac

echo "WEB_PORT=8182"
echo "API_PORT=3105"
echo "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55621/postgres"
echo "prompt: This session runs against an isolated stack: web http://localhost:8182, api http://localhost:3105."
echo "prompt: Never start the developer stack on 8082/3005; the owner is using it."
```

`.foreman/hooks/before-session` — rewrite a config file the session must not commit, and hide it
from `git add -A`:

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "${FOREMAN_ROLE:-}" = "validator" ] || exit 0

"$FOREMAN_WORKTREE/scripts/isolate-ports.sh" "$FOREMAN_WORKTREE/config/app.toml"
git -C "$FOREMAN_WORKTREE" update-index --skip-worktree config/app.toml
```

`.foreman/hooks/after-session` — undo it, whatever happened to the child. This one must be
idempotent and must not fail the tick, hence the `|| true`:

```bash
#!/usr/bin/env bash
set -uo pipefail
[ -n "${FOREMAN_WORKTREE:-}" ] || exit 0

git -C "$FOREMAN_WORKTREE" update-index --no-skip-worktree config/app.toml 2>/dev/null || true
git -C "$FOREMAN_WORKTREE" checkout -- config/app.toml 2>/dev/null || true
```

## 6. Instances

An instance is a name. Its machine config and all of its state live under `~/.foreman/<name>/`:

```
~/.foreman/widgets/
  foreman.json        machine config (below)
  state.json          daemon state: the pid, the current session, the next tick
  sessions.log        one JSON line per finished session
  merges.log          one JSON line per merge
  notify.json         notification bookkeeping
  STOP                kill switch, present or absent
  logs/               foreman.log, hooks.log
  activity/           <sessionId>.jsonl live feeds
  artifacts/<pr>/     validator screenshots copied out of the worktree
  settings.json       generated per dispatch: base headless settings + .foreman/settings.json
  roles/<role>.md     generated per dispatch: base prompt + rules.md + roles/<role>.md
```

`foreman.json`, written by `add` and completed by `init`:

| Key | Required | Default |
|---|---|---|
| `repo` | yes | — (`owner/name`) |
| `project` | written by `init` | — |
| `host` | yes | this Mac's short hostname |
| `repoDir` | yes | — |
| `workDir` | no | `<repoDir>/.worktrees` |
| `model` | no | `opus` |
| `pollSeconds` | no | 300 |
| `maxSessionsPerDay` | no | 20 |
| `maxTurns` | no | 200 |
| `wallClockMinutes` | no | 90 |
| `stallMinutes` | no | 5 |
| `webPort` | no | first free port from 8090, chosen by `add` |
| `minGraphqlPoints` | no | 500 |
| `notify` | no | none (§7) |

`workDir` absent means worktrees live at `<repoDir>/.worktrees/<issue>`, so a checkout is
self-contained; add `.worktrees/` to the repository's `.gitignore`. `model` is always passed as
`--model`, so a session never inherits whatever the interactive `claude` default happens to be.

### Which instance a command means

Every command that needs an instance resolves it in this order and stops at the first hit:

1. `-p <name>` / `--instance <name>`.
2. `$FOREMAN_INSTANCE`.
3. The current directory is inside a configured `repoDir` (or one of its worktrees) — so inside
   `~/Projects/widgets` you can just type `foreman status`.
4. Exactly one instance exists under `~/.foreman/`.
5. Otherwise it errors and lists the instances it found.

`$FOREMAN_CONFIG` is an escape hatch that points straight at a `foreman.json` outside the layout.

```bash
foreman list
# widgets          acme/widgets                     running  :8090
# sprockets        acme/sprockets                   stopped  :8091
```

### Several daemons on one Mac

Nothing is shared between instances: not `STOP`, not the daily cap, not `state.json`, not the
board cache. Two daemons against two repositories run side by side as long as their `webPort`s
differ — `add` picks the next free port from 8090 and refuses a port another instance already
holds. Give each one its own `launchd` agent (`foreman -p <name> launchd install`); the labels are
`com.apptreesoftware.foreman.<name>`, so they do not collide either.

They do share the Claude subscription and the GitHub GraphQL budget, so halve `maxSessionsPerDay`
and raise `pollSeconds` if you run several.

## 7. Kill switches and control

All of these work from any terminal on the Mac. Inside a configured `repoDir` you can drop `-p`.

- **See what it is doing:** `foreman -p widgets status` (add `--watch` for a live view, `--json`
  for the raw report). It reads `state.json`, which the daemon writes every tick, whenever a
  `claude -p` child starts or ends, and (throttled to every 2 s) as the child's stream-json output
  arrives: the `doing` line shows the last tool call and how long ago, turn and token counts, and
  the last thing the session said. `STALLED` appears after `stallMinutes` (default 5) without
  output — a long tool call counts as silence, so it can appear briefly on a healthy session. With
  no session running, the `now` line distinguishes four things: `parked · <reason>` (preflight
  fails every tick, so nothing happens until the condition clears), `between ticks · next <time>`,
  `ticking`, and `idle` — reserved for a tick that found nothing eligible. The `waiting` line
  lists what blocks a new claim — CI on a PR, a human label, a `Depends on` issue, another Mac's
  claim, the `STOP` file, the daily cap — ranked so a live blocker comes first. The `phase` line
  gives one line per open approved epic: tasks done of total, the spend and session count, and the
  median claim→merge time of the ones that merged.
- **Ask what the next tick would do:** `foreman -p widgets next`. The only subcommand that calls
  GitHub; it explains why each open PR is or is not mergeable, and it ignores the `STOP` file.
- **The page:** `foreman -p widgets page` opens `http://127.0.0.1:<webPort>`, served by the daemon
  while it runs and bound to localhost only. It carries the same view plus a pipeline table
  (build → review → validate → CI → merge per in-flight issue), a **Phase** card with a progress
  bar, a **Needs you** card, an **Owner** card of label gates, and a live event feed per session.
  Feeds live in `~/.foreman/<name>/activity/<sessionId>.jsonl` and hold tool names and one-line
  summaries only, never tool inputs or thinking.
- **Show the board as it is now:** the page's **Refresh project** button. It drops the cached
  board and wakes the loop, so a Status you set in the GitHub UI shows up within a tick rather
  than at the end of the poll interval. `foreman go` does the waking half only.
- **Stop now, resume later:** `foreman -p widgets stop`. Touches `STOP`, then `SIGTERM`s the
  daemon, which kills the `claude -p` child, posts `session <id> interrupted on <host>: stopped by
  operator` and exits. The claim stays open, so the next start resumes that session with
  `--resume`. `launchctl bootout` and Ctrl-C do the same.
- **Stop now and discard the session:** `foreman -p widgets abort`. The daemon posts `released by
  <host>: aborted by operator`, unassigns itself and moves a round-1 builder issue back to Ready.
  The worktree is left for reuse. If the daemon is already dead and `state.json` shows an
  unfinished claim, `abort` posts the release itself.
- **Start again:** `foreman -p widgets go` removes `STOP` and wakes the daemon, or `launchctl
  kickstart`s it, or prints the start command. `foreman -p widgets restart` stops and starts,
  clearing the `STOP` that `stop` left.
- **This Mac, next poll only:** `touch ~/.foreman/widgets/STOP`. Preflight fails on the next
  iteration and the daemon parks until the file is gone.
- **This phase, every Mac:** `gh issue edit <epic> --add-label foreman:pause`. No new claims are
  picked under that phase anywhere; in-flight sessions finish normally.
- **The planning backstop, every Mac:** the planner never runs on an epic without `agent-ready`,
  and never on a second epic while a drafted plan is waiting on the owner. Starting a phase is
  therefore always an explicit `gh issue edit <epic> --add-label agent-ready`.
- **Raise the daily cap:** `foreman -p widgets cap` prints the cap the next tick will enforce and
  where it came from; `foreman -p widgets cap 50` raises it; `cap default` hands control back to
  `foreman.json`. The cap is read per tick, so raising it un-parks a capped daemon immediately.
  The override survives a restart. The **Tick** card offers the same, confirm-first.
- **Change the model:** `foreman -p widgets model` prints what the next session will run as;
  `foreman -p widgets model sonnet` changes it. With the daemon running the change goes through
  the page, which owns `state.json`, and applies at the next dispatch — the session running now
  keeps its model, and no restart is needed. `model default` clears the override. Any model name
  is accepted, including a dated id; `models` in `config.json` is just the buttons.
- **Pin one task to a model:** a `model:<name>` label on the issue runs every session on it —
  builder, reviewer, validator, fix rounds — as that model, outranking both the live override and
  `foreman.json`. The label is the source of truth, so it works from `gh issue edit` too.
- **Owner gates, from the page:** the **Owner** card lists every open epic with the label gates
  only a human can open — **Sign off**, **Approve plan**, **Start planning**, **Pause**/**Resume**.
  Each button confirms the exact label change and wakes the daemon. The same gates are just
  labels, so `gh issue edit <epic> --add-label <label>` is identical.
- **Issues waiting on you:** the **Needs you** card lists every open non-epic issue labelled
  `needs-owner`, `decision` or `blocked`, oldest first. `foreman status` prints the same list.
  A `blocked` row has an **Unblock** button: it removes `blocked`, sets Status **Ready** and
  comments `unblocked by owner via foreman@<host>` — fix whatever caused the block first, because
  nothing else about the issue changes.
- **Stop the launchd agent entirely:** `launchctl bootout gui/$(id -u)/com.apptreesoftware.foreman.widgets`,
  or `foreman -p widgets launchd uninstall`.

`foreman start` refuses when the daemon recorded in `state.json` is still alive, and `status` warns
when the web port is held by a different process — the symptom of a stale daemon serving a frozen
page while a newer one does the work. A killed daemon (`kill -9`) does no bookkeeping: `status`
then shows `CRASHED` and, if the child is still alive, `ORPHAN child <pid>`; `stop` or `abort`
kills it.

### Notifications

Optional and off by default. Add a `notify` block to `~/.foreman/<name>/foreman.json`; both
channels are independent, so set either, both or neither.

```json
{
  "notify": {
    "slackWebhookUrl": "https://hooks.slack.com/services/T000/B000/xxxxxxxx",
    "macos": true
  }
}
```

- `slackWebhookUrl` — a Slack **incoming webhook**. Create one at <https://api.slack.com/apps> →
  your app (or **Create New App** → *From scratch*) → **Incoming Webhooks** → toggle on → **Add
  New Webhook to Workspace** → choose the channel or your own DM. That URL is a credential:
  `foreman.json` lives outside the repository, and the foreman never logs it, never puts it in a
  role prompt and never serves it on the page. Rotate it from the same Slack page if it leaks.
- `macos` — `true` shows a Notification Center banner via `osascript`, on whichever Mac the daemon
  runs on. The first banner may need permission for whatever runs the daemon (Terminal, or
  **System Settings → Notifications → Script Editor** for `launchd`).

Seven events, one line each, with the GitHub link:

| Event | Line |
|---|---|
| PR merged | `merged #<pr> → closes #<issue>: <title>` |
| Issue blocked | `blocked #<issue> <title> — <first line of the reason>` |
| Decision issue opened | `decision needed #<issue>: <title>` |
| Phase closed | `phase <epic> closed: <title> — review #<n>` |
| Plan drafted | `plan drafted for #<epic>: <title>` |
| Daemon parked | `foreman parked on <host>: <reason>` |
| Daemon resumed | `foreman resumed on <host> (was: <reason>)` |

A notification carries issue and PR numbers, titles and the foreman's own reason strings — never
tool inputs, session transcripts or the stderr excerpt that goes into a `blocked by foreman@…`
comment. Parked fires once per parked spell, not once per tick; decision issues are announced once
each, and enabling notifications on a repository that already has open ones seeds them silently
rather than replaying the backlog. That bookkeeping is `~/.foreman/<name>/notify.json` — delete it
to re-announce everything. A send that fails logs a `warn` line and is dropped; it never fails a
tick and is never retried. `--dry-run` notifies nothing.

## 8. Budget

Knobs in `~/.foreman/<name>/foreman.json`:

- `maxSessionsPerDay` — preflight refuses a new session once today's count, read from
  `sessions.log`, reaches this. "Today" is the **local** date, so the count clears at local
  midnight, and interrupted or aborted sessions still count. When the cap is what is holding the
  Mac, `status` and the page say `parked · daily session cap reached (N/N)` and the cap is
  changeable from there (§7).
- `maxTurns` — passed to `claude -p --max-turns`; a session that hits it without returning an
  outcome counts as a failed attempt and is retried, up to `limits.attempts`.
- `wallClockMinutes` — the dispatcher kills the child (`SIGTERM`, then `SIGKILL` after 30 s) if it
  runs longer than this.
- `stallMinutes` — minutes without a stream-json event before the page and `status` flag the
  session as stalled. Visibility only; nothing is killed.
- `minGraphqlPoints` — preflight refuses to start a tick when GitHub reports fewer GraphQL points
  left than this (default 500).

There is a second budget besides money: GitHub gives 5000 GraphQL points an hour, and `gh issue
list`, `gh pr list` and `gh project item-list` all spend it. The foreman stays inside it by reading
one issue at a time (`gh issue view`) instead of re-listing the repository, caching the board for
the length of a tick, reusing the tick's snapshot, and polling every `pollSeconds`. If it still
runs out, preflight parks the daemon with `GitHub GraphQL budget low: <n> points left, resets
<time>` until the window rolls over. Each tick samples the budget three times — the `rateLimit`
query is free — and breaks the spend down three ways: **reads** is the loop's own snapshot,
**session** is what the `claude -p` session it dispatched spent, and **elsewhere** is what was gone
before the tick started (another Mac, a second daemon, or a human at a terminal). Attribute before
optimising.

Per-session cost is posted in the `session … finished` issue comment and appended as one JSON line
per session to `~/.foreman/<name>/sessions.log`, which is also what the daily cap reads. Each line
carries `t`, `host`, `role`, `issue`, `sessionId`, `attempt`, `costUsd`, `outcome`, `model`,
`turns`, `durationMinutes`, `denials` and `subtype`, so models can be compared on cost, turns and
wall-clock rather than on cost alone:

```bash
jq -r '[.t, .role, .issue, .model, .costUsd, .durationMinutes] | @tsv' ~/.foreman/widgets/sessions.log
jq -s 'map(.costUsd) | add' ~/.foreman/widgets/sessions.log
```

A merge appends one line to `merges.log` (`issue`, `pr`, `host`, `claimedAt`, `mergedAt`). The
merged issue drops out of every later snapshot, so this is what keeps the phase card's cycle time
computable. Both logs are local caches; losing them only empties those numbers.

## 9. Resume and multi-Mac

All durable state lives in GitHub. Local disk — the worktree, the transcript, `sessions.log` — is a
cache the foreman can lose without losing work, because every role checkpoints by pushing its
branch.

- **Same Mac, same session:** the foreman finds its own open claim and, if the local Claude Code
  transcript for that session id still exists, resumes with `--resume <id>` and a note to continue
  from the last Progress comment.
- **Same Mac, transcript gone:** a fresh session id is used instead, with a note to read the
  issue's Progress comments and `git log origin/<default>..HEAD` before continuing.
- **Different Mac, or after a crash:** an In Progress issue with no comment and no branch commit
  for `limits.staleHours` (2) may be reclaimed by any other foreman. It comments `reclaimed from
  <host> by <host> at <iso>` and starts a fresh session with the same instruction.
- **Two Macs claim the same issue in the same window:** both post a `claimed by …` comment before
  either sees the other's. Once both are visible the alphabetically first host keeps it and the
  others comment `released by <host>: conflict` and unassign — so pick `host` values with that in
  mind if it matters which Mac wins. Work is never lost, only not duplicated.
- **Change requests:** a reviewer or validator failure cycles a builder back for a fix round; after
  `limits.fixRounds` (2) failed rounds — a third change request — the issue is `blocked` instead of
  retried. Two things keep that cap from being hit for the wrong reasons: a fix round is scoped
  (round 2 and later may block only on prior findings still open, regressions in the delta, or a
  real safety issue; anything else becomes a follow-up issue), and a merge conflict is never a
  change request — an approved PR that conflicts gets a rebase round that does not count.
- **To unblock a task by hand:** fix or rebase the branch, push, remove `reviewer:changes` from the
  PR and `blocked` from the issue (or use the page's **Unblock** button). The fix-round counter
  stays where it was, so the next reviewer verdict must be an approval or the task is blocked
  again.

## 10. Troubleshooting

- **`preflight failed: gh token lacks the project scope`.** The daemon parks every tick until the
  token can read and write the board. Fix it with `gh auth refresh -s project,read:project`, then
  `foreman -p <name> go`. `foreman init` prints the same line rather than half-creating a board.
- **A hook is not doing what you expect.** Run it by hand against the instance's `repoDir`:
  `foreman -p <name> hooks run preflight`. Its stdout, its stderr and the hook's exit code are
  printed straight to your terminal, and the command exits with the hook's own code. When the
  daemon runs it instead, the same lines land in `~/.foreman/<name>/logs/hooks.log`. Check the
  hook is executable — one that exists without `chmod +x` is a logged no-op, not an error.
- **`"Ignoring N permissions.allow entries"` in a session log.** The worktree was not marked
  trusted in `~/.claude.json`. The foreman does that itself after creating a worktree, so this
  usually means the worktree was created or moved outside the normal flow — check `~/.claude.json`
  has a `projects` entry for the worktree path with `"hasTrustDialogAccepted": true`.
- **`error_max_turns` as the session subtype.** The role hit `--max-turns` before returning an
  outcome. Raise `maxTurns` if the role's work is legitimately long, or check for a loop in the
  session's feed on the page.
- **The daemon is idle and nothing is claimed.** `foreman -p <name> next` says why. The common
  causes are an epic with no `agent-ready`, a drafted plan with no `plan-approved`, a task whose
  body has no `Parent epic: #N` line (a hand-made issue is never claimed — use `foreman epic new`),
  a `Depends on` issue still open, or a phase held by `limits.blockedPerPhase`.
- **`~/.foreman/<name>/artifacts/<pr>/` is empty after a validation run.** The foreman only copies
  what the validator left in `<worktree>/.validation-artifacts/<pr>/`, and only on a
  `passed`/`failed` outcome — a session that died without an outcome archives nothing. Look for the
  `archived validation artifacts` line in `logs/foreman.log`. Role sessions cannot write to the
  artifacts directory themselves: in `--permission-mode dontAsk` a Bash command that creates a file
  outside the worktree is denied even though `mkdir` and `mv` are allowlisted.
- **A session's `gh` write was denied.** `gh api` is denied to role sessions by the base settings,
  as is a multi-line `--body`; the prompts tell every role to write the text to `.gh-body.md` and
  pass `--body-file`. If a role reports a denial in its notes, that is usually why.
- **Two daemons fighting over a port.** `foreman list` shows each instance's port and whether its
  daemon is running; `foreman status` warns when the port is held by a different process. Pick a
  free port with `foreman add --web-port`, or stop the stale daemon.
- **Branch protection.** A private repository on GitHub's free plan cannot have branch protection
  rules, so the guards against an accidental direct push are the base deny rules (`gh pr merge*`,
  `git push origin <default>*`) applied to every headless session, plus the rule that only the
  foreman itself calls `gh pr merge`.

## 11. Release check

The manual test that a release works end to end, run against a throwaway repository. It exercises
`add`, `init`, `epic new`, the planner, approval, and one task from claim to merge.

```bash
gh repo create acme/foreman-sandbox --private --clone --add-readme
cd foreman-sandbox
mkdir -p docs && $EDITOR docs/sandbox.md      # two paragraphs describing something tiny
git add -A && git commit -m "docs: sandbox spec" && git push

foreman add sandbox --repo acme/foreman-sandbox --repo-dir "$PWD"
foreman -p sandbox init
```

A repository with no application needs a `.foreman/config.json` that says so, and `rules.md` that
tells the roles there is nothing to run, so the planner labels tasks `area:docs` and the validator
is skipped by label:

```bash
cat > .foreman/config.json <<'JSON'
{ "setup": null, "checks": ["true"], "validator": { "skipLabels": ["area:docs"] } }
JSON
cat > .foreman/rules.md <<'MD'
This is a sandbox repository with no application. There is nothing to run or serve; a validator
should confirm the acceptance criteria by reading the merged files. Label every task `area:docs`.
MD
git add .foreman && git commit -m "chore: foreman config" && git push
```

Then run the pipeline:

```bash
foreman -p sandbox epic new --title "Phase 1: sandbox" --phase 1 --spec docs/sandbox.md --agent-ready
foreman -p sandbox status
foreman -p sandbox run --once        # the planner claims the epic and drafts a plan PR
```

Expect `claimed by <host> … role=planner`, then a plan PR against the sandbox and the epic at
**In Review** with `needs-owner`. Merge the plan PR, approve the plan, and let the loop apply it:

```bash
gh pr merge <plan pr> --squash --repo acme/foreman-sandbox
gh issue edit 1 --repo acme/foreman-sandbox --add-label plan-approved
foreman -p sandbox run --once        # applies the plan: task issues at Ready, agent-ready
foreman -p sandbox run --once        # claims the first task for a builder
foreman -p sandbox start
foreman -p sandbox status --watch    # or: foreman -p sandbox logs -f
```

Watch one task go build → review (→ validate, unless skipped by label) → merge, then stop:

```bash
foreman -p sandbox stop
jq -r '[.role, .issue, .outcome, .costUsd] | @tsv' ~/.foreman/sandbox/sessions.log
```

A pass is: the task's PR merged, its issue closed at **Done**, a `merged by foreman@<host>` comment
on the issue, and a line in `sessions.log` per session. The whole check costs a handful of sessions
and takes one to three hours of wall-clock; the daily cap (20) is plenty.

## 12. Developing

```bash
git clone git@github.com:apptreesoftware/foreman.git
cd foreman
pnpm install
pnpm link --global          # `foreman` now runs this checkout's build
pnpm build && foreman help
```

`pnpm dev help` runs the CLI from source with `tsx`, without a build. The checks are the same ones
CI runs:

```bash
pnpm lint            # biome check .
pnpm typecheck       # tsc -p tsconfig.json
pnpm test            # vitest run
pnpm build           # tsc -p tsconfig.build.json → dist/
```

Every test is a unit test against sanitised fixtures (`acme/widgets`) and a fixture repository at
`test/fixtures/repo/.foreman/`; nothing in the suite touches the network, GitHub or a real
`claude`. `pnpm test -- src/hooks.test.ts` runs one file.

The package ships `dist/`, `roles/` and `settings/`; `roles/` and `settings/` are read at runtime
from one level above the running file, so they resolve the same from `src/` and from `dist/`.

### Releasing

A `v*` tag publishes. `.github/workflows/release.yml` installs, runs the four checks, asserts the
tag matches `package.json`'s `version`, and runs `npm publish`:

```bash
# bump "version" in package.json, commit, push, then:
git tag v0.1.1 && git push --tags
gh release create v0.1.1 --title "0.1.1" --notes "…"
```

There is no `NPM_TOKEN` secret. The workflow authenticates through **npm trusted publishing**:
`npm publish` exchanges the job's GitHub OIDC token for a short-lived publish credential, which is
why the job needs `id-token: write`. That needs npm 11.5 or newer, and `setup-node` installs
whatever npm Node 22 bundles (10.x), so the workflow runs `npm i -g npm@11` first.

Trusted publishing is configured per package on npmjs.com, and the package has to exist there
first, so the very first version is published by hand from a logged-in Mac:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
npm publish --access public --provenance=false --otp=<code from your authenticator>
```

`--provenance=false` because `publishConfig` asks for provenance and only a CI job with an OIDC
token can produce it; `--otp` because npm requires a second factor for a publish from a laptop.

**Owner action, once, after that first publish:** on
<https://www.npmjs.com/package/@apptreesoftware/foreman/access> → **Trusted publishing** → add a
GitHub Actions publisher with organization `apptreesoftware`, repository `foreman`, workflow
`release.yml`, environment blank. Until that is done the release job fails at `npm publish`, and
every version has to go out by hand.

## License

MIT.
