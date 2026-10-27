import { localDate } from "./preflight.ts";
import type { SessionLogEntry } from "./sessions.ts";
import type { Board } from "./state-file.ts";

/** Local dates (`YYYY-MM-DD`), both ends inclusive; null is open on that side. */
export interface SessionRange {
  from: string | null;
  to: string | null;
}

/** What the Session tab shows for one range of `sessions.log`. */
export interface SessionHistory {
  from: string | null;
  to: string | null;
  totals: { spendUsd: number; sessions: number; issues: number };
  daily: { date: string; spendUsd: number; sessions: number }[];
  byRole: { role: string; spendUsd: number; sessions: number }[];
  byIssue: {
    issue: number;
    title: string;
    roles: string[];
    sessions: number;
    lastAt: string;
    costUsd: number;
    entries: SessionLogEntry[];
  }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD` form; `2026-02-30` is not one. */
function isDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The query string's range, or null when either bound is not a date or they are out of order. */
export function parseRange(from: string | null, to: string | null): SessionRange | null {
  if ((from !== null && !isDate(from)) || (to !== null && !isDate(to))) return null;
  if (from !== null && to !== null && from > to) return null;
  return { from, to };
}

/** Every date from `a` to `b` inclusive, stepping in UTC so a DST change cannot skip a day. */
function datesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${a}T00:00:00Z`); d.toISOString().slice(0, 10) <= b; ) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}

/** Titles the board knows for open issues and epics, for history rows logged without one. */
export function boardTitles(board: Board | null): Map<number, string> {
  const titles = new Map<number, string>();
  if (!board) return titles;
  for (const r of board.pipeline) titles.set(r.issue, r.title);
  for (const n of board.needsYou) titles.set(n.issue, n.title);
  for (const o of board.owner) titles.set(o.epic, o.title);
  for (const i of board.issues) titles.set(i.issue, i.title);
  return titles;
}

/**
 * Spend and sessions over a range of the log, counted per line the way `todayStats` counts them
 * for the daily cap, so the two figures on the page agree. A row's title comes from the newest
 * line for that issue that recorded one (anywhere in the log), else the board, else `#N`.
 */
export function describeSessionHistory(
  entries: SessionLogEntry[],
  range: SessionRange,
  openTitles: ReadonlyMap<number, string>,
): SessionHistory {
  const dayOf = (e: SessionLogEntry) => localDate(new Date(e.t));
  const inRange = entries
    .filter((e) => {
      const d = dayOf(e);
      return (range.from === null || d >= range.from) && (range.to === null || d <= range.to);
    })
    .sort((a, b) => a.t.localeCompare(b.t));
  const logged = new Map<number, string>();
  for (const e of [...entries].sort((a, b) => a.t.localeCompare(b.t)))
    if (e.title) logged.set(e.issue, e.title);

  const spend = (xs: SessionLogEntry[]) => xs.reduce((s, e) => s + e.costUsd, 0);
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  const daily =
    first && last
      ? datesBetween(range.from ?? dayOf(first), range.to ?? dayOf(last)).map((date) => {
          const day = inRange.filter((e) => dayOf(e) === date);
          return { date, spendUsd: spend(day), sessions: day.length };
        })
      : [];

  const roles = new Map<string, SessionLogEntry[]>();
  const issues = new Map<number, SessionLogEntry[]>();
  for (const e of inRange) {
    roles.set(e.role, [...(roles.get(e.role) ?? []), e]);
    issues.set(e.issue, [...(issues.get(e.issue) ?? []), e]);
  }
  return {
    from: range.from,
    to: range.to,
    totals: { spendUsd: spend(inRange), sessions: inRange.length, issues: issues.size },
    daily,
    byRole: [...roles]
      .map(([role, xs]) => ({ role, spendUsd: spend(xs), sessions: xs.length }))
      .sort((a, b) => b.spendUsd - a.spendUsd),
    byIssue: [...issues]
      .map(([issue, xs]) => ({
        issue,
        title: logged.get(issue) ?? openTitles.get(issue) ?? `#${issue}`,
        roles: [...new Set(xs.map((e) => e.role))],
        sessions: xs.length,
        lastAt: (xs[xs.length - 1] as SessionLogEntry).t,
        costUsd: spend(xs),
        entries: [...xs].reverse(),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}
