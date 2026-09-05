# The foreman

`tools/foreman` is a small TypeScript daemon that runs the Tone & Tonic issue pipeline unattended. It shells out to the `claude` CLI (`claude -p`) to run builder, reviewer, validator, phase-closer, and planner sessions against GitHub issues, and does deterministic bookkeeping — labels, project board status, PR merges — in between. All judgment happens inside the `claude -p` sessions; the foreman itself never decides anything more interesting than "whose turn is it" and "did CI pass."

Design: `docs/superpowers/specs/2026-09-03-autonomous-foreman-design.md`. Build history: `docs/superpowers/plans/2026-09-03-phase-0.5-foreman.md`.

## 1. What it does

Every `pollSeconds` (config, default 300s), the foreman wakes up and runs one iteration:

1. **Preflight.** Refuses to run if `ANTHROPIC_API_KEY` (or any other API-billing env var) is set, `~/.tone_tonic/STOP` exists, `claude auth status` isn't a `claude.ai` subscription login, `gh auth status` fails, Docker isn't responding, or the day's session count is at `maxSessionsPerDay`. See `src/preflight.ts`.
2. **Resume check.** If an issue on the board is In Progress and claimed by this host, the foreman resumes that session instead of picking anything new.
3. **Merge sweep.** For every open, non-draft PR whose issue is In Review: if CI is green, the PR carries `reviewer:approved`, and it carries `validator:passed` or `validator:skipped`, the foreman squash-merges, closes the issue, sets Status Done, and comments `merged by foreman@<host>`.
4. **Pick.** Candidates are issues with Status Ready, label `agent-ready`, no open claim, every "Depends on" issue closed, and whose phase epic isn't `foreman:pause`d. Open PRs needing review or validation are also candidates. Priority: lowest phase number, then review/validate jobs before new builds, then fix rounds, then `size:S` before `M` before `L`.
5. **Claim.** The foreman comments `claimed by <host> at <iso> role=<role> round=<n>`, assigns itself, and (for a first-round build) sets Status In Progress. If another host's claim comment landed in the same window, the alphabetically first host keeps it; the others comment `released by <host>: conflict` and unassign. The ledger (issue comments), not the GitHub assignee, is authoritative — two Macs can share one GitHub login.
6. **Dispatch.** Creates or reuses a git worktree at `<workDir>/<issue>` — by default `<repoDir>/.worktrees/<issue>`, so worktrees stay inside the clone — on branch `feat/<issue>-<slug>`, runs `pnpm install`, and invokes `claude -p` with the role's prompt file, the issue/PR/worktree/branch context, `--max-turns <maxTurns>`, `--model <model>`, and a `wallClockMinutes` timeout. Posts `session <id> on <host> role=<role> attempt=<n>` before each attempt. Records the session in `~/.tone_tonic/state.json` (`current`) until it ends.
7. **Outcome.** Parses the session's structured JSON outcome. On a validator `passed`/`failed`, first copies `<worktree>/.validation-artifacts/<pr>/` — where the validator leaves its screenshots, because a headless session cannot write outside its worktree — to `~/.tone_tonic/artifacts/<pr>/` and logs the destination, so the artifacts survive the worktree being removed at merge. Then applies labels/Status (table below). A session that ends without a valid outcome is retried up to 3 attempts total (`dispatchWithRetry` in `src/dispatch.ts`); if all 3 fail, the issue is labeled `blocked` with a log excerpt and unassigned.
8. **Phase check.** If every task under a phase epic is closed, dispatches the phase-closer. Then the planner, which is gated three ways (`src/phase.ts`): the epic must carry **`agent-ready`** (the owner's go-ahead — without it the foreman never plans anything), no approved phase may still be building, and no other epic's drafted plan may be waiting on the owner. When it dispatches, the epic is assigned and set In Progress so the hour-long session is visible on the board; `plan_drafted` then sets the epic In Review, adds `needs-owner`, removes `agent-ready` and unassigns. Labeling the epic `plan-approved` applies the plan, clears `needs-owner`, and puts the epic back In Progress. Re-adding `agent-ready` asks for a re-plan. Applying a plan fetches `origin` and reads `docs/superpowers/plans/<date>-phase-NN-plan.issues.json` from `origin/main`, so merging the plan PR is enough — the clone at `repoDir` never has to be pulled by hand. If the file is not on `origin/main` yet, the foreman logs and retries on the next tick rather than recording the plan as applied.

`src/state.ts`'s `plan()` runs these in order and stops after the first action that would start a `claude -p` session, so at most one session runs per iteration per Mac.

An iteration that started a session does **not** then sleep `pollSeconds`: it has already spent the session's minutes inside step 6 and has proved there is work on the board, so the next tick runs immediately (`state.json`'s `nextTickAt` says so, and the log line is `session dispatched; ticking again immediately`). An iteration that found nothing eligible still sleeps the full interval, and a failed iteration still backs off (doubling per consecutive failure, capped at `MAX_BACKOFF_SECONDS`, 900s). A `--dry-run` loop never shortens the wait, because in dry-run nothing is actually dispatched.

