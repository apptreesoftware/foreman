# Foreman Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift `tools/foreman` into `github.com/apptreesoftware/foreman`, published as `@apptreesoftware/foreman`, so one `foreman` binary runs one daemon per repository on a Mac with every tone_tonic-specific behaviour moved into a committed `.foreman/` directory.

**Architecture:** The scheduler (`pick`, `state`, `merge`, `ledger`, `loop`, `web`) is kept as is. Coupling is removed at four seams: an instance layout under `~/.foreman/<name>/` replaces `~/.tone_tonic`; a `.foreman/config.json` in the repository replaces hardcoded constants; four shell hooks replace the Supabase, Docker, port and `role-config.sh` logic; base role prompts and base headless settings shipped with the package are composed with the repository's `rules.md` and `settings.json` at dispatch. A single TypeScript CLI replaces the zsh wrapper, the `ctl` script and the launchd sed recipe, and gains `add`, `init`, `epic new`, `list` and `launchd install`.

**Tech Stack:** Node 22, TypeScript 5.9 (`tsc` to `dist/`), Zod 4, Vitest 4, Biome 2, pnpm 11, `gh` CLI, `claude` CLI.

**Spec:** `docs/superpowers/specs/2026-09-18-foreman-extraction-design.md` (in tone_tonic; copied to `docs/` in the new repo by Task 1).

**Scope of this plan:** spec §15 steps 1 to 8: the new repository up to the `0.1.0` publish. Step 9, the tone_tonic migration PR (spec §12), gets its own plan in tone_tonic once `0.1.0` exists, because it is a change to a different repository and depends on the published package.

## Global Constraints

- Package name `@apptreesoftware/foreman`, bin `foreman`, first version `0.1.0`, `engines.node >=22.18 <23`.
- Every source file keeps the existing style: ESM, `.ts` import extensions, double quotes, semicolons, 100-column Biome formatting, `noUncheckedIndexedAccess`.
- No `tone_tonic`, `tonetonic`, `TONE_`, `@tone/`, `supabase`, `docker`, `playwright`, `Slack MCP` string may remain under `src/`, `roles/` or `settings/` after Task 5, except the `setup` and `checks` defaults in `src/repo-config.ts` (spec §13 item 5).
- Label names, Status names, the branch template `feat/<issue>-<slug>`, issue-body sections and the ledger grammar do not change (spec §5.2).
- The five roles stay hardcoded: `builder`, `reviewer`, `validator`, `phase-closer`, `planner`.
- `gh` is the only GitHub client; the daemon never calls the REST or GraphQL API through anything else.
- Every task ends with `pnpm lint && pnpm typecheck && pnpm test` green and a commit on `main` of the new repository (the repository has no CI-gated merge until Task 1 lands `ci.yml`; commit directly on `main` throughout, as the spec's decision 11 says the refactor happens in the new repo before anything depends on it).
- Work in the new repository's clone at `~/Projects/foreman`. Every command below runs there unless it says otherwise.

---

## File structure (end state)

```
foreman/
  package.json                  name, bin, files, scripts
  tsconfig.json                 typecheck (noEmit) over src and test
  tsconfig.build.json           emit src/ (not tests) to dist/
  biome.json, vitest.config.ts, .gitignore, .nvmrc
  .github/workflows/ci.yml      lint, typecheck, test
  .github/workflows/release.yml tag v* → npm publish
  README.md
  docs/                         copies of the spec and this plan
  roles/ground-rules.md         shared preamble, generic
  roles/{builder,reviewer,validator,phase-closer,planner}.md
  settings/headless.json        base Claude Code headless allow/deny
  src/
    cli/main.ts                 entry: parse argv, resolve instance, dispatch subcommand
    cli/daemon.ts               runDaemon(): today's src/main.ts as a function
    cli/ctl.ts                  status/next/stop/abort/go/model/cap: today's scripts/ctl.ts
    cli/launchd.ts              renderPlist, install, uninstall, status
    cli/instances.ts            add, list
    cli/hooks.ts                `hooks run <name>`
    cli/args.ts                 subcommand table and parseArgs
    bootstrap/labels.ts         LABELS, ensureLabels
    bootstrap/board.ts          ensureProject, setStatusOptions, verifyStatusOptions
    bootstrap/scaffold.ts       scaffoldRepoDir
    bootstrap/init.ts           init orchestration
    bootstrap/epic.ts           epic new
    instance.ts                 FOREMAN_HOME, instanceDir, listInstances, resolveInstance
    repo-config.ts              RepoConfigSchema, defaultRepoConfig, loadRepoConfig
    hooks.ts                    runHook, parsePreflight, parseSessionEnv
    prompts.ts                  composeRolePrompt, composeSettings, writeSessionFiles
    config.ts                   machine config (ForemanConfig), no STATE_DIR
    dispatch.ts                 no ports/role-config; hooks env + prompt lines; setup command
    preflight.ts                generic checks + preflight hook
    loop.ts                     hook calls around the session; no adopt
    pick.ts, claim.ts, merge.ts limits from RepoConfig
    ... every other src file as today
  test/fixtures/                sanitised (owner acme, repo widgets)
  test/fixtures/repo/.foreman/  a fixture repository config for prompts/settings/hooks tests
```

Files deleted from today's `tools/foreman`: `bin/foreman`, `launchd/*`, `scripts/*`, `foreman.example.json`, `src/ports.ts`, `src/adopt.ts`, `src/main.ts` (becomes `cli/daemon.ts`), `src/main-run-redundant.test.ts`, `src/role-config.test.ts`, `src/launchd.test.ts`, `src/ports.test.ts`, `src/adopt.test.ts`.

---

### Task 1: New repository from a subtree split, standalone build, CI

**Files:**
- Create (new repo): `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `.nvmrc`, `.github/workflows/ci.yml`, `docs/2026-09-18-foreman-extraction-design.md`, `docs/2026-09-18-foreman-extraction.md`
- Delete (new repo): `src/main-run-redundant.test.ts`, `src/role-config.test.ts`, `src/settings.test.ts`, `src/roles.test.ts`, `foreman.example.json`
- Modify (new repo): `vitest.config.ts`, `biome.json` (copied from tone_tonic root)

**Interfaces:**
- Produces: a clone at `~/Projects/foreman` on `main` where `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass, `dist/main.js` exists, and CI runs the same on push.

- [ ] **Step 1: Split the history and create the repository**

Run from `~/Projects/tone_tonic`:

```bash
git -C ~/Projects/tone_tonic subtree split -P tools/foreman -b foreman-split
gh repo create apptreesoftware/foreman --private --description "Runs a GitHub issue pipeline unattended with claude -p sessions, one daemon per repository"
git clone git@github.com:apptreesoftware/foreman.git ~/Projects/foreman
cd ~/Projects/foreman
git pull ~/Projects/tone_tonic foreman-split
git branch -M main
git push -u origin main
git -C ~/Projects/tone_tonic branch -D foreman-split
```

Expected: `git -C ~/Projects/foreman log --oneline | wc -l` prints 41 or more, and `ls ~/Projects/foreman` shows `src bin launchd scripts test package.json README.md`.

- [ ] **Step 2: Copy the spec and this plan into `docs/`**

```bash
mkdir -p ~/Projects/foreman/docs
cp ~/Projects/tone_tonic/docs/superpowers/specs/2026-09-18-foreman-extraction-design.md ~/Projects/foreman/docs/
cp ~/Projects/tone_tonic/docs/superpowers/plans/2026-09-18-foreman-extraction.md ~/Projects/foreman/docs/
```

- [ ] **Step 3: Delete the tests that reach outside the package and the example config**

```bash
git rm src/main-run-redundant.test.ts src/role-config.test.ts src/settings.test.ts src/roles.test.ts foreman.example.json
```

`roles.test.ts` and `settings.test.ts` come back in Task 5 against the shipped base files. `main-run-redundant.test.ts` belongs in tone_tonic and is re-homed by the migration plan.

- [ ] **Step 4: Write `package.json`**

```json
{
  "name": "@apptreesoftware/foreman",
  "version": "0.1.0",
  "description": "Runs a GitHub issue pipeline unattended with claude -p sessions, one daemon per repository",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/apptreesoftware/foreman.git" },
  "type": "module",
  "bin": { "foreman": "dist/main.js" },
  "files": ["dist", "roles", "settings", "README.md"],
  "engines": { "node": ">=22.18 <23" },
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.build.json && cp src/web.html dist/web.html",
    "dev": "tsx src/main.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome format --write .",
    "prepublishOnly": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": {
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.11",
    "@types/node": "^22.20.1",
    "tsx": "^4.23.13",
    "typescript": "^5.9.3",
    "vitest": "^4.1.11"
  }
}
```

TypeScript 5.9, not 7: the build needs `rewriteRelativeImportExtensions` (5.7+), and the source imports `./x.ts` throughout. `bin` points at `dist/main.js` until Task 6 moves the entry to `dist/cli/main.js`.

- [ ] **Step 5: Write `tsconfig.json`, `tsconfig.build.json`, `.nvmrc`, `.gitignore`, and copy `biome.json`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "declaration": false },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`.nvmrc`: `22`

`.gitignore`:

```
node_modules/
dist/
*.log
.DS_Store
```

`biome.json`: copy `~/Projects/tone_tonic/biome.json` and drop the two tone_tonic `!**/database.types.ts` and `!**/routeTree.gen.ts` entries and the `css` block.

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] } });
```

(unchanged; `scripts/` goes away in Task 6.)

- [ ] **Step 6: Install, lint, typecheck, test, build**

```bash
cd ~/Projects/foreman && pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
node -e "import('./dist/config.js').then(m => console.log(typeof m.parseConfig))"
```

Expected: every command exits 0, the last prints `function`. If `pnpm lint` complains about `test/helpers.ts` or `scripts/*.ts`, run `pnpm format` once and re-run. If `tsc` reports `.ts` extension errors in `dist`, confirm `rewriteRelativeImportExtensions` is in `tsconfig.json` and TypeScript resolves to 5.9 (`pnpm exec tsc --version`).

- [ ] **Step 7: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 8: Commit and push; confirm CI**

```bash
git add -A
git commit -m "chore: standalone package, build and CI for the extracted foreman

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
gh run watch --exit-status
```

Expected: `gh run watch` ends with the `check` job succeeded.

---

### Task 2: Instance layout and resolution

**Files:**
- Create: `src/instance.ts`, `src/instance.test.ts`
- Modify: `src/config.ts`, `src/config.test.ts`, `src/main.ts`, `scripts/ctl.ts`, `scripts/ctl-args.ts`, `scripts/serve.ts`, `src/status.ts:235`

**Interfaces:**
- Produces:
  - `FOREMAN_HOME: string` (`~/.foreman`)
  - `interface Instance { name: string; dir: string; configPath: string }`
  - `instanceDir(name: string, home?: string): string`
  - `listInstances(home?: string): Instance[]`
  - `resolveInstance(opts: { flag?: string; env: NodeJS.ProcessEnv; cwd: string; home?: string; repoDirOf?: (i: Instance) => string | null }): Instance` (throws `InstanceError`)
  - `writeInstanceConfig(i: Instance, cfg: Record<string, unknown>): void`
  - `ConfigSchema` without `slackUser`; `loadConfig(path: string)` takes a required path.
- Consumed by: every later task; `stateDir` is always `instance.dir`.

- [ ] **Step 1: Write the failing tests `src/instance.test.ts`**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstanceError, instanceDir, listInstances, resolveInstance } from "./instance.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "foreman-home-"));
}
function add(h: string, name: string, repoDir = `/repos/${name}`): void {
  mkdirSync(join(h, name), { recursive: true });
  writeFileSync(
    join(h, name, "foreman.json"),
    JSON.stringify({ repo: `acme/${name}`, project: 1, host: "mac-a", repoDir }),
  );
}

describe("instance layout", () => {
  it("instanceDir is <home>/<name>", () => {
    expect(instanceDir("widgets", "/h")).toBe("/h/widgets");
  });
  it("listInstances returns only directories holding foreman.json, sorted by name", () => {
    const h = home();
    add(h, "zeta");
    add(h, "alpha");
    mkdirSync(join(h, "not-an-instance"));
    expect(listInstances(h).map((i) => i.name)).toEqual(["alpha", "zeta"]);
    expect(listInstances(h)[0]?.configPath).toBe(join(h, "alpha", "foreman.json"));
  });
  it("listInstances on a missing home is empty", () => {
    expect(listInstances(join(home(), "nope"))).toEqual([]);
  });
});

describe("resolveInstance", () => {
  it("prefers the -p flag", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    const i = resolveInstance({ flag: "b", env: {}, cwd: "/", home: h });
    expect(i.name).toBe("b");
    expect(i.dir).toBe(join(h, "b"));
  });
  it("rejects an unknown -p name, listing the known ones", () => {
    const h = home();
    add(h, "a");
    expect(() => resolveInstance({ flag: "zzz", env: {}, cwd: "/", home: h })).toThrow(
      /no instance "zzz".*a/s,
    );
  });
  it("then FOREMAN_INSTANCE", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    expect(resolveInstance({ env: { FOREMAN_INSTANCE: "a" }, cwd: "/", home: h }).name).toBe("a");
  });
  it("then the instance whose repoDir contains cwd", () => {
    const h = home();
    add(h, "a", "/repos/a");
    add(h, "b", "/repos/b");
    expect(resolveInstance({ env: {}, cwd: "/repos/b/.worktrees/12/src", home: h }).name).toBe(
      "b",
    );
  });
  it("then the sole instance", () => {
    const h = home();
    add(h, "only");
    expect(resolveInstance({ env: {}, cwd: "/", home: h }).name).toBe("only");
  });
  it("otherwise errors naming every instance", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    expect(() => resolveInstance({ env: {}, cwd: "/", home: h })).toThrow(InstanceError);
    expect(() => resolveInstance({ env: {}, cwd: "/", home: h })).toThrow(/a, b/);
  });
  it("errors when there are none, saying how to add one", () => {
    expect(() => resolveInstance({ env: {}, cwd: "/", home: home() })).toThrow(/foreman add/);
  });
  it("FOREMAN_CONFIG names a config file outside the layout", () => {
    const h = home();
    const dir = mkdtempSync(join(tmpdir(), "elsewhere-"));
    writeFileSync(join(dir, "foreman.json"), "{}");
    const i = resolveInstance({ env: { FOREMAN_CONFIG: join(dir, "foreman.json") }, cwd: "/", home: h });
    expect(i.dir).toBe(dir);
    expect(i.configPath).toBe(join(dir, "foreman.json"));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test -- src/instance.test.ts`
Expected: FAIL, `Cannot find module './instance.ts'`.

- [ ] **Step 3: Write `src/instance.ts`**

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Every instance lives at `~/.foreman/<name>/`; the name is what `-p` and launchd use. */
export const FOREMAN_HOME = join(homedir(), ".foreman");
export const CONFIG_FILENAME = "foreman.json";

export interface Instance {
  name: string;
  /** The state dir: state.json, sessions.log, STOP, logs/, activity/, artifacts/ all live here. */
  dir: string;
  configPath: string;
}

export class InstanceError extends Error {}

export function instanceDir(name: string, home = FOREMAN_HOME): string {
  return join(home, name);
}

export function instanceFor(name: string, home = FOREMAN_HOME): Instance {
  const dir = instanceDir(name, home);
  return { name, dir, configPath: join(dir, CONFIG_FILENAME) };
}

