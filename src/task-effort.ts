import {
  type Board,
  EFFORT_DEFAULT,
  EFFORT_DEFAULT_LEVEL,
  EFFORT_LABEL_PREFIX,
  type EffortChoice,
} from "./state-file.ts";
import type { TaskModelGh } from "./task-model.ts";

/**
 * Swaps the issue's `effort:<level>` label, the same way `applyTaskModel` swaps `model:<name>`:
 * the old one goes first so the issue never carries two; `default` only removes. `current` is
 * the label's level as last seen — the stored board for the page, a fresh read for `ctl`.
 */
export async function applyTaskEffort(
  gh: TaskModelGh,
  task: { issue: number; current: string | null },
  effort: EffortChoice,
): Promise<string> {
  // The default level is what no label means, so choosing it removes the label instead.
  const level = effort === EFFORT_DEFAULT ? EFFORT_DEFAULT_LEVEL : effort;
  if (level === (task.current ?? EFFORT_DEFAULT_LEVEL))
    return `#${task.issue} already runs at ${level} effort`;
  if (task.current)
    await gh.removeLabels("issue", task.issue, [EFFORT_LABEL_PREFIX + task.current]);
  if (level === EFFORT_DEFAULT_LEVEL)
    return `#${task.issue} back on the default ${level} effort${task.current ? ` (was ${task.current})` : ""}`;
  await gh.addLabels("issue", task.issue, [EFFORT_LABEL_PREFIX + level]);
  return `#${task.issue} runs at ${level} effort from its next session`;
}

/** Reflects a just-applied label on the stored board, like `applyTaskModelToBoard`. */
export function applyTaskEffortToBoard(board: Board, issue: number, effort: EffortChoice): Board {
  const next = effort === EFFORT_DEFAULT || effort === EFFORT_DEFAULT_LEVEL ? null : effort;
  return {
    ...board,
    phases: board.phases.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => (t.issue === issue ? { ...t, effort: next } : t)),
    })),
    pipeline: board.pipeline.map((r) => (r.issue === issue ? { ...r, effort: next } : r)),
  };
}
