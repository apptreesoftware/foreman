# Foreman extraction: a standalone, per-repo daemon

**Date:** 2026-09-18
**Status:** Approved (brainstorm complete)
**Depends on:** `2026-09-03-autonomous-foreman-design.md`, `2026-09-03-foreman-control-design.md`, `2026-09-04-foreman-live-visibility-design.md` (all built)
**Target:** `github.com/apptreesoftware/foreman`, npm `@apptreesoftware/foreman`

## 1. Goal

Lift `tools/foreman` out of this repository into a tool that runs the same issue pipeline against any GitHub repository, with several foremans on one Mac (one per repository), and switch tone_tonic over to it. The pipeline itself does not change: epic → planner → tasks → builder → reviewer → validator → merge → phase-closer, with the same labels, board statuses, ledger comments and outcome JSON. What changes is that everything tone_tonic-specific moves out of the daemon and into a `.foreman/` directory that each repository commits.

## 2. Decisions locked during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | Home | `apptreesoftware/foreman` on GitHub, published as `@apptreesoftware/foreman` on npm. Not a personal repository. |
| 2 | Instances | One foreman per repository, several per Mac. An instance is a name; its config and state live at `~/.foreman/<name>/`. |
| 3 | Process | Fixed and always on: epics, phases, planner, phase-closer. The foreman only works tasks that its own planner created. The five roles are hardcoded; no role plugin system. |
| 4 | Entry point | One human-made issue per phase: the epic. `foreman epic new` creates it. The planner creates every task issue, on the board, with the body sections the picker needs. |
| 5 | `adopt` | Removed. A hand-made `agent-ready` issue is not picked up. |
| 6 | Repo-specific process | Committed in the repository under `.foreman/`: config knobs, house rules appended to role prompts, optional per-role additions, extra headless allow/deny rules, and four shell hooks. |
| 7 | Role prompts | Base prompts ship with the foreman. The repository appends rules; it never replaces a base prompt. |
| 8 | Hooks | Executable shell scripts in `.foreman/hooks/`: `preflight`, `session-env`, `before-session`, `after-session`. Any language, no rebuild. |
| 9 | Notifications | The daemon's own `notify` (Slack incoming webhook, macOS banner) is the only path. The Slack MCP connector leaves the role prompts and the headless settings; the `notify-failed` label is gone. |
| 10 | Distribution | `npm i -g @apptreesoftware/foreman`. Node 22. One TypeScript CLI replaces the zsh wrapper, the `ctl` script and the launchd sed recipe. |
| 11 | Method | Move first, refactor in the new repository (`git subtree split` keeps history), then one migration PR to tone_tonic. |
| 12 | tone_tonic | Switches in the same effort, as the last step. `tools/foreman` is deleted; `.foreman/` is added. |
| 13 | `gh` | Still the only GitHub client. Installed and authenticated by the user, with the `project` scope. |

## 3. Repository and package

```
foreman/
  package.json          @apptreesoftware/foreman, "bin": { "foreman": "dist/cli.js" }, "files": ["dist", "roles", "settings"]
  src/                  today's src/ plus cli/, instance.ts, hooks.ts, repo-config.ts, bootstrap/
  roles/                base prompts: builder.md reviewer.md validator.md planner.md phase-closer.md
  settings/headless.json base Claude Code headless settings (allow/deny)
  test/fixtures/        sanitised board/issue/PR fixtures (owner `acme`, repo `widgets`), a fixture repo with a .foreman/ directory
  docs/                 this spec (copied), README
  .github/workflows/    ci.yml (lint, typecheck, test on ubuntu), release.yml (tag v* → npm publish)
```

- Built with `tsc` to `dist/`; no `tsx` at runtime. `pnpm link --global` is the development install.
- Release: a `v*` tag publishes through npm trusted publishing (GitHub OIDC). No `NPM_TOKEN` secret. Versions start at `0.1.0`.
- `scripts/serve.ts` and `scripts/dev-env.ts` do not come along. They start tone_tonic's web and api servers and write its Supabase env files; they move to `tone_tonic/tools/serve` in the migration PR and the validator reaches them through `.foreman/roles/validator.md`.
- `src/main-run-redundant.test.ts` tests a tone_tonic CI script and moves to the tone_tonic root in the migration PR.
- Biome for lint and format, Vitest for tests, as today.