export function listInstances(home = FOREMAN_HOME): Instance[] {
  if (!existsSync(home)) return [];
  return readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(home, d.name, CONFIG_FILENAME)))
    .map((d) => instanceFor(d.name, home))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function within(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/** `repoDir` from an instance's config, or null when the file is unreadable. */
export function repoDirOfInstance(i: Instance): string | null {
  try {
    const raw = JSON.parse(readFileSync(i.configPath, "utf8")) as { repoDir?: unknown };
    if (typeof raw.repoDir !== "string") return null;
    return raw.repoDir.startsWith("~/") ? join(homedir(), raw.repoDir.slice(2)) : raw.repoDir;
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  flag?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  repoDirOf?: (i: Instance) => string | null;
}

/**
 * Spec §4.2: `-p`, then `FOREMAN_INSTANCE`, then the instance whose repoDir contains cwd, then
 * the sole instance. `FOREMAN_CONFIG` is the escape hatch for a config outside the layout.
 */
export function resolveInstance(o: ResolveOptions): Instance {
  const home = o.home ?? FOREMAN_HOME;
  const repoDirOf = o.repoDirOf ?? repoDirOfInstance;
  if (o.env.FOREMAN_CONFIG) {
    const configPath = resolve(o.env.FOREMAN_CONFIG);
    const dir = dirname(configPath);
    return { name: basename(dir), dir, configPath };
  }
  const all = listInstances(home);
  const names = all.map((i) => i.name).join(", ");
  const byName = (name: string): Instance => {
    const hit = all.find((i) => i.name === name);
    if (!hit)
      throw new InstanceError(
        `no instance "${name}" under ${home}${all.length ? ` (have: ${names})` : ""}`,
      );
    return hit;
  };
  if (o.flag) return byName(o.flag);
  if (o.env.FOREMAN_INSTANCE) return byName(o.env.FOREMAN_INSTANCE);
  const byCwd = all.find((i) => {
    const repoDir = repoDirOf(i);
    return repoDir !== null && within(o.cwd, repoDir);
  });
  if (byCwd) return byCwd;
  if (all.length === 1) return all[0] as Instance;
  if (all.length === 0)
    throw new InstanceError(`no instances under ${home}; run: foreman add <name> --repo <owner/repo> --repo-dir <path>`);
  throw new InstanceError(`several instances (${names}); pass -p <name> or set FOREMAN_INSTANCE`);
}

export function writeInstanceConfig(i: Instance, cfg: Record<string, unknown>): void {
  mkdirSync(i.dir, { recursive: true });
  writeFileSync(i.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- src/instance.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Strip `STATE_DIR`, `DEFAULT_CONFIG_PATH`, `TONE_FOREMAN_CONFIG` and `slackUser` from `src/config.ts`**

Replace lines 1 to 8 and 63 to 67 so the file reads:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NotifyConfigSchema } from "./notify.ts";

export const ConfigSchema = z.object({
  // ... unchanged fields, minus the `slackUser` line ...
});
```

and

```ts
export function loadConfig(path: string): ForemanConfig {
  return parseConfig(readFileSync(path, "utf8"));
}
```

Delete `slackUser: z.string().min(1),` (line 21). In `src/config.test.ts`, remove `slackUser` from every fixture object and any assertion on it; a test that asserted the default path or `TONE_FOREMAN_CONFIG` is deleted.

- [ ] **Step 6: Thread the instance through `src/main.ts`, `scripts/ctl.ts`, `scripts/ctl-args.ts`, `scripts/serve.ts`**

`src/main.ts` lines 30 to 46 become:

```ts
const { values } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    instance: { type: "string", short: "p" },
  },
});

const instance = resolveInstance({ flag: values.instance, env: process.env, cwd: process.cwd() });
const STATE_DIR = instance.dir;
const cfg = loadConfig(instance.configPath);
const configPath = instance.configPath;
```

with `import { resolveInstance } from "./instance.ts";` and `DEFAULT_CONFIG_PATH`/`STATE_DIR` dropped from the `./config.ts` import. Every later `STATE_DIR` in the file now refers to this local constant.

`scripts/ctl-args.ts`: replace the `config: { type: "string" }` option with `instance: { type: "string", short: "p" }`, return `instance: values.instance` instead of `config`, and change `USAGE` to end `[-p <instance>]`.

`scripts/ctl.ts`: replace lines 3 and 27 to 36 so it reads

```ts
import { loadConfig } from "../src/config.ts";
import { resolveInstance } from "../src/instance.ts";
// ...
const instance = resolveInstance({ flag: args.instance, env: process.env, cwd: process.cwd() });
const STATE_DIR = instance.dir;
const stopFile = join(STATE_DIR, "STOP");
const cfg = loadConfig(instance.configPath);
```

and line 106's `startCommand` to `` `foreman -p ${instance.name} start` ``.

`scripts/serve.ts:9`: `const stateDir = join(homedir(), ".tone_tonic");` becomes `const stateDir = process.env.FOREMAN_STATE_DIR ?? join(homedir(), ".foreman");` (the file is deleted in Task 6; this keeps typecheck honest until then).

`src/status.ts:235`: replace `~/.tone_tonic/state.json` with `state.json` in the help text.

`src/dispatch.ts:259`: delete the `Slack owner handle` line from `buildPrompt` (the `cfg.slackUser` reference no longer typechecks). In `src/dispatch.test.ts`, remove `slackUser` from config fixtures and any assertion on the Slack line.

`test/helpers.ts` and every other test that builds a `ForemanConfig` literal: remove `slackUser`. Find them with `grep -rn slackUser src scripts test`.

- [ ] **Step 7: Lint, typecheck, test**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. `grep -rn "tone_tonic\|TONE_FOREMAN_CONFIG\|slackUser" src scripts` prints only the comment lines in `preflight.ts`, `loop.ts`, `dispatch.ts`, `ports.ts`, `serve.ts`, `dev-env.ts` (removed by Tasks 4 and 6).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: instances under ~/.foreman/<name>, resolved by -p, env, cwd or sole

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Repository config `.foreman/config.json`

**Files:**
- Create: `src/repo-config.ts`, `src/repo-config.test.ts`, `test/fixtures/repo/.foreman/config.json`
- Modify: `src/pick.ts`, `src/pick.test.ts`, `src/claim.ts`, `src/claim.test.ts`, `src/merge.ts`, `src/state.ts`, `src/state.test.ts`, `src/next.ts`, `src/board.ts`, `src/loop.ts`, `src/plans.ts`, `src/plans.test.ts`, `src/phase.ts`, `src/phase.test.ts`, `src/dispatch.ts`, `src/dispatch.test.ts`, `src/state-file.ts`, `src/status.ts`, `src/web.ts`, `src/main.ts`, `scripts/ctl.ts`

**Interfaces:**
- Produces:
  - `RepoConfigSchema`, `type RepoConfig`, `defaultRepoConfig(): RepoConfig`, `loadRepoConfig(dir: string): RepoConfig` (reads `<dir>/.foreman/config.json`; absent file = defaults; malformed file throws).
  - `RepoConfig` shape: `{ setup: string | null; checks: string[]; plans: { dir: string; specGlob: string }; validator: { skipLabels: string[] }; limits: { fixRounds; ciReruns; blockedPerPhase; staleHours; attempts }; models: string[] }`.
  - `pick(s, repo?)`, `jobCandidates(s, repo?)`, `buildCandidates(s, repo?)`, `heldPhases(s, repo?)`, `validatorRequired(labels, skipLabels)`, `ciRerunsSpent(pr, i, ciReruns)`; `plan(s, repo?)`; `reclaimActions(s, staleHours?)`, `isStale(i, at, now, staleHours?)`; `skipValidatorActions(s, repo?)`; `describeNext(s, repo?)`, `describeBoard(s, i, logs?, repo?)`; `listPlanFilesOnMain(exec, repoDir, planDir, defaultBranch)`, `readPlanFileOnMain(exec, repoDir, path, defaultBranch)`; `planIssuesPath(specPath, today, planDir)`; `dispatchWithRetry(req, cfg, deps, attempts?)`; `Ctx.repo: RepoConfig`, `Ctx.defaultBranch: string`.
  - `StatusInput.modelChoices: string[]`; `StatusReport.model.choices` comes from it.
- Every `?` parameter defaults to `defaultRepoConfig()` (or the matching field of it), so existing tests keep passing unchanged.

- [ ] **Step 1: Write the failing tests `src/repo-config.test.ts`**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRepoConfig, loadRepoConfig } from "./repo-config.ts";

function repo(json?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  if (json !== undefined) {
    mkdirSync(join(dir, ".foreman"));
    writeFileSync(join(dir, ".foreman", "config.json"), json);
  }
  return dir;
}

describe("repo config", () => {
  it("defaults reproduce today's constants, with an empty validator skip list", () => {
    const d = defaultRepoConfig();
    expect(d.setup).toBe("pnpm install");
    expect(d.checks).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
    expect(d.plans).toEqual({ dir: "docs/superpowers/plans", specGlob: "docs/**/*.md" });
    expect(d.validator.skipLabels).toEqual([]);
    expect(d.limits).toEqual({ fixRounds: 2, ciReruns: 1, blockedPerPhase: 2, staleHours: 2, attempts: 3 });
    expect(d.models).toEqual(["opus", "sonnet", "haiku", "fable"]);
  });
  it("a missing file is the defaults", () => {
    expect(loadRepoConfig(repo())).toEqual(defaultRepoConfig());
  });
  it("a partial file overrides only what it names", () => {
    const c = loadRepoConfig(repo('{"setup": null, "limits": {"fixRounds": 3}, "validator": {"skipLabels": ["area:db"]}}'));
    expect(c.setup).toBeNull();
    expect(c.limits.fixRounds).toBe(3);
    expect(c.limits.ciReruns).toBe(1);
    expect(c.validator.skipLabels).toEqual(["area:db"]);
    expect(c.checks).toEqual(defaultRepoConfig().checks);
  });
  it("rejects a malformed file loudly", () => {
    expect(() => loadRepoConfig(repo('{"limits": {"fixRounds": "two"}}'))).toThrow(/fixRounds/);
    expect(() => loadRepoConfig(repo("not json"))).toThrow();
  });
  it("rejects an unknown key so a typo is not silently ignored", () => {
    expect(() => loadRepoConfig(repo('{"check": []}'))).toThrow(/check/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test -- src/repo-config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/repo-config.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Where a repository keeps what the foreman needs to know about it (spec §5). */
export const REPO_DIRNAME = ".foreman";

const LimitsSchema = z
  .object({
    fixRounds: z.number().int().min(1).default(2),
    ciReruns: z.number().int().min(0).default(1),
    blockedPerPhase: z.number().int().min(1).default(2),
    staleHours: z.number().int().min(1).default(2),
    attempts: z.number().int().min(1).default(3),
  })
  .strict();

export const RepoConfigSchema = z
  .object({
    /** Run once when a worktree is created; null skips it. */
    setup: z.string().nullable().default("pnpm install"),
    /** What a rebase round runs, and what the base builder prompt calls "the checks". */
    checks: z.array(z.string()).default(["pnpm lint", "pnpm typecheck", "pnpm test"]),
    plans: z
      .object({
        dir: z.string().default("docs/superpowers/plans"),
        specGlob: z.string().default("docs/**/*.md"),
      })
      .strict()
      .default({}),
    validator: z
      .object({ skipLabels: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    limits: LimitsSchema.default({}),
    /** The page's model buttons and the accepted `model:<name>` labels. */
    models: z.array(z.string().min(1)).min(1).default(["opus", "sonnet", "haiku", "fable"]),
  })
  .strict();
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export function defaultRepoConfig(): RepoConfig {
  return RepoConfigSchema.parse({});
}

export function repoConfigPath(dir: string): string {
  return join(dir, REPO_DIRNAME, "config.json");
}

/** `<dir>/.foreman/config.json`, or the defaults when there is none. A bad file throws. */
export function loadRepoConfig(dir: string): RepoConfig {
  const p = repoConfigPath(dir);
  if (!existsSync(p)) return defaultRepoConfig();
  return RepoConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}
```

Zod 4's `.default({})` on an object schema fills the nested defaults; if `pnpm typecheck` rejects `.default({})`, use `.prefault({})` instead (Zod 4 has both; `prefault` is the one that runs the inner parse).

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- src/repo-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the fixture repo config**

`test/fixtures/repo/.foreman/config.json`:

```json
{
  "setup": "echo setup",
  "checks": ["echo lint", "echo test"],
  "plans": { "dir": "docs/plans", "specGlob": "docs/**/*.md" },
  "validator": { "skipLabels": ["area:infra"] },
  "limits": { "fixRounds": 2, "ciReruns": 1, "blockedPerPhase": 2, "staleHours": 2, "attempts": 3 },
  "models": ["opus", "sonnet"]
}
```

- [ ] **Step 6: Thread limits through the picker and planner**

`src/pick.ts`: delete the four constants (lines 17 to 29) and make every reader take them:

```ts
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";

export function validatorRequired(labels: string[], skipLabels: string[]): boolean {
  const areas = labels.filter((l) => l.startsWith("area:"));
  return areas.length === 0 || areas.some((a) => !skipLabels.includes(a));
}
export function ciRerunsSpent(pr: PullRequest, i: Issue, ciReruns: number): boolean {
  return ciRerunCount(i.comments, pr.headSha) >= ciReruns;
}
export function heldPhases(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): number[] { /* n >= repo.limits.blockedPerPhase */ }
export function buildCandidates(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Candidate[] { /* heldPhases(s, repo) */ }
export function jobCandidates(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Candidate[] {
  // ciRerunsSpent(pr, i, repo.limits.ciReruns); round <= repo.limits.fixRounds;
  // validatorRequired(i.labels, repo.validator.skipLabels)
}
export function pick(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Candidate | null {
  return prioritize([...jobCandidates(s, repo), ...buildCandidates(s, repo)])[0] ?? null;
}
```

Note `validatorRequired` with an empty skip list is always true, which is the spec's default: a repository that never sets `skipLabels` validates every PR. In `src/pick.test.ts` and `src/merge.test.ts`, tests that relied on `area:infra` skipping validation now pass `{ ...defaultRepoConfig(), validator: { skipLabels: ["area:infra", "area:db", "area:shared"] } }` as the second argument; tests that called `validatorRequired(labels)` pass that list explicitly.

`src/merge.ts`: `skipValidatorActions(s, repo = defaultRepoConfig())` uses `validatorRequired(i.labels, repo.validator.skipLabels)`. `src/state.ts`: `plan(s, repo = defaultRepoConfig())` passes `repo` to `skipValidatorActions`, `reclaimActions(s, repo.limits.staleHours)` and `pick(s, repo)`. `src/claim.ts`: replace `STALE_HOURS` with a `staleHours = 2` parameter on `isStale` and `reclaimActions`. `src/next.ts`: `describeNext(s, repo = defaultRepoConfig())` passes `repo` to whatever it calls from `pick.ts`/`merge.ts`/`state.ts` (`grep -n "pick\|jobCandidates\|buildCandidates\|validatorRequired\|MAX_" src/next.ts src/waiting.ts src/pipeline.ts` lists each call; every one gets the `repo` argument). `src/board.ts`: `describeBoard(s, i, logs, repo = defaultRepoConfig())` passes it to `describeNext` and `describeWaiting`.

`src/plans.ts`: `listPlanFilesOnMain(exec, repoDir, planDir, defaultBranch)` uses `` `${defaultBranch}` `` where `origin/main` is and `planDir` where `PLAN_DIR` is; `readPlanFileOnMain(exec, repoDir, path, defaultBranch)` likewise. Delete `PLAN_DIR`. `src/phase.ts`: `planIssuesPath(specPath, today, planDir)`; `parseSpecPath` regex becomes `/## Spec\s*\n[\s\S]*?([\w./-]+\.md)/` (no `docs/` prefix requirement). Update `src/plans.test.ts` and `src/phase.test.ts` to pass the new arguments with today's values.

`src/dispatch.ts`: `dispatchWithRetry(req, cfg, deps, attempts = MAX_ATTEMPTS)` loops to `req.attempt + attempts`; `ensureWorktree(cfg, issue, branch, exec, exists, setup: string | null = "pnpm install")` replaces lines 359 to 361 with

```ts
  if (setup !== null) {
    const install = await exec("sh", ["-c", setup], { cwd: dir });
    if (install.code !== 0)
      throw new Error(`setup command failed in ${dir}: ${install.stderr.slice(-2000)}`);
  }
```

and `REBASE_NOTES` becomes a function `rebaseNotes(checks: string[])` that names `checks.map((c) => \`\\\`${c}\\\`\`).join(", ")` in place of the three pnpm commands; `buildPrompt(req, cfg, checks: string[])` calls it. `origin/main` in `ensureWorktree` (line 349) becomes `` `origin/${defaultBranch}` `` with `defaultBranch` on `ForemanConfig`? No: it is not machine config. Add a `defaultBranch: string` parameter to `ensureWorktree` after `setup`, defaulting to `"main"`.

