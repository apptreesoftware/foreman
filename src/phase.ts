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
  const m = /## Spec\s*\n[\s\S]*?(docs\/[\w./-]+\.md)/.exec(body);
  return m ? (m[1] as string) : null;
}

/** docs/superpowers/specs/<date>-phase-NN-<slug>-design.md → docs/superpowers/plans/<today>-phase-NN-plan.issues.json */
export function planIssuesPath(specPath: string, today: string): string {
  const m = /phase-(\d\d)/.exec(specPath);
  const nn = m ? m[1] : "xx";
  return `docs/superpowers/plans/${today}-phase-${nn}-plan.issues.json`;
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

function plannerFinished(e: Epic, issues: Issue[]): boolean {
  const i = epicIssue(e, issues);
  return (
    !!i &&
    i.comments.some((c) => /^session \S+ finished on \S+: outcome=plan_drafted/.test(c.body.trim()))
  );
}

export function nextUnplannedEpic(epics: Epic[], issues: Issue[]): Epic | null {
  const active = epics.filter(
    (e) =>
      e.state === "OPEN" &&
      (e.status === "In Progress" || e.status === "Ready") &&
      !e.labels.includes("needs-owner"),
  );
  if (active.length > 0) return null; // something is still being built
  return (
    epics
      .filter(
        (e) =>
          e.state === "OPEN" && !e.labels.includes("plan-approved") && !plannerFinished(e, issues),
      )
      .filter((e) => e.status !== "In Review")
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
  const next = nextUnplannedEpic(s.epics, s.issues);
  const nextIssue = next ? epicIssue(next, s.issues) : undefined;
  if (next && !(nextIssue && openClaim(nextIssue.comments)))
    out.push({ type: "plan", epic: next.number });
  return out;
}