## 4. Instances

### 4.1 Layout

```
~/.foreman/<name>/
  foreman.json        machine config (§4.3)
  state.json          daemon state, as today
  sessions.log        one JSON line per finished session
  merges.log          one JSON line per merge
  notify.json         notification bookkeeping
  STOP                kill switch, present or absent
  logs/               foreman.log, hook logs
  activity/           <sessionId>.jsonl feeds
  artifacts/<pr>/     validator screenshots copied out of the worktree
  settings.json       generated: base headless settings + .foreman/settings.json
  roles/<role>.md     generated: base prompt + .foreman/rules.md + .foreman/roles/<role>.md
```

`~/.foreman` replaces `~/.tone_tonic`; `FOREMAN_CONFIG` replaces `TONE_FOREMAN_CONFIG` and points at a `foreman.json` for the rare case of a config outside the layout.

### 4.2 Resolution

Every command resolves its instance in this order and stops at the first hit:

1. `-p <name>` / `--instance <name>`.
2. `FOREMAN_INSTANCE`.
3. The current directory is inside a configured `repoDir` (or one of its worktrees).
4. Exactly one instance exists under `~/.foreman/`.
5. Otherwise: error listing the instances found.

### 4.3 Machine config (`foreman.json`)

Today's schema minus `slackUser`:

| Key | Required | Default |
|---|---|---|
| `repo` | yes | |
| `project` | written by `init` | |
| `host` | yes | |
| `repoDir` | yes | |
| `workDir` | no | `<repoDir>/.worktrees` |
| `model` | no | `opus` |
| `pollSeconds` | no | 300 |
| `maxSessionsPerDay` | no | 20 |
| `maxTurns` | no | 200 |
| `wallClockMinutes` | no | 90 |
| `stallMinutes` | no | 5 |
| `webPort` | no | first free port from 8090, chosen by `add` |
| `minGraphqlPoints` | no | 500 |
| `notify` | no | none |
| `webAuth` | no | none: `{ user, password }` for HTTP Basic; set, every route demands it and the localhost-only Host check is dropped so a tunnel can reach the page |

`webPort` must be unique per instance on a Mac; `foreman add` refuses a port another instance already has.

### 4.4 launchd

`foreman -p <name> launchd install` writes `~/Library/LaunchAgents/com.apptreesoftware.foreman.<name>.plist` with concrete paths (the `foreman` binary, `HOME`, the instance) and bootstraps it. `launchd uninstall` boots it out and removes the plist. The plist keeps `KeepAlive`, `RunAtLoad`, `ThrottleInterval 60`, and names only `HOME` and `PATH`, so launchd starts the daemon from a clean environment and the API-billing env vars never reach it; `runDaemon` exits 2 if one is set anyway. `git pull --ff-only` at daemon start stays.

## 5. Repository config: `.foreman/`

Committed in every repository the foreman works on. `rules.md`, `roles/<role>.md` and `settings.json` are read from the worktree at dispatch time, so a PR that changes them applies to the sessions that run on its own branch; `config.json` and `hooks/` are read from the clone at `repoDir` instead — the config once at daemon start, the hooks at every run — so a change to either needs the clone pulled (the daemon pulls at start) and the daemon restarted.

```
.foreman/
  config.json      process knobs (§5.1)
  rules.md         appended to every role prompt
  roles/<role>.md  optional, appended to that role's prompt after rules.md
  settings.json    { "allow": [...], "deny": [...] } merged into the headless settings
  hooks/           preflight, session-env, before-session, after-session (§6)
```

### 5.1 `config.json`

Every key optional. Defaults reproduce today's behaviour, except `validator.skipLabels`, which defaults to empty; the values below are tone_tonic's.

