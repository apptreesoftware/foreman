import { adoptActions } from "./adopt.ts";
import { ciActions } from "./ci.ts";
import { reclaimActions, resumeAction } from "./claim.ts";
import { blockActions, mergeActions, skipValidatorActions } from "./merge.ts";
import { phaseActions } from "./phase.ts";
import { type Kind, pick } from "./pick.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
import type { Action, Role, Snapshot } from "./types.ts";

export function roleFor(kind: Kind): Role {
  return kind === "review" ? "reviewer" : kind === "validate" ? "validator" : "builder";
}

/** Order matters: the loop executes in order and stops after the first action that starts a session. */
export function plan(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): Action[] {
  const resume = resumeAction(s);
  if (resume) return [resume];
  const out: Action[] = [
    // Before the pick: an adopted issue lands on the board Ready, and the next tick can claim it.
    ...adoptActions(s),
    ...mergeActions(s),
    // Before the pick: a rerun that turns the checks green makes the next tick's merge possible
    // and saves the builder round the picker would otherwise queue (#362).
    ...ciActions(s, repo),
    ...skipValidatorActions(s, repo),
    ...reclaimActions(s, repo.limits.staleHours),
    ...blockActions(s, repo),
  ];
  const c = pick(s, repo);
  if (c)
    out.push({
      type: "claim",
      issue: c.issue,
      role: roleFor(c.kind),
      pr: c.pr,
      round: c.round,
      ...(c.kind === "rebase" ? { rebase: true } : {}),
    });
  out.push(...phaseActions(s));
  return out.length ? out : [{ type: "idle", reason: "nothing eligible" }];
}
