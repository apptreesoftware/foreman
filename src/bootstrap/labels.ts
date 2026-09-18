import type { BootstrapApi } from "../github.ts";

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export const LABELS: readonly LabelSpec[] = [
  { name: "epic", color: "5319E7", description: "A phase's parent issue" },
  {
    name: "agent-ready",
    color: "0E8A16",
    description: "The foreman may claim it (task) or plan it (epic)",
  },
  { name: "blocked", color: "B60205", description: "Cannot proceed; the reason is in a comment" },
  { name: "needs-owner", color: "FBCA04", description: "Waiting on the owner" },
  { name: "decision", color: "FBCA04", description: "A question a role session could not answer" },
  { name: "plan-approved", color: "0E8A16", description: "The owner approved the drafted plan" },
  { name: "signed-off", color: "0E8A16", description: "The owner signed the phase off" },
  { name: "foreman:pause", color: "D93F0B", description: "No new claims under this epic" },
  {
    name: "sandbox",
    color: "C5DEF5",
    description: "A throwaway issue for exercising the pipeline",
  },
  {
    name: "reviewer:approved",
    color: "0E8A16",
    description: "Set by the foreman on a reviewer approval",
  },
  {
    name: "reviewer:changes",
    color: "D93F0B",
    description: "Set by the foreman on a change request",
  },
  {
    name: "validator:passed",
    color: "0E8A16",
    description: "Set by the foreman on a validator pass",
  },
  {
    name: "validator:failed",
    color: "D93F0B",
    description: "Set by the foreman on a validator failure",
  },
  {
    name: "validator:skipped",
    color: "C5DEF5",
    description: "Validation not required for this issue's labels",
  },
  { name: "size:S", color: "BFD4F2", description: "Under an hour" },
  { name: "size:M", color: "BFD4F2", description: "A few hours" },
  { name: "size:L", color: "BFD4F2", description: "A day" },
];

export function modelLabels(models: string[]): LabelSpec[] {
  return models.map((m) => ({
    name: `model:${m}`,
    color: "EDEDED",
    description: `Pin every session on this issue to ${m}`,
  }));
}

export async function ensureLabels(
  gh: Pick<BootstrapApi, "listLabels" | "createLabel">,
  models: string[],
): Promise<{ created: string[] }> {
  const have = new Set(await gh.listLabels());
  const created: string[] = [];
  for (const l of [...LABELS, ...modelLabels(models)]) {
    if (have.has(l.name)) continue;
    await gh.createLabel(l);
    created.push(l.name);
  }
  return { created };
}

/**
 * `phase:N` and `area:*` labels are the planner's to invent, so they cannot be part of `init`'s
 * fixed list; the plan is where they first appear. `gh issue create --label` fails outright on a
 * label the repository does not have, which used to fail the whole `apply_plan` tick — and every
 * retry of it — the first time a plan named an area nobody had used yet.
 */
export async function ensurePlanLabels(
  gh: Pick<BootstrapApi, "listLabels" | "createLabel">,
  names: string[],
): Promise<{ created: string[] }> {
  const wanted = [...new Set(names)];
  if (wanted.length === 0) return { created: [] };
  const have = new Set(await gh.listLabels());
  const created: string[] = [];
  for (const name of wanted) {
    if (have.has(name)) continue;
    const phase = /^phase:(\d+)$/.exec(name);
    await gh.createLabel({
      name,
      color: phase ? "1D76DB" : name.startsWith("area:") ? "0052CC" : "EDEDED",
      description: phase
        ? `Phase ${phase[1]}`
        : name.startsWith("area:")
          ? `Area: ${name.slice(5)}`
          : "",
    });
    created.push(name);
  }
  return { created };
}