`src/loop.ts`: `Ctx` gains `repo: RepoConfig` and `defaultBranch: string`. `realCtx(cfg, gh, login, dryRun, stateDir, control, repo, defaultBranch)` fills `planFiles`/`readPlanFile` with `repo.plans.dir` and `` `origin/${defaultBranch}` ``, and `ensureWorktree: (cfg, issue, branch, exec) => realEnsureWorktree(cfg, issue, branch, exec, undefined, repo.setup, defaultBranch)`. `runOnce` calls `plan(snapshot, ctx.repo)` and `describeBoard(snapshot, {...}, {...}, ctx.repo)`; `runRole` passes `ctx.repo.limits.attempts` to `dispatchWithRetry` and `ctx.repo.checks` to the prompt (via `buildPrompt`'s third argument, which `runSession` receives through a new `checks` field on `DispatchDeps`); `applyPlan` uses `planIssuesPath(specPath, "x", ctx.repo.plans.dir)`. Line 559's comment and the `fetchOrigin` call are unchanged.

`src/main.ts` and `scripts/ctl.ts`: after loading `cfg`, `const repo = loadRepoConfig(cfg.repoDir);` and `const defaultBranch = await gh.defaultBranch();` where `GitHub.defaultBranch()` is a new method:

```ts
  async defaultBranch(): Promise<string> {
    const out = await this.gh(["repo", "view", this.cfg.repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
    return out.trim() || "main";
  }
```

Add `"defaultBranch"` to the `GitHubApi` pick list. Pass both into `realCtx`.

- [ ] **Step 7: Models from config**

`src/state-file.ts`: keep `MODEL_CHOICES` as the default list but make `TaskModelChoiceSchema = z.union([ModelSchema, z.literal(MODEL_DEFAULT)])` (any well-formed name; the allowlist check moves to the handler). `src/web.ts` `setTaskModel` handler: after schema parse, reject with 400 `"model not offered"` unless `model === MODEL_DEFAULT || deps.modelChoices().includes(model)`; `WebDeps` gains `modelChoices: () => string[]`. `src/status.ts`: `StatusInput.modelChoices: readonly string[]`, `model.choices: i.modelChoices`. `src/main.ts` and `scripts/ctl.ts` pass `repo.models`. `src/web.test.ts` and `src/status.test.ts`: add `modelChoices: ["opus", "sonnet", "haiku", "fable"]` to their inputs.

- [ ] **Step 8: Lint, typecheck, test**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: green. `grep -rn "MAX_FIX_ROUNDS\|MAX_CI_RERUNS\|MAX_BLOCKED_PER_PHASE\|VALIDATOR_EXEMPT_AREAS\|STALE_HOURS\|PLAN_DIR\|origin/main" src` prints nothing outside comments and `loop.ts:559`'s comment.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: .foreman/config.json carries setup, checks, plan dir, validator skip labels, limits and models

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Hooks replace the Supabase, Docker, port and role-config logic

**Files:**
- Create: `src/hooks.ts`, `src/hooks.test.ts`, `test/fixtures/repo/.foreman/hooks/{preflight,session-env,before-session,after-session}`
- Delete: `src/ports.ts`, `src/ports.test.ts`
- Modify: `src/preflight.ts`, `src/preflight.test.ts`, `src/dispatch.ts`, `src/dispatch.test.ts`, `src/loop.ts`, `src/loop.test.ts`, `scripts/serve.ts`, `scripts/dev-env.ts`

**Interfaces:**
- Produces:
  - `type HookName = "preflight" | "session-env" | "before-session" | "after-session"`
  - `interface HookContext { instance: string; stateDir: string; repoDir: string; role?: Role; issue?: number; pr?: number | null; worktree?: string; round?: number }`
  - `interface HookResult { ran: boolean; code: number; stdout: string; stderr: string; timedOut: boolean }`
  - `hookPath(repoDir: string, name: HookName): string` → `<repoDir>/.foreman/hooks/<name>`
  - `runHook(name, cwd, ctx, exec, opts?: { timeoutMs?: number; log?: (line: string) => void }): Promise<HookResult>` (`ran: false, code: 0` when the file is missing or not executable)
  - `parsePreflight(r: HookResult): { ok: true; warnings: string[] } | { ok: false; reason: string }`
  - `parseSessionEnv(r: HookResult): { env: Record<string, string>; promptLines: string[] }`
  - `HOOK_TIMEOUT_MS = 600_000`
  - `DispatchRequest` loses `isolated`, gains `env: Record<string, string>` and `promptLines: string[]`.
  - `PreflightDeps` gains `repoDir: string; instance: string`.

- [ ] **Step 1: Write the fixture hooks**

`test/fixtures/repo/.foreman/hooks/preflight` (mode 755):

```sh
#!/bin/sh
echo "warn: fixture warning"
[ -n "$FOREMAN_STATE_DIR" ] || { echo "no state dir" >&2; exit 1; }
[ "$FAIL_PREFLIGHT" = "1" ] && { echo "first line" >&2; echo "fixture says no" >&2; exit 3; }
exit 0
```

`session-env` (755):

```sh
#!/bin/sh
echo "APP_PORT=8182"
echo "prompt: Local URLs: web http://localhost:8182"
echo "ROLE=$FOREMAN_ROLE"
echo "prompt: second line"
echo "ignored line without equals"
```

`before-session` (755):

```sh
#!/bin/sh
echo "$FOREMAN_ROLE $FOREMAN_ISSUE $FOREMAN_WORKTREE" > "$FOREMAN_WORKTREE/.before-ran"
```

`after-session` (755):

```sh
#!/bin/sh
echo after > "$FOREMAN_WORKTREE/.after-ran"
```

Run `chmod +x test/fixtures/repo/.foreman/hooks/*` and `git add` them so the mode is committed.

- [ ] **Step 2: Write the failing tests `src/hooks.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realExec } from "./exec.ts";
import { hookPath, parsePreflight, parseSessionEnv, runHook } from "./hooks.ts";

const repoDir = join(import.meta.dirname, "../test/fixtures/repo");
const base = { instance: "widgets", stateDir: "/tmp/state", repoDir };

describe("runHook", () => {
  it("resolves <repoDir>/.foreman/hooks/<name>", () => {
    expect(hookPath("/r", "preflight")).toBe("/r/.foreman/hooks/preflight");
  });
  it("a missing hook is ran:false, code 0", async () => {
    const r = await runHook("preflight", "/", { ...base, repoDir: mkdtempSync(join(tmpdir(), "nohooks-")) }, realExec);
    expect(r).toMatchObject({ ran: false, code: 0 });
  });
  it("passes FOREMAN_* in the environment and captures both streams", async () => {
    const r = await runHook("preflight", repoDir, base, realExec);
    expect(r.ran).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("warn: fixture warning");
  });
  it("session hooks see role, issue and worktree", async () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    const r = await runHook("before-session", wt, { ...base, role: "builder", issue: 12, worktree: wt, pr: null, round: 1 }, realExec);
    expect(r.code).toBe(0);
    expect(readFileSync(join(wt, ".before-ran"), "utf8").trim()).toBe(`builder 12 ${wt}`);
  });
  it("times out and reports it", async () => {
    const r = await runHook("preflight", repoDir, base, async () => new Promise(() => {}), { timeoutMs: 50 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
  });
  it("logs one line per run when a logger is given", async () => {
    const lines: string[] = [];
    await runHook("after-session", mkdtempSync(join(tmpdir(), "wt-")), { ...base, worktree: "/x" }, realExec, { log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes("after-session") && l.includes("code=0"))).toBe(true);
  });
});

describe("parsePreflight", () => {
  it("exit 0 is ok, with warn: lines as warnings", () => {
    expect(parsePreflight({ ran: true, code: 0, stdout: "warn: a\nnoise\nwarn: b\n", stderr: "", timedOut: false })).toEqual({ ok: true, warnings: ["a", "b"] });
  });
  it("non-zero parks with the last non-empty stderr line", () => {
    expect(parsePreflight({ ran: true, code: 3, stdout: "", stderr: "first line\nfixture says no\n\n", timedOut: false })).toEqual({ ok: false, reason: "fixture says no" });
  });
  it("non-zero with empty stderr still parks, naming the code", () => {
    expect(parsePreflight({ ran: true, code: 2, stdout: "", stderr: "", timedOut: false })).toEqual({ ok: false, reason: "preflight hook exited 2" });
  });
  it("a missing hook is ok with no warnings", () => {
    expect(parsePreflight({ ran: false, code: 0, stdout: "", stderr: "", timedOut: false })).toEqual({ ok: true, warnings: [] });
  });
  it("a timeout parks", () => {
    expect(parsePreflight({ ran: true, code: 124, stdout: "", stderr: "", timedOut: true }).ok).toBe(false);
  });
});

describe("parseSessionEnv", () => {
  it("splits KEY=VALUE lines from prompt: lines and drops the rest", async () => {
    const r = await runHook("session-env", repoDir, { ...base, role: "validator", issue: 1, worktree: "/w", pr: 2, round: 1 }, realExec);
    expect(parseSessionEnv(r)).toEqual({
      env: { APP_PORT: "8182", ROLE: "validator" },
      promptLines: ["Local URLs: web http://localhost:8182", "second line"],
    });
  });
  it("values may contain '='", () => {
    expect(parseSessionEnv({ ran: true, code: 0, stdout: "URL=http://x?a=b\n", stderr: "", timedOut: false }).env).toEqual({ URL: "http://x?a=b" });
  });
  it("a missing hook yields nothing", () => {
    expect(parseSessionEnv({ ran: false, code: 0, stdout: "", stderr: "", timedOut: false })).toEqual({ env: {}, promptLines: [] });
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm test -- src/hooks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/hooks.ts`**

```ts
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import { REPO_DIRNAME } from "./repo-config.ts";
import type { Role } from "./types.ts";

export type HookName = "preflight" | "session-env" | "before-session" | "after-session";
export const HOOK_NAMES: readonly HookName[] = ["preflight", "session-env", "before-session", "after-session"];
export const HOOK_TIMEOUT_MS = 600_000;

export interface HookContext {
  instance: string;
  stateDir: string;
  repoDir: string;
  role?: Role;
  issue?: number;
  pr?: number | null;
  worktree?: string;
  round?: number;
}

export interface HookResult {
  /** False when the repository has no such hook (or it is not executable): a no-op, code 0. */
  ran: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function hookPath(repoDir: string, name: HookName): string {
  return join(repoDir, REPO_DIRNAME, "hooks", name);
}

function executable(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function hookEnv(ctx: HookContext, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    FOREMAN_INSTANCE: ctx.instance,
    FOREMAN_STATE_DIR: ctx.stateDir,
    FOREMAN_REPO_DIR: ctx.repoDir,
  };
  if (ctx.role !== undefined) env.FOREMAN_ROLE = ctx.role;
  if (ctx.issue !== undefined) env.FOREMAN_ISSUE = String(ctx.issue);
  if (ctx.pr !== undefined) env.FOREMAN_PR = ctx.pr === null ? "" : String(ctx.pr);
  if (ctx.worktree !== undefined) env.FOREMAN_WORKTREE = ctx.worktree;
  if (ctx.round !== undefined) env.FOREMAN_ROUND = String(ctx.round);
  return env;
}

export async function runHook(
  name: HookName,
  cwd: string,
  ctx: HookContext,
  exec: Exec,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<HookResult> {
  const path = hookPath(ctx.repoDir, name);
  if (!executable(path)) return { ran: false, code: 0, stdout: "", stderr: "", timedOut: false };
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  let timedOut = false;
  const timer = new Promise<HookResult>((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve({ ran: true, code: 124, stdout: "", stderr: `${name} hook timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs).unref(),
  );
  const run = exec(path, [], { cwd, env: hookEnv(ctx), timeoutMs }).then(
    (r): HookResult => ({ ran: true, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut }),
  );
  const result = await Promise.race([run, timer]);
  opts.log?.(
    `${new Date().toISOString()} ${name} cwd=${cwd} code=${result.code}${result.timedOut ? " timed-out" : ""}\n${result.stdout}${result.stderr}`.trimEnd(),
  );
  return result;
}

export function parsePreflight(r: HookResult): { ok: true; warnings: string[] } | { ok: false; reason: string } {
  if (!r.ran) return { ok: true, warnings: [] };
  if (r.code === 0)
    return {
      ok: true,
      warnings: r.stdout
        .split("\n")
        .filter((l) => l.startsWith("warn:"))
        .map((l) => l.slice(5).trim()),
    };
  const last = r.stderr.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).at(-1);
  return { ok: false, reason: last ?? `preflight hook exited ${r.code}` };
}

export function parseSessionEnv(r: HookResult): { env: Record<string, string>; promptLines: string[] } {
  const env: Record<string, string> = {};
  const promptLines: string[] = [];
  if (!r.ran) return { env, promptLines };
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("prompt:")) promptLines.push(line.slice(7).trim());
    else {
      const eq = line.indexOf("=");
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq)))
        env[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return { env, promptLines };
}
```

`realExec` already honours `timeoutMs` through `execFile`; the `Promise.race` timer is what makes the test's never-resolving exec double finish.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- src/hooks.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Generic preflight**

`src/preflight.ts`: delete `roleStackDir`, `RoleStackDeps`, `ensureRoleStack`, `chromiumInstalled`, the `import { ROLE_SUPABASE_PROJECT } from "./ports.ts"` line, the `docker info` block (lines 195 to 196) and lines 211 to 214. `PreflightDeps` gains `repoDir: string; instance: string; hookLog?: (line: string) => void`. The end of `preflight()` becomes:

```ts
  const hook = await runHook(
    "preflight",
    deps.repoDir,
    { instance: deps.instance, stateDir: deps.stateDir, repoDir: deps.repoDir },
    deps.exec,
    { log: deps.hookLog },
  );
  const verdict = parsePreflight(hook);
  if (!verdict.ok) return verdict;
  return { ok: true, warnings: verdict.warnings };
```

The `gh auth status` check additionally requires the `project` scope (spec §6):

```ts
  const gh = await deps.exec("gh", ["auth", "status"]);
  if (gh.code !== 0) return { ok: false, reason: "gh is not authenticated" };
  const scopes = /Token scopes: (.*)/.exec(`${gh.stdout}${gh.stderr}`)?.[1] ?? "";
  if (!/'project'/.test(scopes))
    return { ok: false, reason: "gh token lacks the project scope; run: gh auth refresh -s project,read:project" };
```

`src/preflight.test.ts`: delete the `ensureRoleStack`, docker and chromium tests; the exec double's `gh auth status` reply must now include `Token scopes: 'project', 'repo'` in stdout; add three tests: a repoDir with no hooks passes with `[]` warnings; the fixture repo (`test/fixtures/repo`) passes with `["fixture warning"]`; the fixture repo with `FAIL_PREFLIGHT=1` in the env passed to `hookEnv`'s base parks with reason `fixture says no` (set `process.env.FAIL_PREFLIGHT` inside the test and delete it in `finally`).

- [ ] **Step 7: Dispatch without ports or role-config**

`src/dispatch.ts`: delete the `./ports.ts` import, `ROLE_CONFIG_SCRIPT`, `SUPABASE_CONFIG`, `needsIsolatedStack`, `roleConfigScript`, `applyRoleConfig`, `restoreRoleConfig`. `DispatchRequest`: replace `isolated: boolean` with `env: Record<string, string>; promptLines: string[]`. `buildPrompt(req, cfg, checks)`: delete the `Local URLs` and `Slack owner handle` lines and the `if (req.isolated)` block; after the `Spec:` line add `...req.promptLines`. `runSession`: `env: childEnv(process.env, req.env)`. Delete `src/ports.ts` and `src/ports.test.ts`. In `src/dispatch.test.ts`, replace every `isolated: true/false` with `env: {}, promptLines: []`, delete the `applyRoleConfig`/`restoreRoleConfig`/`roleConfigScript`/`needsIsolatedStack` describes, and add one test: `buildPrompt` with `promptLines: ["Local URLs: web http://localhost:8182", "second"]` includes both lines, in order, after the `Spec:` line.

- [ ] **Step 8: Hooks around the session in `src/loop.ts`**

`Ctx` gains `instance: string` and `hookLog: (line: string) => void` (`realCtx` appends to `join(stateDir, "logs", "hooks.log")` with `mkdirSync(..., { recursive: true })` first). In `runRole`, replace lines 255 to 262 and the `finally` at 358 to 364 with:

```ts
  const hookCtx = { instance: ctx.instance, stateDir: ctx.stateDir, repoDir: cfg.repoDir, role: r.role, issue: r.issue.number, pr: r.pr, worktree, round: r.round };
  const hook = (name: HookName) => runHook(name, worktree, hookCtx, ctx.exec, { log: ctx.hookLog });
  // Spec §6: after-session also runs before the next session on the same worktree, so whatever a
  // crashed session left behind is undone before this one starts.
  await hook("after-session");
  const sessionEnv = parseSessionEnv(await hook("session-env"));
  const before = await hook("before-session");
  if (before.ran && before.code !== 0) {
    await hook("after-session");
    throw new Error(`before-session hook failed (${before.code}): ${before.stderr.trim().slice(-500)}`);
  }
  const req: DispatchRequest = { /* as before, minus isolated, plus */ env: sessionEnv.env, promptLines: sessionEnv.promptLines };
  // ...
  try {
    result = await dispatchWithRetry(/* unchanged */);
  } finally {
    await hook("after-session");
  }
