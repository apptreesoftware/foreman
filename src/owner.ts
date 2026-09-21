import type { Board, OwnerAction, OwnerItem } from "./state-file.ts";
import type { Snapshot } from "./types.ts";

/** The subset of the GitHub client an owner action needs; keeps the apply step easy to test. */
export interface OwnerGh {
  addLabels: (kind: "issue" | "pr", n: number, labels: string[]) => Promise<void>;
  removeLabels: (kind: "issue" | "pr", n: number, labels: string[]) => Promise<void>;
  closeIssue: (n: number) => Promise<void>;
}

const DETAIL: Record<OwnerAction, string> = {
  sign_off: "phase review is waiting on your sign-off",
  approve_plan: "a drafted plan is waiting on your approval",
  start_planning: "nothing is planned; the planner waits for your go-ahead",
  pause: "",
  unpause: "",
};

/**
 * The epics waiting on a human, and what that human can do about each. Computed from the
 * snapshot the tick already fetched, so the page costs no extra GitHub reads.
 */
export function ownerItems(s: Snapshot): OwnerItem[] {
  const titleOf = (n: number) => s.issues.find((i) => i.number === n)?.title ?? `#${n}`;
  return [...s.epics]
    .filter((e) => e.state === "OPEN")
    .sort((a, b) => a.phase - b.phase)
    .map((e) => {
      const has = (l: string) => e.labels.includes(l);
      const actions: OwnerAction[] = [];
      // needs-owner means two different things; plan-approved is what tells them apart.
      if (has("needs-owner")) actions.push(has("plan-approved") ? "sign_off" : "approve_plan");
      else if (!has("plan-approved") && !has("agent-ready")) actions.push("start_planning");
      actions.push(has("foreman:pause") ? "unpause" : "pause");
      return {
        epic: e.number,
        title: titleOf(e.number),
        phase: e.phase,
        detail: DETAIL[actions[0] as OwnerAction],
        actions,
      };
    });
}

/**
 * Applies a just-performed gate to the stored board, so the page stops offering it immediately.
 * A tick that dispatched a session does not return for up to `wallClockMinutes`, and the board
 * is only rebuilt inside a tick — without this the epic keeps its button for an hour after the
 * label landed on GitHub. The next real tick recomputes everything from the snapshot.
 */
export function applyOwnerActionToBoard(board: Board, epic: number, action: OwnerAction): Board {
  if (!board.owner.some((o) => o.epic === epic)) return board;
  const subject = `epic #${epic}`;
  return {
    ...board,
    // Sign-off closes the epic, so its row goes; the rest lose only the action just performed,
    // and pause/resume swap for each other.
    owner: board.owner.flatMap((o) => {
      if (o.epic !== epic) return [o];
      if (action === "sign_off") return [];
      const actions = o.actions
        .filter((a) => a !== action)
        .concat(action === "pause" ? ["unpause"] : action === "unpause" ? ["pause"] : []);
      return [{ ...o, actions, detail: "" }];
    }),
    waiting:
      action === "sign_off" || action === "approve_plan"
        ? board.waiting.filter((w) => w.subject !== subject)
        : board.waiting,
  };
}

export async function applyOwnerAction(
  gh: OwnerGh,
  epic: number,
  action: OwnerAction,
): Promise<string> {
  switch (action) {
    case "sign_off":
      await gh.addLabels("issue", epic, ["signed-off"]);
      await gh.removeLabels("issue", epic, ["needs-owner"]);
      await gh.closeIssue(epic);
      return `#${epic} signed off and closed`;
    case "approve_plan":
      // Only the label: the foreman's apply_plan creates the task issues on its next tick.
      await gh.addLabels("issue", epic, ["plan-approved"]);
      return `#${epic} labelled plan-approved; the plan is applied on the next tick`;
    case "start_planning":
      await gh.addLabels("issue", epic, ["agent-ready"]);
      return `#${epic} labelled agent-ready; the planner runs when nothing else is in flight`;
    case "pause":
      await gh.addLabels("issue", epic, ["foreman:pause"]);
      return `#${epic} paused; no new claims under this phase on any Mac`;
    case "unpause":
      await gh.removeLabels("issue", epic, ["foreman:pause"]);
      return `#${epic} resumed`;
  }
}
