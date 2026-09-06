import { modelOf } from "./github.ts";
import { parseClaim } from "./ledger.ts";
import type { MergeRecord, SessionLogEntry } from "./sessions.ts";
import type { PhaseProgress, PhaseTask } from "./state-file.ts";
import type { Epic, Issue, Snapshot } from "./types.ts";

/** What the planner writes in every task body it creates (`.claude/roles/planner.md`). */
const PARENT = /^Parent epic:\s*#(\d+)\s*$/m;

/**
 * The task issues of one epic: its sub-issues (linked when the plan was applied, so closed tasks
 * are included) plus any open issue whose body names the epic as its parent — which catches a
 * task created by hand, or one whose sub-issue link never landed.
 */
export function taskNumbersOf(e: Epic, issues: Issue[]): Set<number> {
  const tasks = new Set(e.taskNumbers);
  for (const i of issues) {
    const m = PARENT.exec(i.body);
    if (m && Number(m[1]) === e.number) tasks.add(i.number);
  }
  return tasks;
}

const MERGED = /^merged by foreman@/;

/** Minutes from the first `claimed by` comment to the `merged by foreman@` one, if both exist. */
function ledgerSpanMinutes(i: Issue): number | null {
  const sorted = [...i.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const claimed = sorted.find((c) => parseClaim(c.body) !== null);
  const merged = sorted.find((c) => MERGED.test(c.body.trim()));
  if (!claimed || !merged) return null;
  return minutesBetween(claimed.createdAt, merged.createdAt);
}

const minutesBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * How far each approved, open phase has come and what it has cost: tasks done of total, spend
 * from `sessions.log`, and the median claim→merge time of its merged tasks. Pure, and computed
 * from the tick's snapshot plus the two local logs, so the card costs no extra GitHub reads.
 */
export function phaseProgress(
  s: Snapshot,
  sessions: SessionLogEntry[],
  merges: MergeRecord[],
): PhaseProgress[] {
  return [...s.epics]
    .filter((e) => e.state === "OPEN" && e.labels.includes("plan-approved"))
    .sort((a, b) => a.phase - b.phase || a.number - b.number)
    .map((e) => {
      const tasks = taskNumbersOf(e, s.issues);
      // An issue the snapshot still lists is open (the snapshot is `gh issue list --state open`),
      // so every other task under the epic has been closed — i.e. done.
      const open = new Set([...tasks].filter((n) => s.issues.some((i) => i.number === n)));
      const mine = sessions.filter((x) => tasks.has(x.issue));
      // The ledger wins over the local record: a re-opened or re-merged issue's comments are the
      // truth, and the record was written from an earlier merge of the same issue.
      const spans = new Map<number, number>();
      for (const m of merges) {
        if (!tasks.has(m.issue) || !m.claimedAt) continue;
        spans.set(m.issue, minutesBetween(m.claimedAt, m.mergedAt));
      }
      for (const i of s.issues) {
        if (!tasks.has(i.number)) continue;
        const span = ledgerSpanMinutes(i);
        if (span !== null) spans.set(i.number, span);
      }
      return {
        epic: e.number,
        phase: e.phase,
        title: s.issues.find((i) => i.number === e.number)?.title ?? `#${e.number}`,
        tasksTotal: tasks.size,
        tasksDone: tasks.size - open.size,
        spendUsd: mine.reduce((sum, x) => sum + x.costUsd, 0),
        sessions: mine.length,
        medianMergeMinutes: median([...spans.values()]),
        mergedTasks: spans.size,
        tasks: [...tasks].sort((a, b) => a - b).map((n) => taskRow(n, s.issues)),
      };
    });
}

/** One task as the page lists it; a closed task has left the snapshot and keeps only its number. */
function taskRow(n: number, issues: Issue[]): PhaseTask {
  const i = issues.find((x) => x.number === n);
  return i
    ? { issue: n, title: i.title, status: i.status, closed: false, model: modelOf(i.labels) }
    : { issue: n, title: `#${n}`, status: null, closed: true, model: null };
}
