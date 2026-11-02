import { z } from "zod";
import { openClaim, planApplied, planPrStuckReported } from "./ledger.ts";
import type { Action, Epic, Issue, PullRequest, Snapshot } from "./types.ts";

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

/**
 * What a plan task's body writes in place of an issue number that does not exist until the plan
 * is applied: `{{issue}}` is the task's own number, `{{task:K}}` the number of the plan's K-th
 * task (1-based). Both fill in as the bare number, so a dependency reads `#{{task:3}}`. The
 * planner used to predict these numbers instead, and every issue or PR opened between the draft
 * and the apply shifted them onto the wrong issues.
 */
const PLAN_PLACEHOLDER = /\{\{(?:issue|task:(\d+))\}\}/g;

/** Every `{{task:K}}` in the plan that names no task in it; empty when every body can be filled. */
export function planPlaceholderErrors(plan: PlanIssues): string[] {
  const errors: string[] = [];
  plan.tasks.forEach((t, i) => {
    for (const m of t.body.matchAll(PLAN_PLACEHOLDER)) {
      const k = m[1] === undefined ? null : Number(m[1]);
      if (k !== null && (k < 1 || k > plan.tasks.length))
        errors.push(
          `task ${i + 1} ("${t.title}") names ${m[0]}; the plan has ${plan.tasks.length} tasks`,
        );
    }
  });
  return errors;
}

/** True when the body has a placeholder `fillPlanBody` would replace. */
export function hasPlanPlaceholder(body: string): boolean {
  return new RegExp(PLAN_PLACEHOLDER.source).test(body);
}

/** The body with its placeholders filled; `numbers[K - 1]` is the K-th task's issue number. */
export function fillPlanBody(body: string, own: number, numbers: number[]): string {
  return body.replace(PLAN_PLACEHOLDER, (_all, k: string | undefined) =>
    String(k === undefined ? own : numbers[Number(k) - 1]),
  );
}

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
 * 3. the owner has labelled the epic `agent-ready` — the human backstop. The foreman
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

/** An epic the owner approved whose plan has not been turned into task issues yet. */
export function planUnapplied(e: Epic, issues: Issue[]): boolean {
  const ei = epicIssue(e, issues);
  return (
    e.state === "OPEN" && e.labels.includes("plan-approved") && !!ei && !planApplied(ei.comments)
  );
}

/**
 * The open PR the planner opened for this epic, by the title `planner.md` prescribes:
 * `docs(plan): phase NN plan (#<epic>)`. The newest wins when a re-plan left two open.
 */
export function planPR(s: Snapshot, epic: number): PullRequest | null {
  return (
    s.prs
      .filter((p) => p.title.startsWith("docs(plan):") && p.title.includes(`(#${epic})`))
      .sort((a, b) => b.number - a.number)[0] ?? null
  );
}

export type PlanPrState =
  | { state: "ready" }
  | { state: "pending" }
  | { state: "stuck"; reason: string };

/**
 * Whether an approved plan's PR can be merged now. The owner's approval is the review, so only
 * GitHub's own verdicts gate it: green or absent checks merge, running checks wait a tick, and red
 * checks or a conflict need the owner.
 */
export function planPrState(pr: PullRequest): PlanPrState {
  if (pr.mergeable === "CONFLICTING") return { state: "stuck", reason: "conflicts with main" };
  if (pr.checks === "failure") return { state: "stuck", reason: "checks failed" };
  if (pr.checks === "pending") return { state: "pending" };
  return { state: "ready" };
}

/**
 * Approved plans: merge the plan PR if one is open, then create the tasks. These cost no session,
 * so `plan()` runs them ahead of the pick — an approved plan once waited behind every review and
 * validation that could be claimed, and the owner's approval did nothing visible for an hour.
 */
export function applyPlanActions(s: Snapshot): Action[] {
  const out: Action[] = [];
  for (const e of [...s.epics].sort((a, b) => a.phase - b.phase)) {
    const ei = epicIssue(e, s.issues);
    if (!ei || openClaim(ei.comments) || !planUnapplied(e, s.issues)) continue;
    const p = planPR(s, e.number);
    if (!p) {
      // Merged already, by hand or on an earlier tick; apply_plan reads the file from origin.
      out.push({ type: "apply_plan", epic: e.number });
      continue;
    }
    const st = planPrState(p);
    if (st.state === "ready")
      out.push(
        { type: "merge_plan", epic: e.number, pr: p.number },
        { type: "apply_plan", epic: e.number },
      );
    else if (st.state === "stuck" && !planPrStuckReported(ei.comments, p.number, p.headSha))
      out.push({
        type: "plan_pr_stuck",
        epic: e.number,
        pr: p.number,
        sha: p.headSha,
        reason: st.reason,
      });
  }
  return out;
}

export function phaseActions(s: Snapshot): Action[] {
  const out: Action[] = [];
  for (const e of [...s.epics].sort((a, b) => a.phase - b.phase)) {
    const ei = epicIssue(e, s.issues);
    if (ei && openClaim(ei.comments)) continue;
    // applyPlanActions owns an approved epic until its plan is applied.
    if (planUnapplied(e, s.issues)) continue;
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