```

A thrown `before-session` propagates out of `execute` like any other dispatch failure, so the loop's failure backoff owns it; that matches spec §6 "counts as a failed attempt" closely enough, and the claim stays open so the next tick resumes. Preflight in `runOnce` passes `repoDir: ctx.cfg.repoDir, instance: ctx.instance, hookLog: ctx.hookLog`.

`src/loop.test.ts`: the `Ctx` builder gains `instance: "widgets"` and `hookLog: () => {}`; delete assertions on `role-config.sh`, `skip-worktree` or `TONE_WEB_PORT`; add one test with `cfg.repoDir` pointing at `test/fixtures/repo` and a real `exec` for hooks (a `spawn` double for `claude`): after `runRole`, `<worktree>/.before-ran` and `.after-ran` both exist, and the spawn double saw `APP_PORT=8182` in `env` and `Local URLs` in `input`. Use a temp worktree dir and an `ensureWorktree` double that returns it.

`src/main.ts` and `scripts/ctl.ts`: pass `instance.name` into `realCtx` and into `preflight`'s deps.

- [ ] **Step 9: Keep `scripts/serve.ts` and `scripts/dev-env.ts` compiling**

Both import from `./ports.ts` / `../src/ports.ts`. They are deleted in Task 6; for now move `portFromEnv` and `stackPorts` verbatim into `scripts/ports.ts` (a file under `scripts/`, not `src/`) and point both imports there. The Global Constraints sweep covers `src/`, not `scripts/`.

- [ ] **Step 10: Lint, typecheck, test**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: green. `grep -rln "supabase\|docker\|TONE_\|role-config\|tone_tonic" src` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: preflight, session-env, before-session and after-session hooks replace the Supabase and port logic

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Base role prompts, base headless settings, composition at dispatch; adopt and Slack removed

**Files:**
- Create: `roles/ground-rules.md`, `roles/builder.md`, `roles/reviewer.md`, `roles/validator.md`, `roles/phase-closer.md`, `roles/planner.md`, `settings/headless.json`, `src/prompts.ts`, `src/prompts.test.ts`, `src/roles.test.ts`, `src/settings.test.ts`, `test/fixtures/repo/.foreman/rules.md`, `test/fixtures/repo/.foreman/roles/validator.md`, `test/fixtures/repo/.foreman/settings.json`
- Delete: `src/adopt.ts`, `src/adopt.test.ts`
- Modify: `src/dispatch.ts`, `src/dispatch.test.ts`, `src/loop.ts`, `src/loop.test.ts`, `src/state.ts`, `src/state.test.ts`, `src/next.ts`, `src/types.ts`, `src/ledger.ts`, `src/pick.ts`, `src/pick.test.ts`, `src/github.ts`, `src/phase-progress.ts`, `src/stream.ts`, `src/web.html`, `test/fixtures/board.json`, `test/fixtures/issues.json`, `test/fixtures/issues-graphql.json`, `test/helpers.ts`

**Interfaces:**
- Produces:
  - `PACKAGE_ROOT: string` (`src/prompts.ts`; resolves `roles/` and `settings/` relative to the module, so it works from `dist/` and from `src/`)
  - `composeRolePrompt(role: Role, parts: { groundRules: string; base: string; rules: string | null; roleRules: string | null; checks: string[]; plansDir: string; specGlob: string }): string`
  - `composeSettings(base: HeadlessSettings, extra: { allow?: string[]; deny?: string[] } | null): HeadlessSettings` where `interface HeadlessSettings { enableAllProjectMcpServers: boolean; permissions: { allow: string[]; deny: string[] } }`
  - `readRepoRules(worktree: string, role: Role): { rules: string | null; roleRules: string | null; settings: { allow?: string[]; deny?: string[] } | null }`
  - `writeSessionFiles(stateDir: string, worktree: string, role: Role, repo: RepoConfig): { promptPath: string; settingsPath: string }` → writes `<stateDir>/roles/<role>.md` and `<stateDir>/settings.json`
  - `DispatchRequest` gains `promptPath: string; settingsPath: string`; `buildArgs` uses them.
  - `parentEpicOf(body: string): number | null` in `src/github.ts`.
  - `Action` no longer has `adopt`; `fmt.adopted` is gone.

- [ ] **Step 1: Write `roles/ground-rules.md`**

```markdown
# Headless role session

You are one role in an unattended pipeline run by the foreman. The user prompt tells you your role, the issue, the PR (if any), the worktree you are in, the branch, the spec path, and your session id. There is no human watching. Anything you need to say goes into GitHub.

## Ground rules (all roles)
- Read `CLAUDE.md` and `AGENTS.md` in the worktree first if they exist, then the issue (`gh issue view <n> --comments`), then the spec section the issue links. The **House rules** section at the end of this prompt is the repository's own and outranks anything generic here.
- Work only inside the worktree you were started in. Never `cd`. Every command runs from the worktree root; use `git -C <path> …` instead. Never check out or push the default branch. Never merge (`gh pr merge` is denied; the foreman merges). Never force-push. Never commit secrets.
- `gh api` is denied; use `gh issue`, `gh pr`, `gh project` subcommands.
- You are billed to a subscription. Never set or read `ANTHROPIC_API_KEY`; if you see it in any env file, leave it empty.
- Every GitHub write must be idempotent: re-read before you post, do not duplicate a comment or label that already exists.
- If a tool call is denied, do not retry it another way; note it in your final notes.
- If an Edit/Write under `.claude/` or `.foreman/` is denied, finish everything else, post the exact patch as an issue comment, label the issue `needs-owner`, and return your blocked outcome (humans own `.claude/**` and `.foreman/**`).
- **Never pass a multi-line body inline.** `gh … --body "<text with newlines>"` is denied, heredoc form (`--body "$(cat <<'B' … B)"`) included; only a single-line `--body` gets through. Write the text to `.gh-body.md` at the worktree root with `Write`, then pass `--body-file .gh-body.md`. Overwrite it for the next body; never commit it. This applies to `gh issue create`, `gh issue comment`, `gh pr create`, `gh pr comment` and `gh pr review` alike.
- The checks for this repository are: {{checks}}. Run them before every push.
- Finish by returning the outcome object required by the output schema: `{"outcome": ..., "pr": <number or null>, "notes": "<what the foreman and the next role need to know>"}`. Return it only when the work is done or truly blocked.
```

- [ ] **Step 2: Write `roles/builder.md`**

```markdown
## Role: builder

Goal: turn the issue into a merge-ready PR on the given branch.

1. Read the issue's **Acceptance criteria**, **Touches**, and **Spec** sections, the linked plan task in `{{plansDir}}/` if one exists, and every existing **Progress** comment.
2. If the issue is ambiguous in a way that changes the outcome, do not guess. Open a decision issue: write the context, options A/B with trade-offs, your recommendation and a link to #<issue> to `.gh-body.md`, then `gh issue create --title "Decision: <question>" --label "decision,needs-owner,phase:<N>" --body-file .gh-body.md`, then `gh issue edit <issue> --add-label blocked`, comment why, and return `blocked` with the decision issue number in notes. For small ambiguities pick the simplest interpretation and state it in the PR body.
3. Test-driven: write the failing test first, run it, implement, run again. Run the checks ({{checks}}) before every push.
4. Checkpoints: after each meaningful step, `git add -A && git commit -m "<type>(<area>): <summary> (#<issue>)"` and `git push -u origin <branch>`, then post a Progress comment on the issue:
   ```
   **Progress** (session <id> on <host>)
   - Done: …
   - Next: …
   - Branch: <branch>
   ```
   Keep at most one Progress comment per checkpoint; do not edit old ones.
5. Fix rounds (the prompt says "fix round N"): first `git merge origin/<default branch>` and resolve any conflict, so the reviewer never sees a branch that cannot merge. Then read `gh pr view <pr> --comments` and `gh pr view <pr> --json reviews --jq '.reviews[] | {author: .author.login, state, body}'`, plus the latest validator comment. Address every item, push, and reply on the PR with a checklist of what changed. Do not open a new PR.
6. Open the PR when acceptance criteria pass locally. Immediately before, `git fetch origin && git merge origin/<default branch>`, resolve any conflict, re-run the checks and push, so the PR opens mergeable. Write the body to `.gh-body.md`:

   ```
   Closes #<issue>

   ## What changed
   …
   ## How it was tested
   …
   ## Outside the issue's Touches list / spec deviations
   None.
   ```

   then `gh pr create --title "<type>(<area>): <summary> (#<issue>)" --body-file .gh-body.md`. If the PR already exists (fix round), skip creation. The foreman moves the board to In Review.
7. Rebase rounds (the prompt says "rebase round"): the PR is already approved. `git merge origin/<default branch>`, resolve conflicts keeping both sides' intent, run the checks, commit the merge, push, and post one Progress comment. Change nothing else; do not open a new PR.
8. Return `pr_opened` with the PR number. Notes: anything the reviewer should look at first, spec deviations, and the seeded data the validator needs.

Never label the PR `reviewer:*` or `validator:*`. Never claim, release, or comment on other issues.
```

- [ ] **Step 3: Write `roles/reviewer.md`**

```markdown
## Role: reviewer

You have no memory of how the PR was built. Judge it cold.

1. Read the issue, the spec section, and the diff: `gh pr view <pr>`, `gh pr diff <pr>`. The worktree is already on the PR branch; run `git pull --ff-only` to be sure. On a fix round, also read prior reviews with `gh pr view <pr> --comments` and `gh pr view <pr> --json reviews --jq '.reviews[] | {author: .author.login, state, body}'` so you do not repeat settled feedback.
2. Run the checks yourself ({{checks}}), plus whatever the House rules add for the files this PR touches.
3. Checklist (each item is a pass/fail line in your review):
   - Every acceptance criterion in the issue is met and covered by a test that would fail without the change.
   - Scope: files outside the issue's **Touches** list are called out in the PR body; if not, request changes.
   - PR title/body follow the repository's conventions; `Closes #<issue>` present; no secrets; no debugging output left; no skipped tests.
   - Spec deviations are noted in the PR and the spec was updated in the same PR.
   - Every item the House rules add.
4. **Fix rounds converge.** On fix round 2 or later (the prompt says so, and the PR carries earlier reviews), you may request changes only for:
   - a finding from a prior review that is still not fixed;
   - a regression in the delta since the last review (`git diff <last reviewed sha>..HEAD`);
   - a real safety issue: data loss, a secret, or a change that would reach the default branch or a shared environment by mistake.
   Anything else you find, including a real bug in code the previous round did not flag, goes under **Non-blocking / follow-up**, and if it matters, write the finding (path:line, and "found reviewing #<pr>") to `.gh-body.md` and `gh issue create --title "<type>(<area>): <summary>" --label "phase:<N>,area:<area>,size:S" --body-file .gh-body.md` so it is tracked; do not request changes for it. A branch that conflicts with the default branch is never a finding at any round: the foreman schedules a rebase for an approved PR. Say it under Non-blocking and approve on the code.
5. GitHub has no inline-comment API available to you (`gh api` is denied), so put every concrete finding directly in the review body, one per line, as `path:line — problem — fix`.
6. Decide:
   - Approve: write the checklist to `.gh-body.md`, then `gh pr review <pr> --approve --body-file .gh-body.md` then `gh pr edit <pr> --add-label reviewer:approved --remove-label reviewer:changes` (ignore the error if the label is absent). Return `approved`.
   - Request changes: write the checklist to `.gh-body.md`, failing items first, each as `path:line — problem — fix`, then `gh pr review <pr> --request-changes --body-file .gh-body.md` then `gh pr edit <pr> --add-label reviewer:changes`. Return `changes_requested` with the failing items in notes.
7. Never push commits to the branch, never edit files, never merge, never label `validator:*`.
```

- [ ] **Step 4: Write `roles/validator.md`**

```markdown
## Role: validator

Prove the acceptance criteria against a real, freshly set up instance of the application. The foreman already skipped you for issues whose labels say there is nothing to drive, so this issue has behaviour to verify. The House rules say how to bring the application up, where its URLs are, what test accounts exist and which browser or client tools you have; follow them exactly.

Procedure:
1. `git pull --ff-only`, then the setup and start steps from the House rules. If the application itself will not come up, return `failed` with the log excerpt.
2. Turn each acceptance criterion in the issue into concrete steps with expected observations. Read the PR body for any setup the builder documented.
3. Execute them. A criterion fails if the observation differs, if the console or logs show uncaught errors related to the feature, or if a request to the application returns 5xx.
4. Save artifacts (screenshots, logs) under `.validation-artifacts/<pr>/` inside the worktree, one file per criterion named `<nn>-<slug>.png` or `.txt`. Keep them inside the worktree; a headless session cannot write outside it. The foreman copies the directory to its artifacts store once you return. Never `git add` an artifact.
5. Post one PR comment:
   ```
   ## Validation (session <id> on <host>)
   | # | Criterion | Steps | Result | Artifact |
   |---|-----------|-------|--------|----------|
   ...
   Artifacts: .validation-artifacts/<pr>/ (archived by the foreman on <host>)
   <for failures: exact reproduction steps and the relevant observation>
   ```
6. Label: `gh pr edit <pr> --add-label validator:passed --remove-label validator:failed` or `--add-label validator:failed`.
7. Always run the House rules' stop step before returning, even on failure.
8. Return `passed`, or `failed` with the reproduction steps in notes (the builder gets them verbatim).

Never edit source files, never push, never merge, never label `reviewer:*`.
```

- [ ] **Step 5: Write `roles/planner.md`**

```markdown
## Role: planner

The prompt's "task issue" is the **next phase's epic**, which has no approved plan. Draft the plan; do not start work.

