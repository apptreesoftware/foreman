# Decisions artifact and decision auto-resume — design

Date: 2026-11-17
Status: approved in brainstorming, awaiting spec review

## Problem

A builder that hits an outcome-changing ambiguity opens a `decision` issue and labels its own task
`blocked`. The owner answers on GitHub, then must separately Unblock the task. Two gaps:

1. Answering a decision does not resume the task it blocks. Nothing links the two.
2. Decisions are visible only on GitHub, the localhost status page and Slack. There is no shared
   place where people across AppTree can see open decisions and settle them.

## Outcome

- One claude.ai artifact per foreman daemon (per served repository), shared with AppTree once,
  with a link that never changes.
- It lists every open decision for the repository. A viewer with GitHub write access picks an
  option (or writes an answer) and presses Settle; the decision leaves the list.
- Within one tick the foreman resumes the task the decision blocked, quoting the answer.

## Decisions taken

| Question | Decision |
|---|---|
| What settling does | Post the answer on the decision issue, close it, and resume the blocked task. |
| Artifact scope | One per daemon / repository, permanent link. |
| Who can see | Anyone in AppTree the artifact is shared with. |
| Who can settle | Anyone whose claude.ai GitHub connector has write access to the repository. Everyone else gets a read-only list. |
| Sync mechanism | Approach B: the page reads and writes GitHub through the viewer's GitHub connector (`mcp` capability). The foreman never writes to the artifact. |
| Decision issue layout | New fixed layout for decision issues (below). Approved as an extension of the fixed-process rule; task issue layout is unchanged. |
| Close reason | Only a decision closed as `COMPLETED` resumes its task. `NOT_PLANNED` leaves the task blocked. |

Rejected: approach A (foreman syncs the artifact through a headless Claude session; costs
subscription quota per sync, up to one sync interval of latency) and C (host the localhost status
page for the team).

## Components

### 1. Decision issue layout (`roles/builder.md`)

Step 2 of the builder role changes from free-form to this body:

```
## Question
<one sentence>

## Context
<what the builder found>

## Options
### A: <short label>
<trade-offs>

### B: <short label>
<trade-offs>

## Recommendation
<letter and why>

Blocks: #<issue>
```

At least two options. `Blocks: #<issue>` is a single line naming the one task the decision
blocks. Title, labels and the `blocked` / comment / outcome steps stay as today.

### 2. Decision auto-resume (foreman, `src/`)

A new module (for example `src/decisions.ts`) with a pure planner and an applier, run once per tick
after the snapshot, next to `notify.syncDecisions`.

- **Parse:** `parseDecision(body)` returns `{ blocks: number | null, options: {key, label}[] }`.
  `parseSettled(comments)` returns the earliest comment whose first line matches
  `^Settled: (.+)$`, or null.
- **Plan:** for each decision issue that is `CLOSED` with `stateReason === "COMPLETED"` and
  `blocks === N`, resume N when all of these hold:
  - N is open and labelled `blocked`;
  - no *open* decision issue also has `Blocks: #N`;
  - N has no prior `decision #D … resumed by foreman@…` ledger comment for this decision D
    (idempotency).
- **Apply:** reuse `applyUnblock` (removes `blocked`, clears `reviewer:changes` /
  `validator:failed` on the PR, sets Status Ready), then post a ledger comment on N:
  - with an answer: `decision #D settled: <answer line> — resumed by foreman@<host>`;
  - without one: `decision #D closed; read it before continuing — resumed by foreman@<host>`.
  The ledger grammar gains this one entry in `src/ledger.ts`.
- **Snapshot:** closed decision issues must be visible. Fetch closed `decision`-labelled issues
  updated since the last tick's watermark (or the last 7 days on first run), with `stateReason`
  and comments, instead of widening the main snapshot to `all`.
- All GitHub writes go through `GitHub` in `src/github.ts` and honour `dryRun`.

This works whether the decision was settled from the page or answered and closed directly on
GitHub.

### 3. The decisions page (`src/decisions.html`)

A single self-contained HTML page with `owner/repo` baked in at generation time. Capabilities:
`mcp` (the GitHub connector: list issues, list comments, create comment, update issue state),
`user` (viewer identity for the "by" line).

- **List:** open issues labelled `decision`, oldest first: title, question, options with
  trade-offs, recommendation, the blocked task (`Blocks: #N`, linked), age. Issues without the new
  layout render their body as text with a free-text answer box only.
- **Settle:** choose an option or write an answer, then Settle. The page posts
  ```
  Settled: <letter> — <option label or written answer>
  by <viewer name> via decisions page
  ```
  then closes the issue as completed, then removes it from the list.
- **Read-only:** when the GitHub connector is absent or the viewer lacks write access, Settle is
  replaced by "Connect GitHub to settle". Artifact comments still work.

### 4. CLI

- `foreman decisions page [--out <path>]` writes the page with this instance's repo baked in and
  prints the one-line instruction to publish it from Claude Code.
- `foreman decisions link <url>` stores the artifact URL in the machine config.
- The status page's decision rows and the Slack `decision needed` message link to the stored URL
  when set, GitHub otherwise.

The foreman cannot publish artifacts itself (only a Claude session can); publishing and the one-time
AppTree share are manual.

## Failure handling

| Situation | Behaviour |
|---|---|
| No GitHub connector / no repo write | Read-only list; a refused write is shown and the decision stays. |
| Comment posted, close failed | Page shows "Answer posted, not closed — retry close". Foreman acts only on closed issues. |
| Two settlers at once | Second sees "Already settled by X" after refresh. Foreman quotes the earliest `Settled:` comment. |
| Closed on GitHub without a `Settled:` comment | Task resumes with the "read it before continuing" comment. |
| No `Blocks:` line (old decisions) | No auto-resume; manual Unblock as today. |
| Closed as not planned | Task stays blocked. |
| Foreman stopped | Page keeps working; tasks resume on the next tick after restart. |
| Task has two open decisions | Resumes only after the last one closes. |

## Testing

- `src/decisions.test.ts`: parse (layout, no `Blocks:`, malformed), plan (each row of the failure
  table that involves the foreman), apply (exact `gh` argv via exec doubles, `dryRun` writes
  nothing), idempotency across two ticks.
- `src/roles.test.ts`: builder prompt contains the layout and the `Blocks:` line.
- CLI tests for `decisions page` (repo baked in) and `decisions link` (stored, never logged).
- The page has no automated coverage. It is verified by hand once a GitHub connector exists; until
  then it is reported as built but never driven.

## Build order

1. Decision layout + auto-resume + ledger entry. Independently useful.
2. Page + `decisions page` / `decisions link` + links from the status page and Slack. Blocked on
   confirming that a GitHub connector can be added to claude.ai for AppTree.

## Open risks

- **GitHub connector availability on claude.ai for AppTree — unverified.** Without it, step 2
  cannot settle anything; fall back to approach A or ship step 1 alone.
- **GitHub connector tool names and shapes — unverified.** Must be read from the connector's schema
  before the page is written, not guessed.
- **AppTree-wide sharing — assumed** to be a one-time manual share of the artifact.
