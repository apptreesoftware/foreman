# Web Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-screen status page with a Dashboard plus four tabs (Needs you, Waiting on, Board, Session), per-instance color themes and a modern card layout, backed by the data the new tabs need.

**Architecture:** Server first: every new fact the page shows is computed in TypeScript from the snapshot the tick already has or from local logs, stored on `Board` / `StatusReport` (or served by one new `GET /api/sessions`), and unit-tested. Then `src/web.html` is rewritten tab by tab as one vanilla HTML/CSS/JS file with hash routing, rendering those fields.

**Tech Stack:** TypeScript (ESM, Node), zod, vitest, Biome; vanilla HTML/CSS/JS with container queries; Google Fonts (Inter, JetBrains Mono).

**Spec:** `docs/superpowers/specs/2026-10-26-web-redesign-design.md`. Mockups (visual reference only, local to the owner's Mac mini): `/Users/matthewsmith/claude-out/foreman-redesign/.superpowers/brainstorm/85817-1793061231/content/` — `dashboard-v4.html`, `colors-v1.html`, `sidebar-v1.html` (option A), `session-tab-v1.html`, `needs-you-v2.html`, `needs-waiting-v1.html` (Waiting on half), `board-v1.html`. Where spec and mockup disagree, the spec wins.

## Global Constraints

- One file, `src/web.html`, inline CSS and vanilla JS; no framework, bundler or build step. `pnpm build` keeps copying it to `dist/`.
- Fonts: Inter for text, JetBrains Mono for code-like values, from Google Fonts, with system fallbacks.
- Tabs selected by `location.hash`: `#dashboard`, `#needs-you`, `#waiting`, `#board`, `#session`; default `#dashboard`.
- One `/api/status` poll every 3 s. `/api/sessions` is fetched only while the Session tab is open.
- Every new `StatusReport` / `Board` / `ForemanState` / `SessionLogEntry` field is optional or defaulted, so existing tests and older `state.json` / `sessions.log` files keep working.
- Nothing repository-specific in `src/`: `grep -rniE "pnpm|supabase|docker|playwright" src roles settings` must still return only `src/repo-config.ts`. No project names in sample text.
- `foreman.json` is never served or written by the page. Page-set preferences go to `state.json` through `store.patch`.
- No new GitHub reads. `gh` stays the only GitHub client; every write keeps going through `GitHub` and keeps its server-side allowlist.
- Every write button keeps today's `window.confirm` text (Stop/Abort keep the armed two-click confirm).
- Every value interpolated into HTML goes through `esc()`.
- Contrast: every solid button ≥ 4.5:1 text contrast. Sign off green `#287A3A`; light teal primary `#0B7285`.
- Style: ESM, `.ts` import extensions, double quotes, semicolons, 100-column Biome, `noUncheckedIndexedAccess`; tests next to code as `*.test.ts`; commit messages `type(scope): summary`.
- Before every commit: `pnpm lint && pnpm typecheck && pnpm test` green.

## Review Focus

- **No state, no log, no board** (a fresh instance, or a daemon that has never ticked): every tab renders an empty state instead of throwing; `/api/sessions` returns zeros. Pinned by tests in Tasks 6 and 7.
- **An older `state.json`** written before this change (no `theme`, `issues`, `groups`, owner `since`/`review`): `readState` still parses it and the page still renders. Pinned in Tasks 2, 4 and 6.
- **A bad custom date range** (`from` after `to`, `2026-13-01`, `../etc`): `/api/sessions` answers 400, never 500 and never a partial result. Pinned in Task 7.
- **An issue title containing HTML** (`<img src=x onerror=…>`): shown as text on every tab. Pinned by the `esc(` checks in Tasks 8–11 and the dogfood step in Task 12.
- **The 3 s re-render while the owner is mid-action**: an open Board picker, an expanded Session row, a pinned feed or a scrolled tab must survive a poll. Pinned by the state-set checks in Tasks 10 and 11 and the dogfood step in Task 12.

---

### Task 1: Record the issue title in `sessions.log`

**Files:**
- Modify: `src/sessions.ts` (`SessionLogEntry`, `readSessions`)
- Modify: `src/loop.ts:533-543` and `src/loop.ts:574-584` (the two `appendSession` calls)
- Test: `src/sessions.test.ts`, `src/loop.test.ts`

**Interfaces:**
- Produces: `SessionLogEntry.title?: string` — the issue's (or, for a planner/phase-closer, the epic's) title when the session ran. Absent on older lines.

- [ ] **Step 1: Write the failing tests**

