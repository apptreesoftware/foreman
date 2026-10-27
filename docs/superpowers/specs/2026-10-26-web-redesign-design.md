# Web page redesign

Status: draft for owner review · 2026-10-26

## Intent

The status page (`src/web.html`, served by `src/web.ts`) shows everything on one screen: a main
column (Now, Pipeline, Feed) and a right sidebar of six panels (Phase, Owner, Needs you, Waiting
on, Tick, Recent). The owner looks at the header, the control buttons, Now, Pipeline and Feed. Of
the right sidebar, only Needs you is checked regularly; the rest is noise on the screen they open
most.

The redesign keeps the screen the owner uses as a clean **Dashboard** and moves everything else
behind a left navigation sidebar with four more tabs: **Needs you**, **Waiting on**, **Board** and
**Session**. It also modernises the look (more room per item, larger type, cards) and gives each
foreman instance its own color theme so that several instances open in several browser tabs are
easy to tell apart.

## Goals

- A Dashboard that answers "what is the foreman doing right now" at a glance: daemon state,
  controls, the running session, the in-flight pipeline and the live feed.
- Needs you as its own tab with a red count badge, grouped by the action the owner takes.
- A whole-board overview (every open issue, grouped by phase epic) with the per-task model and
  effort pickers.
- A Session tab with accumulated spend and per-task cost history, filterable by date.
- A per-instance color theme, with the instance name prominent at the top of the sidebar.
- Readable on a laptop and usable at phone width.

## Non-goals

- No new foreman behaviour. Every action the page can take today it can still take, with the same
  confirmation text and the same server-side allowlists; no new kind of GitHub write.
- No change to the daemon loop, the scheduler, the ledger grammar or the roles.
- No frontend framework, bundler or build step for the page.
- No multi-instance overview page. Each instance keeps its own page on its own port.

## Anti-goals

- A page that looks modern but hides something the owner needs when the foreman is stuck. Every
  reason the foreman is idle (STOP file, failed preflight, daily cap, paused phase, stalled
  session, orphaned child, unfinished bookkeeping) must stay visible on the Dashboard.
- More GitHub API spend. Everything new is computed from the snapshot the tick already fetches or
  from local logs.
- A write that skips its confirmation, or an endpoint that accepts an issue the page is not
  offering.

## Constraints

- One file, `src/web.html`, with inline CSS and vanilla JS. `pnpm build` keeps copying it to
  `dist/`. Fonts come from Google Fonts with system fallbacks (the current page already loads IBM
  Plex this way): Inter for text, JetBrains Mono for code-like values.
- Tabs are client-side, selected by `location.hash` (`#dashboard`, `#needs-you`, `#waiting`,
  `#board`, `#session`) so a reload keeps the tab and a tab can be linked. Default `#dashboard`.
- One `/api/status` poll every 3 s, as today. The Session tab fetches its own endpoint (below)
  only while it is open.
- Every new `StatusReport` / `Board` field is optional or defaulted, so existing tests and an older
  `state.json` keep working (CLAUDE.md: every optional parameter defaults to today's behaviour).
- Nothing repository-specific in `src/`: no project names, no package managers in sample text.
- `foreman.json` is never served or written by the page (it may hold `webAuth` and a Slack
  webhook). Page-set preferences go to `state.json` through `store.patch`, like the model and cap
  overrides already do (`src/cli/daemon.ts`, `setModel` / `setCap`).

## Visual reference

The approved mockups are on the owner's Mac mini (not in this public repository, because they
contain real project data):
`/Users/matthewsmith/claude-out/foreman-redesign/.superpowers/brainstorm/85817-1793061231/content/`

| File | Approved for |
|---|---|
| `dashboard-v4.html` | Dashboard layout, card style, Pipeline dot track, Feed density, narrow layout |
| `colors-v1.html` | The four color schemes (dark), with a light-mode strip each |
| `sidebar-v1.html` | Option **A**: name with an initial tile; theme picker in the footer |
| `session-tab-v1.html` | Session tab, including the Daemon card |
| `needs-you-v2.html` | Needs you: group order and button colors |
| `needs-waiting-v1.html` | Waiting on (second half of the page) |
| `board-v1.html` | Board tab |

Where this document and a mockup disagree, this document wins.

## Design

### Shell

- **Layout:** a 232 px left sidebar and a main column. The old right sidebar is gone.
- **Sidebar header (option A):** a 40 px rounded tile in the theme's primary color holding the
  instance name's first letter, the instance name at 19 px bold, `foreman · <host>` under it in
  muted text, then the daemon pill: `Running · up 12d` (green), `Stopped` (amber), `Crashed`
  (red), `Unknown` (amber). STOP present adds `· STOP file` to the pill.
