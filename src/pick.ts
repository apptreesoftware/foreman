import { parseDependsOn, phaseOf, sizeOf } from "./github.ts";
import { fixRound, openClaim } from "./ledger.ts";
import type { Epic, Issue, Size, Snapshot } from "./types.ts";

export type Kind = "build" | "fix" | "review" | "validate";
export interface Candidate {
  kind: Kind;
  issue: number;
  pr: number | null;
  phase: number;
  size: Size | null;
  round: number;
}

export const MAX_FIX_ROUNDS = 2;
export const VALIDATOR_EXEMPT_AREAS = ["area:infra", "area:db", "area:shared"];

/** True when the issue touches anything beyond infra/db/shared (no area label ⇒ required). */
export function validatorRequired(labels: string[]): boolean {
  const areas = labels.filter((l) => l.startsWith("area:"));
  return areas.length === 0 || areas.some((a) => !VALIDATOR_EXEMPT_AREAS.includes(a));
}
const UNPHASED = 99;

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

export function buildCandidates(s: Snapshot): Candidate[] {
  return s.issues
    .filter((i) => i.state === "OPEN" && i.status === "Ready" && i.labels.includes("agent-ready"))
    .filter((i) => !i.labels.includes("blocked") && !i.labels.includes("epic"))
    .filter((i) => openClaim(i.comments) === null)
    .filter((i) => depsClosed(i, s.issues))
    .filter((i) => !isPaused(i, s.epics) && !blockedByDirectionCritical(i, s.epics))
    .map((i) => ({
      kind: "build" as const,
      issue: i.number,
      pr: null,
      phase: issuePhase(i),
      size: sizeOf(i.labels),
      round: 1,
    }));
}

export function jobCandidates(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const pr of s.prs) {
    if (pr.issue === null || pr.isDraft) continue;
    const i = s.issues.find((x) => x.number === pr.issue);
    if (!i || i.status !== "In Review" || i.labels.includes("blocked") || openClaim(i.comments))
      continue;
    if (isPaused(i, s.epics)) continue;
    const base = { issue: i.number, pr: pr.number, phase: issuePhase(i), size: sizeOf(i.labels) };
    const has = (l: string) => pr.labels.includes(l);
    if (has("reviewer:changes") || has("validator:failed")) {
      const round = fixRound(i.comments) + 1;
      if (round <= MAX_FIX_ROUNDS) out.push({ kind: "fix", round, ...base });
    } else if (!has("reviewer:approved")) out.push({ kind: "review", round: 1, ...base });
    else if (!has("validator:passed") && !has("validator:skipped") && validatorRequired(i.labels))
      out.push({ kind: "validate", round: 1, ...base });
  }
  return out;
}

const KIND_RANK: Record<Kind, number> = { review: 0, validate: 1, fix: 2, build: 3 };
const SIZE_RANK: Record<string, number> = { S: 0, M: 1, L: 2 };

export function prioritize(cs: Candidate[]): Candidate[] {
  return [...cs].sort(
    (a, b) =>
      a.phase - b.phase ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (SIZE_RANK[a.size ?? ""] ?? 3) - (SIZE_RANK[b.size ?? ""] ?? 3) ||
      a.issue - b.issue,
  );
}

export function pick(s: Snapshot): Candidate | null {
  return prioritize([...jobCandidates(s), ...buildCandidates(s)])[0] ?? null;
}
