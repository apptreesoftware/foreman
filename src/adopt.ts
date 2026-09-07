import type { Action, Snapshot } from "./types.ts";

/**
 * Open, non-epic `agent-ready` issues with no project item. The picker only ever sees Status
 * `Ready`, so an issue created by hand and never added to the board is invisible: not picked, not
 * reported as waiting, and everything that depends on it stalls silently (#220 held all of Phase 1
 * this way). Adopting it costs one item-add, one status write and one comment, and the next tick
 * picks it up like any other Ready issue.
 */
export function adoptActions(s: Snapshot): Action[] {
  return s.issues
    .filter(
      (i) =>
        i.state === "OPEN" &&
        !i.labels.includes("epic") &&
        i.labels.includes("agent-ready") &&
        i.itemId === null,
    )
    .map((i) => ({ type: "adopt" as const, issue: i.number }));
}
