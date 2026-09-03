import { reclaimActions, resumeAction } from "./claim.ts";
import { blockActions, mergeActions, skipValidatorActions } from "./merge.ts";
import { phaseActions } from "./phase.ts";
import { type Kind, pick } from "./pick.ts";
import type { Action, Role, Snapshot } from "./types.ts";

export function roleFor(kind: Kind): Role {
  return kind === "review" ? "reviewer" : kind === "validate" ? "validator" : "builder";
}

/** Order matters: the loop executes in order and stops after the first action that starts a session. */
export function plan(s: Snapshot): Action[] {
  const resume = resumeAction(s);
  if (resume) return [resume];
  const out: Action[] = [
    ...mergeActions(s),
    ...skipValidatorActions(s),
    ...reclaimActions(s),
    ...blockActions(s),
  ];
  const c = pick(s);
  if (c)
    out.push({ type: "claim", issue: c.issue, role: roleFor(c.kind), pr: c.pr, round: c.round });
  out.push(...phaseActions(s));
  return out.length ? out : [{ type: "idle", reason: "nothing eligible" }];
}