1. Read the epic body, its spec (`## Spec` line), `AGENTS.md` if present, and the previous phase's plan in `{{plansDir}}/` for format. If a closed, unmerged `docs(plan): phase NN plan` PR exists for this epic (`gh pr list --state closed --search "phase NN plan in:title" --json number,title,url`), read its diff with `gh pr diff <n>` and start from that draft, keeping what still matches the spec, instead of planning from scratch.
2. Resolve the spec's open questions yourself with the simplest workable answer and list each answer under an **Assumptions for the owner** section at the top of the plan; the owner overrides them in the planning session.
3. Invoke the `superpowers:writing-plans` skill (use the Skill tool; if unavailable, follow the previous phase's plan as the template) to write `{{plansDir}}/<today>-phase-NN-plan.md` where NN is the two-digit phase number from the epic's `phase:N` label, zero-padded.
4. Write `{{plansDir}}/<today>-phase-NN-plan.issues.json` matching this schema exactly:
   ```json
   { "epic": <epic number>,
     "tasks": [ { "number": <existing issue number, omit to create>, "title": "<type>(<area>): …",
                  "body": "## Goal\n…\n## Acceptance criteria\n- [ ] …\n## Touches\n…\n## Depends on\n#…, #… or None\n## Spec\n<path> § <section>\n\nParent epic: #<epic>",
                  "labels": ["phase:N", "area:…", "size:S|M|L"] } ] }
   ```
   One entry per plan task, in dependency order. Every body ends with the `Parent epic: #<epic>` line; the foreman ignores a task without it. Existing sub-issues (`gh issue list --search "Parent epic: #<epic> in:body" --state all --limit 100 --json number,title,state`) are updated by number, not duplicated. Do **not** include `agent-ready` in labels; the foreman adds it after approval.
5. Commit on the given branch, push, open a PR titled `docs(plan): phase NN plan (#<epic>)` whose body starts with `Refs #<epic>` (not `Closes`) and summarises the assumptions. Comment on the epic: `Plan drafted: <pr url>. Label me plan-approved after review.`
6. Return `plan_drafted` with the PR number. The foreman notifies the owner.

Never label `plan-approved` or `agent-ready`, never create task issues directly, never merge, never touch the default branch.
```

- [ ] **Step 6: Write `roles/phase-closer.md`**

```markdown
## Role: phase-closer

The prompt's "task issue" is the **phase epic**. Every task under it is Done. Produce the owner's review package.

1. Collect: `gh issue list --search "Parent epic: #<epic> in:body" --state all --limit 100 --json number,title,state` for task numbers; for each, `gh issue view <n> --json title,closedByPullRequestsReferences` (fall back to `gh pr list --state merged --search "<n> in:body" --json number,title`) for the merged PR list; open `decision` issues for this phase (`gh issue list --label decision --label phase:<N> --state open`); validator comments on those PRs (`gh pr view <pr> --comments`) for artifact paths; the phase spec's acceptance criteria.
2. Create the review issue: write the body to `.gh-body.md`, then `gh issue create --title "Phase <N> review: <epic title>" --label "phase:<N>,needs-owner" --body-file .gh-body.md`. Sections:
   - **Merged PRs** (number, title, issue)
   - **How to test, step by step**: the setup, start and login steps from the House rules, then one numbered scenario per spec acceptance criterion.
   - **Artifacts**: paths reported by the validator, per PR.
   - **Known gaps and open decisions**: open `decision` issues, spec deviations noted in PR bodies, anything labelled blocked.
   - **Sign-off**: "Reply here and add the `signed-off` label to #<epic> to close the phase. Add `foreman:pause` to the next phase's epic to hold the foreman."
   Link it from the epic with a comment `Phase review: #<review>`.
3. Label the epic: `gh issue edit <epic> --add-label needs-owner`. (The foreman moves the epic to In Review.)
4. Return `phase_closed` with `pr: null` and notes = the review issue number. The foreman notifies the owner.

Never close the epic, never label `signed-off`, never merge, never touch the default branch.
```

- [ ] **Step 7: Write `settings/headless.json`**

Today's `.claude/headless-settings.json` with these lines removed from `allow`: `Bash(pnpm *)`, `Bash(pnpx *)`, `Bash(npx playwright *)`, `Bash(supabase *)`, `mcp__playwright`, the three `mcp__claude_ai_Slack__*`; and from `deny`: `Bash(docker *)`, `Bash(orb *)`, the five `Bash(supabase …)`, `Read(~/.tone_tonic/foreman.json)`, `Edit(//Users/*/.tone_tonic/**)`, `Write(//Users/*/.tone_tonic/**)`. Add to `deny`: `Read(~/.foreman/*/foreman.json)`, `Edit(~/.foreman/**)`, `Write(~/.foreman/**)`. Keep `enableAllProjectMcpServers: true` and everything else byte for byte. The git-push denies say `main`; add the same seven lines for `master` so a repository with that default branch is protected too (`Bash(git push origin master*)`, `Bash(git push -u origin master*)`, `Bash(git push * master*)`, `Bash(git push origin HEAD:master*)`, `Bash(git checkout master*)`, `Bash(git switch master*)`, `Bash(git branch -D master*)`).

- [ ] **Step 8: Write the fixture repo rules and settings**

`test/fixtures/repo/.foreman/rules.md`:

```markdown
- Use `pnpm --filter <pkg> …` for package scripts.
- Never run `supabase stop`.
```

`test/fixtures/repo/.foreman/roles/validator.md`:

```markdown
Start the app with `pnpm --filter @acme/serve start`; it answers on http://localhost:8182. Stop it with `pnpm --filter @acme/serve stop`.
```

`test/fixtures/repo/.foreman/settings.json`:

```json
{ "allow": ["Bash(pnpm *)", "Bash(supabase *)"], "deny": ["Bash(supabase stop*)", "Bash(git push origin main*)"] }
```

- [ ] **Step 9: Write the failing tests `src/prompts.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, composeRolePrompt, composeSettings, readRepoRules, writeSessionFiles } from "./prompts.ts";
import { defaultRepoConfig } from "./repo-config.ts";

const fixtureRepo = join(import.meta.dirname, "../test/fixtures/repo");

describe("composeRolePrompt", () => {
  const parts = { groundRules: "# Ground\n{{checks}}\n", base: "## Role: builder\n{{plansDir}} {{specGlob}}\n", rules: "house\n", roleRules: "builder-only\n", checks: ["pnpm lint", "pnpm test"], plansDir: "docs/plans", specGlob: "docs/**/*.md" };
  it("orders ground rules, base, house rules, role rules", () => {
    const p = composeRolePrompt("builder", parts);
    const at = (s: string) => p.indexOf(s);
    expect(at("# Ground")).toBeLessThan(at("## Role: builder"));
    expect(at("## Role: builder")).toBeLessThan(at("## House rules"));
    expect(at("## House rules")).toBeLessThan(at("house"));
    expect(at("house")).toBeLessThan(at("## builder rules"));
    expect(at("## builder rules")).toBeLessThan(at("builder-only"));
  });
  it("fills every placeholder", () => {
    const p = composeRolePrompt("builder", parts);
    expect(p).toContain("`pnpm lint`, `pnpm test`");
    expect(p).toContain("docs/plans docs/**/*.md");
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });
  it("omits the House rules and role sections when the repository has none", () => {
    const p = composeRolePrompt("builder", { ...parts, rules: null, roleRules: null });
    expect(p).not.toContain("## House rules");
    expect(p).not.toContain("## builder rules");
  });
});

describe("composeSettings", () => {
  const base = { enableAllProjectMcpServers: true, permissions: { allow: ["Read"], deny: ["Bash(gh pr merge*)"] } };
  it("appends repository allow and deny", () => {
    const s = composeSettings(base, { allow: ["Bash(pnpm *)"], deny: ["Bash(supabase stop*)"] });
    expect(s.permissions.allow).toEqual(["Read", "Bash(pnpm *)"]);
    expect(s.permissions.deny).toEqual(["Bash(gh pr merge*)", "Bash(supabase stop*)"]);
  });
  it("a repository allow cannot cancel a base deny", () => {
    const s = composeSettings(base, { allow: ["Bash(gh pr merge*)"] });
    expect(s.permissions.deny).toContain("Bash(gh pr merge*)");
    expect(s.permissions.allow).not.toContain("Bash(gh pr merge*)");
  });
  it("dedupes and tolerates null", () => {
    expect(composeSettings(base, { deny: ["Bash(gh pr merge*)"] }).permissions.deny).toEqual(["Bash(gh pr merge*)"]);
    expect(composeSettings(base, null)).toEqual(base);
  });
});

describe("readRepoRules", () => {
  it("reads rules.md, roles/<role>.md and settings.json from the worktree", () => {
    const r = readRepoRules(fixtureRepo, "validator");
    expect(r.rules).toContain("supabase stop");
    expect(r.roleRules).toContain("@acme/serve");
    expect(r.settings?.allow).toEqual(["Bash(pnpm *)", "Bash(supabase *)"]);
  });
  it("is all null for a role without a file, and for a repo without .foreman", () => {
    expect(readRepoRules(fixtureRepo, "builder").roleRules).toBeNull();
    expect(readRepoRules(mkdtempSync(join(tmpdir(), "bare-")), "builder")).toEqual({ rules: null, roleRules: null, settings: null });
  });
});

describe("writeSessionFiles", () => {
  it("writes <stateDir>/roles/<role>.md and <stateDir>/settings.json from the shipped bases", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const out = writeSessionFiles(stateDir, fixtureRepo, "validator", { ...defaultRepoConfig(), checks: ["echo ok"] });
    expect(out.promptPath).toBe(join(stateDir, "roles", "validator.md"));
    expect(out.settingsPath).toBe(join(stateDir, "settings.json"));
    const prompt = readFileSync(out.promptPath, "utf8");
    expect(prompt).toContain("## Role: validator");
    expect(prompt).toContain("`echo ok`");
    expect(prompt).toContain("@acme/serve");
    const settings = JSON.parse(readFileSync(out.settingsPath, "utf8"));
    expect(settings.permissions.allow).toContain("Bash(pnpm *)");
    expect(settings.permissions.deny).toContain("Bash(gh pr merge*)");
  });
  it("PACKAGE_ROOT holds roles/ and settings/", () => {
    expect(existsSync(join(PACKAGE_ROOT, "roles", "ground-rules.md"))).toBe(true);
    expect(existsSync(join(PACKAGE_ROOT, "settings", "headless.json"))).toBe(true);
  });
});
```

- [ ] **Step 10: Run to see them fail**

Run: `pnpm test -- src/prompts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 11: Write `src/prompts.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_DIRNAME, type RepoConfig } from "./repo-config.ts";
import type { Role } from "./types.ts";

/** `roles/` and `settings/` sit beside `src/` and beside `dist/`, one level up from this file. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface HeadlessSettings {
  enableAllProjectMcpServers: boolean;
  permissions: { allow: string[]; deny: string[] };
}
export interface RepoSettingsExtra {
  allow?: string[];
  deny?: string[];
}

export interface PromptParts {
  groundRules: string;
  base: string;
  rules: string | null;
  roleRules: string | null;
  checks: string[];
  plansDir: string;
  specGlob: string;
}

function fill(text: string, p: PromptParts): string {
  return text
    .replaceAll("{{checks}}", p.checks.map((c) => `\`${c}\``).join(", "))
    .replaceAll("{{plansDir}}", p.plansDir)
    .replaceAll("{{specGlob}}", p.specGlob);
}

export function composeRolePrompt(role: Role, p: PromptParts): string {
  const sections = [fill(p.groundRules, p).trimEnd(), fill(p.base, p).trimEnd()];
  if (p.rules) sections.push(`## House rules\n${p.rules.trimEnd()}`);
  if (p.roleRules) sections.push(`## ${role} rules\n${p.roleRules.trimEnd()}`);
  return `${sections.join("\n\n")}\n`;
}

/** Base plus repository, deduplicated; a repository allow never removes a base deny. */
export function composeSettings(base: HeadlessSettings, extra: RepoSettingsExtra | null): HeadlessSettings {
  const deny = [...new Set([...base.permissions.deny, ...(extra?.deny ?? [])])];
  const allow = [...new Set([...base.permissions.allow, ...(extra?.allow ?? [])])].filter((r) => !deny.includes(r));
  return { ...base, permissions: { allow, deny } };
}

function readIf(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function readRepoRules(worktree: string, role: Role): { rules: string | null; roleRules: string | null; settings: RepoSettingsExtra | null } {
  const dir = join(worktree, REPO_DIRNAME);
  const settingsText = readIf(join(dir, "settings.json"));
  return {
    rules: readIf(join(dir, "rules.md")),
    roleRules: readIf(join(dir, "roles", `${role}.md`)),
    settings: settingsText ? (JSON.parse(settingsText) as RepoSettingsExtra) : null,
  };
}

export function readBasePrompt(role: Role): { groundRules: string; base: string } {
  return {
    groundRules: readFileSync(join(PACKAGE_ROOT, "roles", "ground-rules.md"), "utf8"),
    base: readFileSync(join(PACKAGE_ROOT, "roles", `${role}.md`), "utf8"),
  };
}

export function readBaseSettings(): HeadlessSettings {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "settings", "headless.json"), "utf8")) as HeadlessSettings;
}

/** Spec §7: the files `claude -p` is pointed at, regenerated per dispatch from the worktree's `.foreman/`. */
export function writeSessionFiles(stateDir: string, worktree: string, role: Role, repo: RepoConfig): { promptPath: string; settingsPath: string } {
  const repoRules = readRepoRules(worktree, role);
  const prompt = composeRolePrompt(role, {
    ...readBasePrompt(role),
    rules: repoRules.rules,
    roleRules: repoRules.roleRules,
    checks: repo.checks,
    plansDir: repo.plans.dir,
    specGlob: repo.plans.specGlob,
  });
  const settings = composeSettings(readBaseSettings(), repoRules.settings);
  mkdirSync(join(stateDir, "roles"), { recursive: true });
  const promptPath = join(stateDir, "roles", `${role}.md`);
  const settingsPath = join(stateDir, "settings.json");
  writeFileSync(promptPath, prompt);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { promptPath, settingsPath };
}
```

- [ ] **Step 12: Run the tests**

Run: `pnpm test -- src/prompts.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 13: Point dispatch at the generated files**

`src/dispatch.ts`: `DispatchRequest` gains `promptPath: string; settingsPath: string`; in `buildArgs` replace the two `join(req.worktree, ".claude", …)` arguments with `req.settingsPath` and `req.promptPath`. `src/loop.ts` `runRole`: before building `req`, `const files = writeSessionFiles(ctx.stateDir, worktree, r.role, ctx.repo);` and set both fields. `src/dispatch.test.ts`: every request literal gains `promptPath: "/s/roles/builder.md", settingsPath: "/s/settings.json"`, and the `buildArgs` test asserts `--settings /s/settings.json` and `--append-system-prompt-file /s/roles/builder.md`. `src/loop.test.ts`'s `Ctx` gets `stateDir` pointing at a temp dir so `writeSessionFiles` can write.

- [ ] **Step 14: Remove adopt, require `Parent epic:`**

Delete `src/adopt.ts`, `src/adopt.test.ts`. `src/types.ts`: delete the `adopt` variant. `src/state.ts`: delete the import and the `...adoptActions(s),` line. `src/loop.ts`: delete `case "adopt"`. `src/ledger.ts`: delete `fmt.adopted`. `src/next.ts`: delete any `adopt` branch (`grep -n adopt src/next.ts`). `src/state.test.ts` and `src/loop.test.ts`: delete the adopt tests. Move the `PARENT` regex from `src/phase-progress.ts:8` to `src/github.ts` as

```ts
/** The `Parent epic: #N` line the planner ends every task body with; null when absent. */
export function parentEpicOf(body: string): number | null {
  const m = /^Parent epic:\s*#(\d+)\s*$/m.exec(body);
  return m ? Number(m[1]) : null;
}
```

and use it in `phase-progress.ts`. `src/pick.ts` `buildCandidates`: add `.filter((i) => parentEpicOf(i.body) !== null)` after the `agent-ready` filter. `test/helpers.ts` `issue()` default body gains `\n\nParent epic: #1`. `src/pick.test.ts`: add a test that an otherwise-eligible issue whose body lacks the line is not a candidate. `src/waiting.ts`: if it reports off-board `agent-ready` issues as waiting on adoption (`grep -n "adopt\|itemId === null" src/waiting.ts`), change that item's detail to `not a planner task (no Parent epic line)` and keep the kind.

- [ ] **Step 15: Sanitise fixtures and the last vocabulary**

```bash
sed -i '' -e 's#matthewtsmith/tone_tonic#acme/widgets#g' -e 's#matthewtsmith#acme#g' -e 's#tone_tonic#widgets#g' -e 's#Tone & Tonic#Widgets#g' test/fixtures/board.json test/fixtures/issues.json test/fixtures/issues-graphql.json test/helpers.ts
grep -rn "supabase\|pnpm" test/fixtures/*.json | wc -l
```

Any `supabase`/`pnpm` left in fixture issue bodies is data, not code; leave it. `src/stream.ts:89-90`: the `mcp__playwright__` special case becomes generic: strip any `mcp__<server>__` prefix to `<server>:<tool>`. `src/web.html:173`: `family` reads the model list from `/api/status`'s `model.choices` instead of the literal regex (`choices.find((c) => model.includes(c)) ?? model`). `src/notify.ts:31`: `MACOS_TITLE` becomes a function `macosTitle(instance: string) => \`foreman ${instance}\``, `NotifierDeps` gains `instance: string`, `realCtx` passes it.

- [ ] **Step 16: Rewrite `src/roles.test.ts` and `src/settings.test.ts` against the shipped files**

`src/roles.test.ts`: read from `join(PACKAGE_ROOT, "roles")`; keep the "each names only its own outcomes" test as is (now over `ground-rules.md` + `<role>.md` concatenated); keep "shares the hard rules" asserting `Never merge`, `default branch`, `ANTHROPIC_API_KEY`, `` Never `cd` `` on `ground-rules.md`; keep the `.gh-body.md` / `--body-file` / no-heredoc tests; delete the "byte-identical preamble" and the tone_tonic URL/login/Slack tests; add: no role file contains `pnpm`, `supabase`, `Slack`, `slack_`, `notify-failed`, `tone_tonic`, `~/.tone_tonic`; `planner.md` contains `Parent epic: #<epic>` and `.issues.json`; every file's `{{…}}` placeholders are in the set `checks`, `plansDir`, `specGlob`.

