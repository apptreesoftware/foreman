import type { BudgetReport } from "./state-file.ts";

export interface BudgetSample {
  remaining: number;
  limit: number;
  resetAt: string;
}

/**
 * Three free `rateLimit` reads per tick turn the hourly GraphQL budget into an attributed
 * number: what the loop's own snapshot cost, what the `claude -p` session it dispatched
 * spent, and what was gone before the tick even started — a role session on another issue, a
 * second daemon, or a human at a terminal.
 */
export function budgetUpdate(
  prev: BudgetReport | null,
  s: {
    before: BudgetSample | null;
    afterReads: BudgetSample | null;
    afterActions: BudgetSample | null;
  },
  at: string,
): BudgetReport | null {
  const { before, afterReads, afterActions } = s;
  if (!before || !afterReads || !afterActions) return prev;
  // A window reset (remaining jumps back up) reads as negative spend; report it as none.
  const spent = (a: number, b: number) => Math.max(0, a - b);
  return {
    at,
    remaining: afterActions.remaining,
    limit: afterActions.limit,
    resetAt: afterActions.resetAt,
    tickReads: spent(before.remaining, afterReads.remaining),
    actionSpend: spent(afterReads.remaining, afterActions.remaining),
    betweenTicks: prev ? spent(prev.remaining, before.remaining) : 0,
  };
}

export function formatBudget(b: BudgetReport | null): string {
  if (!b) return "";
  const reset = b.resetAt ? `${b.resetAt.slice(11, 16)}Z` : "–";
  return `${b.remaining} of ${b.limit} GraphQL points left, resets ${reset} · last tick: ${b.tickReads} reads, ${b.actionSpend} session, ${b.betweenTicks} elsewhere`;
}