- **Navigation:** Dashboard, Needs you, Waiting on, Board, Session, each with an icon. The active
  tab uses the theme's soft accent background.
- **Badges:**

  | Tab | Badge counts | Style |
  |---|---|---|
  | Needs you | rows in Approve a plan + Sign off a phase + Unblock + Answer or close (Ready to plan is not counted) | red when > 0, grey 0 |
  | Waiting on | rows shown in its groups (banners not counted) | grey |
  | Others | none | |

- **Sidebar footer:** pid, and the theme picker: four color swatches, the current one ringed.
- **Feedback:** the result message of every action (today's `#msg`) becomes a toast in the
  bottom-right corner for about 5 s; errors stay until dismissed.
- **Narrow screens:** below about 760 px of page width the sidebar becomes a horizontal strip of
  icon tabs at the top (badges kept, the active tab shows its name), the header controls wrap to
  their own row, and stat tiles go 2 × 2. Below about 460 px only the active tab shows its label.
  Use container queries so the breakpoints follow the content width.

### Themes

Four schemes, each with a dark and a light token set. Dark values (from `colors-v1.html`):

| Theme | bg | surface | sunk | line | accent (text) | accent-soft | primary (buttons) | on-primary |
|---|---|---|---|---|---|---|---|---|
| indigo | #0E1015 | #161A21 | #1D222B | #262C36 | #8EA6FF | #1E2645 | #4263EB | #FFFFFF |
| violet | #0E0D13 | #16151E | #1E1C29 | #2A2736 | #B4A4FF | #2A2250 | #6E56CF | #FFFFFF |
| teal | #0B1114 | #121A1E | #182328 | #223036 | #5FD4E4 | #0F3239 | #22B8CF | #04161A |
| mono | #0A0A0B | #141416 | #1C1C1F | #27272B | #EDEDEF | #2A2A2F | #EDEDEF | #0A0A0B |

Ink for all dark themes follows the indigo row's pattern (`ink` ≈ #ECEEF2, `ink-2` ≈ #A3AAB5,
`ink-3` ≈ #6E7581), tinted toward each theme as in the mockup. Light primaries: indigo #3B5BDB,
violet #6E56CF, teal #0B7285 (white text; darker than the mockup's #0C8599, which fails 4.5:1),
mono #111113 (white text); the light ground and soft
accent values are on each theme's strip in the mockup. The builder derives the remaining light
tokens in the same structure.

Status colors are shared by every theme and keep one meaning each: green done/ok (#5CCB8D dark),
amber warning (#F0B44C), red failed (#FF8787), each with a soft background variant. In mono, the
active-stage dot and the session progress bar use a muted blue (#5B8DEF) because its primary is
near-white.

The page follows `prefers-color-scheme` as today; the theme choice selects which pair of token
sets applies.

Every solid button meets 4.5:1 text contrast. The pale accent is for text, the active nav item and
tool pills only; it is never a button fill. (This fixes the current Go button, which is too light
on a dark background.)

**Choosing a theme:** the swatches in the sidebar footer call `POST /api/theme`. With no choice
saved, the daemon picks one at start and saves it, so it never changes on its own afterwards: the
theme least used by the other instances on this Mac (read from their `state.json` files via
`listInstances`), ties broken by a stable hash of the instance name. Up to four instances
therefore start with four different themes; a fifth repeats one.

### Dashboard

From top to bottom:

1. **Header row:** the page title `Dashboard`, then the controls in two groups: `Go` (solid
   primary), `Refresh project`, `Compute next`; then `Stop` and `Abort` (red text, armed
   two-click confirm as today).
2. **Banners**, only when present, each one line with its fix: STOP file present (amber, "Go
   resumes"), preflight failed (red, with the reason), daily cap reached (amber, "N of N
   sessions today", with a link to the Session tab's cap control), a paused phase (amber), a
   stalled session (red, "no output for Nm"), an orphaned child (red), unfinished bookkeeping
   (red, "run ctl abort"), a pending stop/abort (amber), and "no state.json: restart the daemon"
   when the daemon state is UNKNOWN.
3. **Compute next output**, when requested: a dismissable card under the banners with the same
   text the `<pre>` shows today.
4. **Now card.** While a session runs: a role chip (`REVIEWER`), round chip, effort chip when not
   high; the title `#<issue> · <title>` at 20 px; a meta line with the PR, the model and the
   branch; the elapsed-time bar with start, `Nm of Mm` and deadline; four stat tiles (turns,
   tokens, 5 h window, 7 d window); and the latest tool call with its age, plus the latest
   assistant text in italics when present. With no session, the card is compact: the phase label
   (`idle`, `between ticks`, `ticking`, `parked`) and its one-line detail, as today.
5. **Pipeline.** One card per in-flight issue: `#<issue> <title>` with a sub-line (PR, claim host,
   role and round, fix round); then the stage track; then tags (model when pinned, `<level>
   effort` when not high, `blocked`, `CI pending`, `mergeable`, `fix round N`). The track is
   five dots (Build, Review, Validate, CI, Merge) joined by a line, labels under the dots: green
   filled for done, a blue ring for active, red filled for failed, hollow grey for pending,
   dashed for skipped. The track column has a fixed width and the tag column a fixed width, so
   every card's dots line up, with about 32 px between the track and the tags. When the pipeline
   is narrower than about 760 px, the track moves to its own full-width row under the title,
   separated by a hairline, and the tags stay top-right.
6. **Feed.** A card of compact rows (about 26 px each): time, a kind pill (tool name in the
   accent pill, red pill for a tool error, plain text for `init`/`text`/`result`), the summary
   with ellipsis, assistant text wrapping in italics. Newest last, auto-scroll as today, the
   newest row highlighted. It shows the current session; after "View feed" on the Session tab it
   shows that session, with a "Back to live" chip in its header.

The Recent list, the Tick panel, the Phase card and the Owner card are no longer on the
Dashboard; see "Where everything moved".

### Needs you

Grouped by the action the owner takes, in this order, oldest first within a group. Each row shows
the wait time large on the left (`51d`, amber once over 30 days), the issue number and title, a
sub-line, and its action on the right.

1. **Approve a plan** · epics offering `approve_plan`. Sub-line: when the plan was drafted and a
   "read the plan" link. Button: **Approve plan**, solid theme primary.
2. **Sign off a phase** · epics offering `sign_off`. Sub-line: a small green progress bar with
   `done/total tasks`, the phase spend, and a link to its review issue. Button: **Sign off**,
   solid green (#287A3A, white text, 5.3:1).
3. **Ready to plan** · epics offering `start_planning`. Not counted in the badge. Sub-line notes a
   planner session costs about $5. Button: **Start planning**, amber tint (amber-soft
   background, amber text and border).
4. **Unblock** · `needsYou` items labelled `blocked`, with the reason from the waiting detail.
   Button: **Unblock**, neutral.
5. **Answer or close** · the remaining `needsYou` items (`decision`, `needs-owner`). Label tags
   and, for an old phase review whose epic is no longer open, "epic already closed". Button:
   **Open ↗** (link to the issue), ghost style.

Each group title has a small dot in its button's color. Every button keeps today's
`window.confirm` text.

A phase review issue (`Phase <N> review: <epic title>`, created by the phase-closer with
`needs-owner`) is shown on its epic's Sign off row, not as its own row. Pair them in this order:
(1) the epic's own comment `Phase review: #<review>`, which `roles/phase-closer.md` has the
phase-closer post and which is already in the snapshot's comments; (2) otherwise, the epic's title
with its leading `Phase <X>:` removed appearing in the review's title. Never pair by the
`phase:<N>` label alone, because several epics can share a phase number. A review issue with no
open matching epic goes to Answer or close.

Pause and Resume are no longer on this tab; they live on the Board's epic headers.

### Waiting on

- A status line at the top: green "Nothing stops new claims: …" when no global blocker is active;
  otherwise the same banners as the Dashboard (STOP, preflight, cap, paused).
- Then groups by wait kind with counts: CI, Review cycle, Dependencies, Another Mac
  (`other_host`), Phase gate, and Fix on GitHub (the `human` waits that are not on Needs you, such
  as "agent-ready but Status Backlog" or "no Parent epic line", and "phase N held").
- Each row: a kind icon, the subject and detail, a sub-line with context (the issue title, the
  state of each dependency), and `since` when known.
- Dependency rows for the same issue merge into one (`#270 waits on #268 and #269`).
- Any `human` wait whose subject issue or epic is a row on Needs you is not repeated; a dashed
  link row at the bottom points to Needs you with its count.

### Board

Every open issue on the project board, grouped under its phase epic.

- **Top bar:** title with a count line (`N open issues in M phases · read from the last tick,
  HH:MMZ`), a search box (number or title), a Status filter (All, Ready, In progress, In review,
  Backlog, Blocked, each with a count) and a "Show done" checkbox.
- **Epic card header:** `PHASE <N>` eyebrow, `#<epic> <title>`, a state chip (Planning / Plan
  waiting / Building / Sign-off waiting / Not started, plus Paused), and **Pause** or **Resume**.
  A facts line: green progress bar `done of total`, spend and session count, median claim→merge
  (from today's phase progress), or "no tasks yet" for an epic still being planned.
- **Task rows** in a table: issue and title with a sub-line of labels (`blocked` in red, `size:*`,
  `area:*`) and a hint (`waits on #268, #269`, `next to claim`, `validator failed · fix round 2`);
  Status as a colored dot and word (Backlog grey, Ready blue, In progress amber, In review violet,
  Done green); PR; a **model** picker; an **effort** picker.
- **Pickers** are compact dropdowns. A value that differs from the default is highlighted (model
  in the accent color, effort in amber). The effort menu lists low, medium, high (marked
  default), xhigh, max; the model menu lists `StatusReport.model.choices` and `default`. Choosing
  a value shows the same confirm text as today and calls `/api/task-model` or
  `/api/task-effort`.
- **Done tasks** collapse into one "▸ N done" row per epic. Closed issues are not in the snapshot,
  so the expanded list shows numbers (linked) without titles.
- **Issues whose epic is closed** (a signed-off phase with leftovers) group under `Phase <N>` from
  their `phase:<N>` label, slightly dimmed, with no Pause button. The closed epic's title is not
  in the snapshot, so the header reads `Phase <N> · epic closed`. Issues with no epic and no
  phase label group under "No phase".

### Session

- **Range filter:** a segmented control: Today, 7 days, 30 days, All (the whole `sessions.log`),
  Custom (a from/to date pair). Days are local days, the same boundary `todayStats` uses for the
  daily cap.
- **Totals:** four tiles: spend, sessions, tasks and epics touched, spend per session.
- **Daily spend:** a single-series bar chart, one bar per day in range, theme accent bars with
  4 px rounded tops and a 2 px gap, a recessive grid with `$` labels, the peak bar labelled, and a
  hover tooltip per bar (date, cost, session count). One series, so no legend.
- **By role:** horizontal bars per role, sorted by spend, value at the end.
- **Cost by task:** a table, most expensive first: issue and title, role chips, session count,
  last run, cost with an inline bar. The first ten rows show, then "Show all N". Clicking a row
  expands its sessions: time, role, model, turns, outcome (green/amber/red), cost, and **View
  feed**, which switches to the Dashboard with that session pinned in the Feed.
- **Daemon card** (what today's Tick panel holds): model for new sessions (buttons, current one
  highlighted, override note), daily session cap (today's count and spend, cap buttons, override
  note), GitHub budget (remaining of limit, reset time, last tick's read attribution), and a line
  with last tick and preflight, next tick, backoff, and launchd. Same endpoints and confirm text
  as today.

### Where everything moved

| Today | Redesign |
|---|---|
| Header: daemon badge, pid, uptime | Sidebar pill (state, uptime); pid in sidebar footer |
| Header: STOP present, stalled, "no state.json" | Dashboard banners |
| Header buttons, Compute next output | Dashboard header row; output card under the banners |
| Now, Pipeline, Feed | Dashboard |
| Phase card (progress, spend, cycle time) | Board epic headers; Sign off rows on Needs you |
| Phase card task model pins / effort buttons | Board task pickers |
| Owner card: Sign off, Approve plan, Start planning | Needs you groups |
| Owner card: Pause / Resume | Board epic headers |
| Needs you card | Needs you tab |
| Waiting on card | Waiting on tab |
| Tick card | Session tab, Daemon card; blockers also as Dashboard banners |
| Recent card | Session tab, Cost by task (expanded rows) |

## Data and API changes

All computed from the existing snapshot or local files; no new GitHub reads.

1. **`StatusReport.instance`** (string): the instance name, for the sidebar header and the theme
   hash. Optional in the type so old fixtures parse; the daemon always sets it.
2. **`StatusReport.theme`**: `{ current, source: "override" | "derived", choices }`. Stored as
   `theme` in `state.json` via `store.patch`. **`POST /api/theme`** `{ theme: <name> | "default" }`,
   allowlisted to the four names plus `default` (which clears the override).
3. **`OwnerItem.since`** (ISO or null): when the epic started waiting, for the wait-time column.
   `src/waiting.ts` already computes this for the same epics.
4. **`Board.issues[]`**, built in `describeBoard` from `Snapshot.issues`, `prs` and `epics`: for
   every open non-epic issue, `{ issue, title, status, labels (display subset), epic, phase, pr,
   dependsOn, openDependsOn, blocked, model, effort }`. Grouping, in order: (1) the open epic
   whose `taskNumbersOf` set includes the issue (sub-issues plus the body's `Parent epic: #N`
   line, the same set the phase progress uses); (2) else, by its `phase:<N>` label, the one open
   epic with that phase when exactly one exists; (3) else, when several open epics share that
   phase, a `Phase <N> · not linked to an epic` group; (4) else, when no open epic has that phase,
   `Phase <N> · epic closed`; (5) else "No phase".
5. **`Board.epics[]`** or an extension of `phases`, so the Board can show every open epic
   (including ones being planned) with its state, not only approved phases.
6. **Needs-you pairing**: the review-issue-to-epic match described above, computed server-side so
   the badge count and the rows agree.
7. **Allowlist for the pickers**: `/api/task-model` and `/api/task-effort` accept any issue in
   `Board.issues` (today: only tasks under an approved phase). Still the board, still no arbitrary
   issue number.
8. **`GET /api/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD`** (both optional; absent means the whole
   log): `{ totals, daily[], byRole[], byIssue[] }`, each `byIssue` row with its entries. Computed
   from `readSessions`. Sessions and cost are counted per log line, the same way `todayStats`
   counts them, so the Session tab and the cap counter agree. Same host check / auth as
   every other route. The page fetches it when the Session tab opens, when the range changes, and
   when `recent[0].sessionId` changes in the status poll.
9. **Titles in the cost history**: see open question 1.

## Calls made during design (owner may override)

- Theme choice is stored in `state.json` through `store.patch`, not in `foreman.json` as first
  said in conversation: the daemon reads `foreman.json` only at start and the page never writes
  it; `state.json` is the existing home for page-set overrides and is per instance.
- With no saved choice, the daemon saves the theme least used by the other instances on this Mac,
  so instances start distinct and a theme never shifts on its own.
- Review pairing uses the epic's `Phase review: #<review>` comment first, then a title match.
- Board grouping uses `taskNumbersOf`, then a unique open epic for the phase label.
- Session counts follow `todayStats` (per log line).
- Sign off green is #287A3A and light teal is #0B7285, to meet 4.5:1.
- The sidebar shows the instance name (what `foreman -p` uses), not the repository name.
- A phase review issue shows on its epic's Sign off row.
- Ready to plan is not counted in the Needs you badge.
- Waits over 30 days turn amber.
- The tab is labelled "Session" (the conversation's "Session info").
- Session days are local days, matching the daily cap.
- Session tab "View feed" switches to the Dashboard with that session pinned.
- Board pickers are offered for every open issue on the board, widening the allowlist from
  approved-phase tasks.

## Open questions

1. **Titles for closed issues in the cost history.** `sessions.log` records the issue number but
   not its title, and closed issues are not in the snapshot, so most history rows would show only
   `#N`. Options: (a) add an optional `title` to each new `sessions.log` entry, so rows from now on
   have titles and older rows show `#N` (or a title from any later entry for the same issue); (b)
   look titles up on GitHub when the Session tab opens, cached in the instance directory, which
   spends API budget the page avoids today; (c) both; (d) neither: titles only for issues still
   open (from the snapshot), `#N` for the rest. (a) touches `appendSession` in `src/loop.ts`,
   which the non-goals otherwise leave alone; (b) adds a `gh` read path; (d) is page-only.
2. **Issues that are open but not on the project board.** Some repositories have open issues with
   no board Status (phase review issues, follow-ups filed by hand). Show them on the Board under
   an "Off board" status, or leave them off? Showing them adds an "Off board" filter and widens
   the picker allowlist to every open issue the snapshot holds.

## Left to the builder

- Exact spacing, radii and type sizes beyond what the mockups show; icons (inline SVG, as in the
  mockups).
- The full light-mode token sets, following the dark structure and the strip values.
- The hash function for the derived theme.
- Whether `Board.epics` is a new field or an extension of `phases`.
- How the page keeps a tab's scroll position and an open picker across the 3 s re-render (today's
  page re-renders whole sections; the Board pickers and the Session expansions must survive a
  poll, the way `openPhases` survives today).
- Toast behaviour details.

## Testing

- TDD for every new pure function: `Board.issues` and epic grouping, needs-you grouping and review
  pairing, the Waiting on de-duplication and badge counts, session aggregation by range, the theme
  derivation.
- `src/web.test.ts`: new routes (`/api/theme`, `/api/sessions`, the widened picker allowlist)
  with the existing request-level tests; the `web.html` string-contains tests at the end of the
  file are rewritten for the new markup (confirm strings, endpoint paths, element ids).
- `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm build`; then dogfood with `npm link` on
  a live instance and check every tab at laptop and phone width, in both color schemes.
- `README.md`: update the section that describes the page.
