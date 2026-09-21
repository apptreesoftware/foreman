# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

`@apptreesoftware/foreman`: a TypeScript daemon that runs a GitHub issue pipeline unattended. It shells out to `claude -p` for five fixed roles (planner, builder, reviewer, validator, phase-closer) against issues on a GitHub Projects v2 board and does the deterministic bookkeeping between them: labels, board Status, claims, CI reruns, squash merges. One daemon per repository; several per Mac. Everything repository-specific lives in the served repository's `.foreman/` directory, never here.

Read `README.md` first.

## Layout

- `src/cli/` — the `foreman` binary: `main.ts` dispatches subcommands; `daemon.ts` is the long-running loop entry; `ctl.ts` the control commands; `launchd.ts`, `instances.ts`, `hooks.ts`, `args.ts`.
- `src/bootstrap/` — `init` (labels, board, scaffold) and `epic new`.
- `src/loop.ts` — one tick: preflight, snapshot, plan, execute; `runRole` runs the hooks around a `claude -p` session. Large; edit surgically.
- `src/pick.ts`, `src/state.ts`, `src/merge.ts`, `src/claim.ts`, `src/phase.ts` — the scheduler. `src/ledger.ts` is the issue-comment grammar that is the source of truth for who holds what.
- `src/dispatch.ts` — `claude -p` argv, prompt, env, worktrees, retries. `src/prompts.ts` composes the role prompt and headless settings per dispatch. `src/hooks.ts` runs the four repo hooks.
- `src/instance.ts`, `src/config.ts` (machine config, `~/.foreman/<name>/foreman.json`), `src/repo-config.ts` (`.foreman/config.json`).
- `src/web.ts` + `src/web.html` — the localhost status page. `src/status.ts`, `src/next.ts`, `src/waiting.ts`, `src/board.ts` describe it.
- `roles/*.md` — base role prompts (`ground-rules.md` + one per role). `settings/headless.json` — base Claude Code allow/deny for role sessions.
- `test/fixtures/repo/.foreman/` — a fixture served repository (config, rules, settings, executable hooks). `test/fixtures/*.json` — recorded `gh` output for owner `acme`, repo `widgets`.

## Commands

```
pnpm install
pnpm lint            # biome check
pnpm typecheck
pnpm test            # vitest, no network; hook tests run real shell fixtures
pnpm build           # tsc to dist/ + copies src/web.html
pnpm dev -- help     # run the CLI from source
npm link             # make `foreman` on this Mac run this clone (rebuild with pnpm build after changes)
pnpm test -- src/hooks.test.ts          # one file
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, build on every push. A `v*` tag runs `release.yml`, which publishes to npm through trusted publishing; bump `version` in `package.json` first, the workflow refuses a mismatched tag.

## Rules

- **Fixed process.** Label names, the five board Statuses, the issue-body sections (`## Goal`, `## Acceptance criteria`, `## Touches`, `## Depends on`, `## Spec`, `Parent epic: #N`), the branch template `feat/<issue>-<slug>`, the ledger grammar and the outcome JSON do not change. The five roles are hardcoded. Anything a repository may vary goes through `.foreman/config.json`, `rules.md`, `roles/<role>.md`, `settings.json` or the four hooks, not through new constants here.
- **Nothing repository-specific in `src/`, `roles/` or `settings/`.** No package-manager, database, browser, or product names. The only exceptions are the `setup`/`checks` defaults in `src/repo-config.ts`. `grep -rniE "pnpm|supabase|docker|playwright" src roles settings` must return only `src/repo-config.ts`.
- **Subscription billing only.** `FORBIDDEN_ENV` (`src/preflight.ts`) names are refused at startup, in preflight, and stripped from the child env in `childEnv` even when a `session-env` hook sets them. Never weaken this.
- **Secrets stay off disk.** `session-env` stdout is never written to `hooks.log`; `foreman.json` (which may hold a Slack webhook) is never logged or served.
- **Hooks come from the clone, not the branch.** `hookPath` resolves under `repoDir`; `config.json` is read from the clone at daemon start. `rules.md`, `roles/<role>.md` and `settings.json` are read from the worktree at dispatch. The composed settings deny `Edit`/`Write` under the worktree's `.foreman/**` and `.claude/**`. Keep that boundary.
- **A setup or hook failure blocks the issue** (`blockOnSetupFailure` in `src/loop.ts`); it never leaves an open claim for the next tick to retry.
- **`gh` is the only GitHub client.** Every write goes through `GitHub` in `src/github.ts`, which honours `dryRun`. Tests never touch the network; they use exec doubles that assert the exact `gh` argv.
- **Repository config must never brick the CLI.** Control commands use `loadRepoConfigSafe` and fall back to defaults with a warning; only the daemon refuses a bad `.foreman/config.json`, naming the file.
- **Every optional parameter defaults to today's behaviour** so existing tests keep passing when a knob is added.
- Style: ESM, `.ts` import extensions, double quotes, semicolons, 100-column Biome, `noUncheckedIndexedAccess`. Tests next to the code as `*.test.ts`; TDD for behaviour changes.
- Commit messages: `type(scope): summary`. `pnpm lint && pnpm typecheck && pnpm test` green before every push.

## Working on a served repository

To dogfood a change: `npm link` here, then `pnpm build` after every change, then in the served repository `foreman -p <name> run --once --dry-run` before `start`. State lives under `~/.foreman/<name>/`; `foreman -p <name> stop` before touching it. Never run two daemons on one instance, and never point two instances at the same `repoDir`.
