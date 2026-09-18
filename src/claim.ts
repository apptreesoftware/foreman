import { activeClaims, type Claim, lastActivityAt, openClaim } from "./ledger.ts";
import type { Action, Issue, Snapshot } from "./types.ts";

type ResumeAction = Extract<Action, { type: "resume" }>;

export function resumeAction(s: Snapshot): ResumeAction | null {
  for (const i of s.issues) {
    const open = openClaim(i.comments);
    if (!open || open.claim.host !== s.host || i.state !== "OPEN") continue;
    const pr = s.prs.find((p) => p.issue === i.number)?.number ?? null;
    return {
      type: "resume",
      issue: i.number,
      role: open.claim.role,
      sessionId: open.sessionId,
      pr,
    };
  }
  return null;
}

export function resolveConflict(claims: Claim[], host: string): "keep" | "release" {
  const hosts = [...new Set(claims.map((c) => c.host))].sort();
  return hosts.length <= 1 || hosts[0] === host ? "keep" : "release";
}

export function conflictOn(issue: Issue, host: string): "keep" | "release" {
  return resolveConflict(activeClaims(issue.comments), host);
}

export function isStale(
  i: Issue,
  branchLastCommitAt: string | null,
  now: string,
  staleHours = 2,
): boolean {
  const cutoff = Date.parse(now) - staleHours * 3600_000;
  const lastComment = lastActivityAt(i.comments);
  const newest = Math.max(
    lastComment ? Date.parse(lastComment) : 0,
    branchLastCommitAt ? Date.parse(branchLastCommitAt) : 0,
  );
  return newest < cutoff;
}

export function reclaimActions(s: Snapshot, staleHours = 2): Action[] {
  const out: Action[] = [];
  for (const i of s.issues) {
    const open = openClaim(i.comments);
    if (!open || open.claim.host === s.host || i.state !== "OPEN") continue;
    if (isStale(i, s.branchLastCommitAt[i.number] ?? null, s.now, staleHours)) {
      out.push({ type: "reclaim", issue: i.number, fromHost: open.claim.host });
    }
  }
  return out;
}
