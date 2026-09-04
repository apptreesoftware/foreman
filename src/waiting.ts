import { parseDependsOn } from "./github.ts";
import { fixRound, openClaim } from "./ledger.ts";
import { plannerFinished } from "./phase.ts";
import { MAX_FIX_ROUNDS } from "./pick.ts";
import { WAIT_KINDS, type WaitItem } from "./state-file.ts";
import type { Snapshot } from "./types.ts";

export interface WaitingInput {
  host: string;
  preflight: { ok: boolean; reason: string | null } | null;
  stopPresent: boolean;
  todayCount: number;
  cap: number;
}

const ORDER = new Map(WAIT_KINDS.map((k, i) => [k, i]));

/** Conditions known without a snapshot; describeStatus merges these in between ticks. */
export function liveWaits(i: WaitingInput): WaitItem[] {
  const out: WaitItem[] = [];
  const capped = i.todayCount >= i.cap;
  if (i.stopPresent)
    out.push({
      kind: "stop",
      subject: "STOP",
      detail: "STOP file present; ctl go to resume",
      since: null,
    });
  // The cap message already explains why preflight failed, so a capped day does not also emit
  // the preflight item.
  else if (!capped && i.preflight && !i.preflight.ok)
    out.push({
      kind: "preflight",
      subject: "preflight",
      detail: i.preflight.reason ?? "preflight failed",
      since: null,
    });
  if (capped)
    out.push({
      kind: "cap",
      subject: "cap",
      detail: `${i.todayCount} of ${i.cap} sessions today`,
      since: null,
    });
  return out;
}

function blockedReason(comments: Snapshot["issues"][number]["comments"]): string {
  const c = [...comments]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((x) => x.body.trim().startsWith("blocked by"));
  if (!c) return "";
  const first = c.body.trim().split("\n")[0] ?? "";
  return first.replace(/^blocked by [^:]*:\s*/, "").slice(0, 100);
}

export function describeWaiting(s: Snapshot, i: WaitingInput): WaitItem[] {
  const out: WaitItem[] = [...liveWaits(i)];
  const byNumber = new Map(s.issues.map((x) => [x.number, x]));
  const isEpic = (n: number) => byNumber.get(n)?.labels.includes("epic") ?? false;

  for (const e of s.epics) {
    if (e.state === "OPEN" && e.labels.includes("foreman:pause"))
      out.push({
        kind: "paused",
        subject: `phase ${e.phase}`,
        detail: `phase ${e.phase} paused (foreman:pause on #${e.number})`,
        since: null,
      });
  }
  for (const e of [...s.epics].sort((a, b) => a.phase - b.phase)) {
    if (e.state !== "OPEN") continue;
    const ei = byNumber.get(e.number);
    if (e.labels.includes("needs-owner"))
      out.push({
        kind: "human",
        subject: `epic #${e.number}`,
        detail: `epic #${e.number} awaits owner sign-off`,
        since: ei?.updatedAt ?? null,
      });
    else if (!e.labels.includes("plan-approved") && plannerFinished(e, s.issues))
      out.push({
        kind: "human",
        subject: `epic #${e.number}`,
        detail: `epic #${e.number} awaits plan-approved`,
        since: ei?.updatedAt ?? null,
      });
  }
  for (const x of s.issues) {
    if (x.state === "OPEN" && !isEpic(x.number) && x.labels.includes("blocked")) {
      const why = blockedReason(x.comments);
      out.push({
        kind: "human",
        subject: `#${x.number}`,
        detail: `#${x.number} blocked${why ? `: ${why}` : ""}`,
        since: x.updatedAt,
      });
    }
  }
  for (const p of s.prs) {
    const x = p.issue === null ? undefined : byNumber.get(p.issue);
    if (x?.status !== "In Review" || openClaim(x.comments) || x.labels.includes("blocked"))
      continue;
    if (p.checks === "pending")
      out.push({
        kind: "ci",
        subject: `PR #${p.number}`,
        detail: `PR #${p.number} checks pending`,
        since: p.updatedAt,
      });
    else if (p.checks === "failure")
      out.push({
        kind: "ci",
        subject: `PR #${p.number}`,
        detail: `PR #${p.number} checks failed`,
        since: p.updatedAt,
      });
    if (p.labels.includes("reviewer:changes") || p.labels.includes("validator:failed")) {
      const round = fixRound(x.comments) + 1;
      if (round <= MAX_FIX_ROUNDS)
        out.push({
          kind: "review_cycle",
          subject: `PR #${p.number}`,
          detail: `PR #${p.number} fix round ${round} queued`,
          since: p.updatedAt,
        });
    }
  }
  for (const x of s.issues) {
    if (
      x.state !== "OPEN" ||
      isEpic(x.number) ||
      x.status !== "Ready" ||
      !x.labels.includes("agent-ready")
    )
      continue;
    for (const d of parseDependsOn(x.body)) {
      const dep = byNumber.get(d);
      if (dep && dep.state === "OPEN")
        out.push({
          kind: "dependency",
          subject: `#${x.number}`,
          detail: `#${x.number} waits on #${d}`,
          since: null,
        });
    }
  }
  for (const x of s.issues) {
    const open = openClaim(x.comments);
    if (x.state === "OPEN" && open && open.claim.host !== i.host)
      out.push({
        kind: "other_host",
        subject: `#${x.number}`,
        detail: `#${x.number} claimed by ${open.claim.host} (${open.claim.role} round ${open.claim.round})`,
        since: open.claim.at,
      });
  }
  return out.sort((a, b) => (ORDER.get(a.kind) ?? 99) - (ORDER.get(b.kind) ?? 99));
}