In `src/sessions.test.ts`:
```ts
it("reads a title when present and leaves it undefined on older lines", () => {
  // write two lines: one with "title":"feat: a grid", one without
  const [withTitle, without] = readSessions(dir);
  expect(withTitle?.title).toBe("feat: a grid");
  expect(without?.title).toBeUndefined();
});
```
In `src/loop.test.ts`, extend "sessions.log records the model, turns, duration, denials and subtype" (or add a sibling test) so the issue is `issue({ number: 1, title: "feat: a grid" })` and the parsed line `toMatchObject({ title: "feat: a grid" })`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test -- src/sessions.test.ts src/loop.test.ts`
Expected: FAIL — `title` undefined.

- [ ] **Step 3: Implement**

Add `title?: string` to `SessionLogEntry` with a doc comment ("the issue title at the time; absent on lines written before titles were recorded"). In `readSessions`, set `title` only when `typeof j.title === "string"`. In both `appendSession` calls in `src/loop.ts`, add `title: r.issue.title`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/sessions.test.ts src/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts src/loop.ts src/loop.test.ts
git commit -m "feat(sessions): record the issue title on each sessions.log line"
```

---

### Task 2: `Board.issues` and `Board.groups` for the Board tab

**Files:**
- Create: `src/board-issues.ts`, `src/board-issues.test.ts`
- Modify: `src/state-file.ts` (new schemas; `BoardSchema` fields)
- Modify: `src/board.ts` (`describeBoard` fills them)
- Modify: `src/status.ts` (`describeStatus` carries them into the merged board)
- Test: `src/board.test.ts`, `src/status.test.ts`, `src/state-file.test.ts`

**Interfaces:**
- Consumes: `taskNumbersOf(e: Epic, issues: Issue[]): Set<number>` (`src/phase-progress.ts`), `parseDependsOn(body)`, `phaseOf(labels)` (`src/github.ts`), `MODEL_LABEL_PREFIX`, `EFFORT_LABEL_PREFIX`.
- Produces (in `src/state-file.ts`):
  ```ts
  export const BoardIssueSchema = z.object({
    issue: z.number().int(),
    title: z.string(),
    status: z.string().nullable(),            // null = not on the project board ("Off board")
    labels: z.array(z.string()),              // display subset: "blocked", "size:*", "area:*"
    group: z.string(),                        // BoardGroup.key this issue is listed under
    pr: z.number().int().nullable(),          // open non-draft PR whose `issue` is this one
    dependsOn: z.array(z.number().int()),
    openDependsOn: z.array(z.number().int()), // the subset still open in the snapshot
    blocked: z.boolean(),
    model: z.string().nullable(),             // `model:<name>` label value
    effort: z.string().nullable(),            // `effort:<level>` label value
  });
  export const BoardGroupSchema = z.object({
    key: z.string(),                          // "epic:<n>" | "phase:<n>:unlinked" | "phase:<n>:closed" | "none"
    kind: z.enum(["epic", "unlinked", "closed", "none"]),
    epic: z.number().int().nullable(),
    phase: z.number().nullable(),
    title: z.string(),
    state: z.enum(["planning", "plan_waiting", "building", "signoff_waiting", "not_started"]).nullable(),
    paused: z.boolean(),
    doneTasks: z.array(z.number().int()),     // closed task numbers (taskNumbersOf minus open ones)
  });
  // BoardSchema gains:
  issues: z.array(BoardIssueSchema).default([]),
  groups: z.array(BoardGroupSchema).default([]),
  ```
  and `export function describeBoardIssues(s: Snapshot): { issues: BoardIssue[]; groups: BoardGroup[] }` in `src/board-issues.ts`.

Rules (from the spec, "Data and API changes" 4 and "Board"):
- `issues`: every open non-epic issue in `s.issues`, on the board or not.
- Grouping, first match wins: (1) the open epic whose `taskNumbersOf` set has the issue → `epic:<n>`; (2) else the one open epic whose `phase` equals the issue's `phase:<N>` label, when exactly one exists → `epic:<n>`; (3) several open epics share that phase → `phase:<N>:unlinked`, title `Phase <N> · not linked to an epic`; (4) no open epic has that phase → `phase:<N>:closed`, title `Phase <N> · epic closed`; (5) else `none`, title `No phase`.
- Every open epic gets a group, even with no open issues. Epic title from its issue.
- `state` from epic labels: `needs-owner` + `plan-approved` → `signoff_waiting`; `needs-owner` alone → `plan_waiting`; `plan-approved` → `building`; `agent-ready` → `planning`; else `not_started`. `paused` = `foreman:pause`. Non-epic groups: `state` null, `paused` false.
- Group order: epic groups by `phase` then epic number; then `unlinked` and `closed` groups by phase; `none` last. Issues ordered by number within a group.

