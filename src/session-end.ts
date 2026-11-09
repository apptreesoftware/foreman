import type { Activity } from "./stream.ts";

/**
 * Why a `claude -p` session ended without an outcome, when the API rather than the task stopped
 * it. Both refusals arrive as `subtype: "success"`, so the subtype says nothing here.
 */
export type EndCause = "usage_limit" | "safeguard" | "other";

export interface SessionEnd {
  cause: EndCause;
  /** The API request id a refusal names (`req_…`), for the block comment; null when absent. */
  requestId: string | null;
  /** When the spent usage window resets, from the rate-limit event; null when unknown. */
  resetsAt: string | null;
}

/*
 * Every match on the API's wording lives in this block, and nowhere else in the package: that
 * wording changes, and when it does this is the one place to follow it.
 */
const USAGE_LIMIT_TEXT = /hit your .*limit/i;
const SAFEGUARD_TEXT = /safeguards flagged/i;
const REQUEST_ID = /\breq_[A-Za-z0-9]+/;
/** The `error` field Claude Code puts on the synthetic message that announces a usage limit. */
const USAGE_LIMIT_API_ERROR = "rate_limit";

/** A window is spent at utilization 1; the rate-limit event reports 0–1. */
const SPENT = 1;

/**
 * When the spent window resets: the later reset when both are spent. Null while every window
 * still has room, or when the event named no reset for the spent one.
 */
export function exhaustedResetAt(activity: Activity): string | null {
  const r = activity.rateLimit;
  if (!r) return null;
  const spent = [
    r.fiveHour >= SPENT ? r.resetsAt : undefined,
    r.sevenDay >= SPENT ? r.sevenDayResetsAt : undefined,
  ];
  if (spent.every((x) => x === undefined)) return null;
  const known = spent.filter((x): x is string => typeof x === "string");
  return known.sort().at(-1) ?? null;
}

function spentWindow(activity: Activity): boolean {
  const r = activity.rateLimit;
  return r !== null && (r.fiveHour >= SPENT || r.sevenDay >= SPENT);
}

/**
 * Pure. The texts are the result line's `result`, the last streamed assistant text, and stderr,
 * in that order; the first is the only one that carries a refusal's full `Request ID:` line.
 */
export function classifyEnd(
  result: { resultText: string | null; stderr: string },
  activity: Activity,
): SessionEnd {
  const texts = [result.resultText ?? "", activity.lastText?.text ?? "", result.stderr];
  const requestId =
    texts.map((t) => REQUEST_ID.exec(t)?.[0]).find((x): x is string => x !== undefined) ?? null;
  if (texts.some((t) => SAFEGUARD_TEXT.test(t)))
    return { cause: "safeguard", requestId, resetsAt: null };
  if (
    texts.some((t) => USAGE_LIMIT_TEXT.test(t)) ||
    activity.lastApiError === USAGE_LIMIT_API_ERROR ||
    spentWindow(activity)
  ) {
    // The text names a local clock time ("resets 3:50pm (America/Los_Angeles)"); the event's
    // epoch is the reliable one. With no spent window on record, the five-hour reset is the
    // limit the text is about, as long as it is still ahead of the session's last event.
    const resetsAt = exhaustedResetAt(activity) ?? activity.rateLimit?.resetsAt ?? null;
    return { cause: "usage_limit", requestId, resetsAt };
  }
  return { cause: "other", requestId: null, resetsAt: null };
}

/** Past the reset by this much, so the first session after it does not race the API's clock. */
export const PAUSE_MARGIN_MS = 2 * 60_000;
/**
 * How long to pause when the reset time is unknown or already behind us. Without a floor a
 * stale reset would let the next tick dispatch straight into the same refusal.
 */
export const PAUSE_FALLBACK_MS = 30 * 60_000;

export function pauseUntil(resetsAt: string | null, now: string): string {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const t =
    Number.isFinite(at) && at > Date.parse(now)
      ? at + PAUSE_MARGIN_MS
      : Date.parse(now) + PAUSE_FALLBACK_MS;
  return new Date(t).toISOString();
}

/** `22:52Z` within a day of `now`; `2026-11-13 00:02Z` for a weekly reset further out. */
export function formatResetAt(iso: string, now: string): string {
  const clock = `${iso.slice(11, 16)}Z`;
  return Date.parse(iso) - Date.parse(now) < 24 * 3600_000 ? clock : `${iso.slice(0, 10)} ${clock}`;
}

/** The pause reason the daemon stores, and preflight, `status` and the page show. */
export const USAGE_LIMIT_REASON = "usage limit";

/**
 * The one-line reason for a block or a notification when a dispatch ended without an outcome.
 * `other` keeps the exact wording foreman has always used.
 */
export function endReason(r: {
  timedOut: boolean;
  subtype: string;
  end?: SessionEnd;
  /** The request id of each flagged session, in order; null where the error named none. */
  flagged?: (string | null)[];
}): string {
  if (r.end?.cause === "safeguard") {
    const flagged = r.flagged ?? [r.end.requestId];
    const ids = flagged.filter((x): x is string => x !== null);
    const n = flagged.length;
    return `safeguard flag on ${n} session${n === 1 ? "" : "s"}${ids.length ? ` (${ids.join(", ")})` : ""}`;
  }
  if (r.end?.cause === "usage_limit") return USAGE_LIMIT_REASON;
  return `${r.timedOut ? "timed out" : r.subtype} after retries`;
}
