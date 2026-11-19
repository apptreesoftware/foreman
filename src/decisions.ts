import type { GitHubApi } from "./github.ts";
import { decisionUnblocked, fmt, lastUnblockedAt, openClaim } from "./ledger.ts";
import { log } from "./log.ts";
import { type UnblockGh, unblockEdits } from "./needs-you.ts";
import type { ClosedDecision, Comment, Snapshot } from "./types.ts";

/** The decision layout's last line: the one task this decision blocks. */
const BLOCKS = /^[ \t]*Blocks: #(\d+)[ \t]*$/m;
/** The first line of the comment the decisions page posts when someone settles. */
const SETTLED = /^Settled: (.+)$/;
const MAX_ANSWER = 500;

export function parseBlocks(body: string): number | null {
  const m = BLOCKS.exec(body);
  return m ? Number(m[1]) : null;
}

const firstLine = (c: Comment): string => (c.body.trim().split("\n")[0] ?? "").trim();
const isSettled = (c: Comment): boolean => SETTLED.test(firstLine(c));

/**
 * The answer to quote on the resumed task: the earliest `Settled:` comment wins, so two people
 * settling at once resolve to whoever was first. Null when the decision was answered some other
 * way, e.g. closed by hand on GitHub. The caller drops `Settled:` comments by authors without
 * write access first (`trustedSettled`).
 */
export function settledAnswer(comments: Comment[]): string | null {
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const m = SETTLED.exec(firstLine(c));
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
 * still names the same task. A decision of the same spell closed as not planned holds the task
 * blocked even when another was completed; any other close reason is ignored.
 */
export function planDecisionResumes(s: Snapshot, closed: ClosedDecision[]): DecisionResume[] {
  const stillOpen = new Set(
    s.issues
      .filter((i) => i.state === "OPEN" && i.labels.includes("decision"))
      .map((i) => parseBlocks(i.body))
      .filter((n): n is number => n !== null),
  );
  const tasks = new Map(s.issues.map((i) => [i.number, i]));
  /** Opened after the task's last unblock, so it belongs to the current blocked spell. */
  const inSpell = (d: ClosedDecision, n: number): boolean => {
    const unblockedAt = lastUnblockedAt(tasks.get(n)?.comments ?? []);
    return unblockedAt === null || d.createdAt > unblockedAt;
  };
  const held = new Set<number>();
  for (const d of closed) {
    if (d.stateReason !== "NOT_PLANNED") continue;
    const n = parseBlocks(d.body);
    if (n !== null && inSpell(d, n)) held.add(n);
  }
  const byTask = new Map<number, DecisionResume>();
  for (const d of [...closed].sort((a, b) => a.number - b.number)) {
    if (d.stateReason !== "COMPLETED") continue;
    const n = parseBlocks(d.body);
    if (n === null || stillOpen.has(n) || held.has(n)) continue;
    const task = tasks.get(n);
    if (task?.state !== "OPEN" || !task.labels.includes("blocked")) continue;
    if (openClaim(task.comments)) continue;
    if (decisionUnblocked(task.comments, d.number)) continue;
    if (!inSpell(d, n)) continue;
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

export type DecisionGh = UnblockGh & Pick<GitHubApi, "listClosedDecisions" | "hasWriteAccess">;

/**
 * The decisions with every `Settled:` comment by an author without write access removed, as if it
 * had never been written: on a public repository anyone can comment, and the answer is quoted to
 * an unattended builder. Each author is looked up once; no `Settled:` comment, no lookup.
 */
async function trustedSettled(
  gh: Pick<GitHubApi, "hasWriteAccess">,
  decisions: ClosedDecision[],
): Promise<ClosedDecision[]> {
  const authors = new Set(
    decisions.flatMap((d) => d.comments.filter(isSettled).map((c) => c.author)),
  );
  const writers = new Set<string>();
  for (const a of authors) if (await gh.hasWriteAccess(a)) writers.add(a);
  return decisions.map((d) => ({
    ...d,
    comments: d.comments.filter((c) => !isSettled(c) || writers.has(c.author)),
  }));
}

/**
 * Resumes every blocked task whose decision was settled: a `decision #D …` ledger line per
 * decision it consumes, then the same edits as the owner's Unblock (PR verdicts, Status Ready,
 * label). The ledger lines come first and `blocked` is removed last, so a failure partway through
 * leaves the task blocked with the answer recorded rather than losing it; the owner's Unblock
 * then finishes the job by hand. Closed decisions are read for the last week; only when that
 * yields a candidate does a second read fetch every decision closed as not planned, however old,
 * so one closed before the window still holds its task. Only a `Settled:` comment by someone with
 * write access counts as the answer. Returns the tasks resumed. Every write goes through `gh`, so
 * `dryRun` writes nothing.
 */
export async function resumeSettledDecisions(gh: DecisionGh, s: Snapshot): Promise<number[]> {
  // Nothing is blocked, so nothing can be resumed: an idle board spends no call on this.
  if (!s.issues.some((i) => i.state === "OPEN" && i.labels.includes("blocked"))) return [];
  const since = new Date(Date.parse(s.now) - DECISION_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const recent = await gh.listClosedDecisions(since);
  if (planDecisionResumes(s, recent).length === 0) return [];
  const seen = new Set(recent.map((d) => d.number));
  const notPlanned = (await gh.listClosedDecisions(since, { notPlanned: true })).filter(
    (d) => !seen.has(d.number),
  );
  const resumes = planDecisionResumes(s, await trustedSettled(gh, [...recent, ...notPlanned]));
  for (const r of resumes) {
    for (const d of r.decisions)
      await gh.comment("issue", r.task, fmt.decisionUnblocked(s.host, d.number, d.answer));
    await unblockEdits(gh, { issue: r.task, itemId: r.itemId, pr: r.pr }, { blockedLast: true });
    log("info", "decision resumed task", {
      task: r.task,
      decisions: r.decisions.map((d) => d.number),
    });
  }
  return resumes.map((r) => r.task);
}
