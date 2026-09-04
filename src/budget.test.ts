import { describe, expect, it } from "vitest";
import { budgetUpdate, formatBudget } from "./budget.ts";

const s = (remaining: number) => ({ remaining, limit: 5000, resetAt: "2026-09-04T19:00:00Z" });
const at = "2026-09-04T18:30:00Z";

describe("budgetUpdate", () => {
  it("splits a tick's spend into reads, actions, and everyone else", () => {
    const first = budgetUpdate(
      null,
      { before: s(5000), afterReads: s(4970), afterActions: s(4900) },
      at,
    );
    expect(first).toMatchObject({
      remaining: 4900,
      tickReads: 30,
      actionSpend: 70,
      betweenTicks: 0,
    });
    const second = budgetUpdate(
      first,
      { before: s(4600), afterReads: s(4570), afterActions: s(4560) },
      at,
    );
    // 4900 at the end of the last tick, 4600 at the start of this one: 300 points spent by
    // something that is not the daemon's loop — a role session, or a human at a terminal.
    expect(second).toMatchObject({ betweenTicks: 300, tickReads: 30, actionSpend: 10 });
  });
  it("treats a window reset as no spend rather than a negative", () => {
    const prev = budgetUpdate(
      null,
      { before: s(200), afterReads: s(180), afterActions: s(150) },
      at,
    );
    const next = budgetUpdate(
      prev,
      { before: s(5000), afterReads: s(4980), afterActions: s(4980) },
      at,
    );
    expect(next?.betweenTicks).toBe(0);
  });
  it("keeps the previous report when the budget cannot be read", () => {
    const prev = budgetUpdate(
      null,
      { before: s(200), afterReads: s(180), afterActions: s(150) },
      at,
    );
    expect(budgetUpdate(prev, { before: null, afterReads: null, afterActions: null }, at)).toBe(
      prev,
    );
  });
});

describe("formatBudget", () => {
  it("reads as one line", () => {
    const b = budgetUpdate(
      null,
      { before: s(4000), afterReads: s(3980), afterActions: s(3900) },
      at,
    );
    expect(formatBudget(b)).toBe(
      "3900 of 5000 GraphQL points left, resets 19:00Z · last tick: 20 reads, 80 session, 0 elsewhere",
    );
  });
  it("is empty without a sample", () => {
    expect(formatBudget(null)).toBe("");
  });
});
