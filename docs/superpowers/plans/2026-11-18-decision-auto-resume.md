# Decision Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `decision` issue is closed as completed, the foreman resumes the task its `Blocks: #N` line names, quoting the settled answer on the task.

**Architecture:** Builders write decision issues in a fixed layout ending in `Blocks: #<issue>`. Each tick, if any open issue is `blocked`, the foreman reads `decision` issues closed in the last 7 days (one `gh issue list` call), plans which blocked tasks they release (pure function, `src/decisions.ts`), and applies each through the existing `applyUnblock` with a new ledger comment instead of `unblocked by owner`. Idempotency and safety come from the ledger: one `decision #D …` comment per consumed decision, and a decision only counts if it closed after the task's newest `blocked by …` comment.

**Tech Stack:** TypeScript (ESM, `.ts` imports), vitest, `gh` CLI, Biome.

**Spec:** `/Users/coreys/apptree/upgrade/foreman/docs/superpowers/specs/2026-11-17-decisions-artifact-design.md` (part 1 only: layout + auto-resume + ledger entry; the page is a later plan).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `ClosedDecision` type |
| `src/ledger.ts` | modify | `fmt.decisionResumed`, `decisionResumed()`, `lastBlockedAt()` |
| `src/github.ts` | modify | `GitHub.listClosedDecisions(since)`; add to `GitHubApi` |
| `src/needs-you.ts` | modify | `applyUnblock` takes an optional ledger note (defaults to today's) |
| `src/decisions.ts` | create | `parseBlocks`, `settledAnswer`, `planDecisionResumes`, `resumeSettledDecisions` |
| `src/loop.ts` | modify | call `resumeSettledDecisions` in `runOnce` after `syncDecisions` |
| `roles/builder.md` | modify | step 2: the fixed decision layout |
| `README.md` | modify | outcome table, ledger grammar, Needs-you paragraph |
| Tests | `src/ledger.test.ts`, `src/github.test.ts`, `src/needs-you.test.ts`, `src/decisions.test.ts` (new), `src/loop.test.ts`, `src/roles.test.ts` | |

Run every test command from `/Users/coreys/apptree/upgrade/foreman`. Work on a feature branch, e.g. `feat/decision-auto-resume` off `main`.

---

### Task 1: Ledger grammar for decision resumes

**Files:**
- Modify: `src/ledger.ts` (add to `fmt`; add two functions after `planPrStuckReported`)
- Test: `src/ledger.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/ledger.test.ts` (add `decisionResumed`, `lastBlockedAt` to the existing `./ledger.ts` import, and `comment`, `hoursAgo` from `../test/helpers.ts` if not already imported):

```ts
describe("decision resume ledger", () => {
  it("formats a settled and an unanswered resume", () => {
    expect(fmt.decisionResumed("mac-a", 40, "B — Use REST")).toBe(
      "decision #40 settled: B — Use REST — resumed by foreman@mac-a",
    );
    expect(fmt.decisionResumed("mac-a", 41, null)).toBe(
      "decision #41 closed; read it before continuing — resumed by foreman@mac-a",
    );
  });

  it("decisionResumed finds only the named decision", () => {
    const cs = [comment(fmt.decisionResumed("mac-a", 40, "A")), comment("decision #4 is odd")];
    expect(decisionResumed(cs, 40)).toBe(true);
    expect(decisionResumed(cs, 41)).toBe(false);
    expect(decisionResumed(cs, 4)).toBe(false);
  });

  it("lastBlockedAt is the newest `blocked by` comment, from the foreman or a role", () => {
    const cs = [
      comment("blocked by foreman@mac-a: setup failed", hoursAgo(9)),
      comment("blocked by builder: see #40", hoursAgo(5)),
      comment("unblocked by owner via foreman@mac-a", hoursAgo(2)),
    ];
    expect(lastBlockedAt(cs)).toBe(hoursAgo(5));
    expect(lastBlockedAt([comment("Progress")])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/ledger.test.ts`
Expected: FAIL — `fmt.decisionResumed is not a function` / `decisionResumed` not exported.

- [ ] **Step 3: Implement**

In `src/ledger.ts`, add to the `fmt` object after `unblocked`:

```ts
  /**
   * The foreman resumed a task because decision #`decision` was closed as completed. Not
   * TERMINAL and not `blocked by`: a resume must neither close a claim nor count as a block.
   */
  decisionResumed: (host: string, decision: number, answer: string | null) =>
    answer
      ? `decision #${decision} settled: ${answer} — resumed by foreman@${host}`
      : `decision #${decision} closed; read it before continuing — resumed by foreman@${host}`,
```

After `planPrStuckReported`, add:

```ts
const DECISION_RESUMED = /^decision #(\d+) (?:settled: |closed; )/;

/** Whether this task was already resumed for decision `n`; each decision resumes at most once. */
export function decisionResumed(comments: Comment[], n: number): boolean {
  return comments.some((c) => DECISION_RESUMED.exec(c.body.trim())?.[1] === String(n));
}

/**
 * When the issue was last blocked through the ledger: `blocked by foreman@…` (setup, attempts,
 * fix rounds) or `blocked by <role>: …` (a role's `blocked` outcome). Null when it never was —
 * a `blocked` label added by hand leaves no comment.
 */
export function lastBlockedAt(comments: Comment[]): string | null {
  return (
    comments
      .filter((c) => c.body.trim().startsWith("blocked by "))
      .map((c) => c.createdAt)
      .sort()
      .at(-1) ?? null
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/ledger.test.ts
git commit -m "feat(ledger): decision-resumed entry and lastBlockedAt"
```

---

### Task 2: `ClosedDecision` type and `GitHub.listClosedDecisions`

**Files:**
- Modify: `src/types.ts` (after `Issue`)
- Modify: `src/github.ts` (method after `getIssue`; `GitHubApi` Pick list)
- Modify: `src/loop.test.ts:43-85` (`fakeGh` must satisfy `GitHubApi`)
- Test: `src/github.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/github.test.ts`:

```ts
describe("listClosedDecisions", () => {
  it("reads closed decision issues since a date and maps their comments", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            number: 40,
            body: "## Question\nX?\n\nBlocks: #5",
            stateReason: "COMPLETED",
            closedAt: "2026-09-03T11:00:00Z",
            comments: [{ author: { login: "jane" }, body: "Settled: B", createdAt: "2026-09-03T10:59:00Z" }],
          },
          { number: 41, body: null, stateReason: "", closedAt: "2026-09-02T11:00:00Z", comments: [] },
        ]),
      };
    };
    const out = await new GitHub(cfg, exec, false).listClosedDecisions("2026-08-27");
    expect(calls).toEqual([
      [
        "gh",
        "issue",
        "list",
        "--repo",
        "acme/widgets",
        "--label",
        "decision",
        "--state",
        "closed",
        "--search",
        "closed:>=2026-08-27",
        "--limit",
        "100",
        "--json",
        "number,body,stateReason,closedAt,comments",
      ],
    ]);
    expect(out).toEqual([
      {
        number: 40,
        body: "## Question\nX?\n\nBlocks: #5",
        stateReason: "COMPLETED",
        closedAt: "2026-09-03T11:00:00Z",
        comments: [{ author: "jane", body: "Settled: B", createdAt: "2026-09-03T10:59:00Z" }],
      },
      { number: 41, body: "", stateReason: null, closedAt: "2026-09-02T11:00:00Z", comments: [] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/github.test.ts`
Expected: FAIL — `listClosedDecisions is not a function`.

- [ ] **Step 3: Implement**

In `src/types.ts`, after the `Issue` interface:

```ts
/** A closed `decision` issue, read only to resume the task its `Blocks: #N` line names. */
export interface ClosedDecision {
  number: number;
  body: string;
  /** GitHub's close reason. Only COMPLETED resumes; NOT_PLANNED, DUPLICATE and the rest do not. */
  stateReason: string | null;
  closedAt: string;
  comments: Comment[];
}
```

In `src/github.ts`, add `ClosedDecision` to the `./types.ts` import, then after `getIssue`:

```ts
  /**
   * `decision` issues closed on or after `since` (YYYY-MM-DD), with the close reason the resume
   * needs. A REST search, not the tick's GraphQL read, so it spends none of that budget; and the
   * loop only calls it on a tick that has a blocked issue to resume.
   */
  async listClosedDecisions(since: string): Promise<ClosedDecision[]> {
    const raw = JSON.parse(
      await this.gh([
        "issue",
        "list",
        "--repo",
        this.cfg.repo,
        "--label",
        "decision",
        "--state",
        "closed",
        "--search",
        `closed:>=${since}`,
        "--limit",
        "100",
        "--json",
        "number,body,stateReason,closedAt,comments",
      ]),
    ) as Array<{
      number: number;
      body: string | null;
      stateReason: string | null;
      closedAt: string;
      comments: Array<{ author: { login: string } | null; body: string; createdAt: string }>;
    }>;
    return raw.map((i) => ({
      number: i.number,
      body: i.body ?? "",
      stateReason: i.stateReason || null,
      closedAt: i.closedAt,
      comments: i.comments.map(
        (c): Comment => ({ author: c.author?.login ?? "", body: c.body, createdAt: c.createdAt }),
      ),
    }));
  }
```

In the `GitHubApi` Pick list, add `| "listClosedDecisions"` after `| "getIssue"`.

In `src/loop.test.ts`, change `fakeGh` so every existing caller still compiles and new tests can pass closed decisions:

```ts
function fakeGh(issues: Issue[], closedDecisions: ClosedDecision[] = []) {
```

add `ClosedDecision` to the `./types.ts` import, and add to the `gh` object after `getIssue`:

```ts
    listClosedDecisions: async (since: string) => {
      calls.push(`listClosedDecisions ${since}`);
      return closedDecisions;
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/github.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean (any other `GitHubApi` fake it flags gets the same `listClosedDecisions: async () => []`).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/github.ts src/github.test.ts src/loop.test.ts
git commit -m "feat(github): list recently closed decision issues"
```

---

### Task 3: `applyUnblock` takes an optional ledger note

**Files:**
- Modify: `src/needs-you.ts:37-51`
- Test: `src/needs-you.test.ts` (inside `describe("applyUnblock")`)

- [ ] **Step 1: Write the failing test**

Add inside `describe("applyUnblock", …)`:

```ts
  it("posts the given note in place of the owner unblock line", async () => {
    const { gh, calls } = fakeGh();
    await applyUnblock(
      gh,
      { issue: 5, itemId: "PVTI_5", host: "mac-a", pr: null },
      "decision #40 settled: B — resumed by foreman@mac-a",
    );
    expect(calls).toEqual([
      "removeLabels issue 5 blocked",
      "setStatus PVTI_5 Ready",
      "comment issue 5 decision #40 settled: B — resumed by foreman@mac-a",
    ]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/needs-you.test.ts`
Expected: FAIL — last call is `comment issue 5 unblocked by owner via foreman@mac-a`.

- [ ] **Step 3: Implement**

In `src/needs-you.ts`, change the signature and the comment line:

```ts
export async function applyUnblock(
  gh: UnblockGh,
  i: { issue: number; itemId: string | null; host: string; pr: number | null },
  /** The ledger line; the owner's Unblock button leaves the default. */
  note: string = fmt.unblocked(i.host),
): Promise<string> {
```

and replace `await gh.comment("issue", i.issue, fmt.unblocked(i.host));` with:

```ts
  await gh.comment("issue", i.issue, note);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/needs-you.test.ts`
Expected: PASS, including the existing unblock tests.

- [ ] **Step 5: Commit**

```bash
git add src/needs-you.ts src/needs-you.test.ts
git commit -m "refactor(needs-you): applyUnblock takes an optional ledger note"
```

---

### Task 4: Parse decision issues

**Files:**
- Create: `src/decisions.ts`
- Test: `src/decisions.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `src/decisions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { comment, hoursAgo } from "../test/helpers.ts";
import { parseBlocks, settledAnswer } from "./decisions.ts";

describe("parseBlocks", () => {
  it("reads the task from a `Blocks: #N` line", () => {
    expect(parseBlocks("## Question\nX?\n\n## Recommendation\nA\n\nBlocks: #57\n")).toBe(57);
  });
  it("is null without the line, or when it is not on a line of its own", () => {
    expect(parseBlocks("Context: this blocks #57")).toBeNull();
    expect(parseBlocks("Blocks: #57 and #58")).toBeNull();
    expect(parseBlocks("")).toBeNull();
  });
});

describe("settledAnswer", () => {
  it("is the earliest `Settled:` first line, trimmed", () => {
    const cs = [
      comment("Settled: A — later answer", hoursAgo(1)),
      comment("Settled:  B — Use REST \nby Jane via decisions page", hoursAgo(2)),
      comment("I prefer B", hoursAgo(3)),
    ];
    expect(settledAnswer(cs)).toBe("B — Use REST");
  });
  it("is null when nobody settled through the page", () => {
    expect(settledAnswer([comment("go with B")])).toBeNull();
  });
  it("caps a very long answer at 500 characters", () => {
    expect(settledAnswer([comment(`Settled: ${"x".repeat(900)}`)])?.length).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/decisions.test.ts`
Expected: FAIL — cannot find module `./decisions.ts`.

- [ ] **Step 3: Implement**

Create `src/decisions.ts`:

```ts
import type { Comment } from "./types.ts";

/** The decision layout's last line: the one task this decision blocks. */
const BLOCKS = /^Blocks: #(\d+)\s*$/m;
/** The first line of the comment the decisions page posts when someone settles. */
const SETTLED = /^Settled: (.+)$/;
const MAX_ANSWER = 500;

export function parseBlocks(body: string): number | null {
  const m = BLOCKS.exec(body);
  return m ? Number(m[1]) : null;
}

/**
 * The answer to quote on the resumed task: the earliest `Settled:` comment wins, so two people
 * settling at once resolve to whoever was first. Null when the decision was answered some other
 * way, e.g. closed by hand on GitHub.
 */
export function settledAnswer(comments: Comment[]): string | null {
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const first = (c.body.trim().split("\n")[0] ?? "").trim();
    const m = SETTLED.exec(first);
    if (m) return (m[1] as string).trim().slice(0, MAX_ANSWER);
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions.ts src/decisions.test.ts
git commit -m "feat(decisions): parse Blocks line and settled answer"
```

---

### Task 5: Plan which tasks a closed decision resumes

**Files:**
- Modify: `src/decisions.ts`
- Test: `src/decisions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `src/decisions.test.ts`: `issue`, `pr`, `snapshot` from `../test/helpers.ts`; `fmt` from `./ledger.ts`; `planDecisionResumes` from `./decisions.ts`; `type ClosedDecision` from `./types.ts`. Then append:

```ts
const blockedTask = (over: Parameters<typeof issue>[0] = {}) =>
  issue({
    number: 5,
    labels: ["phase:1", "blocked"],
    comments: [comment("blocked by builder: see #40", hoursAgo(4))],
    ...over,
  });

const closed = (over: Partial<ClosedDecision> = {}): ClosedDecision => ({
  number: 40,
  body: "## Question\nX?\n\nBlocks: #5",
  stateReason: "COMPLETED",
  closedAt: hoursAgo(1),
  comments: [comment("Settled: B — Use REST", hoursAgo(1))],
  ...over,
});

describe("planDecisionResumes", () => {
  it("resumes the blocked task with the settled answer and its PR", () => {
    const s = snapshot({ issues: [blockedTask()], prs: [pr({ number: 77, issue: 5 })] });
    expect(planDecisionResumes(s, [closed()])).toEqual([
      { task: 5, itemId: "PVTI_5", pr: 77, decisions: [{ number: 40, answer: "B — Use REST" }] },
    ]);
  });

  it("resumes with no answer when the decision was closed by hand", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ comments: [] })])[0]?.decisions).toEqual([
      { number: 40, answer: null },
    ]);
  });

  it("does nothing for a decision closed as not planned", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ stateReason: "NOT_PLANNED" })])).toEqual([]);
  });

  it("does nothing without a Blocks line", () => {
    const s = snapshot({ issues: [blockedTask()] });
    expect(planDecisionResumes(s, [closed({ body: "Options A/B, see #5" })])).toEqual([]);
  });

  it("does nothing when the task is not blocked, or not open in the snapshot", () => {
    expect(planDecisionResumes(snapshot({ issues: [blockedTask({ labels: ["phase:1"] })] }), [closed()])).toEqual([]);
    expect(planDecisionResumes(snapshot({ issues: [] }), [closed()])).toEqual([]);
  });

  it("waits while another open decision still blocks the same task", () => {
    const other = issue({ number: 41, labels: ["decision", "needs-owner"], body: "Blocks: #5" });
    const s = snapshot({ issues: [blockedTask(), other] });
    expect(planDecisionResumes(s, [closed()])).toEqual([]);
  });

  it("does not resume twice for the same decision", () => {
    const task = blockedTask({
      comments: [
        comment("blocked by builder: see #40", hoursAgo(4)),
        comment(fmt.decisionResumed("mac-a", 40, "B"), hoursAgo(0.5)),
      ],
    });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });

  it("ignores a decision closed before the task's latest block", () => {
    // Settled and consumed earlier, then the task was blocked again for another reason.
    const task = blockedTask({ comments: [comment("blocked by foreman@mac-a: fix rounds spent", hoursAgo(0.5))] });
    expect(planDecisionResumes(snapshot({ issues: [task] }), [closed()])).toEqual([]);
  });

  it("folds two closed decisions for one task into one resume, lowest number first", () => {
    const s = snapshot({ issues: [blockedTask()] });
    const out = planDecisionResumes(s, [
      closed({ number: 42, comments: [comment("Settled: A")] }),
      closed(),
    ]);
    expect(out).toEqual([
      {
        task: 5,
        itemId: "PVTI_5",
        pr: null,
        decisions: [
          { number: 40, answer: "B — Use REST" },
          { number: 42, answer: "A" },
        ],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/decisions.test.ts`
Expected: FAIL — `planDecisionResumes` not exported.

- [ ] **Step 3: Implement**

In `src/decisions.ts`, extend the imports:

```ts
import { decisionResumed, lastBlockedAt } from "./ledger.ts";
import type { ClosedDecision, Comment, Snapshot } from "./types.ts";
```

and append:

```ts
export interface DecisionResume {
  task: number;
  itemId: string | null;
  pr: number | null;
  /** Every closed decision this resume consumes, lowest number first. */
  decisions: Array<{ number: number; answer: string | null }>;
}

/**
 * Which blocked tasks the closed decisions release. A decision counts once (the ledger says so),
 * only when closed as completed, only after the task's latest `blocked by …` comment — so a task
 * blocked again for another reason is not released by an old answer — and only once no open
 * decision still names the same task.
 */
export function planDecisionResumes(s: Snapshot, closed: ClosedDecision[]): DecisionResume[] {
  const stillOpen = new Set(
    s.issues
      .filter((i) => i.state === "OPEN" && i.labels.includes("decision"))
      .map((i) => parseBlocks(i.body))
      .filter((n): n is number => n !== null),
  );
  const byTask = new Map<number, DecisionResume>();
  for (const d of [...closed].sort((a, b) => a.number - b.number)) {
    if (d.stateReason !== "COMPLETED") continue;
    const n = parseBlocks(d.body);
    if (n === null || stillOpen.has(n)) continue;
    const task = s.issues.find((i) => i.number === n);
    if (!task || task.state !== "OPEN" || !task.labels.includes("blocked")) continue;
    if (decisionResumed(task.comments, d.number)) continue;
    const blockedAt = lastBlockedAt(task.comments);
    if (blockedAt !== null && d.closedAt <= blockedAt) continue;
    const r = byTask.get(n) ?? {
      task: n,
      itemId: task.itemId,
      pr: s.prs.find((p) => p.issue === n)?.number ?? null,
      decisions: [],
    };
    r.decisions.push({ number: d.number, answer: settledAnswer(d.comments) });
    byTask.set(n, r);
  }
  return [...byTask.values()].sort((a, b) => a.task - b.task);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/decisions.test.ts`
Expected: PASS (all `parseBlocks`, `settledAnswer`, `planDecisionResumes` tests).

- [ ] **Step 5: Commit**

```bash
git add src/decisions.ts src/decisions.test.ts
git commit -m "feat(decisions): plan which blocked tasks a closed decision resumes"
```

---

### Task 6: Apply resumes

**Files:**
- Modify: `src/decisions.ts`
- Test: `src/decisions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `resumeSettledDecisions`, `type DecisionGh` to the `./decisions.ts` import and append:

```ts
describe("resumeSettledDecisions", () => {
  function fakeGh(closedDecisions: ClosedDecision[]) {
    const calls: string[] = [];
    const gh: DecisionGh = {
      listClosedDecisions: async (since) => {
        calls.push(`listClosedDecisions ${since}`);
        return closedDecisions;
      },
      removeLabels: async (kind, n, labels) => {
        calls.push(`removeLabels ${kind} ${n} ${labels.join(",")}`);
      },
      comment: async (kind, n, body) => {
        calls.push(`comment ${kind} ${n} ${body}`);
      },
      setStatus: async (itemId, status) => {
        calls.push(`setStatus ${itemId} ${status}`);
      },
      addToProject: async (n) => `PVTI_new_${n}`,
    };
    return { gh, calls };
  }

  it("reads nothing when no open issue is blocked", async () => {
    const { gh, calls } = fakeGh([closed()]);
    expect(await resumeSettledDecisions(gh, snapshot({ issues: [issue({ number: 5 })] }))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("looks back seven days and unblocks with one ledger line per decision", async () => {
    const { gh, calls } = fakeGh([closed(), closed({ number: 42, comments: [] })]);
    const s = snapshot({ issues: [blockedTask()], prs: [pr({ number: 77, issue: 5 })] });
    expect(await resumeSettledDecisions(gh, s)).toEqual([5]);
    expect(calls).toEqual([
      "listClosedDecisions 2026-08-27",
      "removeLabels issue 5 blocked",
      "removeLabels pr 77 reviewer:changes,validator:failed",
      "setStatus PVTI_5 Ready",
      "comment issue 5 decision #40 settled: B — Use REST — resumed by foreman@mac-a",
      "comment issue 5 decision #42 closed; read it before continuing — resumed by foreman@mac-a",
    ]);
  });
});
```

(`snapshot()` uses host `mac-a` and now `2026-09-03T12:00:00Z`; seven days back is `2026-08-27`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/decisions.test.ts`
Expected: FAIL — `resumeSettledDecisions` not exported.

- [ ] **Step 3: Implement**

In `src/decisions.ts`, extend the imports:

```ts
import type { GitHubApi } from "./github.ts";
import { decisionResumed, fmt, lastBlockedAt } from "./ledger.ts";
import { log } from "./log.ts";
import { applyUnblock, type UnblockGh } from "./needs-you.ts";
```

and append:

```ts
/** How far back closed decisions are read; an older one resumes nothing. */
export const DECISION_LOOKBACK_DAYS = 7;

export type DecisionGh = UnblockGh & Pick<GitHubApi, "listClosedDecisions">;

/**
 * Resumes every blocked task whose decision was settled: the same edits as the owner's Unblock
 * (label, PR verdicts, Status Ready) with a `decision #D …` ledger line in place of
 * `unblocked by owner`, plus one more line per extra decision it consumes. Returns the tasks
 * resumed. Every write goes through `gh`, so `dryRun` writes nothing.
 */
export async function resumeSettledDecisions(gh: DecisionGh, s: Snapshot): Promise<number[]> {
  // Nothing is blocked, so nothing can be resumed: an idle board spends no call on this.
  if (!s.issues.some((i) => i.state === "OPEN" && i.labels.includes("blocked"))) return [];
  const since = new Date(Date.parse(s.now) - DECISION_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const resumes = planDecisionResumes(s, await gh.listClosedDecisions(since));
  for (const r of resumes) {
    const [first, ...rest] = r.decisions;
    if (!first) continue;
    await applyUnblock(
      gh,
      { issue: r.task, itemId: r.itemId, host: s.host, pr: r.pr },
      fmt.decisionResumed(s.host, first.number, first.answer),
    );
    for (const d of rest)
      await gh.comment("issue", r.task, fmt.decisionResumed(s.host, d.number, d.answer));
    log("info", "decision resumed task", {
      task: r.task,
      decisions: r.decisions.map((d) => d.number),
    });
  }
  return resumes.map((r) => r.task);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions.ts src/decisions.test.ts
git commit -m "feat(decisions): resume tasks whose decision was settled"
```

---

### Task 7: Run it every tick

**Files:**
- Modify: `src/loop.ts` (`runOnce`, right after `await ctx.notify.syncDecisions(snapshot.issues);`)
- Test: `src/loop.test.ts` (inside the `describe` that holds "runOnce hands the tick's issues to syncDecisions…")

- [ ] **Step 1: Write the failing tests**

Add `comment` and `hoursAgo` to the `../test/helpers.ts` import in `src/loop.test.ts` if absent, then add next to the syncDecisions test:

```ts
  it("runOnce resumes a task whose decision was settled", async () => {
    const task = issue({
      number: 5,
      labels: ["phase:1", "blocked"],
      comments: [comment("blocked by builder: see #40", hoursAgo(4))],
    });
    const { gh, calls } = fakeGh(
      [task],
      [
        {
          number: 40,
          body: "Blocks: #5",
          stateReason: "COMPLETED",
          closedAt: hoursAgo(1),
          comments: [comment("Settled: B — Use REST", hoursAgo(1))],
        },
      ],
    );
    await runOnce(ctx({ gh, exec: okExec, notify: recordNotify().port, stateDir: tmp() }));
    expect(calls).toContain("removeLabels issue 5 blocked");
    expect(calls).toContain("setStatus PVTI_5 Ready");
    expect(calls).toContain(
      "comment issue 5 decision #40 settled: B — Use REST — resumed by foreman@mac-a",
    );
  });

  it("runOnce survives a failed decision read", async () => {
    const task = issue({ number: 5, labels: ["phase:1", "blocked"] });
    const { gh } = fakeGh([task]);
    gh.listClosedDecisions = async () => {
      throw new Error("gh issue list failed (1): HTTP 502");
    };
    await expect(
      runOnce(ctx({ gh, exec: okExec, notify: recordNotify().port, stateDir: tmp() })),
    ).resolves.toBeDefined();
  });
```

Note: the `rec` helper joins arguments with `String`, so `removeLabels("issue", 5, ["blocked"])` records as `removeLabels issue 5 blocked`. The fake ignores the `since` date, so these tests do not depend on `ctx()`'s clock.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/loop.test.ts -t "decision"`
Expected: the first new test FAILS (no `removeLabels issue 5 blocked`); the second passes or fails depending on order — both must pass after Step 3.

- [ ] **Step 3: Implement**

In `src/loop.ts`, add the import:

```ts
import { resumeSettledDecisions } from "./decisions.ts";
```

and directly after `await ctx.notify.syncDecisions(snapshot.issues);`:

```ts
  // A settled decision resumes the task it blocked. The snapshot still shows that task blocked,
  // so the picker claims it next tick. A failed read or write is logged and never costs the
  // tick: the decision stays closed and the next tick tries again.
  try {
    await resumeSettledDecisions(ctx.gh, snapshot);
  } catch (e) {
    log("warn", "decision resume failed", { error: e instanceof Error ? e.message : String(e) });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/loop.test.ts`
Expected: PASS (whole file — the existing syncDecisions test must still record `[[1, 40]]`).

- [ ] **Step 5: Commit**

```bash
git add src/loop.ts src/loop.test.ts
git commit -m "feat(loop): resume tasks whose decision was settled each tick"
```

---

### Task 8: Builder writes the fixed decision layout

**Files:**
- Modify: `roles/builder.md` (step 2)
- Test: `src/roles.test.ts` (inside `describe("role prompts")`)

- [ ] **Step 1: Write the failing test**

Add inside `describe("role prompts", …)`:

```ts
  it("builder writes decisions in the layout the foreman and decisions page parse", () => {
    const builder = readFileSync(join(dir, "builder.md"), "utf8");
    for (const s of ["## Question", "## Context", "## Options", "### A:", "### B:", "## Recommendation", "Blocks: #<issue>"])
      expect(builder, s).toContain(s);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/roles.test.ts`
Expected: FAIL — `builder.md` lacks `## Question`.

- [ ] **Step 3: Implement**

In `roles/builder.md`, replace step 2 with:

````markdown
2. If the issue is ambiguous in a way that changes the outcome, do not guess. Open a decision issue. Write this to `.gh-body.md`, with at least two options, and `Blocks:` alone on the last line:

   ```
   ## Question
   <one sentence>

   ## Context
   <what you found, and a link to #<issue>>

   ## Options
   ### A: <short label>
   <trade-offs>

   ### B: <short label>
   <trade-offs>

   ## Recommendation
   <letter, and why>

   Blocks: #<issue>
   ```

   then `gh issue create --title "Decision: <question>" --label "decision,needs-owner,phase:<N>" --body-file .gh-body.md`, then `gh issue edit <issue> --add-label blocked`, comment why, and return `blocked` with the decision issue number in notes. When the decision is settled the foreman resumes this issue and quotes the answer in a `decision #<n> settled: …` comment; read it before anything else. For small ambiguities pick the simplest interpretation and state it in the PR body.
````

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/roles.test.ts`
Expected: PASS, including "no base file names a repository's own tooling".

- [ ] **Step 5: Commit**

```bash
git add roles/builder.md src/roles.test.ts
git commit -m "feat(roles): builder writes decisions in a fixed layout with Blocks line"
```

---

### Task 9: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Outcome table**

In `### Outcome → labels / status`, after the `| builder \`blocked\` | issue \`blocked\`, unassigned |` row, add:

```markdown
| (foreman) `decision` issue with `Blocks: #N` closed as completed | #N unblocked → Ready, `decision #<d> settled: <answer> — resumed by foreman@<host>` |
```

- [ ] **Step 2: Ledger grammar block**

In the ledger grammar code block, after `unblocked by owner via foreman@<host>`, add:

```
decision #<d> settled: <answer> — resumed by foreman@<host>
decision #<d> closed; read it before continuing — resumed by foreman@<host>
```

- [ ] **Step 3: Needs-you paragraph**

After the bullet that ends `…because nothing else about the issue changes.`, add:

```markdown
- **Settled decisions resume their task:** a builder's decision issue ends in `Blocks: #<issue>`.
  Close it as **completed** and, on its next tick, the foreman does what Unblock does to that issue
  and comments `decision #<d> settled: <answer> — resumed by foreman@<host>`, quoting the first
  comment that starts `Settled: `, or `decision #<d> closed; read it before continuing` when there
  is none. Close it as **not planned** to leave the task blocked. It waits while another open
  decision still names the same task, ignores decisions closed more than 7 days ago or before the
  task's latest `blocked by …` comment, and resumes once per decision. Decisions written before
  this layout have no `Blocks:` line and still need Unblock.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): decision auto-resume"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green. Fix any Biome formatting with `pnpm biome check --write src` and re-run.

- [ ] **Step 2: Repository-specific names check**

Run: `grep -rniE "pnpm|supabase|docker|playwright" src roles settings`
Expected: only `src/repo-config.ts`.

- [ ] **Step 3: Dry run against a served repository (live, read-only)**

```bash
npm link && pnpm build
foreman -p <name> run --once --dry-run
```

Expected: tick completes; if the repo has a blocked issue, the log shows the `gh issue list … --label decision --state closed` read and any resume as `dry-run: gh` lines, with nothing written.

- [ ] **Step 4: Live check (owner-approved, on a test issue)**

On a served repository: create a task issue labelled `blocked` with a `blocked by builder: test` comment, then a decision issue whose body ends `Blocks: #<task>`, comment `Settled: A — test`, close it as completed. Within one tick the task should lose `blocked`, move to Ready and carry `decision #<d> settled: A — test — resumed by foreman@<host>`. Record the result in the PR body as verified live, or say it was not run.
