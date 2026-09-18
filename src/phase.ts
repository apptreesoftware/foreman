import { z } from "zod";
import { openClaim, planApplied } from "./ledger.ts";
import type { Action, Epic, Issue, Snapshot } from "./types.ts";

export const PlanIssuesSchema = z.object({
  epic: z.number().int(),
  tasks: z.array(
    z.object({
      number: z.number().int().optional(), // present → edit existing issue; absent → create
      title: z.string().min(1),
      body: z.string().min(1), // AGENTS.md template
      labels: z.array(z.string()),
    }),
  ),
});
export type PlanIssues = z.infer<typeof PlanIssuesSchema>;

export function parseDirectionCritical(specText: string): boolean {
  return /^\*\*Direction-critical:\*\*\s*yes\b/im.test(specText);
}

export function parseSpecPath(body: string): string | null {
  const m = /## Spec\s*\n[\s\S]*?([\w./-]+\.md)/.exec(body);
  return m ? (m[1] as string) : null;
}

/**
 * The `NN` in `<date>-phase-NN-plan.issues.json`, which is what the planner is told to name its
 * plan after: the epic's own `phase:N` label, zero-padded.
 *
 * The spec path is only a fallback, for a repository that names its specs `…-phase-NN-…` and has
 * done so since before the label was authoritative. Deriving it from the spec path alone is how
 * `apply_plan` used to fail for every repository that names its specs anything else: the filter
 * matched no plan file, the epic never got its tasks, and the tick logged "approved plan file not
 * on origin/main" for ever.
 */
export function planPhaseNumber(labels: string[], specPath: string): string | null {
  for (const l of labels) {
    const m = /^phase:(\d+)$/.exec(l);
    if (m) return (m[1] as string).padStart(2, "0");
  }
  return /phase-(\d\d)/.exec(specPath)?.[1] ?? null;
}

/** docs/superpowers/specs/<date>-phase-NN-<slug>-design.md → <planDir>/<today>-phase-NN-plan.issues.json */
export function planIssuesPath(specPath: string, today: string, planDir: string): string {
  const m = /phase-(\d\d)/.exec(specPath);
  const nn = m ? m[1] : "xx";
  return `${planDir}/${today}-phase-${nn}-plan.issues.json`;
}

export function phaseComplete(e: Epic, issues: Issue[]): boolean {
  return (
    e.taskNumbers.length > 0 &&
    e.taskNumbers.every((n) => !issues.some((i) => i.number === n && i.state === "OPEN"))
  );
}

function epicIssue(e: Epic, issues: Issue[]): Issue | undefined {
  return issues.find((i) => i.number === e.number);
}

/**
 * An epic whose drafted plan is waiting on the owner: `needs-owner` without `plan-approved`.
 * A phase epic waiting on sign-off carries `plan-approved` too, so it does not count here.
 */
export function planAwaitingOwner(epics: Epic[]): Epic | null {
  return (
    epics.find(
      (e) =>
        e.state === "OPEN" &&
        e.labels.includes("needs-owner") &&
        !e.labels.includes("plan-approved"),
    ) ?? null
  );
}

/**
 * The epic the planner may draft next, or null. Three gates, in order:
 * 1. no approved phase is still being built,
 * 2. no drafted plan is already waiting on the owner (one plan in flight),
 * 3. the owner has labelled the epic `agent-ready` — the human backstop (#187). The foreman
 *    removes that label when the plan is drafted, so re-labelling is how you ask for a re-plan.
 */
/** An approved phase whose tasks are still being built; the planner waits for it. */
export function buildingEpic(epics: Epic[]): Epic | null {
  return (
    epics.find(
      (e) =>
        e.state === "OPEN" &&
        e.labels.includes("plan-approved") &&
        (e.status === "In Progress" || e.status === "Ready") &&
        !e.labels.includes("needs-owner"),
    ) ?? null
  );
}

export function nextUnplannedEpic(epics: Epic[]): Epic | null {
  if (buildingEpic(epics)) return null; // a phase is still being built
  if (planAwaitingOwner(epics)) return null; // one drafted plan at a time
  return (
    epics
      .filter(
        (e) =>
          e.state === "OPEN" &&
          e.labels.includes("agent-ready") &&
          !e.labels.includes("plan-approved") &&
          !e.labels.includes("needs-owner") &&
          e.status !== "In Review",
      )
      .sort((a, b) => a.phase - b.phase)[0] ?? null
  );
}

export function phaseActions(s: Snapshot): Action[] {
  const out: Action[] = [];
  for (const e of [...s.epics].sort((a, b) => a.phase - b.phase)) {
    const ei = epicIssue(e, s.issues);
    if (ei && openClaim(ei.comments)) continue;
    if (
      e.state === "OPEN" &&
      e.labels.includes("plan-approved") &&
      ei &&
      !planApplied(ei.comments)
    ) {
      out.push({ type: "apply_plan", epic: e.number });
      continue;
    }
    if (
      e.state === "OPEN" &&
      e.status !== "In Review" &&
      !e.labels.includes("needs-owner") &&
      phaseComplete(e, s.issues)
    ) {
      out.push({ type: "phase_close", epic: e.number });
      return out; // one session-starting action per iteration
    }
  }
  const next = nextUnplannedEpic(s.epics);
  const nextIssue = next ? epicIssue(next, s.issues) : undefined;
  if (next && !(nextIssue && openClaim(nextIssue.comments)))
    out.push({ type: "plan", epic: next.number });
  return out;
}
