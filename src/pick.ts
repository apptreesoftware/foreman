import { parseDependsOn, parseTouches, phaseOf, sizeOf, touchesOverlap } from "./github.ts";
import { ciRerunCount, fixRound, openClaim } from "./ledger.ts";
import type { Epic, Issue, PullRequest, Size, Snapshot } from "./types.ts";

export type Kind = "build" | "fix" | "review" | "validate" | "rebase";
export interface Candidate {
  kind: Kind;
  issue: number;
  pr: number | null;
  phase: number;
  size: Size | null;
  round: number;
  /** A build whose Touches overlap an issue with an open PR; sorted after the others (#237). */
  contended: boolean;
}

export const MAX_FIX_ROUNDS = 2;
/**
 * Reruns of a red PR's failed jobs before the foreman stops treating the failure as a flake and
 * pays for a builder round (#362). One: a rerun costs nothing but runner time, and a second one
 * has never told us anything the first did not.
 */
export const MAX_CI_RERUNS = 1;
/**
 * Open blocked tasks in one phase before the foreman stops starting new builds there (#237).
 * Every blocked task is owner work; piling more builds on top of them only breeds conflicts.
 */
export const MAX_BLOCKED_PER_PHASE = 2;
export const VALIDATOR_EXEMPT_AREAS = ["area:infra", "area:db", "area:shared"];

/** True when the issue touches anything beyond infra/db/shared (no area label ⇒ required). */
export function validatorRequired(labels: string[]): boolean {
  const areas = labels.filter((l) => l.startsWith("area:"));
  return areas.length === 0 || areas.some((a) => !VALIDATOR_EXEMPT_AREAS.includes(a));
}
const UNPHASED = 99;

/** True once the free recovery for this head commit is used up and CI is still red. */
export function ciRerunsSpent(pr: PullRequest, i: Issue): boolean {
  return ciRerunCount(i.comments, pr.headSha) >= MAX_CI_RERUNS;
}

export function issuePhase(i: Issue): number {
  return phaseOf(i.labels) ?? UNPHASED;
}

export function isPaused(i: Issue, epics: Epic[]): boolean {
  const p = issuePhase(i);
  return epics.some((e) => e.phase === p && e.labels.includes("foreman:pause"));
}

export function blockedByDirectionCritical(i: Issue, epics: Epic[]): boolean {
  const p = issuePhase(i);
  return epics.some(
    (e) =>
      e.state === "OPEN" && e.directionCritical && !e.labels.includes("signed-off") && e.phase < p,
  );
}

export function depsClosed(i: Issue, issues: Issue[]): boolean {
  return parseDependsOn(i.body).every(
    (n) => !issues.some((x) => x.number === n && x.state === "OPEN"),
  );
}

/** Phases with `MAX_BLOCKED_PER_PHASE` or more open, non-epic blocked tasks, ascending. */
export function heldPhases(s: Snapshot): number[] {
  const counts = new Map<number, number>();
  for (const i of s.issues) {
    if (i.state !== "OPEN" || i.labels.includes("epic") || !i.labels.includes("blocked")) continue;
    const phase = issuePhase(i);
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= MAX_BLOCKED_PER_PHASE)
    .map(([phase]) => phase)
    .sort((a, b) => a - b);
}

/** Touches of every issue that has an open PR: the files a new build would be racing. */
function inFlightTouches(s: Snapshot): string[][] {
  const withPr = new Set(s.prs.map((p) => p.issue));
  return s.issues.filter((i) => withPr.has(i.number)).map((i) => parseTouches(i.body));
}

export function buildCandidates(s: Snapshot): Candidate[] {
  const held = new Set(heldPhases(s));
  const busy = inFlightTouches(s);
  return s.issues
    .filter((i) => i.state === "OPEN" && i.status === "Ready" && i.labels.includes("agent-ready"))
    .filter((i) => !i.labels.includes("blocked") && !i.labels.includes("epic"))
    .filter((i) => openClaim(i.comments) === null)
    .filter((i) => depsClosed(i, s.issues))
    .filter((i) => !isPaused(i, s.epics) && !blockedByDirectionCritical(i, s.epics))
    .filter((i) => !held.has(issuePhase(i)))
    .map((i) => {
      const touches = parseTouches(i.body);
      return {
        kind: "build" as const,
        issue: i.number,
        pr: null,
        phase: issuePhase(i),
        size: sizeOf(i.labels),
        round: 1,
        contended: busy.some((t) => touchesOverlap(touches, t)),
      };
    });
}

export function jobCandidates(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const pr of s.prs) {
    if (pr.issue === null || pr.isDraft) continue;
    const i = s.issues.find((x) => x.number === pr.issue);
    if (!i || i.status !== "In Review" || i.labels.includes("blocked") || openClaim(i.comments))
      continue;
    if (isPaused(i, s.epics)) continue;
    const base = {
      issue: i.number,
      pr: pr.number,
      phase: issuePhase(i),
      size: sizeOf(i.labels),
      contended: false,
    };
    const has = (l: string) => pr.labels.includes(l);
    // Red CI the free rerun did not clear is a builder's problem, and it comes first: reviewing
    // or validating a branch whose own suite fails spends a session on the wrong question, and
    // once the PR is approved and validated no other branch here fires at all — which is how a
    // flake stalled #344 for an hour (#362).
    if (pr.checks === "failure" && ciRerunsSpent(pr, i)) {
      const round = fixRound(i.comments) + 1;
      if (round <= MAX_FIX_ROUNDS) out.push({ kind: "fix", round, ...base });
    } else if (has("reviewer:changes") || has("validator:failed")) {
      // The fix round merges origin/main itself (builder.md), so a conflict never queues twice.
      const round = fixRound(i.comments) + 1;
      if (round <= MAX_FIX_ROUNDS) out.push({ kind: "fix", round, ...base });
    } else if (!has("reviewer:approved")) out.push({ kind: "review", round: 1, ...base });
    else if (pr.mergeable === "CONFLICTING")
      // Approved but unmergeable: a rebase-only builder round at the *current* fix round, so it
      // never counts toward MAX_FIX_ROUNDS. Ahead of validation, which would run on a stale base.
      out.push({ kind: "rebase", round: fixRound(i.comments), ...base });
    else if (!has("validator:passed") && !has("validator:skipped") && validatorRequired(i.labels))
      out.push({ kind: "validate", round: 1, ...base });
  }
  return out;
}

const KIND_RANK: Record<Kind, number> = { rebase: 0, review: 1, validate: 2, fix: 3, build: 4 };
const SIZE_RANK: Record<string, number> = { S: 0, M: 1, L: 2 };

export function prioritize(cs: Candidate[]): Candidate[] {
  return [...cs].sort(
    (a, b) =>
      a.phase - b.phase ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      Number(a.contended) - Number(b.contended) ||
      (SIZE_RANK[a.size ?? ""] ?? 3) - (SIZE_RANK[b.size ?? ""] ?? 3) ||
      a.issue - b.issue,
  );
}

export function pick(s: Snapshot): Candidate | null {
  return prioritize([...jobCandidates(s), ...buildCandidates(s)])[0] ?? null;
}
