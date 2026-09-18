import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { GitHub } from "../github.ts";
import type { Instance } from "../instance.ts";
import { loadRepoConfig } from "../repo-config.ts";

/** A tiny glob: `**` matches any path, `*` matches within one segment; enough for a spec glob. */
export function matchesGlob(glob: string, path: string): boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${re}$`).test(path);
}

export function epicBody(spec: string): string {
  return `## Spec\n${spec}\n`;
}

/** Opens a phase epic on the instance's board, at Backlog, for the owner to plan or approve. */
export async function runEpicNew(
  instance: Instance,
  o: { title: string; phase: number; spec: string; agentReady: boolean },
  out: (s: string) => void,
): Promise<number> {
  const cfg = loadConfig(instance.configPath);
  if (cfg.project === undefined)
    throw new Error(`project is not set; run: foreman -p ${instance.name} init`);
  const repo = loadRepoConfig(cfg.repoDir);
  if (!matchesGlob(repo.plans.specGlob, o.spec))
    throw new Error(`${o.spec} does not match plans.specGlob (${repo.plans.specGlob})`);
  const gh = new GitHub(
    { repo: cfg.repo, owner: cfg.owner, project: cfg.project },
    realExec,
    false,
  );
  if (!(await gh.fileOnDefaultBranch(o.spec)))
    throw new Error(`${o.spec} is not on the default branch of ${cfg.repo}`);
  const phaseLabel = `phase:${o.phase}`;
  if (!(await gh.listLabels()).includes(phaseLabel))
    await gh.createLabel({ name: phaseLabel, color: "1D76DB", description: `Phase ${o.phase}` });
  const labels = ["epic", phaseLabel, ...(o.agentReady ? ["agent-ready"] : [])];
  const number = await gh.createIssue({ title: o.title, body: epicBody(o.spec), labels });
  const itemId = await gh.addToProject(number);
  await gh.setStatus(itemId, "Backlog");
  out(
    `https://github.com/${cfg.repo}/issues/${number}${
      o.agentReady ? "  (agent-ready: the planner picks it up next tick)" : ""
    }`,
  );
  return 0;
}