`src/settings.test.ts`: read `settings/headless.json` via `readBaseSettings()`; keep every existing assertion except: drop `Bash(pnpm *)`, `Bash(supabase *)`, `Bash(npx playwright *)`, `mcp__playwright`, the Slack rules from the "allows" list; drop `Bash(docker *)`, `Bash(supabase stop*)` from the "denies" list; replace the `~/.tone_tonic` tests with `Read(~/.foreman/*/foreman.json)`, `Edit(~/.foreman/**)`, `Write(~/.foreman/**)`; delete the `.claude/settings.json` describe (that file is tone_tonic's); add: `master` push/checkout denies present.

- [ ] **Step 17: Lint, typecheck, test, sweep**

```bash
pnpm lint && pnpm typecheck && pnpm test
grep -rniE "tone_tonic|tonetonic|TONE_|@tone/|supabase|docker|playwright|slack" src roles settings | grep -v "^src/repo-config.ts"
```

Expected: tests green; the grep prints nothing.

- [ ] **Step 18: Commit**

```bash
git add -A
git commit -m "feat: base role prompts and headless settings composed with the repo's .foreman/ at dispatch; adopt and Slack MCP removed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: One CLI: `foreman <subcommand>`, launchd per instance, no zsh wrapper

**Files:**
- Create: `src/cli/args.ts`, `src/cli/args.test.ts`, `src/cli/main.ts`, `src/cli/daemon.ts`, `src/cli/ctl.ts`, `src/cli/launchd.ts`, `src/cli/launchd.test.ts`, `src/cli/instances.ts`, `src/cli/instances.test.ts`, `src/cli/hooks.ts`
- Delete: `src/main.ts`, `scripts/` (all), `bin/foreman`, `launchd/` (all), `src/launchd.test.ts`, `src/ctl.test.ts` only if it tests `scripts/ctl.ts` (it tests `src/ctl.ts`; keep it)
- Modify: `package.json` (`bin`, `dev`, `build`), `vitest.config.ts`, `src/launchd-status.ts`, `src/ctl.ts`, `src/notify.ts`

**Interfaces:**
- Produces:
  - `parseCli(argv: string[]): Cli` where `type Cli = { instance?: string; cmd: Command; args: Record<string, string | boolean>; positionals: string[] }` and `Command` is one of `add | list | init | epic | run | start | stop | abort | go | status | next | model | cap | logs | page | launchd | hooks | help`.
  - `USAGE: string`.
  - `launchdLabel(name: string): string` → `com.apptreesoftware.foreman.<name>`.
  - `renderPlist(o: { label: string; foremanBin: string; instance: string; stateDir: string; home: string; path: string }): string`.
  - `launchdInstalled(label: string): Promise<boolean>` (parameter added to today's function).
  - `runDaemon(instance: Instance, o: { once: boolean; dryRun: boolean }): Promise<never>`.
  - `runCtl(instance: Instance, cmd: "status" | "next" | "stop" | "abort" | "go" | "model" | "cap", o: { watch: boolean; json: boolean; value: string | null }): Promise<void>`.
  - `addInstance(o: { name; repo; repoDir; host?; webPort?; home? }): Instance` (refuses a duplicate `webPort`, picks the first free port from 8090 when unset).

- [ ] **Step 1: Write the failing tests `src/cli/args.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseCli } from "./args.ts";

