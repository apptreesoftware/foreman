import { overlayCurrent } from "./board.ts";
import { formatBudget } from "./budget.ts";
import { type SessionLogEntry, todayStats } from "./sessions.ts";
import {
  type Board,
  type BudgetReport,
  CAP_CHOICES,
  type CurrentSession,
  type ForemanState,
  type StopMode,
} from "./state-file.ts";
import { liveWaits } from "./waiting.ts";

export type DaemonState = "RUNNING" | "STOPPED" | "CRASHED" | "UNKNOWN";

/**
 * What the daemon is doing right now, as opposed to "is a session recorded this instant". Between
 * a session ending and the next tick the foreman sleeps `pollSeconds`, which used to read as
 * "idle" even with work queued; `idle` is now reserved for a tick that found nothing eligible
 * (#206). `parked` is the daemon returning early from every tick because preflight fails — the
 * daily cap, `STOP`, a failing preflight hook, the GraphQL budget — which is neither idle nor
 * between ticks (#213).
 */
export type NowPhase = "session" | "parked" | "ticking" | "between_ticks" | "idle";

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
  /** `model` from foreman.json; the state file's `model` overrides it while set (#210). */
  configModel: string;
  /** The repo's `models`; the page and `ctl status` offer these as one-click choices. */
  modelChoices: readonly string[];
}

export interface StatusReport {
  host: string;
  repo: string;
  /** When the report was taken, so `formatStatus` can render durations, not bare clock times. */
  now: string;
  daemon: DaemonState;
  pid: number | null;
  uptimeMinutes: number | null;
  launchdInstalled: boolean;
  stopPresent: boolean;
  nowPhase: NowPhase;
  /** What the next session will run as, where it came from, and the page's one-click choices. */
  model: {
    current: string;
    /** What foreman.json says, kept so the page and `ctl status` can name what an override hides. */
    configured: string;
    source: "config" | "override";
    choices: readonly string[];
  };
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
  /** The daily session cap the next tick will enforce, and the page's one-click choices (#213). */
  cap: {
    current: number;
    configured: number;
    source: "config" | "override";
    choices: readonly number[];
  };
}

export const RECENT_LIMIT = 5;

const minutesBetween = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

/** A planned action that is not `idle(...)` means the last tick had real work to do. */
const hadWork = (lastPlan: string[] | null) => (lastPlan ?? []).some((a) => !a.startsWith("idle("));

