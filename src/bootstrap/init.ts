import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { GitHub } from "../github.ts";
import type { Instance } from "../instance.ts";
import { loadRepoConfig } from "../repo-config.ts";
import { ensureProject } from "./board.ts";
import { ensureLabels } from "./labels.ts";
import { scaffoldRepoDir } from "./scaffold.ts";

/** Spec §9, in order: scopes, labels, board, scaffold. Idempotent; a second run reports and changes nothing. */
export async function runInit(instance: Instance, out: (s: string) => void): Promise<number> {
  const raw = JSON.parse(readFileSync(instance.configPath, "utf8")) as Record<string, unknown>;
  const project = typeof raw.project === "number" ? raw.project : null;
  // `project` is optional in ConfigSchema, so this loads before init has run.
  const cfg = loadConfig(instance.configPath);
  const repo = cfg.repo;
  const owner = cfg.owner;
  const repoDir = cfg.repoDir;
  const gh = new GitHub({ repo, owner, project: project ?? undefined }, realExec, false);
  const scopes = await gh.tokenScopes();
  if (!scopes.includes("project")) {
    out("gh token lacks the project scope. Run: gh auth refresh -s project,read:project");
    return 1;
  }
  const repoCfg = loadRepoConfig(repoDir);
  const labels = await ensureLabels(gh, repoCfg.models);
  out(
    labels.created.length ? `labels created: ${labels.created.join(", ")}` : "labels: all present",
  );
  const board = await ensureProject(gh, {
    owner,
    repo,
    project,
    title: repo.slice(repo.indexOf("/") + 1),
  });
  if (board.created) {
    writeFileSync(
      instance.configPath,
      `${JSON.stringify({ ...raw, project: board.number }, null, 2)}\n`,
    );
    out(`project ${board.number} created, linked, Status options set; foreman.json updated`);
  } else if (board.drift.length) {
    for (const d of board.drift) out(`project ${board.number}: ${d}`);
    return 1;
  } else out(`project ${board.number}: Status options ok`);
  const scaffold = scaffoldRepoDir(repoDir);
  out(
    scaffold.written.length
      ? `scaffolded ${scaffold.written.join(", ")} in ${repoDir}; review and commit them`
      : ".foreman/: present",
  );
  return 0;
}