- [ ] **Step 1: Write the failing tests** in `src/board-issues.test.ts` (use `issue`, `epic`, `snapshot`, `pr` from `test/helpers.ts`):
  - `"lists open non-epic issues, off-board ones with status null"` — an issue with `status: null` appears with `status: null`.
  - `"groups by taskNumbersOf, including a Parent epic line"` — epic 10 with `taskNumbers: []`, issue body `Parent epic: #10` → `group: "epic:10"`.
  - `"falls back to the single open epic with the issue's phase label"` — one open epic `phase:7`, issue labelled `phase:7` with no parent → `epic:<that epic>`.
  - `"puts a shared-phase issue in an unlinked group"` — two open epics with `phase: 10`, issue `phase:10` unlinked → group `phase:10:unlinked`, title `"Phase 10 · not linked to an epic"`.
  - `"puts an issue whose phase has no open epic in a closed group"` → `phase:4:closed`, `"Phase 4 · epic closed"`.
  - `"puts an issue with neither in No phase"` → `none`, `"No phase"`.
  - `"gives every open epic a group with its state, even with no issues"` — labels → each of the five `state` values and `paused: true` for `foreman:pause`.
  - `"fills pr, dependsOn, openDependsOn, blocked, model, effort and the display labels"` — PR `pr({ number: 276, issue: 268 })`; body `## Depends on\n- #269\n- #250` with 269 open, 250 absent → `openDependsOn: [269]`; labels `["blocked","size:L","area:web","agent-ready","model:sonnet","effort:xhigh","phase:7"]` → `labels: ["blocked","size:L","area:web"]`, `model: "sonnet"`, `effort: "xhigh"`.
  - `"lists closed task numbers as doneTasks"` — epic `taskNumbers: [1,2,3]`, only 3 open → `doneTasks: [1,2]`.

  In `src/board.test.ts`: `describeBoard` output has `issues` and `groups` equal to `describeBoardIssues(s)`. In `src/status.test.ts`: a stored board with `issues`/`groups` comes back on `report.board`. In `src/state-file.test.ts`: a `state.json` board without `issues`/`groups` parses with both `[]`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- src/board-issues.test.ts src/board.test.ts src/status.test.ts src/state-file.test.ts`
Expected: FAIL — module / fields missing.

- [ ] **Step 3: Implement** the schemas, `describeBoardIssues`, the two fields in `describeBoard`, and `issues: stored?.issues ?? [], groups: stored?.groups ?? []` in the merged board in `describeStatus`. Fix any test fixture that builds a full `Board` literal by adding `issues: [], groups: []`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/board-issues.ts src/board-issues.test.ts src/state-file.ts src/board.ts src/status.ts src/*.test.ts
git commit -m "feat(board): every open issue grouped under its phase epic"
```

---

### Task 3: Board issues are the model/effort picker allowlist

**Files:**
- Modify: `src/task-model.ts` (`phaseTasks` → `pickerTasks`, `applyTaskModelToBoard`), `src/task-effort.ts` (`applyTaskEffortToBoard`), `src/web.ts` (`WebDeps`), `src/cli/daemon.ts`
- Test: `src/task-model.test.ts`, `src/task-effort.test.ts`, `src/web.test.ts`

**Interfaces:**
- Consumes: `Board.issues` (Task 2).
- Produces: `export function pickerTasks(board: Board | null): { issue: number; model: string | null; effort: string | null }[]` in `src/task-model.ts` — `board.issues` when non-empty, else today's open phase tasks (an older board before its first new tick). `WebDeps.phaseTasks` is renamed `WebDeps.pickerTasks` with that return type.

- [ ] **Step 1: Write the failing tests**
  - `src/task-model.test.ts`: `"pickerTasks lists every board issue, off-board included"`; `"pickerTasks falls back to open phase tasks when issues is empty"`; `"applyTaskModelToBoard updates board.issues too"`.
  - `src/task-effort.test.ts`: `"applyTaskEffortToBoard updates board.issues too"`.
  - `src/web.test.ts`: `/api/task-model` and `/api/task-effort` accept an issue present only in `pickerTasks()` (an off-board issue) and still answer 400 `"#999 is not a task on the board"` for one that is absent.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- src/task-model.test.ts src/task-effort.test.ts src/web.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `pickerTasks`; map `issues` in both `apply…ToBoard` functions; rename the dep in `src/web.ts` and its two allowlist checks; in `src/cli/daemon.ts` use `pickerTasks(store.get().board)` for the allowlist and for `current` in `setTaskModel` / `setTaskEffort`.