describe("parseCli", () => {
  it("reads -p before the subcommand", () => {
    expect(parseCli(["-p", "widgets", "status", "--watch"])).toMatchObject({ instance: "widgets", cmd: "status", args: { watch: true } });
  });
  it("reads --instance after the subcommand too", () => {
    expect(parseCli(["status", "--instance", "widgets"]).instance).toBe("widgets");
  });
  it("add takes name and flags", () => {
    expect(parseCli(["add", "widgets", "--repo", "acme/widgets", "--repo-dir", "~/w", "--web-port", "8091"])).toMatchObject({ cmd: "add", positionals: ["widgets"], args: { repo: "acme/widgets", "repo-dir": "~/w", "web-port": "8091" } });
  });
  it("epic new takes title, phase, spec, agent-ready", () => {
    const c = parseCli(["epic", "new", "--title", "Phase 3", "--phase", "3", "--spec", "docs/x.md", "--agent-ready"]);
    expect(c).toMatchObject({ cmd: "epic", positionals: ["new"], args: { title: "Phase 3", phase: "3", spec: "docs/x.md", "agent-ready": true } });
  });
  it("run takes --once and --dry-run", () => {
    expect(parseCli(["run", "--once", "--dry-run"]).args).toEqual({ once: true, "dry-run": true });
  });
  it("model and cap carry an optional value", () => {
    expect(parseCli(["model", "sonnet"]).positionals).toEqual(["sonnet"]);
    expect(parseCli(["cap"]).positionals).toEqual([]);
  });
  it("launchd and hooks take a verb", () => {
    expect(parseCli(["launchd", "install"]).positionals).toEqual(["install"]);
    expect(parseCli(["hooks", "run", "preflight"]).positionals).toEqual(["run", "preflight"]);
  });
  it("no command or an unknown one is help", () => {
    expect(parseCli([]).cmd).toBe("help");
    expect(() => parseCli(["frobnicate"])).toThrow(/unknown command "frobnicate"/);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test -- src/cli/args.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/cli/args.ts`**

```ts
import { parseArgs } from "node:util";

export const COMMANDS = ["add", "list", "init", "epic", "run", "start", "stop", "abort", "go", "status", "next", "model", "cap", "logs", "page", "launchd", "hooks", "help"] as const;
export type Command = (typeof COMMANDS)[number];

export interface Cli {
  instance?: string;
  cmd: Command;
  args: Record<string, string | boolean>;
  positionals: string[];
}

export const USAGE = `foreman — one daemon per repository, driven by claude -p

  foreman add <name> --repo <owner/repo> --repo-dir <path> [--host <h>] [--web-port <n>]
  foreman list
  foreman [-p <name>] init
  foreman [-p <name>] epic new --title <t> --phase <n> --spec <path> [--agent-ready]
  foreman [-p <name>] run [--once] [--dry-run]     run the daemon in the foreground
  foreman [-p <name>] start | stop | abort | go | restart
  foreman [-p <name>] status [--watch] [--json] | next
  foreman [-p <name>] model [<name>|default] | cap [<n>|default]
  foreman [-p <name>] logs [-f] | page
  foreman [-p <name>] launchd install | uninstall | status
  foreman [-p <name>] hooks run <preflight|session-env|before-session|after-session>

The instance is -p, else FOREMAN_INSTANCE, else the one whose repoDir contains the cwd, else the only one.
`;

const OPTIONS = {
  instance: { type: "string", short: "p" },
  repo: { type: "string" },
  "repo-dir": { type: "string" },
  host: { type: "string" },
  "web-port": { type: "string" },
  title: { type: "string" },
  phase: { type: "string" },
  spec: { type: "string" },
  "agent-ready": { type: "boolean" },
  once: { type: "boolean" },
  "dry-run": { type: "boolean" },
  watch: { type: "boolean" },
  json: { type: "boolean" },
  f: { type: "boolean" },
} as const;

export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [cmd, ...rest] = positionals;
  if (!cmd) return { cmd: "help", args: {}, positionals: [] };
  if (!(COMMANDS as readonly string[]).includes(cmd)) throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  const { instance, ...args } = values;
  const defined = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Record<string, string | boolean>;
  return { instance, cmd: cmd as Command, args: defined, positionals: rest };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- src/cli/args.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing tests `src/cli/launchd.test.ts` and `src/cli/instances.test.ts`**

`src/cli/launchd.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { launchdLabel, renderPlist } from "./launchd.ts";

describe("launchd", () => {
  it("label is per instance", () => {
    expect(launchdLabel("widgets")).toBe("com.apptreesoftware.foreman.widgets");
  });
  it("plist runs `foreman -p <name> run` with KeepAlive, logs under the state dir, and no billing vars", () => {
    const p = renderPlist({ label: "com.apptreesoftware.foreman.widgets", foremanBin: "/opt/homebrew/bin/foreman", instance: "widgets", stateDir: "/Users/me/.foreman/widgets", home: "/Users/me", path: "/opt/homebrew/bin:/usr/bin:/bin" });
    expect(p).toContain("<key>Label</key><string>com.apptreesoftware.foreman.widgets</string>");
    expect(p).toContain("<string>/opt/homebrew/bin/foreman</string><string>-p</string><string>widgets</string><string>run</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>ThrottleInterval</key><integer>60</integer>");
    expect(p).toContain("/Users/me/.foreman/widgets/logs/foreman.out.log");
    expect(p).toContain("<key>HOME</key><string>/Users/me</string>");
    expect(p).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(p).not.toContain("ANTHROPIC_API_KEY");
  });
});
```

`src/cli/instances.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addInstance } from "./instances.ts";

describe("addInstance", () => {
  it("writes foreman.json with the first free port from 8090", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const a = addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "mac-a", home });
    const b = addInstance({ name: "b", repo: "acme/b", repoDir: "/r/b", host: "mac-a", home });
    expect(JSON.parse(readFileSync(a.configPath, "utf8"))).toEqual({ repo: "acme/a", host: "mac-a", repoDir: "/r/a", webPort: 8090 });
    expect(JSON.parse(readFileSync(b.configPath, "utf8")).webPort).toBe(8091);
  });
  it("refuses a duplicate name or port", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "h", webPort: 9000, home });
    expect(() => addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "h", home })).toThrow(/exists/);
    expect(() => addInstance({ name: "b", repo: "acme/b", repoDir: "/r/b", host: "h", webPort: 9000, home })).toThrow(/9000.*a/);
  });
  it("host defaults to the lowercased short hostname", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const i = addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", home });
    expect(JSON.parse(readFileSync(i.configPath, "utf8")).host).toMatch(/^[a-z0-9-]+$/);
  });
});
```

- [ ] **Step 6: Write `src/cli/launchd.ts` and `src/cli/instances.ts`**

`src/cli/launchd.ts`:

```ts
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realExec } from "../exec.ts";
import type { Instance } from "../instance.ts";
import { launchdInstalled, launchdUid } from "../launchd-status.ts";

export function launchdLabel(name: string): string {
  return `com.apptreesoftware.foreman.${name}`;
}

export function plistPath(label: string, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function renderPlist(o: { label: string; foremanBin: string; instance: string; stateDir: string; home: string; path: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(o.foremanBin)}</string><string>-p</string><string>${esc(o.instance)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${esc(o.home)}</string><key>PATH</key><string>${esc(o.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(join(o.stateDir, "logs", "foreman.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.stateDir, "logs", "foreman.err.log"))}</string>
</dict>
</plist>
`;
}

/** The billing env vars never reach the plist: launchd starts from a clean environment, and `runDaemon` refuses to start if one is set. */
export async function launchdInstall(i: Instance, foremanBin: string): Promise<string> {
  const label = launchdLabel(i.name);
  mkdirSync(join(i.dir, "logs"), { recursive: true });
  const p = plistPath(label);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(p, renderPlist({ label, foremanBin, instance: i.name, stateDir: i.dir, home: homedir(), path: `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }));
  if (await launchdInstalled(label)) await realExec("launchctl", ["bootout", `gui/${launchdUid()}/${label}`]);
  const r = await realExec("launchctl", ["bootstrap", `gui/${launchdUid()}`, p]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  return `installed ${label} (${p})`;
}

export async function launchdUninstall(i: Instance): Promise<string> {
  const label = launchdLabel(i.name);
  if (await launchdInstalled(label)) await realExec("launchctl", ["bootout", `gui/${launchdUid()}/${label}`]);
  const p = plistPath(label);
  if (existsSync(p)) unlinkSync(p);
  return `removed ${label}`;
}
```

`src/launchd-status.ts`: delete `LAUNCHD_LABEL`; `launchdInstalled(label: string)` uses the parameter. `src/ctl.ts` `CtlDeps.launchdKickstart` stays; its implementation in `cli/ctl.ts` uses `launchdLabel(instance.name)`.

`src/cli/instances.ts`:

```ts
import { hostname } from "node:os";
import { instanceFor, type Instance, listInstances, writeInstanceConfig } from "../instance.ts";
import { existsSync, readFileSync } from "node:fs";

const FIRST_PORT = 8090;

function portOf(i: Instance): number | null {
  try {
    const p = (JSON.parse(readFileSync(i.configPath, "utf8")) as { webPort?: unknown }).webPort;
    return typeof p === "number" ? p : FIRST_PORT;
  } catch {
    return null;
  }
}

export function addInstance(o: { name: string; repo: string; repoDir: string; host?: string; webPort?: number; home?: string }): Instance {
  const i = instanceFor(o.name, o.home);
  if (existsSync(i.configPath)) throw new Error(`instance "${o.name}" exists (${i.configPath})`);
  const taken = new Map<number, string>();
  for (const other of listInstances(o.home)) {
    const p = portOf(other);
    if (p !== null) taken.set(p, other.name);
  }
  let webPort = o.webPort;
  if (webPort === undefined) {
    webPort = FIRST_PORT;
    while (taken.has(webPort)) webPort++;
  } else if (taken.has(webPort)) throw new Error(`web port ${webPort} is used by instance "${taken.get(webPort)}"`);
  const host = o.host ?? hostname().split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "mac";
  writeInstanceConfig(i, { repo: o.repo, host, repoDir: o.repoDir, webPort });
  return i;
}

export function formatList(instances: Instance[], detail: (i: Instance) => { repo: string; daemon: string; port: number | null }): string {
  if (instances.length === 0) return "no instances; run: foreman add <name> --repo <owner/repo> --repo-dir <path>\n";
  return `${instances.map((i) => { const d = detail(i); return `${i.name.padEnd(16)} ${d.repo.padEnd(32)} ${d.daemon.padEnd(8)} :${d.port ?? "-"}`; }).join("\n")}\n`;
}
```

Run: `pnpm test -- src/cli`
Expected: PASS.

- [ ] **Step 7: Move `src/main.ts` to `src/cli/daemon.ts` as `runDaemon`**

Wrap the whole of today's `src/main.ts` (minus its `parseArgs` block and `resolveInstance` call) in `export async function runDaemon(instance: Instance, o: { once: boolean; dryRun: boolean }): Promise<never>`, with `const STATE_DIR = instance.dir; const cfg = loadConfig(instance.configPath); const repo = loadRepoConfig(cfg.repoDir);` at the top, `configPath: instance.configPath`, and `launchdInstalled(launchdLabel(instance.name))`. `checkEnv` stays first and `process.exit(2)`s. `realCtx` receives, after `control`, the arguments Tasks 3 and 4 added: `repo`, `defaultBranch` (from `await gh.defaultBranch()`) and `instance.name`; `preflight` deps get `repoDir`, `instance` and `hookLog`. Everything else is a verbatim move; imports change from `./x.ts` to `../x.ts`. Delete `src/main.ts`.

- [ ] **Step 8: Move `scripts/ctl.ts` to `src/cli/ctl.ts` as `runCtl`**

Same treatment: `export async function runCtl(instance: Instance, cmd, o)`; `STATE_DIR = instance.dir`; `startCommand: \`foreman -p ${instance.name} start\``; `launchdKickstart` uses `launchdLabel(instance.name)`; `status()` reads `o.watch`/`o.json`; `model`/`cap` read `o.value`. Delete `scripts/ctl.ts`, `scripts/ctl-args.ts`, `scripts/ctl.test.ts`.

- [ ] **Step 9: Write `src/cli/hooks.ts` and `src/cli/main.ts`**

`src/cli/hooks.ts`:

```ts
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { HOOK_NAMES, type HookName, runHook } from "../hooks.ts";
import type { Instance } from "../instance.ts";

export async function runHookCommand(instance: Instance, name: string): Promise<number> {
  if (!(HOOK_NAMES as readonly string[]).includes(name)) throw new Error(`unknown hook "${name}"; one of ${HOOK_NAMES.join(", ")}`);
  const cfg = loadConfig(instance.configPath);
  const r = await runHook(name as HookName, cfg.repoDir, { instance: instance.name, stateDir: instance.dir, repoDir: cfg.repoDir }, realExec, { log: (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (!r.ran) process.stderr.write(`no executable ${name} hook in ${cfg.repoDir}/.foreman/hooks\n`);
  return r.code;
}
```

`src/cli/main.ts` (the bin entry; `#!/usr/bin/env node` first line):

```ts
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { InstanceError, listInstances, resolveInstance } from "../instance.ts";
import { readState } from "../state-file.ts";
import { parseCli, USAGE } from "./args.ts";
import { runCtl } from "./ctl.ts";
import { runDaemon } from "./daemon.ts";
import { runHookCommand } from "./hooks.ts";
import { addInstance, formatList } from "./instances.ts";
import { launchdInstall, launchdLabel, launchdUninstall } from "./launchd.ts";
import { launchdInstalled } from "../launchd-status.ts";
import { runInit } from "../bootstrap/init.ts";
import { runEpicNew } from "../bootstrap/epic.ts";

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const out = (s: string) => process.stdout.write(`${s}\n`);
  if (cli.cmd === "help") { process.stdout.write(USAGE); return 0; }
  if (cli.cmd === "add") {
    const [name] = cli.positionals;
    const repo = cli.args.repo; const repoDir = cli.args["repo-dir"];
    if (!name || typeof repo !== "string" || typeof repoDir !== "string") throw new Error("usage: foreman add <name> --repo <owner/repo> --repo-dir <path> [--host <h>] [--web-port <n>]");
    const i = addInstance({ name, repo, repoDir, host: typeof cli.args.host === "string" ? cli.args.host : undefined, webPort: typeof cli.args["web-port"] === "string" ? Number(cli.args["web-port"]) : undefined });
    out(`added ${i.name}: ${i.configPath}\nnext: foreman -p ${i.name} init`);
    return 0;
  }
  if (cli.cmd === "list") {
    process.stdout.write(formatList(listInstances(), (i) => {
      const s = readState(i.dir);
      let repo = "?"; let port: number | null = null;
      try { const c = loadConfig(i.configPath); repo = c.repo; port = c.webPort; } catch {}
      return { repo, daemon: s && pidAlive(s.pid) ? "running" : "stopped", port };
    }));
    return 0;
  }
  const instance = resolveInstance({ flag: cli.instance, env: process.env, cwd: process.cwd() });
  const s = (k: string) => (typeof cli.args[k] === "string" ? (cli.args[k] as string) : null);
  const b = (k: string) => cli.args[k] === true;
  switch (cli.cmd) {
    case "init": return runInit(instance, out);
    case "epic": {
      if (cli.positionals[0] !== "new") throw new Error("usage: foreman epic new --title <t> --phase <n> --spec <path> [--agent-ready]");
      const title = s("title"); const phase = s("phase"); const spec = s("spec");
      if (!title || !phase || !spec) throw new Error("--title, --phase and --spec are required");
      return runEpicNew(instance, { title, phase: Number(phase), spec, agentReady: b("agent-ready") }, out);
    }
    case "run": return runDaemon(instance, { once: b("once"), dryRun: b("dry-run") });
    case "start": {
      const st = readState(instance.dir);
      if (st && st.exitedAt === null && pidAlive(st.pid)) { out(`daemon already running (pid ${st.pid}); use foreman -p ${instance.name} restart`); return 1; }
      mkdirSync(join(instance.dir, "logs"), { recursive: true });
      const log = openSync(join(instance.dir, "logs", "foreman.log"), "a");
      const child = spawn(process.execPath, [process.argv[1] as string, "-p", instance.name, "run"], { detached: true, stdio: ["ignore", log, log], env: process.env });
      child.unref();
      out(`started foreman ${instance.name} (pid ${child.pid}); log: ${join(instance.dir, "logs", "foreman.log")}`);
      return 0;
    }
    case "stop": case "abort": case "go": case "status": case "next": case "model": case "cap":
      await runCtl(instance, cli.cmd, { watch: b("watch"), json: b("json"), value: cli.positionals[0] ?? null });
      return 0;
    case "logs": {
      const file = join(instance.dir, "logs", "foreman.log");
      if (!existsSync(file)) { out(`no log yet at ${file}`); return 1; }
      const r = spawn("tail", [b("f") ? "-f" : "-n", b("f") ? file : "200", ...(b("f") ? [] : [file])], { stdio: "inherit" });
      return new Promise((resolve) => r.on("close", (c) => resolve(c ?? 0)));
    }
    case "page": {
      const cfg = loadConfig(instance.configPath);
      await realExec("open", [`http://127.0.0.1:${cfg.webPort}`]);
      return 0;
    }
    case "launchd": {
      const verb = cli.positionals[0];
      if (verb === "install") { out(await launchdInstall(instance, process.argv[1] as string)); return 0; }
      if (verb === "uninstall") { out(await launchdUninstall(instance)); return 0; }
      if (verb === "status") { out((await launchdInstalled(launchdLabel(instance.name))) ? `${launchdLabel(instance.name)} installed` : "not installed"); return 0; }
      throw new Error("usage: foreman launchd install | uninstall | status");
    }
    case "hooks": {
      if (cli.positionals[0] !== "run" || !cli.positionals[1]) throw new Error("usage: foreman hooks run <name>");
      return runHookCommand(instance, cli.positionals[1]);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`foreman: ${err instanceof InstanceError ? err.message : err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
```

`runInit` and `runEpicNew` do not exist until Task 7; for this task create `src/bootstrap/init.ts` and `src/bootstrap/epic.ts` each exporting the named function that throws `new Error("not implemented until Task 7")`, so the CLI typechecks. `launchd install` passes `process.argv[1]`, which for a global install is the `foreman` bin shim; launchd runs it through `node` since the file has the shebang and the `PATH` in the plist finds `node`. Add `restart` to `COMMANDS` and handle it as `stop` then `start`.

- [ ] **Step 10: Delete the wrapper, the launchd files and the scripts; repoint `package.json`**

```bash
git rm -r bin launchd scripts src/launchd.test.ts
```

`package.json`: `"bin": { "foreman": "dist/cli/main.js" }`, `"dev": "tsx src/cli/main.ts"`, build unchanged. `vitest.config.ts`: `include: ["src/**/*.test.ts"]`. `src/notify.ts`: done in Task 5. Check `grep -rn "scripts/\|bin/foreman\|launchd/" src README.md` and fix any leftover reference in `src/` (README is rewritten in Task 8).

- [ ] **Step 11: Lint, typecheck, test, build, smoke**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
chmod +x dist/cli/main.js
node dist/cli/main.js help | head -3
node dist/cli/main.js list
FOREMAN_CONFIG=/nonexistent/foreman.json node dist/cli/main.js status; echo "exit $?"
```

Expected: usage printed; `no instances; run: foreman add …`; the last prints `foreman: ENOENT…` and `exit 2`. `tsc` preserves the shebang, so `pnpm link --global` then `foreman help` works from any directory.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: one foreman CLI with add, list, run, start, ctl commands, logs, page, launchd and hooks run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `init` and `epic new`

**Files:**
- Create: `src/bootstrap/labels.ts`, `src/bootstrap/board.ts`, `src/bootstrap/scaffold.ts`, `src/bootstrap/bootstrap.test.ts`
- Modify: `src/bootstrap/init.ts`, `src/bootstrap/epic.ts` (replace the Task 6 stubs), `src/github.ts`, `src/github.test.ts`

**Interfaces:**
- Produces:
  - `LABELS: ReadonlyArray<{ name: string; color: string; description: string }>` (the fixed set from spec §9 step 2, without `model:*`); `modelLabels(models: string[])`.
  - `ensureLabels(gh: BootstrapApi, models: string[]): Promise<{ created: string[] }>`.
  - `STATUS_OPTIONS = ["Backlog", "Ready", "In Progress", "In Review", "Done"]`.
  - `ensureProject(gh: BootstrapApi, o: { owner: string; repo: string; project: number | null; title: string }): Promise<{ number: number; created: boolean; drift: string[] }>`.
  - `scaffoldRepoDir(repoDir: string): { written: string[] }`.
  - `runInit(instance: Instance, out: (s: string) => void): Promise<number>`.
  - `runEpicNew(instance: Instance, o: { title: string; phase: number; spec: string; agentReady: boolean }, out): Promise<number>`.
  - New `GitHub` methods: `tokenScopes(): Promise<string[]>`, `listLabels(): Promise<string[]>`, `createLabel(l)`, `createProject(owner, title): Promise<number>`, `linkProject(number, owner)`, `projectFields(number, owner): Promise<{ projectId: string; status: { id: string; options: { id: string; name: string }[] } | null }>`, `setStatusOptions(fieldId, names)`, `fileOnDefaultBranch(path): Promise<boolean>`. `BootstrapApi = Pick<GitHub, those | "createIssue" | "addToProject" | "setStatus" | "addLabels">`.

- [ ] **Step 1: Write the failing tests `src/bootstrap/bootstrap.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProject, STATUS_OPTIONS } from "./board.ts";
import { ensureLabels, LABELS, modelLabels } from "./labels.ts";
import { scaffoldRepoDir } from "./scaffold.ts";

function api(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const gh = {
    listLabels: async () => ["epic", "blocked"],
    createLabel: async (l: { name: string }) => { calls.push(`label ${l.name}`); },
    createProject: async (_o: string, t: string) => { calls.push(`create ${t}`); return 7; },
    linkProject: async (n: number) => { calls.push(`link ${n}`); },
    projectFields: async () => ({ projectId: "PVT_1", status: { id: "F1", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "Done" }] } }),
    setStatusOptions: async (f: string, names: string[]) => { calls.push(`options ${f} ${names.join("|")}`); },
    ...over,
  };
  return { gh, calls };
}

describe("labels", () => {
  it("creates only the missing labels, including model:<m>", async () => {
    const { gh, calls } = api();
    const r = await ensureLabels(gh, ["opus", "sonnet"]);
    expect(calls).not.toContain("label epic");
    expect(calls).toContain("label agent-ready");
    expect(calls).toContain("label model:sonnet");
    expect(r.created).toHaveLength(LABELS.length - 2 + 2);
  });
  it("is idempotent", async () => {
    const all = [...LABELS.map((l) => l.name), ...modelLabels(["opus"]).map((l) => l.name)];
    const { gh, calls } = api({ listLabels: async () => all });
    await ensureLabels(gh, ["opus"]);
    expect(calls).toEqual([]);
  });
});

describe("board", () => {
  it("creates, links and sets the five Status options when project is unset", async () => {
    const { gh, calls } = api();
    const r = await ensureProject(gh, { owner: "acme", repo: "acme/widgets", project: null, title: "widgets" });
    expect(r).toEqual({ number: 7, created: true, drift: [] });
    expect(calls).toEqual(["create widgets", "link 7", `options F1 ${STATUS_OPTIONS.join("|")}`]);
  });
  it("reports drift instead of editing an existing project", async () => {
    const { gh, calls } = api();
    const r = await ensureProject(gh, { owner: "acme", repo: "acme/widgets", project: 3, title: "widgets" });
    expect(r.created).toBe(false);
    expect(r.drift).toEqual(["Status options are Todo, Done; expected Backlog, Ready, In Progress, In Review, Done"]);
    expect(calls).toEqual([]);
  });
  it("an existing project with the right options has no drift", async () => {
    const { gh } = api({ projectFields: async () => ({ projectId: "P", status: { id: "F", options: STATUS_OPTIONS.map((n, i) => ({ id: String(i), name: n })) } }) });
    expect((await ensureProject(gh, { owner: "acme", repo: "acme/widgets", project: 3, title: "w" })).drift).toEqual([]);
  });
});

describe("scaffold", () => {
  it("writes config.json, rules.md, settings.json and an empty hooks dir once", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-"));
    const first = scaffoldRepoDir(dir);
    expect(first.written.sort()).toEqual([".foreman/config.json", ".foreman/hooks/", ".foreman/rules.md", ".foreman/settings.json"]);
    expect(JSON.parse(readFileSync(join(dir, ".foreman", "config.json"), "utf8")).setup).toBe("pnpm install");
    expect(existsSync(join(dir, ".foreman", "hooks"))).toBe(true);
    expect(scaffoldRepoDir(dir).written).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test -- src/bootstrap`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add the `gh` methods to `src/github.ts`**

```ts
  /** Scopes of the current token, from `gh auth status`'s "Token scopes:" line. */
  async tokenScopes(): Promise<string[]> {
    const r = await this.exec("gh", ["auth", "status"]);
    const m = /Token scopes: (.*)/.exec(`${r.stdout}\n${r.stderr}`);
    return m ? [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string) : [];
  }

  async listLabels(): Promise<string[]> {
    const out = await this.gh(["label", "list", "--repo", this.cfg.repo, "--limit", "200", "--json", "name", "--jq", ".[].name"]);
    return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }

  createLabel(l: { name: string; color: string; description: string }): Promise<void> {
    return this.write(["label", "create", l.name, "--repo", this.cfg.repo, "--color", l.color, "--description", l.description]);
  }

  async createProject(owner: string, title: string): Promise<number> {
    const out = JSON.parse(await this.gh(["project", "create", "--owner", owner, "--title", title, "--format", "json"])) as { number: number };
    return out.number;
  }

  linkProject(number: number, owner: string): Promise<void> {
    return this.write(["project", "link", String(number), "--owner", owner, "--repo", this.cfg.repo]);
  }

  async projectFields(number: number, owner: string): Promise<{ projectId: string; status: { id: string; options: { id: string; name: string }[] } | null }> {
    const view = JSON.parse(await this.gh(["project", "view", String(number), "--owner", owner, "--format", "json"])) as { id: string };
    const fields = JSON.parse(await this.gh(["project", "field-list", String(number), "--owner", owner, "--format", "json"])) as { fields: { id: string; name: string; options?: { id: string; name: string }[] }[] };
    const status = fields.fields.find((f) => f.name === "Status");
    return { projectId: view.id, status: status?.options ? { id: status.id, options: status.options } : null };
  }

  /** Replaces the single-select options wholesale; only ever called on a project `init` just created. */
  setStatusOptions(fieldId: string, names: string[]): Promise<void> {
    const options = names.map((n) => `{name: "${n}", color: GRAY, description: ""}`).join(", ");
    return this.write(["api", "graphql", "-f", `query=mutation { updateProjectV2Field(input: {fieldId: "${fieldId}", singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`]);
  }

  async fileOnDefaultBranch(path: string): Promise<boolean> {
    const r = await this.exec("gh", ["api", `repos/${this.cfg.repo}/contents/${path}`, "--jq", ".sha"]);
    return r.code === 0;
  }
```

Add each name to the `GitHubApi` pick list and export `type BootstrapApi = Pick<GitHub, "tokenScopes" | "listLabels" | "createLabel" | "createProject" | "linkProject" | "projectFields" | "setStatusOptions" | "fileOnDefaultBranch" | "createIssue" | "addToProject" | "setStatus" | "addLabels">`. In `src/github.test.ts` add one test per method against the existing exec double: the argv `gh` receives is exactly the array above for a fixed input (assert `tokenScopes` parses `Token scopes: 'project', 'repo'` to `["project", "repo"]`; `setStatusOptions("F1", ["A", "B"])` sends a query containing `fieldId: "F1"` and `{name: "A", color: GRAY`).

- [ ] **Step 4: Write `src/bootstrap/labels.ts`, `board.ts`, `scaffold.ts`**

`labels.ts`:

```ts
import type { BootstrapApi } from "../github.ts";

export interface LabelSpec { name: string; color: string; description: string }

export const LABELS: readonly LabelSpec[] = [
  { name: "epic", color: "5319E7", description: "A phase's parent issue" },
  { name: "agent-ready", color: "0E8A16", description: "The foreman may claim it (task) or plan it (epic)" },
  { name: "blocked", color: "B60205", description: "Cannot proceed; the reason is in a comment" },
  { name: "needs-owner", color: "FBCA04", description: "Waiting on the owner" },
  { name: "decision", color: "FBCA04", description: "A question a role session could not answer" },
  { name: "plan-approved", color: "0E8A16", description: "The owner approved the drafted plan" },
  { name: "signed-off", color: "0E8A16", description: "The owner signed the phase off" },
  { name: "foreman:pause", color: "D93F0B", description: "No new claims under this epic" },
  { name: "sandbox", color: "C5DEF5", description: "A throwaway issue for exercising the pipeline" },
  { name: "reviewer:approved", color: "0E8A16", description: "Set by the foreman on a reviewer approval" },
  { name: "reviewer:changes", color: "D93F0B", description: "Set by the foreman on a change request" },
  { name: "validator:passed", color: "0E8A16", description: "Set by the foreman on a validator pass" },
  { name: "validator:failed", color: "D93F0B", description: "Set by the foreman on a validator failure" },
  { name: "validator:skipped", color: "C5DEF5", description: "Validation not required for this issue's labels" },
  { name: "size:S", color: "BFD4F2", description: "Under an hour" },
  { name: "size:M", color: "BFD4F2", description: "A few hours" },
  { name: "size:L", color: "BFD4F2", description: "A day" },
];

export function modelLabels(models: string[]): LabelSpec[] {
  return models.map((m) => ({ name: `model:${m}`, color: "EDEDED", description: `Pin every session on this issue to ${m}` }));
}

export async function ensureLabels(gh: Pick<BootstrapApi, "listLabels" | "createLabel">, models: string[]): Promise<{ created: string[] }> {
  const have = new Set(await gh.listLabels());
  const created: string[] = [];
  for (const l of [...LABELS, ...modelLabels(models)]) {
    if (have.has(l.name)) continue;
    await gh.createLabel(l);
    created.push(l.name);
  }
  return { created };
}
```

`board.ts`:

```ts
import type { BootstrapApi } from "../github.ts";

export const STATUS_OPTIONS = ["Backlog", "Ready", "In Progress", "In Review", "Done"] as const;

type Api = Pick<BootstrapApi, "createProject" | "linkProject" | "projectFields" | "setStatusOptions">;

export async function ensureProject(gh: Api, o: { owner: string; repo: string; project: number | null; title: string }): Promise<{ number: number; created: boolean; drift: string[] }> {
  if (o.project === null) {
    const number = await gh.createProject(o.owner, o.title);
    await gh.linkProject(number, o.owner);
    const fields = await gh.projectFields(number, o.owner);
    if (!fields.status) throw new Error(`project ${number} has no Status field`);
    await gh.setStatusOptions(fields.status.id, [...STATUS_OPTIONS]);
    return { number, created: true, drift: [] };
  }
  const fields = await gh.projectFields(o.project, o.owner);
  const drift: string[] = [];
  if (!fields.status) drift.push("project has no Status single-select field");
  else {
    const names = fields.status.options.map((x) => x.name);
    if (names.join("|") !== STATUS_OPTIONS.join("|"))
      drift.push(`Status options are ${names.join(", ")}; expected ${STATUS_OPTIONS.join(", ")}`);
  }
  return { number: o.project, created: false, drift };
}
```

`scaffold.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRepoConfig, REPO_DIRNAME } from "../repo-config.ts";

const RULES = `<!-- Appended to every role prompt as "House rules". Say how to run, test and start this
repository, which accounts and URLs a validator uses, and any rule a reviewer must check. -->
`;

export function scaffoldRepoDir(repoDir: string): { written: string[] } {
  const dir = join(repoDir, REPO_DIRNAME);
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(dir, rel);
    if (existsSync(p)) return;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    written.push(`${REPO_DIRNAME}/${rel}`);
  };
  put("config.json", `${JSON.stringify(defaultRepoConfig(), null, 2)}\n`);
  put("rules.md", RULES);
  put("settings.json", `${JSON.stringify({ allow: [], deny: [] }, null, 2)}\n`);
  const hooks = join(dir, "hooks");
  if (!existsSync(hooks)) {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, ".gitkeep"), "");
    written.push(`${REPO_DIRNAME}/hooks/`);
  }
  return { written };
}
```

Run: `pnpm test -- src/bootstrap`
Expected: PASS (6 tests).

- [ ] **Step 5: Write `src/bootstrap/init.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { GitHub } from "../github.ts";
import type { Instance } from "../instance.ts";
import { loadRepoConfig } from "../repo-config.ts";
import { ensureProject } from "./board.ts";
import { ensureLabels } from "./labels.ts";
import { scaffoldRepoDir } from "./scaffold.ts";

/** Spec §9, in order: scopes, labels, board, scaffold. Idempotent; a second run reports and changes nothing. */
export async function runInit(instance: Instance, out: (s: string) => void): Promise<number> {
  const raw = JSON.parse(readFileSync(instance.configPath, "utf8")) as Record<string, unknown>;
  const project = typeof raw.project === "number" ? raw.project : null;
  // `project` is optional in ConfigSchema (see below), so this loads before init has run.
  const cfg = loadConfig(instance.configPath);
  const repo = cfg.repo;
  const owner = cfg.owner;
  const repoDir = cfg.repoDir;
  const gh = new GitHub({ repo, owner, project: project ?? undefined }, realExec, false);
  const scopes = await gh.tokenScopes();
  if (!scopes.includes("project")) {
    out("gh token lacks the project scope. Run: gh auth refresh -s project,read:project");
    return 1;
  }
  const repoCfg = loadRepoConfig(repoDir);
  const labels = await ensureLabels(gh, repoCfg.models);
  out(labels.created.length ? `labels created: ${labels.created.join(", ")}` : "labels: all present");
  const board = await ensureProject(gh, { owner, repo, project, title: repo.slice(repo.indexOf("/") + 1) });
  if (board.created) {
    writeFileSync(instance.configPath, `${JSON.stringify({ ...raw, project: board.number }, null, 2)}\n`);
    out(`project ${board.number} created, linked, Status options set; foreman.json updated`);
  } else if (board.drift.length) {
    for (const d of board.drift) out(`project ${board.number}: ${d}`);
    return 1;
  } else out(`project ${board.number}: Status options ok`);
  const scaffold = scaffoldRepoDir(repoDir);
  out(scaffold.written.length ? `scaffolded ${scaffold.written.join(", ")} in ${repoDir}; review and commit them` : ".foreman/: present");
  return 0;
}
```

`ConfigSchema.project` must become `.optional()` for this to load before `init` has run; change it to `z.number().int().positive().optional()` and make `GhConfig.project` accept `number | undefined`, with `toIssue` reading `this.cfg.project` as before (an undefined project means no board item ever matches, which is correct before `init`). `runDaemon` refuses to start when `cfg.project` is undefined: `foreman: project is not set; run foreman -p <name> init`.

- [ ] **Step 6: Write `src/bootstrap/epic.ts`**

```ts
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { GitHub } from "../github.ts";
import type { Instance } from "../instance.ts";
import { loadRepoConfig } from "../repo-config.ts";

/** A tiny glob: `**` any path, `*` within a segment; enough for `docs/**/*.md`. */
export function matchesGlob(glob: string, path: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${re}$`).test(path);
}

export function epicBody(spec: string): string {
  return `## Spec\n${spec}\n`;
}

export async function runEpicNew(instance: Instance, o: { title: string; phase: number; spec: string; agentReady: boolean }, out: (s: string) => void): Promise<number> {
  const cfg = loadConfig(instance.configPath);
  if (cfg.project === undefined) throw new Error(`project is not set; run: foreman -p ${instance.name} init`);
  const repo = loadRepoConfig(cfg.repoDir);
  if (!matchesGlob(repo.plans.specGlob, o.spec)) throw new Error(`${o.spec} does not match plans.specGlob (${repo.plans.specGlob})`);
  const gh = new GitHub({ repo: cfg.repo, owner: cfg.owner, project: cfg.project }, realExec, false);
  if (!(await gh.fileOnDefaultBranch(o.spec))) throw new Error(`${o.spec} is not on the default branch of ${cfg.repo}`);
  const phaseLabel = `phase:${o.phase}`;
  if (!(await gh.listLabels()).includes(phaseLabel))
    await gh.createLabel({ name: phaseLabel, color: "1D76DB", description: `Phase ${o.phase}` });
  const labels = ["epic", phaseLabel, ...(o.agentReady ? ["agent-ready"] : [])];
  const number = await gh.createIssue({ title: o.title, body: epicBody(o.spec), labels });
  const itemId = await gh.addToProject(number);
  await gh.setStatus(itemId, "Backlog");
  out(`https://github.com/${cfg.repo}/issues/${number}${o.agentReady ? "  (agent-ready: the planner picks it up next tick)" : ""}`);
  return 0;
}
```

Add to `src/bootstrap/bootstrap.test.ts`:

```ts
describe("epic new", () => {
  it("matchesGlob handles docs/**/*.md", async () => {
    const { matchesGlob } = await import("./epic.ts");
    expect(matchesGlob("docs/**/*.md", "docs/specs/a.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "docs/a.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "src/a.md")).toBe(false);
    expect(matchesGlob("docs/**/*.md", "docs/a.txt")).toBe(false);
  });
  it("epicBody carries the Spec section parseSpecPath reads", async () => {
    const { epicBody } = await import("./epic.ts");
    const { parseSpecPath } = await import("../phase.ts");
    expect(parseSpecPath(epicBody("docs/specs/a.md"))).toBe("docs/specs/a.md");
  });
});
```

- [ ] **Step 7: Lint, typecheck, test; manual check against a throwaway repository**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm link --global
gh repo create apptreesoftware/foreman-sandbox --private
git clone git@github.com:apptreesoftware/foreman-sandbox.git /tmp/foreman-sandbox
mkdir -p /tmp/foreman-sandbox/docs && printf '# Sandbox\n\nOne paragraph.\n' > /tmp/foreman-sandbox/docs/sandbox.md
git -C /tmp/foreman-sandbox add -A && git -C /tmp/foreman-sandbox commit -qm "docs: sandbox spec" && git -C /tmp/foreman-sandbox push -q
foreman add sandbox --repo apptreesoftware/foreman-sandbox --repo-dir /tmp/foreman-sandbox
foreman -p sandbox init
foreman -p sandbox init
foreman -p sandbox epic new --title "Phase 1: sandbox" --phase 1 --spec docs/sandbox.md
gh issue view 1 --repo apptreesoftware/foreman-sandbox --json labels,projectItems --jq '{labels: [.labels[].name], status: .projectItems[0].status.name}'
```

Expected: first `init` prints labels created, project created, scaffolded; second prints `all present`, `Status options ok`, `.foreman/: present`; the issue shows labels `epic, phase:1` and status `Backlog`. Leave the sandbox repository in place for Task 8's release check.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: foreman init creates labels and the board; foreman epic new creates the phase epic

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: README, release workflow, `0.1.0`

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (rewrite), `package.json` (`publishConfig`)

**Interfaces:**
- Produces: `@apptreesoftware/foreman@0.1.0` on npm; `README.md` that a stranger can follow from `npm i -g` to a merged sandbox task; a tag-driven release path for every later version.

- [ ] **Step 1: Rewrite `README.md`**

Structure (each section is prose plus commands; carry over from today's README the paragraphs that still hold, with `~/.tone_tonic` → `~/.foreman/<name>`, `pnpm --filter @tone/foreman ctl x` → `foreman -p <name> x`, and every tone_tonic-specific sentence dropped):

1. **What it is**: one paragraph from today's intro, generic.
2. **Install**: `brew install gh node@22`, `npm i -g @apptreesoftware/foreman`, `gh auth login && gh auth refresh -s project,read:project`, `claude` once interactively (`claude auth status` must say `claude.ai`).
3. **Set up a repository**: `foreman add`, `foreman init`, what `init` creates, commit `.foreman/`, `foreman epic new --agent-ready`, `foreman run --once --dry-run`, `foreman start`, `foreman launchd install`.
4. **The process**: today's §1 numbered loop (preflight, resume, merge sweep, CI rerun, pick, claim, dispatch, outcome, phase check), minus the adopt item; the outcome → labels table; the label list; the Status list; the issue-body sections; the ledger comment grammar.
5. **`.foreman/`**: `config.json` keys and defaults (spec §5.1), `rules.md`, `roles/<role>.md`, `settings.json`, hooks (spec §6 table, env vars, contracts) with a worked example hook for each of the four.
6. **Instances**: layout, resolution order, `foreman list`, several daemons on one Mac, unique `webPort`.
7. **Kill switches and control**: today's §5 with the new command names; notifications (today's "Push notifications").
8. **Budget**: today's §6.
9. **Resume and multi-Mac**: today's §7.
10. **Troubleshooting**: today's §8 minus the Supabase, Playwright and Slack items, plus: `foreman hooks run preflight` to debug a hook; `preflight failed: gh token lacks the project scope`.
11. **Release check** (spec §11 manual): the sandbox sequence from Task 7 step 7 followed by `foreman -p sandbox start`, `plan-approved` by hand, one task through build → review → validate → merge.
12. **Developing**: clone, `pnpm install`, `pnpm link --global`, `pnpm dev -- help`, tests, how to release (step 3 below).

- [ ] **Step 2: Add `publishConfig` and write `.github/workflows/release.yml`**

`package.json`: `"publishConfig": { "access": "public", "provenance": true }`.

`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: https://registry.npmjs.org }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm typecheck && pnpm test && pnpm build
      - run: |
          test "v$(node -p 'require("./package.json").version')" = "${GITHUB_REF_NAME}" || { echo "tag ${GITHUB_REF_NAME} does not match package.json version"; exit 1; }
      - run: npm publish
```

No `NODE_AUTH_TOKEN`: with a trusted publisher configured on npmjs.com, `npm publish` (npm 11.5+, which `setup-node` with Node 22 provides) authenticates through the job's OIDC token.

- [ ] **Step 3: Publish `0.1.0` by hand, then configure trusted publishing**

Trusted publishing is configured per package on npmjs.com, and the package has to exist first, so the first publish is manual from this Mac (already logged in as `matthewtsmith`, owner of `apptreesoftware`):

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
npm publish --access public
npm view @apptreesoftware/foreman version
```

Expected: `0.1.0`. Then on <https://www.npmjs.com/package/@apptreesoftware/foreman/access> → **Trusted publishing** → add GitHub Actions publisher: organization `apptreesoftware`, repository `foreman`, workflow `release.yml`, environment blank. Record that in README §12.

- [ ] **Step 4: Release check against the sandbox**

On this Mac, with the sandbox instance from Task 7:

```bash
npm i -g @apptreesoftware/foreman@0.1.0
foreman -p sandbox status
foreman -p sandbox epic new --title "Phase 1: sandbox" --phase 1 --spec docs/sandbox.md --agent-ready
foreman -p sandbox run --once
```

Expected: the tick claims the epic for the planner (`claimed by <host> … role=planner`), the session drafts a plan PR against `foreman-sandbox`, and the epic ends `needs-owner` / In Review. Then merge the plan PR, `gh issue edit 1 --repo apptreesoftware/foreman-sandbox --add-label plan-approved`, `foreman -p sandbox run --once` twice (apply plan, then claim the first task), and let `foreman -p sandbox start` finish build → review → validate → merge on that task. Spec §13 item 2 (two daemons on one Mac at once) is exercised by the migration plan, when `tone_tonic` and `sandbox` both run; it needs a second repository this plan does not have. Record the outcome (issue numbers, cost from `sessions.log`) as the release note on the `v0.1.0` GitHub release:

```bash
git tag v0.1.0 && git push --tags
gh release create v0.1.0 --title "0.1.0" --notes "First standalone release. Sandbox run: <summary>"
```

The tag push runs `release.yml`; because `0.1.0` is already on npm the `npm publish` step fails with `403 … cannot publish over previously published version` and that is expected for this one release. Delete the failed run or ignore it; `0.1.1` onward publishes from the tag.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README for the standalone foreman; tag-driven npm release

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

---

## After this plan

Write `docs/superpowers/plans/<date>-foreman-migration.md` in tone_tonic from spec §12 once `0.1.0` is published: delete `tools/foreman`, `.claude/roles`, `.claude/headless-settings.json`; add `.foreman/` (config, rules, `roles/validator.md`, `roles/reviewer.md`, settings extras, four hooks); move `serve.ts`/`dev-env.ts` to `tools/serve`; re-home `main-run-redundant.test.ts`; update `CLAUDE.md`, `AGENTS.md`, `docs/ops/runbook.md`; `foreman add tone_tonic`, copy the logs, swap the launchd agent. That PR runs a `sandbox` task through the published package before it merges (spec §13 item 7).