```json
{
  "setup": "pnpm install",
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "plans": { "dir": "docs/superpowers/plans", "specGlob": "docs/**/*.md" },
  "validator": { "skipLabels": ["area:infra", "area:db", "area:shared"] },
  "limits": { "fixRounds": 2, "ciReruns": 1, "blockedPerPhase": 2, "staleHours": 2, "attempts": 3 },
  "models": ["opus", "sonnet", "haiku", "fable"]
}
```

- `setup` runs once when a worktree is created (today's `pnpm install`). `null` skips it.
- `checks` is what the rebase round runs and what the base builder prompt names as "the checks".
- `plans.dir` is where the planner writes `<date>-phase-NN-plan.md` and `.issues.json`, and where `apply_plan` looks on the default branch. `plans.specGlob` is what `## Spec` links must match.
- `validator.skipLabels`: a PR whose issue carries one of these gets `validator:skipped`. Default is empty; tone_tonic sets the three area labels.
- `limits` are today's constants.
- `models` populates the page's model buttons and the accepted `model:<name>` labels.

### 5.2 What stays fixed

Label names, board Status names (Backlog, Ready, In Progress, In Review, Done), the branch template `feat/<issue>-<slug>`, the issue-body sections (`## Goal`, `## Acceptance criteria`, `## Touches`, `## Depends on`, `## Spec`, `Parent epic: #N`), the ledger comment grammar and the outcome JSON. These are the process, and the process is fixed (decision 3). The README documents them. The default branch is read from `gh repo view --json defaultBranchRef`, never configured.

## 6. Hooks

Four optional executables in `.foreman/hooks/`. A missing hook is a no-op. Each runs with a 10-minute timeout, stdout and stderr captured to `~/.foreman/<name>/logs/hooks.log`, and this environment:

| Variable | Set for |
|---|---|
| `FOREMAN_INSTANCE`, `FOREMAN_STATE_DIR`, `FOREMAN_REPO_DIR` | all hooks |
| `FOREMAN_ROLE`, `FOREMAN_ISSUE`, `FOREMAN_PR`, `FOREMAN_WORKTREE`, `FOREMAN_ROUND` | session hooks (`FOREMAN_PR` empty when none) |

| Hook | Runs | Contract |
|---|---|---|
| `preflight` | every tick, from `repoDir`, after the built-in checks | Exit 0: ok. Non-zero: the daemon parks; the last non-empty stderr line is the reason. Stdout lines starting `warn:` are preflight warnings. |
| `session-env` | once per dispatch, around every attempt of that session, from the worktree | Stdout `KEY=VALUE` lines enter the child environment. Stdout lines starting `prompt:` are appended, in order, to the session prompt. Non-zero exit blocks the issue with the hook's stderr; the operator fixes the hook and unblocks. |
| `before-session` | after `session-env`, once per dispatch, around every attempt of that session, from the worktree | Non-zero exit blocks the issue with the hook's stderr; the operator fixes the hook and unblocks. |
| `after-session` | once per dispatch, from the worktree: after the last attempt exits, is killed, or the daemon is interrupted; and again before the next dispatch on the same worktree | Exit code logged, never fatal. |

The built-in preflight keeps what is generic to running `claude -p` on a subscription: the `STOP` file, `claude auth status` is a `claude.ai` login, no API-billing env var, `gh auth status` with the `project` scope, the daily cap, the GraphQL budget. Docker, Supabase, the `tone_tonic_val` stack and the Playwright chromium check leave the daemon.

tone_tonic's hooks, written in the migration PR:

- `preflight`: `docker info`; bring up `tone_tonic_val` from a copy of `packages/db/supabase` under `$FOREMAN_STATE_DIR/val-stack` with `role-config.sh` applied (today's `ensureRoleStack`); warn when `~/Library/Caches/ms-playwright` has no chromium.
- `session-env`: for builder, reviewer and validator, print `TONE_WEB_PORT=8182`, `TONE_API_PORT=3105`, `SUPABASE_API_URL=http://127.0.0.1:55621` and the `prompt:` lines that today's `ports.ts` and `dispatch.ts` add (local URLs, the isolated-stack paragraph).
- `before-session`: run `packages/db/scripts/role-config.sh` on the worktree's `config.toml` and `git update-index --skip-worktree` it, for those three roles.
- `after-session`: `--no-skip-worktree`, then `git checkout -- packages/db/supabase/config.toml`.

## 7. Role prompts and headless settings

### 7.1 Prompts

The foreman ships five base prompts. They hold everything that is the pipeline's own contract: the ground rules (never `cd` out of the worktree, never touch the default branch, never merge, idempotent GitHub writes, the `.gh-body.md` workaround), the ledger and Progress-comment formats, the fix-round and rebase-round rules, the PR body template with `Closes #<issue>`, the decision-issue protocol, the planner's `.issues.json` schema, the phase-closer's review-issue sections, and the outcome JSON. They name `{{checks}}`, `{{plansDir}}` and `{{specGlob}}` and nothing else about the repository.

At dispatch the foreman writes `~/.foreman/<name>/roles/<role>.md`:

```
<base roles/<role>.md with placeholders filled>

## House rules
<.foreman/rules.md>

## <role> rules
<.foreman/roles/<role>.md, if present>
```

and passes it with `--append-system-prompt-file`. Sessions also read the repository's `CLAUDE.md` as any Claude Code session does; `rules.md` is for what the roles need beyond that (which commands to run, what a validator boots, DB rules a reviewer must check).

### 7.2 Settings

`settings/headless.json` keeps what is generic: the tool allowlist, the coreutils allowlist, `gh issue|pr|project` allowed, `gh pr merge|close`, `gh api`, `git push` to the default branch, force pushes, `worktree remove`, `sudo`, `rm -rf` of home, reads of `~/.ssh`, `~/.aws`, `~/.claude*` denied. `Bash(pnpm *)`, `Bash(supabase *)`, `Bash(docker *)`, `Bash(npx playwright *)`, `mcp__playwright__*` and `mcp__claude_ai_Slack__*` leave the base file; a repository that needs them adds them in `.foreman/settings.json`. At dispatch the foreman concatenates base and repository `allow` and `deny` arrays into `~/.foreman/<name>/settings.json` and passes `--settings`. A repository rule can add to either list; it cannot remove a base deny.

`trustWorktree` (the `hasTrustDialogAccepted` write to `~/.claude.json`) stays as it is.

## 8. CLI

One binary, `foreman`, with `-p <name>` on every command that needs an instance.

| Command | Does |
|---|---|
| `add <name> --repo <owner/repo> --repo-dir <path> [--host <h>] [--web-port <n>]` | Writes `~/.foreman/<name>/foreman.json`. `host` defaults to the Mac's short hostname, lowercased. |
| `init` | Idempotent repository bootstrap (§9). |
| `epic new --title <t> --phase <n> --spec <path> [--agent-ready]` | Creates the epic issue (§9). |
| `start` / `run [--once] [--dry-run]` | `start` detaches the daemon with its log; `run` runs it in the foreground. |
| `stop`, `abort`, `go`, `status [--watch] [--json]`, `next`, `model [<name>|default]`, `cap [<n>|default]`, `logs [-f]`, `page` | As today's `ctl` and wrapper. |
| `launchd install|uninstall|status` | §4.4. |
| `list` | Every instance under `~/.foreman/` with its repo, daemon state and port. |
| `hooks run <hook>` | Runs one hook by hand against the instance's `repoDir`, for debugging. |

The web page and its `/api/*` endpoints do not change beyond the vocabulary already generic to the process. The `serve`/`dev-env` subcommands are gone.

## 9. Bootstrap: `init` and `epic new`

`foreman -p <name> init`, idempotent, in this order:

1. `gh auth status` succeeds and the token has the `project` scope; if not, print `gh auth refresh -s project,read:project` and stop.
2. Labels exist on `repo`: `epic`, `agent-ready`, `blocked`, `needs-owner`, `decision`, `plan-approved`, `signed-off`, `foreman:pause`, `sandbox`, `reviewer:approved`, `reviewer:changes`, `validator:passed`, `validator:failed`, `validator:skipped`, `size:S`, `size:M`, `size:L`, and `model:<m>` for each entry in `config.json`'s `models`. `phase:N` and `area:*` labels are created by the planner when it applies a plan.
3. A Projects v2 board exists. If `project` is unset in `foreman.json`: `gh project create --owner <owner> --title <repo name>`, link it to the repository, set the `Status` single-select options to exactly Backlog, Ready, In Progress, In Review, Done via `gh api graphql` (`updateProjectV2Field`), and write the project number to `foreman.json`. If `project` is set, verify the field and its options and report any drift instead of editing.
4. `.foreman/` exists in `repoDir`: if absent, scaffold `config.json` (defaults, commented in the README), an empty `rules.md`, `settings.json` with empty arrays, and no hooks. Nothing is committed; the user reviews and commits.

`foreman -p <name> epic new --title "Phase 3: billing" --phase 3 --spec docs/specs/billing.md [--agent-ready]`:

1. The spec path exists on the default branch and matches `plans.specGlob`.
2. Creates the issue with labels `epic`, `phase:3` (created if missing) and, with `--agent-ready`, `agent-ready`; body `## Spec\n<path>`.
3. Adds it to the board with Status Backlog; prints the issue URL.

From there the existing loop takes over: the planner runs on an `agent-ready` epic, `plan-approved` applies the plan and creates the task issues on the board at Ready, the picker claims them.

## 10. Core changes

Removed from the daemon: `ports.ts`, `adopt.ts`, the Docker/Supabase/chromium checks and `ensureRoleStack` in `preflight.ts`, `applyRoleConfig`/`restoreRoleConfig` in `dispatch.ts`, `needsIsolatedStack`, the Slack MCP references, `scripts/serve.ts`, `scripts/dev-env.ts`, `bin/foreman`, `launchd/*`, `main-run-redundant.test.ts`.

Added: `instance.ts` (layout, resolution), `repo-config.ts` (`.foreman/config.json` schema and defaults), `hooks.ts` (runner with the contract in §6), `prompts.ts` (prompt and settings composition), `cli/` (subcommands), `bootstrap/` (`init`, `epic new`).

Changed: every `~/.tone_tonic` path goes through the instance layout; every constant in §5.1 reads from repo config; the picker requires `Parent epic:` in the body; `MODEL_CHOICES` and `CAP_CHOICES` come from config; `launchd-status.ts` uses the per-instance label; `notify.ts`'s macOS title is `foreman <name>`; `dispatch.ts` runs the hooks around the child and composes prompt and settings per attempt.

## 11. Testing

- Unit tests as today, on sanitised fixtures (`acme/widgets`). `roles.test.ts` and `settings.test.ts` read the shipped `roles/` and `settings/headless.json` plus a fixture repository at `test/fixtures/repo/.foreman/`; they assert the composed prompt contains base, rules and role sections in that order and that a repository deny cannot remove a base deny.
- `hooks.test.ts`: each hook's contract with tiny shell fixtures (exit codes, `warn:` and `prompt:` lines, the `after-session` always-runs guarantee on kill).
- `instance.test.ts`: the five resolution steps; `add` refuses a duplicate port.
- `bootstrap.test.ts`: `init` and `epic new` against a recorded `gh` double; idempotence.
- Manual: `foreman add sandbox …`, `init` against a throwaway repository, `epic new --agent-ready` with a two-paragraph spec, `run --once --dry-run`, then a real run through planner → approve → build → merge on one trivial task. Recorded in the new repository's README as the release check.

## 12. Migration of tone_tonic (last step, one PR)

- Delete `tools/foreman`, `.claude/roles/`, `.claude/headless-settings.json`; remove the `@tone/foreman` workspace entries.
- Add `.foreman/config.json` (the values in §5.1), `.foreman/rules.md` (the tone_tonic parts of today's ground rules: Supabase ports, never `docker`/`supabase stop`, DB rules, design rules, `pnpm --filter` commands, read `CLAUDE.md` and `AGENTS.md`), `.foreman/roles/validator.md` (serve, dev-env, seeded logins, Mailpit, Playwright, `.validation-artifacts`), `.foreman/roles/reviewer.md` (the DB checklist), `.foreman/settings.json` (`pnpm`, `supabase`, `npx playwright`, `mcp__playwright__*` allows; `supabase stop|link|db push|projects|unlink`, `docker`, `orb` denies), and the four hooks from §6.
- Move `scripts/serve.ts` and `scripts/dev-env.ts` to `tools/serve` as `@tone/serve`; the validator rules name `pnpm --filter @tone/serve start`. Move `main-run-redundant.test.ts` next to the script it tests.
- Update `CLAUDE.md` (Workflow section, ports table entry for the foreman page), `AGENTS.md` (issue conventions: tasks come from the planner; the hand-made path is `foreman epic new`), `docs/ops/runbook.md` where it names `tools/foreman`.
- On the Mac: `npm i -g @apptreesoftware/foreman`, `foreman add tone_tonic --repo matthewtsmith/tone_tonic --repo-dir ~/Projects/tone_tonic --web-port 8090`, set `project: 2` by hand, copy `~/.tone_tonic/{sessions.log,merges.log,notify.json}` to `~/.foreman/tone_tonic/`, `launchctl bootout` the old agent, `foreman -p tone_tonic launchd install`. No migration code (pre-production rule).

## 13. Acceptance criteria

1. `npm i -g @apptreesoftware/foreman` on a clean Mac with `gh` and `claude` gives a working `foreman` binary; `foreman list` shows nothing and says how to `add`.
2. Two instances on one Mac run at once against two repositories with different ports, labels and state, and neither reads the other's `STOP`, cap or `state.json`.
3. `init` on an empty repository produces the labels and a board whose `Status` options are exactly the five, and a second `init` changes nothing.
4. `epic new --agent-ready` followed by a running daemon produces a drafted plan on the epic without any hand-made task issue.
5. Every tone_tonic-specific string in the daemon's `src/` is gone: `grep -rE 'tone_tonic|tonetonic|TONE_|@tone/|supabase|pnpm' src/` returns only the `setup` and `checks` defaults in `repo-config.ts`.
6. Hook contract holds under kill: `after-session` runs when the child is `SIGKILL`ed and when the daemon is stopped by `foreman stop`.
7. tone_tonic runs a full task through the published package on the migration PR's branch before that PR merges; the `sandbox` issue is the proof.

## 14. Out of scope

- Any board other than GitHub Projects v2, any host other than github.com, any CLI other than `gh`.
- Configurable label names, Status names or roles.
- Linux or Windows daemons (launchd only; `foreman run` works anywhere Node runs).
- A hosted or multi-user foreman.
- Migrating `~/.tone_tonic` state automatically.

## 15. Task breakdown

Detailed in the implementation plan. In order:

1. Create `apptreesoftware/foreman` from `git subtree split`; package rename; `tsc` build; CI green on the unchanged code with the three outside-reaching tests removed or re-pointed.
2. Instance layout and resolution; state dir parameterised; `add`, `list`.
3. Repo config schema and defaults; constants read from it.
4. Hook runner and the four hook points; delete `ports.ts`, `ensureRoleStack`, `applyRoleConfig`/`restoreRoleConfig`.
5. Base prompts and base settings; composition at dispatch; Slack MCP removed; `adopt` removed; picker requires `Parent epic:`.
6. CLI: fold `ctl` and the zsh wrapper into subcommands; `launchd install|uninstall`.
7. `init` and `epic new`.
8. README, release workflow, `0.1.0`.
9. tone_tonic migration PR (§12).