- [ ] **Step 4: Run to verify pass** — `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task-model.ts src/task-effort.ts src/web.ts src/cli/daemon.ts src/*.test.ts
git commit -m "feat(web): model and effort pickers for every issue on the board"
```

---

### Task 4: Owner wait time and phase-review pairing

**Files:**
- Create: `src/review-pairing.ts`, `src/review-pairing.test.ts`
- Modify: `src/state-file.ts` (`OwnerItemSchema`, `NeedsYouItemSchema`), `src/owner.ts` (`ownerItems`), `src/needs-you.ts` (`needsYouItems`)
- Test: `src/owner.test.ts`, `src/needs-you.test.ts`, `src/state-file.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // OwnerItemSchema gains
  since: z.string().nullable().default(null),     // the epic issue's updatedAt
  review: z.number().int().nullable().default(null), // paired phase review issue, sign_off epics only
  // NeedsYouItemSchema gains
  reviewOf: z.number().int().nullable().default(null), // epic this review issue is paired with
  phaseReview: z.boolean().default(false),         // title matches /^Phase .+ review:/
  ```
  `export function pairReviews(s: Snapshot): Map<number, number>` in `src/review-pairing.ts` — review issue number → open epic number.

Pairing rule (spec, Needs you): (1) an open epic's own comment matching `/^Phase review: #(\d+)/m` pairs that issue; (2) otherwise, a needs-owner issue whose title matches `/^Phase .+ review: (.+)$/` pairs with the open epic whose title, with a leading `/^Phase [^:]+:\s*/` removed, appears in the review's title. Never by `phase:<N>` alone. Comment wins over title.