function nowPhaseOf(
  daemon: DaemonState,
  hasSession: boolean,
  nextTickAt: string | null,
  lastPlan: string[] | null,
  now: string,
  preflightOk: boolean,
): NowPhase {
  if (hasSession) return "session";
  // A daemon that is not RUNNING has no tick coming, whatever the last plan said.
  if (daemon !== "RUNNING" || !nextTickAt) return "idle";
  // Preflight runs first in every tick and returns early on failure, so until the condition
  // clears the daemon does nothing at all — it is parked, not resting between ticks.
  if (!preflightOk) return "parked";
  if (Date.parse(nextTickAt) <= Date.parse(now)) return "ticking";
  return hadWork(lastPlan) ? "between_ticks" : "idle";
}

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
  // The override is what the next tick's preflight will actually enforce, so the cap wait item
  // and the reported cap must both use it — otherwise raising the cap leaves a stale "capped"
  // on the page until the next tick rebuilds the board (#213).
  const cap = s?.maxSessionsPerDay ?? i.maxSessionsPerDay;
  const live = liveWaits({
    host: i.host,
    preflight: s?.lastPreflight ?? null,
    stopPresent: i.stopPresent,
    todayCount: today.count,
    cap,
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
          needsYou: stored?.needsYou ?? [],
          phases: stored?.phases ?? [],
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
    now: i.now,
    daemon,
    pid: s?.pid ?? null,
    uptimeMinutes: s && daemon === "RUNNING" ? minutesBetween(s.startedAt, i.now) : null,
    launchdInstalled: i.launchdInstalled,
    stopPresent: i.stopPresent,
    nowPhase: nowPhaseOf(
      daemon,
      current !== null,
      s?.nextTickAt ?? null,
      s?.lastPlan ?? null,
      i.now,
      s?.lastPreflight?.ok ?? true,
    ),
    cap: {
      current: cap,
      configured: i.maxSessionsPerDay,
      source: s?.maxSessionsPerDay ? "override" : "config",
      choices: CAP_CHOICES,
    },
    model: {
      current: s?.model ?? i.configModel,
      configured: i.configModel,
      source: s?.model ? "override" : "config",
      choices: i.modelChoices,
    },
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
    today: { count: today.count, cap, spendUsd: today.spendUsd },
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
      "       no state.json: the running daemon predates this feature; restart it to get state, the page, and ctl stop/abort",
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
  } else if (r.nowPhase === "parked")
    lines.push(
      `now    parked · ${r.tick?.preflight?.reason ?? "preflight failed"}   (retrying every tick)`,
    );
  else if (r.nowPhase === "between_ticks")
    lines.push(`now    between ticks · next ${hhmm(r.tick?.nextAt ?? null)}`);
  else if (r.nowPhase === "ticking") lines.push("now    ticking");
  else if (r.daemon === "RUNNING") lines.push("now    idle");
  if (r.orphan) lines.push(`ORPHAN child ${r.orphan.pid} still running for #${r.orphan.issue}`);
  if (r.unfinished)
    lines.push(
      `UNFINISHED ${r.unfinished.mode} bookkeeping for ${r.unfinished.role} #${r.unfinished.issue}; run ctl abort`,
    );
  lines.push(`next   ${r.lastPlan ? r.lastPlan.join(", ") : "–"}   (as of last tick)`);
  // How far the phase has come and what it has cost, so a glance answers "are we nearly there"
  // and "what has this phase spent" without opening GitHub (#226).
  const phases = r.board?.phases ?? [];
  if (phases.length)
    for (const p of phases)
      lines.push(
        `phase  #${p.epic} phase ${p.phase} ${p.title}   ${p.tasksDone}/${p.tasksTotal} tasks   $${p.spendUsd.toFixed(2)} over ${p.sessions} sessions   median ${
          p.medianMergeMinutes === null
            ? "–"
            : `${mins(p.medianMergeMinutes)} claim→merge (${p.mergedTasks} merged)`
        }`,
      );
  else lines.push("phase  no approved phase in flight");
  if (r.board?.waiting.length)
    lines.push(`waiting  ${r.board.waiting.map((w) => w.detail).join(" · ")}`);
  // Always printed, empty state included: an owner who cannot see this list does not know they
  // are the thing holding the queue up (#224). The wait is a duration, not a clock time: these
  // rows routinely sit for days, and `hhmm` cannot say anything past 24h.
  const needsYou = r.board?.needsYou ?? [];
  lines.push(
    `needs you  ${
      needsYou.length
        ? needsYou
            .map(
              (n) =>
                `#${n.issue} ${n.labels.join(",")} ${n.title} (waiting ${mins(minutesBetween(n.since, r.now))})`,
            )
            .join(" · ")
        : "nothing"
    }`,
  );
  lines.push(
    `recent ${
      r.recent.length
        ? r.recent
            .map((e) => `${hhmm(e.t)} ${e.role} #${e.issue} ${e.outcome} $${e.costUsd.toFixed(2)}`)
            .join(" | ")
        : "none"
    }`,
  );
  lines.push(
    `model  ${r.model.current}${
      r.model.source === "override" ? ` (override; foreman.json says ${r.model.configured})` : ""
    }`,
  );
  lines.push(`today  ${r.today.count} of ${r.today.cap} sessions, $${r.today.spendUsd.toFixed(2)}`);
  if (r.budget) lines.push(`budget ${formatBudget(r.budget)}`);
  return `${lines.join("\n")}\n`;
}
