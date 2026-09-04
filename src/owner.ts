import type { OwnerAction, OwnerItem } from "./state-file.ts";
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
 * snapshot the tick already fetched, so the page costs no extra GitHub reads (#198).
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