- [ ] **Step 1: Write the failing tests** in `src/review-pairing.test.ts`:
  - `"pairs by the epic's Phase review comment"` — epic 514 comment `Phase review: #571` → `get(571) === 514`.
  - `"pairs by title with the epic's Phase prefix removed"` — epic `Phase 10b: Services, tuition and enrollment`, review `Phase 10b review: Services, tuition and enrollment` → paired.
  - `"pairs a review whose title repeats the epic's full title"` — epic `Phase 10c: Platform subscriptions`, review `Phase 10c review: Phase 10c: Platform subscriptions` → paired.
  - `"does not pair two epics that share a phase number by label"` — epics 10a/10b both `phase:10`, review titled for 10b → paired only with 10b.
  - `"leaves a review unpaired when no open epic matches"`.

  In `src/owner.test.ts`: `ownerItems` sets `since` to the epic issue's `updatedAt` and `review` on a sign_off epic. In `src/needs-you.test.ts`: `reviewOf` set for a paired review, `phaseReview: true` with `reviewOf: null` for an unpaired one. In `src/state-file.test.ts`: an older board's owner/needsYou rows parse with the defaults.

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/review-pairing.test.ts src/owner.test.ts src/needs-you.test.ts src/state-file.test.ts` → FAIL.

- [ ] **Step 3: Implement** `pairReviews`; call it from `ownerItems` and `needsYouItems`.

- [ ] **Step 4: Run to verify pass** — `pnpm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-pairing.ts src/review-pairing.test.ts src/state-file.ts src/owner.ts src/needs-you.ts src/*.test.ts
git commit -m "feat(needs-you): owner wait time and phase review pairing"
```

---

### Task 5: Attention: badge counts, banners and Waiting on rows

**Files:**
- Create: `src/attention.ts`, `src/attention.test.ts`
- Modify: `src/status.ts` (`StatusReport.attention`)
- Test: `src/status.test.ts`

**Interfaces:**
- Consumes: `Board` with `owner`, `needsYou` (Task 4 fields), `waiting`.
- Produces:
  ```ts
  export const BANNER_KINDS = ["stop", "preflight", "cap", "paused"] as const;
  export interface Attention {
    needsYou: number;      // Needs you badge
    waiting: number;       // Waiting on badge (= waitRows.length)
    banners: WaitItem[];   // BANNER_KINDS items, in WAIT_KINDS order
    waitRows: WaitItem[];  // what the Waiting on tab lists
  }
  export function describeAttention(board: Board | null): Attention;
  // StatusReport gains: attention: Attention
  ```

Rules (spec, Shell badges and Waiting on):
- `needsYou` = owner items offering `approve_plan` or `sign_off` + `needsYou` items with `reviewOf === null`. `start_planning` not counted.
- `waitRows` = every waiting item except banner kinds, except a `human` item whose subject (`#N` or `epic #N`) names an issue or epic that is a Needs you row (any owner item with `approve_plan`, `sign_off` or `start_planning`, or any `needsYou` issue), with `dependency` items for the same subject merged into one: detail `#270 waits on #268 and #269` (three or more: `#a, #b and #c`), `since` the earliest non-null.

- [ ] **Step 1: Write the failing tests** in `src/attention.test.ts`:
  - `"counts approve and sign-off epics and unpaired needs-you issues, not start_planning"` — owner items: one `["approve_plan","pause"]`, one `["sign_off","pause"]`, one `["start_planning","pause"]`, one `["pause"]`; needsYou: three items, one with `reviewOf: 514` → `needsYou: 4`.
  - `"moves stop, preflight, cap and paused into banners"`.
  - `"drops human waits whose subject is on Needs you and keeps the rest"` — `epic #93 awaits owner sign-off` dropped; `#41 is agent-ready but Status Backlog` kept.
  - `"merges dependency rows for one issue"` — two items for `#270` → one with detail `"#270 waits on #268 and #269"`.
  - `"is all zeros and empty for a null board"`.

  In `src/status.test.ts`: `describeStatus` returns `attention` computed from the merged board (live `stop` wait appears in `banners`).

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/attention.test.ts src/status.test.ts` → FAIL.
- [ ] **Step 3: Implement** `describeAttention`; set `attention: describeAttention(board)` in `describeStatus`.
- [ ] **Step 4: Run to verify pass** — `pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/attention.ts src/attention.test.ts src/status.ts src/status.test.ts
git commit -m "feat(status): badge counts, banners and de-duplicated waiting rows"
```

---

### Task 6: Per-instance theme and instance name

**Files:**
- Create: `src/theme.ts`, `src/theme.test.ts`
- Modify: `src/state-file.ts` (`ForemanStateSchema.theme`, `initialState`), `src/status.ts` (`StatusInput.instance`, `StatusReport.instance`, `StatusReport.theme`), `src/web.ts` (`POST /api/theme`, `WebDeps.setTheme`), `src/cli/daemon.ts`
- Test: `src/state-file.test.ts`, `src/status.test.ts`, `src/web.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const THEMES = ["indigo", "violet", "teal", "mono"] as const;
  export const ThemeSchema = z.enum(THEMES);
  export type ThemeName = z.infer<typeof ThemeSchema>;
  export function nameHash(name: string): number;          // stable 32-bit (FNV-1a)
  export function pickTheme(name: string, taken: readonly ThemeName[]): ThemeName;
  // ForemanStateSchema gains: theme: ThemeSchema.nullable().default(null)
  // initialState(o) accepts theme?: ThemeName | null
  // StatusInput gains: instance?: string   (default "")
  // StatusReport gains: instance: string; theme: { current: ThemeName; choices: readonly ThemeName[] }
  // WebDeps gains: setTheme: (theme: ThemeName) => Promise<string>
  ```
- `pickTheme`: the themes used least often in `taken`; among those, `candidates[nameHash(name) % candidates.length]`.
- `StatusReport.theme.current` = `state.theme ?? pickTheme(instance, [])` (a daemon that has never run still gets a stable color).
- Daemon start: `theme: previous?.theme ?? pickTheme(instance.name, others)`, where `others` are the non-null `readState(i.dir)?.theme` of every other entry in `listInstances()`. Saved immediately (it is part of `initialState`), so it never shifts on its own.
- `POST /api/theme` body `{ theme: ThemeName }`; anything else → 400 `"bad theme"`; non-POST → 405. Handler: `store.patch({ theme })`, returns `"theme is now <name>"`. (The spec's `"default"` value is dropped: a theme is always saved, so there is no override to clear.)

- [ ] **Step 1: Write the failing tests**
  - `src/theme.test.ts`: `"pickTheme is stable for a name"`; `"pickTheme takes the only unused theme"` (`taken = ["indigo","violet","teal"]` → `"mono"`); `"four instances in turn get four different themes"` (fold `pickTheme` over four names, accumulating `taken`); `"a fifth instance repeats one"`.
  - `src/state-file.test.ts`: older state parses with `theme: null`; `initialState({ …, theme: "teal" }).theme === "teal"`.
  - `src/status.test.ts`: `instance` echoed; `theme.current` from state; with `state: null`, `theme.current === pickTheme(instance, [])`.
  - `src/web.test.ts`: `POST /api/theme {"theme":"violet"}` → 200 and `setTheme` called with `"violet"`; `{"theme":"pink"}` → 400; `GET` → 405.

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/theme.test.ts src/state-file.test.ts src/status.test.ts src/web.test.ts` → FAIL.
- [ ] **Step 3: Implement** the above; pass `instance: instance.name` into `describeStatus` in the daemon.
- [ ] **Step 4: Run to verify pass** — `pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/theme.ts src/theme.test.ts src/state-file.ts src/status.ts src/web.ts src/cli/daemon.ts src/*.test.ts
git commit -m "feat(web): per-instance color theme, distinct by default"
```

---

### Task 7: Session history endpoint

**Files:**
- Create: `src/session-history.ts`, `src/session-history.test.ts`
- Modify: `src/web.ts` (`GET /api/sessions`, `WebDeps.sessions`), `src/cli/daemon.ts`
- Test: `src/web.test.ts`

**Interfaces:**
- Consumes: `SessionLogEntry.title` (Task 1), `Board.issues` (Task 2), `localDate` (`src/preflight.ts`).
- Produces:
  ```ts
  export interface SessionRange { from: string | null; to: string | null } // YYYY-MM-DD, local, inclusive
  export interface SessionHistory {
    from: string | null; to: string | null;
    totals: { spendUsd: number; sessions: number; issues: number };
    daily: { date: string; spendUsd: number; sessions: number }[];
    byRole: { role: string; spendUsd: number; sessions: number }[];
    byIssue: {
      issue: number; title: string; roles: string[]; sessions: number;
      lastAt: string; costUsd: number; entries: SessionLogEntry[];
    }[];
  }
  export function describeSessionHistory(
    entries: SessionLogEntry[], range: SessionRange, openTitles: ReadonlyMap<number, string>,
  ): SessionHistory;
  export function boardTitles(board: Board | null): Map<number, string>; // issues, owner, needsYou, pipeline
  export function parseRange(from: string | null, to: string | null): SessionRange | null; // null = invalid
  // WebDeps gains: sessions: (range: SessionRange) => SessionHistory
  ```

Rules (spec, Session and Data 8):
- Filter by `localDate(new Date(e.t))` within `[from, to]`; a null bound is open.
- Count per log line, cost summed per line (same as `todayStats`).
- `daily`: one row per local date from `from ?? first entry's date` to `to ?? last entry's date`, zero rows filled; `[]` when no entries in range.
- `byRole` sorted by `spendUsd` desc; `byIssue` sorted by `costUsd` desc, `entries` newest first, `roles` in first-seen order.
- Title: the newest entry in the whole log (not only the range) for that issue with a `title`; else `openTitles`; else `#N`.
- `parseRange`: each present bound must match `/^\d{4}-\d{2}-\d{2}$/` and be a real date; `from <= to`; otherwise `null`.
- Route: `GET /api/sessions?from=&to=` → `parseRange` null → 400 `"bad range"`; else 200 with `d.sessions(range)`. Same auth/host check as every route.
- Daemon: `sessions: (range) => describeSessionHistory(readSessions(STATE_DIR), range, boardTitles(store.get().board))`.

- [ ] **Step 1: Write the failing tests** in `src/session-history.test.ts`:
  - `"totals, daily, byRole and byIssue for the whole log"` (three entries over two days, two roles, two issues; assert exact numbers).
  - `"fills zero days between the first and last entry"`.
  - `"filters by an inclusive local-date range"`.
  - `"takes a title from the newest titled line, then open titles, then #N"`.
  - `"is zeros and empty arrays for no entries"`.
  - `"parseRange rejects a malformed date, a non-date and from after to"` (`"2026-13-01"`, `"../etc"`, `from: "2026-10-27", to: "2026-10-01"` → `null`).

  In `src/web.test.ts`: `GET /api/sessions` → 200 with `sessions` called with `{ from: null, to: null }`; `?from=2026-10-01&to=2026-10-26` passes the range through; `?from=nope` → 400.

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/session-history.test.ts src/web.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module, the route and the daemon dep.
- [ ] **Step 4: Run to verify pass** — `pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/session-history.ts src/session-history.test.ts src/web.ts src/cli/daemon.ts src/web.test.ts
git commit -m "feat(web): session cost history endpoint"
```

---

### Task 8: Page shell, themes and the Dashboard

**Files:**
- Modify (rewrite): `src/web.html`
- Test: `src/web.test.ts` (the `describe("web.html", …)` block)

**Interfaces:**
- Consumes: `StatusReport` fields `instance`, `theme`, `attention`, `current`, `board.pipeline`, `nowPhase`, `tick`, `stopPresent`, `orphan`, `unfinished`, `stopping`, `daemon`, `uptimeMinutes`, `pid`, `lastPlan`; `POST /api/theme`; existing `/api/go|stop|abort|refresh|next|feed`.
- Produces (for Tasks 9–11, in the page script): `const $ = …`, `const esc = …`, `function route()` reading `location.hash`, `function toast(message, isError)`, one `<section data-tab="…">` per tab, `let feedSession`, `let feedPinned`, a `function pinFeed(sessionId)` that switches to `#dashboard` and pins the Feed, and a `function renderAll(r)` that each later task extends with its tab's renderer.

Spec sections to implement: Shell (layout, sidebar header option A, nav with icons, badges from `r.attention`, footer with pid and theme swatches, toast, narrow layout via container queries at about 760 px and 460 px), Themes (token table; light sets; `prefers-color-scheme`; status colors; mono active-stage `#5B8DEF`; pale accent never a button fill), Dashboard (header row and button groups, banners from `r.attention.banners` plus stalled / orphan / unfinished / stopping / UNKNOWN, Compute next card, Now card, Pipeline cards with the five-dot track in a fixed-width column and fixed-width tag column, Feed compact rows with "Back to live" when pinned).

- [ ] **Step 1: Rewrite the failing `web.html` tests.** Replace the existing string checks with:
  - each tab: `expect(html).toContain('data-tab="dashboard"')` … for all five, and `location.hash`.
  - themes: contains `data-theme="indigo"` handling and each value `#4263EB`, `#6E56CF`, `#22B8CF`, `#EDEDEF`, `#3B5BDB`, `#0B7285`, `#5B8DEF`; `prefers-color-scheme`; `@container`.
  - `fetch("/api/theme"`, `fetch("/api/next")`, `fetch("/api/refresh"`, `/api/feed?session=`, `const esc =`, `r.attention`, `Back to live`, `no state.json: restart the daemon`, `run ctl abort`, `Confirm ${cmd}?`.
  - gone: `expect(html).not.toContain('id="tick"')`, same for `id="recent"`, `id="phases"`, `id="owner"`.
- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/web.test.ts` → FAIL.
- [ ] **Step 3: Write the page** shell and Dashboard. Other tabs render a placeholder section for now. Keep the Stop/Abort `armed()` behaviour and the feed auto-scroll rule as they are today.
- [ ] **Step 4: Run to verify pass** — `pnpm test -- src/web.test.ts` → PASS; then `pnpm lint && pnpm typecheck && pnpm test`.
- [ ] **Step 5: Check it renders.** `pnpm build`, then serve `dist/web.html` against a recorded status (or a dry-run daemon) and look at it at 1400 px and 400 px wide; dots line up across cards, track drops to its own row when narrow, Go button readable in dark mode.
- [ ] **Step 6: Commit**

```bash
git add src/web.html src/web.test.ts
git commit -m "feat(web): dashboard, navigation sidebar and per-instance themes"
```

---

### Task 9: Needs you and Waiting on tabs

**Files:**
- Modify: `src/web.html`, `src/web.test.ts`

**Interfaces:**
- Consumes: `board.owner` (`since`, `review`, `actions`), `board.needsYou` (`reviewOf`, `phaseReview`, `labels`, `since`), `board.phases` (progress for Sign off rows), `r.attention`; `POST /api/owner`, `POST /api/unblock`.

Spec sections: Needs you (group order Approve a plan → Sign off a phase → Ready to plan → Unblock → Answer or close; wait time large, amber over 30 days; sub-lines; group dots; button classes: Approve solid theme primary, Sign off solid `#287A3A`, Start planning amber tint, Unblock neutral, Open ↗ ghost link; a paired review shows as a link on its epic's Sign off row and is not its own row; unpaired `phaseReview` rows say "epic already closed"); Waiting on (green "Nothing stops new claims" line or the banners; groups CI, Review cycle, Dependencies, Another Mac, Phase gate, Fix on GitHub from `r.attention.waitRows`; link row to Needs you with its count).

- [ ] **Step 1: Write the failing tests:** the five group titles appear in order (`indexOf` strictly increasing); `Nothing stops new claims`; `Fix on GitHub`; `epic already closed`; `#287A3A`; today's confirm texts are kept: `` `Sign off #${n}?` ``, `Approve the plan on #`, `` `Start planning #${n}?` ``, `` `Unblock #${issue}?` ``; `fetch("/api/owner"`, `fetch("/api/unblock"`.
- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/web.test.ts` → FAIL.
- [ ] **Step 3: Implement** both tabs.
- [ ] **Step 4: Run to verify pass**, then the full gate.
- [ ] **Step 5: Commit**

```bash
git add src/web.html src/web.test.ts
git commit -m "feat(web): Needs you and Waiting on tabs"
```

---

### Task 10: Board tab

**Files:**
- Modify: `src/web.html`, `src/web.test.ts`

**Interfaces:**
- Consumes: `board.groups`, `board.issues`, `board.phases` (progress facts by epic), `board.pipeline` (hints such as `validator failed · fix round 2`), `r.lastPlan` (first `claim#N` → "next to claim"), `r.model.choices`, `r.effort.levels`; `POST /api/task-model`, `POST /api/task-effort`, `POST /api/owner` (`pause` / `unpause`).

Spec section: Board (top bar with count line, search, Status filter including Off board with counts, Show done; epic card header with eyebrow, title, state chip, Pause/Resume; facts line; task table with labels sub-line and hint, Status dot colors, PR, model and effort dropdown pickers highlighting non-default values, effort menu marking `high` as default; `▸ N done` row listing linked numbers; dimmed `closed` groups without Pause).

- [ ] **Step 1: Write the failing tests:** `Off board`; `Show done`; `esc(g.title)` (group titles come from the server and are escaped); `fetch("/api/task-model"`, `fetch("/api/task-effort"`; confirm texts kept: `Run every foreman session on #` and `A session running now keeps the effort it started with`; `` `Pause #${n}?` ``; the UI-state sets survive polls: `const openPicker` and `const openDone` (or the names chosen) declared at top level, not inside the renderer.
- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** the tab. Search and filter state live in top-level variables so a poll re-render keeps them; an open picker stays open across a re-render.
- [ ] **Step 4: Run to verify pass**, then the full gate.
- [ ] **Step 5: Commit**

```bash
git add src/web.html src/web.test.ts
git commit -m "feat(web): Board tab with every open issue and per-task pickers"
```

---

### Task 11: Session tab

**Files:**
- Modify: `src/web.html`, `src/web.test.ts`

**Interfaces:**
- Consumes: `GET /api/sessions` (Task 7), `pinFeed(sessionId)` (Task 8), `r.model`, `r.cap`, `r.today`, `r.budget`, `r.tick`, `r.launchdInstalled`, `r.recent[0].sessionId`; `POST /api/model`, `POST /api/cap`.

Spec section: Session (range segmented control Today / 7 days / 30 days / All / Custom with local dates; four totals tiles with spend per session computed page-side; Daily spend single-series bar chart — accent bars, 4 px rounded tops, 2 px gap, recessive `$` grid, peak label, per-bar hover tooltip with date, cost and session count, no legend; By role bars; Cost by task table, first ten rows then "Show all N", expandable rows with View feed → `pinFeed`; Daemon card with today's model and cap controls and their confirm texts, GitHub budget, last/next tick, backoff, launchd). Fetch `/api/sessions` on tab open, on range change, and when `r.recent[0]?.sessionId` changes.

- [ ] **Step 1: Write the failing tests:** `` fetch(`/api/sessions ``; the five range labels; `View feed`; `Show all`; kept confirm texts `` `Run foreman sessions as ${model}?` `` and `Set the daily session cap to`; `fetch("/api/model"`, `fetch("/api/cap"`; an expanded-rows set declared at top level.
- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** the tab.
- [ ] **Step 4: Run to verify pass**, then the full gate.
- [ ] **Step 5: Commit**

```bash
git add src/web.html src/web.test.ts
git commit -m "feat(web): Session tab with spend history and daemon controls"
```

---

### Task 12: README and live check

**Files:**
- Modify: `README.md` (the section describing the status page)

- [ ] **Step 1: Update `README.md`**: describe the Dashboard and the four tabs, the theme picker, `GET /api/sessions` and `POST /api/theme`, and that the Tick/Recent/Phase/Owner panels moved.
- [ ] **Step 2: Full gate** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build` → all green; `grep -rniE "pnpm|supabase|docker|playwright" src roles settings` → only `src/repo-config.ts`.
- [ ] **Step 3: Ask the owner before touching a live daemon.** Restarting an instance's daemon is outward-facing; get a yes and which instance. Then `npm link` (once), `pnpm build`, `foreman -p <name> stop`, `foreman -p <name> start`.
- [ ] **Step 4: Look at every tab** on the live page (`http://mini:<webPort>`, laptop and phone width, dark and light): banners appear for a STOP file (`foreman -p <name> stop` then check, then `go`); an issue title with `<b>` renders as text; open a Board picker and expand a Session row, wait two polls, both still open; pick a theme swatch and reload.
- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): the redesigned status page"
```
