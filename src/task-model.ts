import {
  type Board,
  MODEL_DEFAULT,
  MODEL_LABEL_PREFIX,
  type PhaseTask,
  type TaskModelChoice,
} from "./state-file.ts";

/** The subset of the GitHub client a task-model change needs; keeps the apply step easy to test. */
export interface TaskModelGh {
  addLabels: (kind: "issue" | "pr", n: number, labels: string[]) => Promise<void>;
  removeLabels: (kind: "issue" | "pr", n: number, labels: string[]) => Promise<void>;
}

/**
 * The tasks the page may set a model on: every open task of every phase on the stored board.
 * This is the endpoint's allowlist, so an issue the last tick did not list under an approved
 * phase — or one already closed — never reaches GitHub.
 */
export function phaseTasks(board: Board | null): PhaseTask[] {
  return (board?.phases ?? []).flatMap((p) => p.tasks.filter((t) => !t.closed));
}

/**
 * Swaps the issue's `model:<name>` label: the old one goes first so the issue never carries two,
 * then the new one lands; `default` only removes. `current` is what the stored board saw, which
 * is what the page showed the owner when they clicked — the tick's snapshot is the truth we have.
 */
export async function applyTaskModel(
  gh: TaskModelGh,
  task: { issue: number; current: string | null },
  model: TaskModelChoice,
): Promise<string> {
  if (task.current) await gh.removeLabels("issue", task.issue, [MODEL_LABEL_PREFIX + task.current]);
  if (model === MODEL_DEFAULT)
    return `#${task.issue} back on the global model${task.current ? ` (was ${task.current})` : ""}`;
  await gh.addLabels("issue", task.issue, [MODEL_LABEL_PREFIX + model]);
  return `#${task.issue} runs as ${model} from its next session`;
}

/**
 * Reflects a just-applied label on the stored board, so the page shows the new model at once
 * rather than after the next tick — which, with a session running, can be an hour away.
 */
export function applyTaskModelToBoard(board: Board, issue: number, model: TaskModelChoice): Board {
  const next = model === MODEL_DEFAULT ? null : model;
  return {
    ...board,
    phases: board.phases.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => (t.issue === issue ? { ...t, model: next } : t)),
    })),
    pipeline: board.pipeline.map((r) => (r.issue === issue ? { ...r, model: next } : r)),
  };
}