### Outcome → labels / status

| Role outcome | Labels / Status set by the foreman |
|---|---|
| builder `pr_opened` | issue → In Review |
| builder `blocked` | issue `blocked`, unassigned |
| reviewer `approved` / `changes_requested` | PR `reviewer:approved` / `reviewer:changes` |
| validator `passed` / `failed` | PR `validator:passed` / `validator:failed` |
| (foreman) infra/db/shared-only | PR `validator:skipped` |
| (foreman) green CI + approved + validated | squash merge, issue closed → Done, `merged by foreman@<host>` |
| third change request | issue `blocked` |
| phase-closer `phase_closed` | epic → In Review, `needs-owner` |
| planner `plan_drafted` | epic → In Review, `needs-owner`, `agent-ready` removed, unassigned; nothing else until `plan-approved`, which applies the plan (tasks `agent-ready` + Ready), clears `needs-owner` and returns the epic to In Progress |

## 2. Install on a Mac

1. **Prereqs.** Xcode Command Line Tools, Homebrew, then:
   ```bash
   brew install gh node@22 pnpm supabase/tap/supabase
   ```
   OrbStack or Docker Desktop (running). The `claude` CLI, version 2.1.259 or newer (`claude --version`).
2. **Clone and install.**
   ```bash
   git clone git@github.com:matthewtsmith/tone_tonic.git ~/Projects/tone_tonic
   cd ~/Projects/tone_tonic && pnpm install
   ```
3. **`gh` auth**, with the project scopes the foreman needs to read/write the board:
   ```bash
   gh auth login
   gh auth refresh -s project,read:project
   ```
4. **Connect Claude and Slack.** Run `claude` once interactively in the repo, accept the trust dialog, then `/mcp` and connect **claude.ai Slack**. Quit. Confirm:
   ```bash
   claude mcp list      # "claude.ai Slack … Connected"
   claude auth status   # "authMethod":"claude.ai"
   ```
   Each Mac needs this connector step done separately — see Troubleshooting if a role later reports `notify-failed`.
5. **Playwright chromium** (needed by the validator role):
   ```bash
   npx playwright@1.62.1 install chromium
   ```
   If this stalls or the validator later can't find the browser, see Troubleshooting §8.
6. **Pull the local Supabase images** once, so the first real run doesn't stall on a Docker pull:
   ```bash
   pnpm db:start
   ```
