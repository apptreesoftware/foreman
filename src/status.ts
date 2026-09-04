import { overlayCurrent } from "./board.ts";
import { formatBudget } from "./budget.ts";
import { type SessionLogEntry, todayStats } from "./sessions.ts";
import type { Board, BudgetReport, CurrentSession, ForemanState, StopMode } from "./state-file.ts";
import { liveWaits } from "./waiting.ts";

export type DaemonState = "RUNNING" | "STOPPED" | "CRASHED" | "UNKNOWN";

export interface StatusInput {
  state: ForemanState | null;
  now: string;
  pidAlive: (pid: number) => boolean;
  stopPresent: boolean;
  launchdInstalled: boolean;
  sessions: SessionLogEntry[];
  maxSessionsPerDay: number;
  wallClockMinutes: number;
  host: string;
  stallMinutes: number;
  repo: string;
}

export interface StatusReport {
  host: string;
  repo: string;
  daemon: DaemonState;
  pid: number | null;
  uptimeMinutes: number | null;
  launchdInstalled: boolean;
  stopPresent: boolean;
  tick: {
    lastAt: string | null;
    nextAt: string | null;
    preflight: { ok: boolean; reason: string | null } | null;
    consecutiveFailures: number;
    blockedBySession: boolean;
  } | null;
  current:
    | (CurrentSession & {
        elapsedMinutes: number;
        limitMinutes: number;
        silentMinutes: number;
        stalled: boolean;
      })
    | null;
  orphan: { pid: number; issue: number } | null;
  stopping: ForemanState["stopping"];
  unfinished: { issue: number; mode: StopMode; role: string } | null;
  lastPlan: string[] | null;
  board: Board | null;
  budget: BudgetReport | null;
  recent: SessionLogEntry[];
  today: { count: number; cap: number; spendUsd: number };
}

export const RECENT_LIMIT = 5;

const minutesBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

export function describeStatus(i: StatusInput): StatusReport {
  const s = i.state;
  let daemon: DaemonState = "UNKNOWN";
  if (s) daemon = i.pidAlive(s.pid) ? "RUNNING" : s.exitedAt ? "STOPPED" : "CRASHED";
  const current = s?.current ?? null;
  const orphan =
    daemon !== "RUNNING" && current?.childPid && i.pidAlive(current.childPid)
      ? { pid: current.childPid, issue: current.issue }
      : null;
  const recent = [...i.sessions].sort((a, b) => b.t.localeCompare(a.t)).slice(0, RECENT_LIMIT);
  const today = todayStats(i.sessions, new Date(i.now));
  const live = liveWaits({
    host: i.host,
    preflight: s?.lastPreflight ?? null,
    stopPresent: i.stopPresent,
    todayCount: today.count,
    cap: i.maxSessionsPerDay,
  });
  const liveKinds = new Set(live.map((w) => w.kind));
  const stored = s?.board ?? null;
  let board: Board | null =
    stored || live.length
      ? {
          at: stored?.at ?? i.now,
          waiting: [...live, ...(stored?.waiting ?? []).filter((w) => !liveKinds.has(w.kind))],
          pipeline: stored?.pipeline ?? [],
          owner: stored?.owner ?? [],
          explain: stored?.explain ?? [],
          prs: stored?.prs ?? [],
        }
      : null;
  if (current && board) board = overlayCurrent(board, current, i.host);
  const silentMinutes = current
    ? minutesBetween(current.activity?.lastEventAt ?? current.startedAt, i.now)
    : 0;
  return {
    host: s?.host ?? i.host,
    repo: i.repo,
    daemon,
    pid: s?.pid ?? null,
    uptimeMinutes: s && daemon === "RUNNING" ? minutesBetween(s.startedAt, i.now) : null,
    launchdInstalled: i.launchdInstalled,
    stopPresent: i.stopPresent,
    tick: s
      ? {
          lastAt: s.lastTickAt,
          nextAt: s.nextTickAt,
          preflight: s.lastPreflight,
          consecutiveFailures: s.consecutiveFailures,
          blockedBySession: current !== null,
        }
      : null,
    current: current
      ? {
          ...current,
          elapsedMinutes: minutesBetween(current.startedAt, i.now),
          limitMinutes: i.wallClockMinutes,
          silentMinutes,
          stalled: current.activity !== null && silentMinutes >= i.stallMinutes,
        }
      : null,
    orphan,
    stopping: s?.stopping ?? null,
    unfinished: s?.unfinished
      ? { issue: s.unfinished.issue, mode: s.unfinished.mode, role: s.unfinished.role }
      : null,
    lastPlan: s?.lastPlan ?? null,
    board,
    budget: s?.budget ?? null,
    recent,
    today: { count: today.count, cap: i.maxSessionsPerDay, spendUsd: today.spendUsd },
  };
}

