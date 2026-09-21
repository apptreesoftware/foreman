import { parentEpicOf, parseDependsOn } from "./github.ts";
import { fixRound, openClaim } from "./ledger.ts";
import { buildingEpic, planAwaitingOwner } from "./phase.ts";
import { heldPhases, issuePhase } from "./pick.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
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

export function describeWaiting(
  s: Snapshot,
  i: WaitingInput,
  repo: RepoConfig = defaultRepoConfig(),
): WaitItem[] {
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
    // A drafted plan and a closed phase both park the epic on `needs-owner`; `plan-approved`
    // is what tells them apart, and the plan case also holds every other epic.
    if (e.labels.includes("needs-owner"))
      out.push({
        kind: "human",
        subject: `epic #${e.number}`,
        detail: e.labels.includes("plan-approved")
          ? `epic #${e.number} awaits owner sign-off`
          : `epic #${e.number} awaits plan-approved`,
        since: ei?.updatedAt ?? null,
      });
  }
  // Nothing is drafted or being built, so the only thing between the foreman and the next
  // phase is the owner's `agent-ready` label on the epic.
  if (!planAwaitingOwner(s.epics) && !buildingEpic(s.epics)) {
    const next = [...s.epics]
      .filter(
        (e) =>
          e.state === "OPEN" &&
          !e.labels.includes("plan-approved") &&
          !e.labels.includes("agent-ready"),
      )
      .sort((a, b) => a.phase - b.phase)[0];
    if (next)
      out.push({
        kind: "phase_gate",
        subject: `epic #${next.number}`,
        detail: `epic #${next.number} awaits agent-ready before the planner runs`,
        since: byNumber.get(next.number)?.updatedAt ?? null,
      });
  }
  // A phase with too many blocked tasks starts no new builds until the owner clears one;
  // said once per phase, ahead of the per-issue lines that explain which tasks those are.
  const blockedCount = (phase: number) =>
    s.issues.filter(
      (x) =>
        x.state === "OPEN" &&
        !isEpic(x.number) &&
        x.labels.includes("blocked") &&
        issuePhase(x) === phase,
    ).length;
  for (const phase of heldPhases(s, repo))
    out.push({
      kind: "human",
      subject: `phase ${phase}`,
      detail: `phase ${phase} held: ${blockedCount(phase)} blocked tasks need you before any new build starts`,
      since: null,
    });
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
  // Non-epic issues parked on a human. The epics have their own loop above and their own card;
  // these used to have nowhere to show at all, so they sat unanswered.
  for (const x of s.issues) {
    if (x.state !== "OPEN" || isEpic(x.number)) continue;
    const decision = x.labels.includes("decision");
    if (!decision && !x.labels.includes("needs-owner")) continue;
    out.push({
      kind: "human",
      subject: `#${x.number}`,
      detail: `#${x.number} ${decision ? "decision" : "needs owner"}: ${x.title}`,
      since: x.updatedAt,
    });
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
      if (round <= repo.limits.fixRounds)
        out.push({
          kind: "review_cycle",
          subject: `PR #${p.number}`,
          detail: `PR #${p.number} fix round ${round} queued`,
          since: p.updatedAt,
        });
    } else if (p.labels.includes("reviewer:approved") && p.mergeable === "CONFLICTING")
      out.push({
        kind: "review_cycle",
        subject: `PR #${p.number}`,
        detail: `PR #${p.number} conflicts with main; rebase queued`,
        since: p.updatedAt,
      });
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
  // `agent-ready` and yet unpickable. Two reasons, one line each, because neither leaves any
  // other trace: no candidate, no session, no log.
  //  - Parked in a Status the picker never reads. Backlog and Done are the two that no other
  //    line explains: Backlog is where the planner leaves a task whose dependencies were still
  //    open, and Done on an open issue is a stale write. In Progress and In Review are normal
  //    mid-flight states, so they stay quiet.
  //  - No `Parent epic: #N` line, which the picker now requires. Nothing adopts an issue onto
  //    the board any more either, so a hand-made issue — Ready, or off the board entirely —
  //    would otherwise sit there for ever. Reporting it is all this does; the owner adds the
  //    line or the planner does.
  for (const x of s.issues) {
    if (x.state !== "OPEN" || isEpic(x.number) || !x.labels.includes("agent-ready")) continue;
    if (openClaim(x.comments)) continue;
    if (x.status === "Backlog" || x.status === "Done")
      out.push({
        kind: "human",
        subject: `#${x.number}`,
        detail: `#${x.number} is agent-ready but Status ${x.status}`,
        since: x.updatedAt,
      });
    else if (parentEpicOf(x.body) === null)
      out.push({
        kind: "human",
        subject: `#${x.number}`,
        detail: `#${x.number} is agent-ready but not a planner task (no Parent epic line)`,
        since: x.updatedAt,
      });
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
