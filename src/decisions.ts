import type { GitHubApi } from "./github.ts";
import { decisionUnblocked, fmt, lastUnblockedAt, openClaim } from "./ledger.ts";
import { log } from "./log.ts";
import { type UnblockGh, unblockEdits } from "./needs-you.ts";
import type { ClosedDecision, Comment, Snapshot } from "./types.ts";

/** The decision layout's last line: the one task this decision blocks. */
const BLOCKS = /^Blocks: #(\d+)\s*$/m;
/** The first line of the comment the decisions page posts when someone settles. */
const SETTLED = /^Settled: (.+)$/;
const MAX_ANSWER = 500;

export function parseBlocks(body: string): number | null {
  const m = BLOCKS.exec(body);
  return m ? Number(m[1]) : null;
}

/**
 * The answer to quote on the resumed task: the earliest `Settled:` comment wins, so two people
 * settling at once resolve to whoever was first. Null when the decision was answered some other
 * way, e.g. closed by hand on GitHub.
 */
export function settledAnswer(comments: Comment[]): string | null {
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const first = (c.body.trim().split("\n")[0] ?? "").trim();
    const m = SETTLED.exec(first);
    if (m) return (m[1] as string).trim().slice(0, MAX_ANSWER);
  }
  return null;
}

export interface DecisionResume {
  task: number;
  itemId: string | null;
  pr: number | null;
  /** Every closed decision this resume consumes, lowest number first. */
  decisions: Array<{ number: number; answer: string | null }>;
}

/**
 * Which blocked tasks the closed decisions release. A decision counts once (the ledger says so),
 * only when closed as completed, only when opened after the task was last unblocked or resumed —
 * so a task blocked again for another reason is not released by an old answer, while a decision
 * settled before the builder's session returned still counts — and only once no open decision
 * still names the same task.
 */
export function planDecisionResumes(s: Snapshot, closed: ClosedDecision[]): DecisionResume[] {
  const stillOpen = new Set(
    s.issues
      .filter((i) => i.state === "OPEN" && i.labels.includes("decision"))
      .map((i) => parseBlocks(i.body))
      .filter((n): n is number => n !== null),
  );
  const byTask = new Map<number, DecisionResume>();
  for (const d of [...closed].sort((a, b) => a.number - b.number)) {
    if (d.stateReason !== "COMPLETED") continue;
    const n = parseBlocks(d.body);
    if (n === null || stillOpen.has(n)) continue;
    const task = s.issues.find((i) => i.number === n);
    if (task?.state !== "OPEN" || !task.labels.includes("blocked")) continue;
    if (openClaim(task.comments)) continue;
    if (decisionUnblocked(task.comments, d.number)) continue;
    const unblockedAt = lastUnblockedAt(task.comments);
    if (unblockedAt !== null && d.createdAt <= unblockedAt) continue;
    const r = byTask.get(n) ?? {
      task: n,
      itemId: task.itemId,
      pr: s.prs.find((p) => p.issue === n)?.number ?? null,
      decisions: [],
    };
    r.decisions.push({ number: d.number, answer: settledAnswer(d.comments) });
    byTask.set(n, r);
  }
  return [...byTask.values()].sort((a, b) => a.task - b.task);
}

/** How far back closed decisions are read; an older one resumes nothing. */
export const DECISION_LOOKBACK_DAYS = 7;

export type DecisionGh = UnblockGh & Pick<GitHubApi, "listClosedDecisions">;

/**
 * Resumes every blocked task whose decision was settled: a `decision #D …` ledger line per
 * decision it consumes, then the same edits as the owner's Unblock (label, PR verdicts, Status
 * Ready). The ledger lines come first, so a failure partway through leaves the task blocked with
 * the answer recorded rather than losing it; the owner's Unblock then finishes the job by hand.
 * Returns the tasks resumed. Every write goes through `gh`, so `dryRun` writes nothing.
 */
export async function resumeSettledDecisions(gh: DecisionGh, s: Snapshot): Promise<number[]> {
  // Nothing is blocked, so nothing can be resumed: an idle board spends no call on this.
  if (!s.issues.some((i) => i.state === "OPEN" && i.labels.includes("blocked"))) return [];
  const since = new Date(Date.parse(s.now) - DECISION_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const resumes = planDecisionResumes(s, await gh.listClosedDecisions(since));
  for (const r of resumes) {
    for (const d of r.decisions)
      await gh.comment("issue", r.task, fmt.decisionUnblocked(s.host, d.number, d.answer));
    await unblockEdits(gh, { issue: r.task, itemId: r.itemId, host: s.host, pr: r.pr });
    log("info", "decision resumed task", {
      task: r.task,
      decisions: r.decisions.map((d) => d.number),
    });
  }
  return resumes.map((r) => r.task);
}