const hhmm = (iso: string | null) => (iso ? `${iso.slice(11, 19)}Z` : "–");
const mins = (m: number) =>
  m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatStatus(r: StatusReport): string {
  const lines: string[] = [];
  const up = r.uptimeMinutes === null ? "" : `  up ${mins(r.uptimeMinutes)}`;
  lines.push(
    `foreman ${r.host}   ${r.daemon}${r.pid ? ` pid ${r.pid}` : ""}${up}    launchd: ${
      r.launchdInstalled ? "installed" : "not installed"
    }   STOP: ${r.stopPresent ? "present" : "absent"}`,
  );
  if (r.daemon === "UNKNOWN")
    lines.push(
      "       no ~/.tone_tonic/state.json: the running daemon predates this feature; restart it to get state, the page, and ctl stop/abort",
    );
  if (r.tick) {
    const pre = r.tick.preflight
      ? r.tick.preflight.ok
        ? "preflight ok"
        : `preflight failed: ${r.tick.preflight.reason}`
      : "no tick yet";
    lines.push(
      `tick   last ${hhmm(r.tick.lastAt)}  ${pre}   next ${hhmm(r.tick.nextAt)}   backoff ${r.tick.consecutiveFailures}`,
    );
  }
  if (r.stopping) lines.push(`STOPPING (${r.stopping.mode}) since ${hhmm(r.stopping.at)}`);
  if (r.current) {
    const c = r.current;
    lines.push(
      `now    ${c.role} #${c.issue} round ${c.round} attempt ${c.attempt}  session ${c.sessionId.slice(0, 8)}  ${mins(c.elapsedMinutes)} of ${c.limitMinutes}m${c.childPid ? `  child ${c.childPid}` : ""}`,
    );
    lines.push(`       worktree ${c.worktree}  branch ${c.branch}`);
    const a = c.activity;
    if (a?.lastTool)
      lines.push(
        `doing  ${a.lastTool.name} ${a.lastTool.summary}  (${mins(c.silentMinutes)} ago)  turns ${a.turns}  tokens ${k(a.tokens.input)} in / ${k(a.tokens.output)} out`,
      );
    if (a?.lastText) lines.push(`       "${a.lastText.text}"`);
    if (c.stalled)
      lines.push(
        `STALLED  no output for ${mins(c.silentMinutes)} (limit ${c.limitMinutes}m; ctl stop to interrupt)`,
      );
  } else if (r.daemon === "RUNNING") lines.push("now    idle");
  if (r.orphan) lines.push(`ORPHAN child ${r.orphan.pid} still running for #${r.orphan.issue}`);
  if (r.unfinished)
    lines.push(
      `UNFINISHED ${r.unfinished.mode} bookkeeping for ${r.unfinished.role} #${r.unfinished.issue}; run ctl abort`,
    );
  lines.push(`next   ${r.lastPlan ? r.lastPlan.join(", ") : "–"}   (as of last tick)`);
  if (r.board?.waiting.length)
    lines.push(`waiting  ${r.board.waiting.map((w) => w.detail).join(" · ")}`);
  lines.push(
    `recent ${
      r.recent.length
        ? r.recent
            .map((e) => `${hhmm(e.t)} ${e.role} #${e.issue} ${e.outcome} $${e.costUsd.toFixed(2)}`)
            .join(" | ")
        : "none"
    }`,
  );
  lines.push(`today  ${r.today.count} of ${r.today.cap} sessions, $${r.today.spendUsd.toFixed(2)}`);
  if (r.budget) lines.push(`budget ${formatBudget(r.budget)}`);
  return `${lines.join("\n")}\n`;
}
