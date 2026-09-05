import type { GitHubApi } from "./github.ts";
import { fmt } from "./ledger.ts";
import { type Board, NEEDS_YOU_LABELS, type NeedsYouItem } from "./state-file.ts";
import type { Snapshot } from "./types.ts";

/**
 * The open non-epic issues waiting on the owner: a `decision` or `needs-owner` issue nobody has
 * answered, and a `blocked` issue only a human can restart. Epics are on the Owner card, so they
 * are excluded here. Oldest first — the point of the card is that #165 has been waiting a week.
 */
export function needsYouItems(s: Snapshot): NeedsYouItem[] {
  return s.issues
    .filter((x) => x.state === "OPEN" && !x.labels.includes("epic"))
    .map((x) => ({
      issue: x.number,
      title: x.title,
      labels: NEEDS_YOU_LABELS.filter((l) => x.labels.includes(l)) as string[],
      since: x.updatedAt,
      itemId: x.itemId,
    }))
    .filter((x) => x.labels.length > 0)
    .sort((a, b) => a.since.localeCompare(b.since) || a.issue - b.issue);
}

export type UnblockGh = Pick<GitHubApi, "removeLabels" | "comment" | "setStatus" | "addToProject">;

/**
 * The Unblock gate: the two GitHub edits an owner otherwise makes by hand (drop the label, set
 * Status Ready) plus a ledger comment, so the picker considers the issue again on the next tick.
 * The issue is not un-assigned or re-labelled `agent-ready` — whatever the builder left is what
 * the next session picks up.
 */
export async function applyUnblock(
  gh: UnblockGh,
  i: { issue: number; itemId: string | null; host: string },
): Promise<string> {
  await gh.removeLabels("issue", i.issue, ["blocked"]);
  // An issue that is somehow off the project board has no status to set until it is on it.
  const itemId = i.itemId ?? (await gh.addToProject(i.issue));
  await gh.setStatus(itemId, "Ready");
  await gh.comment("issue", i.issue, fmt.unblocked(i.host));
  return `#${i.issue} unblocked and moved to Ready; the next tick may claim it`;
}

/**
 * Applies a just-performed unblock to the stored board, for the same reason as
 * `applyOwnerActionToBoard`: the board is only rebuilt inside a tick, and a tick that dispatched
 * a session does not return for up to `wallClockMinutes`, so without this the Unblock button
 * stays on the page for an hour after the label is gone. The next real tick recomputes it all.
 */
export function applyUnblockToBoard(board: Board, issue: number): Board {
  if (!board.needsYou.some((n) => n.issue === issue)) return board;
  const blockedDetail = `#${issue} blocked`;
  return {
    ...board,
    // The row goes only if `blocked` was its only reason to be there; a `decision` issue that was
    // also blocked still needs an answer.
    needsYou: board.needsYou.flatMap((n) => {
      if (n.issue !== issue) return [n];
      const labels = n.labels.filter((l) => l !== "blocked");
      return labels.length ? [{ ...n, labels }] : [];
    }),
    waiting: board.waiting.filter((w) => !w.detail.startsWith(blockedDetail)),
    pipeline: board.pipeline.map((r) => (r.issue === issue ? { ...r, blocked: false } : r)),
  };
}