7. **Config.**
   ```bash
   mkdir -p ~/.tone_tonic
   cp tools/foreman/foreman.example.json ~/.tone_tonic/foreman.json
   ```
   Edit `~/.tone_tonic/foreman.json`: set `host` to something unique to this Mac (lowercase, no spaces — it's how ledger comments tell Macs apart), `repoDir` to the clone path from step 2, and `slackUser` to the Slack handle that should get DMs. The schema (`src/config.ts`) is `repo`, `project`, `host`, `repoDir`, `slackUser`, and the optional `workDir`, `model`, `pollSeconds`, `maxSessionsPerDay`, `maxTurns`, `wallClockMinutes`, `stallMinutes`, `webPort`, `minGraphqlPoints`, `notify`.

   Two of those defaults matter:

   - **`workDir`** — where role worktrees go. Absent means `<repoDir>/.worktrees/<issue>`, so a checkout is self-contained; `.worktrees/` is in the repo's `.gitignore`, and Biome reads that file, so nothing walks into them. Set it only if this Mac needs them somewhere else.
   - **`model`** — the model every `claude -p` session runs as. Defaults to `opus`. It is always passed as `--model`, so a foreman session never inherits whatever the interactive `claude` default happens to be on this Mac.

   **Migrating from `workDir: "~/tone_tonic-work"`:** drop the key from `foreman.json`, then for each existing worktree either move it — `git -C <repoDir> worktree move ~/tone_tonic-work/<n> <repoDir>/.worktrees/<n>` — or prune it and let the foreman recreate it on the next claim: `git -C <repoDir> worktree remove --force ~/tone_tonic-work/<n>`. Do this with the daemon stopped, and only for worktrees with no unpushed work (`git -C ~/tone_tonic-work/<n> status`).
8. **Preflight run** — a single dry-run iteration that touches nothing:
   ```bash
   pnpm --filter @tone/foreman start --once --dry-run
   ```
   Expect a `preflight ok` log line followed by a `plan` line. Do **not** write `pnpm --filter @tone/foreman start -- --once --dry-run` — with the pnpm version pinned in this repo (pnpm 11) the leading `--` is rejected; pass the flags directly after `start` everywhere.

## 3. Billing verification (do this before enabling launchd on a new Mac)

The foreman only ever runs `claude -p` against a subscription login; if that ever silently draws from API billing instead, the safeguard to catch it is a manual check, not automation, per spec §2's billing note.

```bash
env | grep -i -E 'anthropic|claude_code_use'    # must print nothing
pnpm --filter @tone/foreman start --once        # against a `sandbox`-labeled issue
```

Then open both usage dashboards:

- https://platform.claude.com/settings/usage (API usage) — must show **no** new usage.
- https://claude.ai/settings/usage — must show the session that just ran.

Record the result (with a screenshot or the two numbers) as a comment on the phase epic before enabling launchd on that Mac.

## 4. Enable launchd

launchd needs concrete paths, not the `__REPO__`/`__HOME__` placeholders committed in the plist and wrapper script. Two ways to install; prefer the copy variant so `git status` in the repo clone stays clean.

**Copy to `~/.tone_tonic` (preferred):**

```bash
REPO=$(pwd)
mkdir -p ~/.tone_tonic
sed -e "s#__REPO__#$REPO#g" tools/foreman/launchd/foreman.sh > ~/.tone_tonic/foreman.sh
chmod +x ~/.tone_tonic/foreman.sh
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" tools/foreman/launchd/com.tonetonic.foreman.plist \
  | sed "s#$REPO/tools/foreman/launchd/foreman.sh#$HOME/.tone_tonic/foreman.sh#" \
  > ~/Library/LaunchAgents/com.tonetonic.foreman.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tonetonic.foreman.plist
```

**In-repo (simpler, leaves the repo clone with two modified-in-place files):**

```bash
REPO=$(pwd)
sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" tools/foreman/launchd/com.tonetonic.foreman.plist > ~/Library/LaunchAgents/com.tonetonic.foreman.plist
sed -i '' "s#__REPO__#$REPO#g" tools/foreman/launchd/foreman.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tonetonic.foreman.plist
```

Either way, check it came up and watch the log:

```bash
launchctl print gui/$(id -u)/com.tonetonic.foreman | head
tail -f ~/.tone_tonic/logs/foreman.out.log
```

The plist sets `KeepAlive` and `RunAtLoad`, so launchd restarts the foreman if it exits and starts it at login; `ThrottleInterval` (60s) stops a crash loop from spinning.

## 5. Kill switches

All of these work from any terminal on the Mac. Install the wrapper once and the commands are `foreman <cmd>`:

```bash
tools/foreman/bin/foreman install    # symlinks itself into ~/.local/bin
foreman help
```

The wrapper reads `repoDir` and `webPort` from `~/.tone_tonic/foreman.json`, so it drives the configured clone no matter which directory (or worktree) you run it from, and it stays current because the symlink points into the clone. It adds `start`, `restart`, `update` (pull + install), `logs [-f]` and `page` to the `ctl` commands below. Without it, every command here is `pnpm --filter @tone/foreman ctl <cmd>` run inside the clone. A daemon started before this version has no state.json and no page; stop it once by pid and start it again to get any of this.

- **See what it is doing:** `ctl status` (add `--watch` for a live view, `--json` for the raw report). Reads `~/.tone_tonic/state.json`, which the daemon writes every tick, whenever a `claude -p` child starts or ends, and (throttled to every 2 s) as the child's stream-json output arrives: the `doing` line shows the last tool call and how long ago, turn and token counts, and the last thing the session said; `STALLED` appears after `stallMinutes` (config, default 5) without output. A long tool call (a full `pnpm test`, a Playwright wait) also counts as silence, so STALLED can appear briefly on a healthy session. With no session running the `now` line distinguishes four things: `parked · <reason>` (preflight fails every tick, so the daemon does nothing until the condition clears — the daily cap, `STOP`, Docker, the GraphQL budget), `between ticks · next <time>` (asleep on a schedule with work still planned), `ticking` (the next tick is due, so an iteration is in flight), and `idle` — reserved for a tick that found nothing eligible. The `waiting` line lists what blocks a new claim — CI on a PR, a human label (`plan-approved`, `needs-owner`, `blocked`), a `Depends on` issue, another Mac's claim, the `STOP` file, or the daily cap — ranked so a live blocker comes first and the background `phase_gate` item (a phase that has not started yet) comes last, since it never explains why the work in flight is stuck. `ctl next` asks GitHub what the next tick would do and why each open PR is or is not mergeable; it ignores the `STOP` file. The `phase` line answers "how far has this phase come, and what has it cost": one line per open epic labelled `plan-approved`, with tasks done of total, the spend and session count against those tasks, and the median claim→merge time of the ones that have merged (`phase  #10 phase 1 …  7/12 tasks  $42.50 over 23 sessions  median 1h35m claim→merge (7 merged)`; `phase  no approved phase in flight` when nothing is approved). The same view, plus a pipeline table (build → review → validate → CI → merge per in-flight issue), a **Phase** card with a progress bar per phase, and a live event feed per session, is served at http://127.0.0.1:8090 while the daemon is running (port `webPort` in `foreman.json`). Feeds are kept under `~/.tone_tonic/activity/<sessionId>.jsonl`; they hold tool names and one-line summaries only, never tool inputs or thinking. A daemon started before this version shows no live activity until it is restarted.
- **Stop now, resume later:** `ctl stop`. Touches `STOP`, then `SIGTERM`s the daemon. The daemon kills the running `claude -p` child, posts `session <id> interrupted on <host>: stopped by operator`, and exits. The claim stays open, so the next start resumes that session with `--resume`. `launchctl bootout` and Ctrl-C do the same thing.
- **Stop now and discard the session:** `ctl abort`. Same, via `SIGUSR1`, but the daemon posts `released by <host>: aborted by operator`, unassigns itself, and moves a round-1 builder issue back to Ready. The worktree is left for reuse. If the daemon is already dead and `state.json` shows an unfinished claim, `ctl abort` posts the release itself.
- **Start again:** `ctl go`. Removes `STOP`, then wakes the daemon (`SIGUSR2`), or `launchctl kickstart`s it, or prints the start command.
- **Raise the daily cap:** `foreman cap` prints the cap the next tick will enforce and where it came from; `foreman cap 50` raises it, `foreman cap default` hands control back to `foreman.json`. The **Tick** card offers the same next to today's session count, confirm-first. The cap is read per tick, so raising it un-parks a capped daemon on the very next tick — and a change from the page wakes the loop, so it happens immediately rather than after the poll interval. No restart, and no hand-editing `foreman.json` while the daemon is parked on it. Accepted values are 1–500; the buttons are just the common ones. The override survives a restart.
- **Change the model:** `foreman model` prints what the next session will run as and where that came from; `foreman model sonnet` changes it. With the daemon running the change goes through the page's `/api/model`, which owns `state.json`, and applies at the next dispatch — the session running now keeps the model it started with, and no restart is needed. With the daemon stopped it is written to `state.json` directly and applies at the next start. The **Tick** card on the page shows the same thing with one-click buttons (`opus`, `sonnet`, `haiku`, `fable`), each confirming first. An override survives a restart and outranks `model` in `foreman.json`; `ctl status` says `model sonnet (override; foreman.json says opus)` when one is set. `foreman model default` clears the override and hands control back to `foreman.json` (the page shows the same as a `default (opus)` button whenever one is set). Any model name is accepted, including a dated id like `claude-haiku-4-5-20251001`; the buttons are just the common ones.
- **This Mac, next poll only:** `touch ~/.tone_tonic/STOP`. Preflight fails on the next iteration and the foreman sleeps until the file is removed.
- **This phase, every Mac:** `gh issue edit <epic> --add-label foreman:pause`. No new claims are picked for issues under that phase on any Mac; in-flight sessions finish normally.
- **The planning backstop, every Mac:** the planner never runs on an epic that is not labeled `agent-ready`, and never on a second epic while a drafted plan is still waiting on the owner. Starting a phase is therefore always an explicit `gh issue edit <epic> --add-label agent-ready`; leaving every epic unlabeled leaves the foreman idle. `ctl status` says `epic #N awaits agent-ready before the planner runs` when this is what is holding it.
- **Owner gates, from the page:** the **Owner** card lists every open epic with the label gates only a human can open — **Sign off** (adds `signed-off`, drops `needs-owner`, closes the epic), **Approve plan** (`plan-approved`), **Start planning** (`agent-ready`), **Pause** / **Resume** (`foreman:pause`). Each button confirms the exact label change first, and the daemon wakes straight after so the next tick acts on it. The same gates are still just labels, so `gh issue edit <epic> --add-label <label>` works identically.
- **Get told instead of looking:** the page is localhost-only, so add `notify` to `~/.tone_tonic/foreman.json` to have the foreman push a one-line notification on the events that change what you have to do — see below.
- **Issues waiting on you, from the page:** the **Needs you** card lists every open *non-epic* issue labelled `needs-owner`, `decision` or `blocked` — the ones that have no epic card to sit on and used to be invisible everywhere. Oldest first, each linked to GitHub with how long it has waited; `ctl status` prints the same list on a `needs you` line (`nothing` when there is none), and each one is also a `human` item on the `waiting` line. A `blocked` row carries an **Unblock** button: it confirms, then removes `blocked`, sets Status **Ready**, and comments `unblocked by owner via foreman@<host>` — the two GitHub edits that otherwise have to be made by hand before the picker will consider the issue again. The daemon wakes straight after, so the next tick can claim it; fix whatever caused the block first, because nothing else about the issue is changed. The server only accepts an issue the page is currently offering, the same allowlist rule as the Owner buttons.
- **Stop the launchd agent entirely:** `launchctl bootout gui/$(id -u)/com.tonetonic.foreman` (a clean stop, as above).

`foreman start` refuses when the daemon recorded in `state.json` is still alive, and `foreman status` warns when the web port is held by a different process — the symptom of a stale daemon serving a frozen page while a newer one does the work.

A killed daemon (`kill -9`) does no bookkeeping: `ctl status` then shows `CRASHED` and, if the child is still alive, `ORPHAN child <pid>`; `ctl stop` or `ctl abort` kills it.

### Push notifications

Optional, off by default: `foreman.example.json` carries no `notify` block, so a config copied from it notifies nothing until you add one. Both channels are independent; set either, both, or neither.

```json
{
  "notify": {
    "slackWebhookUrl": "https://hooks.slack.com/services/T000/B000/xxxxxxxx",
    "macos": true
  }
}
```

- `slackWebhookUrl` — a Slack **incoming webhook**. Create one at <https://api.slack.com/apps> → your app (or **Create New App** → *From scratch*, pick the workspace) → **Incoming Webhooks** → toggle on → **Add New Webhook to Workspace** → choose the channel or your own DM. Copy the `https://hooks.slack.com/services/…` URL into `foreman.json`. That URL is a credential: `foreman.json` lives in `~/.tone_tonic/`, outside the repo, and the foreman never logs it, never puts it in a role session's prompt, and never serves it on the page. Rotate it from the same Slack page if it leaks.
- `macos` — `true` shows a Notification Center banner via `osascript`. It appears on whichever Mac the daemon runs on, so it is the fallback when you are at the machine rather than away from it. The first banner may need Notification Center permission for whatever runs the daemon (Terminal, or `launchd` → **System Settings → Notifications → Script Editor**).

Seven events, one line each, with the GitHub link:

| Event | Line |
|---|---|
| PR merged | `merged #<pr> → closes #<issue>: <title>` |
| Issue blocked | `blocked #<issue> <title> — <first line of the reason>` |
| Decision issue opened | `decision needed #<issue>: <title>` |
| Phase closed | `phase <epic> closed: <title> — review #<n>` |
| Plan drafted | `plan drafted for #<epic>: <title>` (links the plan PR) |
| Daemon parked | `foreman parked on <host>: <reason>` |
| Daemon resumed | `foreman resumed on <host> (was: <reason>)` |

A notification carries issue and PR numbers, titles, and the foreman's own reason strings — never tool inputs, session transcripts, or the stderr excerpt that goes into the `blocked by foreman@…` GitHub comment. Reasons are cut to one line.

Parked fires once per parked spell, not once per tick, and resumed once when preflight passes again; if the reason changes mid-spell (the daily cap clears but Docker is down) the daemon stays quiet and the resume line names the latest reason. Decision issues are announced once each; enabling notifications on a repo that already has open decision issues seeds them silently rather than replaying the backlog. That bookkeeping lives in `~/.tone_tonic/notify.json` — delete it to re-announce everything.

A send that fails (webhook down, no network, `osascript` denied) logs a `warn` line and is dropped; it never fails a tick and is never retried. Sends have a 5 s timeout. `--dry-run` notifies nothing.

## 6. Budget

Three knobs in `~/.tone_tonic/foreman.json`:

- `maxSessionsPerDay` — preflight refuses to start a new session once today's count (from `~/.tone_tonic/sessions.log`) reaches this. "Today" is the **local** date, so the count clears at local midnight, and interrupted or aborted sessions still count. When the cap is what is holding the Mac, `ctl status` and the page say `parked · daily session cap reached (N/N)` rather than "idle", and the cap is changeable from there — see §5.
- `maxTurns` — passed to `claude -p --max-turns`; a session that hits this without returning an outcome counts as a failed attempt and is retried (up to 3 attempts total).
- `wallClockMinutes` — the dispatcher kills the `claude -p` child (`SIGTERM`, then `SIGKILL` after 30s) if it runs longer than this.
- `stallMinutes` — minutes without a stream-json event before the page and `ctl status` flag the session as stalled (visibility only; nothing is killed).
- `minGraphqlPoints` — preflight refuses to start a tick when GitHub reports fewer GraphQL points left than this (default 500).

Each tick samples the budget three times (the `rateLimit` query is free) and `ctl status`, the page's Tick card and the log line `graphql budget` break the spend down three ways: **reads** is what the loop's own snapshot cost, **session** is what the `claude -p` session it dispatched spent, and **elsewhere** is what was gone before the tick started — a role session on another Mac, a second daemon, or a human at a terminal. Attribute before optimising.

There is a second budget besides money: GitHub gives 5000 GraphQL points an hour, and `gh issue list`, `gh pr list` and `gh project item-list` all spend it. The foreman keeps inside it by reading one issue at a time (`gh issue view`) instead of re-listing the repo, caching the project board for the length of a tick, reusing the tick's snapshot instead of re-fetching issues it already has, and polling every `pollSeconds` (default 300). If it still runs out, preflight parks the daemon with `GitHub GraphQL budget low: <n> points left, resets <time>` until the window rolls over.

Per-session cost (from the session's JSON result) is posted in the `session … finished` issue comment and appended as one JSON line per session to `~/.tone_tonic/sessions.log`, which is also what `countSessionsToday` reads for the daily cap. Each line carries `t`, `host`, `role`, `issue`, `sessionId`, `attempt`, `costUsd`, `outcome`, and — since #226 — `model` (the id the CLI reported at init, e.g. `claude-opus-5`, falling back to the dispatched name), `turns`, `durationMinutes`, `denials` and `subtype`, so opus and sonnet can be compared on cost, turns and wall-clock rather than on cost alone. The **Recent** card and `jq` over the log both read them; lines written before #226 have none of these fields and still parse, reading as `""`/`0`.

A merge also appends one line to `~/.tone_tonic/merges.log` (`issue`, `pr`, `host`, `claimedAt`, `mergedAt`). The merged issue closes and drops out of every later snapshot, so this is what keeps the phase card's cycle time computable; it is a local cache like `sessions.log`, and losing it only empties that number.

The Phase card and the `phase` line are computed inside the tick from the snapshot it already fetched plus these two logs — no extra GitHub reads. A phase's task list is the epic's sub-issues plus any issue whose body says `Parent epic: #<epic>`; a task the snapshot no longer lists is closed, i.e. done.

## 7. Resume and multi-Mac

All durable state lives in GitHub; local disk (the worktree, the transcript, `sessions.log`) is a cache the foreman can lose without losing work, because every role checkpoints by pushing the branch.

- **Same Mac, same session:** the foreman finds its own open claim (an issue it claimed that's still In Progress) and, if the local Claude Code transcript for that session id still exists, resumes with `--resume <id>` and a note to continue from the last Progress comment.
- **Same Mac, transcript gone** (e.g. `~/.claude/projects/...` was cleared): a fresh session id is used instead, with a note to read the issue's Progress comments and `git log origin/main..HEAD` before continuing.
- **Different Mac / after a crash:** an In Progress issue with no comment and no branch commit for 2 hours (`STALE_HOURS` in `src/claim.ts`) may be reclaimed by any other foreman — it comments `reclaimed from <host> by <host> at <iso>` and starts a fresh builder session with the same "read Progress comments, continue" instruction.
- **Two Macs claim the same issue in the same window:** both post a `claimed by …` comment before either sees the other's. Once both are visible, `resolveConflict` (`src/claim.ts`) keeps the alphabetically first host and the other(s) comment `released by <host>: conflict` and unassign — so pick a `host` value with this in mind if it matters which Mac "wins" a race (it shouldn't matter in practice; work isn't lost, just not duplicated).
- Reviewer/validator "changes requested" cycles a builder back for a fix round; after `MAX_FIX_ROUNDS` (2) failed rounds — i.e. a third change request — the issue is labeled `blocked` instead of retried again.

## 8. Troubleshooting

- **`"Ignoring N permissions.allow entries"` in a session log.** The worktree wasn't marked trusted in `~/.claude.json`. The foreman does this itself (`trustWorktree` in `src/dispatch.ts`) after `ensureWorktree` runs, so this usually means the worktree was created or moved outside the foreman's normal flow — check `~/.claude.json`'s `projects` map has an entry for the worktree path with `"hasTrustDialogAccepted": true`.
- **`error_max_turns` as the session subtype.** The role hit `--max-turns` before returning an outcome. Raise `maxTurns` in `~/.tone_tonic/foreman.json` if the role's work is legitimately long, or check whether it's looping.
- **Validator fails at `serve start`.** Check `~/.tone_tonic/logs/serve-api.log` and `~/.tone_tonic/logs/serve-web.log` (written by `pnpm --filter @tone/foreman serve start`) for why the web or api process didn't come up on its port.
- **`notify-failed` label appears on an epic.** The Slack connector was unreachable from that Mac's headless session (message content lands as a GitHub comment on the epic instead, so nothing is lost). Re-run `claude` → `/mcp` on that Mac and confirm `claude mcp list` shows the Slack connector Connected (see Install step 4).
- **Playwright chromium not found by the MCP server, or the MCP's own installer stalls.** On Apple Silicon Macs, `@playwright/mcp@0.0.80` bundles its own `playwright-core`, and a plain `npx playwright@1.62.1 install chromium` can put the browser where that bundled core doesn't look — the MCP's own downloader can then stall trying to fetch it again. Workaround:
  1. Try the MCP's own bundled installer once: `npx -y -p @playwright/mcp@0.0.80 -c 'playwright install chromium'`.
  2. If that stalls, install with `npx playwright@1.62.1 install chromium`, then look at `ls ~/Library/Caches/ms-playwright` — a failed MCP run's error names the directory names it expects (`chromium-*`, `chromium_headless_shell-*`). Symlink or copy the directories `npx playwright@1.62.1` produced to those expected names.
- **A validator screenshot is missing from `.playwright-mcp/`.** The screenshot tool sometimes writes the PNG to the worktree root instead of `.playwright-mcp/`; the validator sweeps both into `.validation-artifacts/<pr>/`, so check both locations before concluding a screenshot step failed.
- **`~/.tone_tonic/artifacts/<pr>/` is empty after a validation run.** The foreman only copies what the validator left in `<worktree>/.validation-artifacts/<pr>/`, and only on a `passed`/`failed` outcome — a session that died without an outcome archives nothing. Look for the `archived validation artifacts` log line in `~/.tone_tonic/logs/foreman.out.log`; if it's absent, the worktree directory didn't exist. Role sessions cannot write to `~/.tone_tonic/artifacts/` themselves: in `--permission-mode dontAsk`, a Bash command that creates or moves a file outside the worktree is denied even though `mkdir`/`mv` are allowlisted.
- **Branch protection isn't enforced on `main`.** This repo is private on GitHub's free plan, so branch protection rules return HTTP 403 and can't be turned on. The guards against an accidental direct push or merge are the `.claude/headless-settings.json` deny rules (`gh pr merge*`, `git push origin main*`, etc., applied to every headless session) plus the rule that only the foreman itself calls `gh pr merge` — not a GitHub-enforced branch rule.

## 9. Manual operations

- `foreman status|next|stop|abort|go` (or `pnpm --filter @tone/foreman ctl <cmd>` without the wrapper) — see §5. `status --watch` refreshes every 2 s from local files; `next` is the only subcommand that calls GitHub.
- `foreman start|restart|update|logs|page` — wrapper-only conveniences: start the daemon detached with its log in `~/.tone_tonic/foreman.log`, restart it, pull the clone and install deps, tail the log, open the page.
- `pnpm --filter @tone/foreman dev-env` — writes `apps/api/.env.local` and `apps/web/.env.local` from the running local Supabase's `supabase status -o env` output. Useful before running validator-style manual checks yourself.
- `pnpm --filter @tone/foreman serve start` / `serve stop` / `serve status` — starts/stops/checks the web (`:8082`) and api (`:3005`) dev servers in the background, logging to `~/.tone_tonic/logs/serve-*.log` and tracking PIDs in `~/.tone_tonic/serve.json`. This is what the validator role uses to bring the app up before driving it with Playwright.
- `pnpm --filter @tone/foreman start --once` — run a single loop iteration and exit, instead of polling forever. Useful for debugging one action at a time.
- `pnpm --filter @tone/foreman start --dry-run` — log every action `execute()` would take (including the full `claim#N` / `merge#N` / `apply_plan#N` / `plan#N` plan) without calling any `gh` method or spawning `claude`. Combine with `--once` for a single readonly pass; without `--once` it dry-runs forever on the poll interval.
- `pnpm --filter @tone/foreman start --config <path>` — use a config file other than `~/.tone_tonic/foreman.json` (or `$TONE_FOREMAN_CONFIG`). This is how a second foreman on the same Mac (for testing multi-Mac behavior) points at a different `host`/`workDir` without touching the first one's config.
- `GET /api/feed?session=<uuid>&limit=<n>` on the page's port returns the last `n` (default 50, max 500) feed entries for that session.

Example dry-run output against the real repo (one line per JSON log entry):

```json
{"msg":"preflight ok","host":"matthew-mbp","once":true,"dryRun":true,"warnings":[]}
{"msg":"plan","actions":["claim#146","apply_plan#124","apply_plan#1","plan#10"]}
{"msg":"action","type":"claim","issue":146,"role":"builder","pr":null,"round":1,"dryRun":true}
```

`execute()` stops after the first action that would start a `claude -p` session (here, `claim#146`), so `apply_plan#124`, `apply_plan#1`, and `plan#10` are logged as part of the plan but never run in this iteration — and dry-run never gets far enough to write anything to GitHub regardless.
