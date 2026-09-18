import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRepoConfig, REPO_DIRNAME } from "../repo-config.ts";

const RULES = `<!-- Appended to every role prompt as "House rules". Say how to run, test and start this
repository, which accounts and URLs a validator uses, and any rule a reviewer must check. -->
`;

/** Writes what a repository needs under `.foreman/`, skipping anything already there. */
export function scaffoldRepoDir(repoDir: string): { written: string[] } {
  const dir = join(repoDir, REPO_DIRNAME);
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(dir, rel);
    if (existsSync(p)) return;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    written.push(`${REPO_DIRNAME}/${rel}`);
  };
  put("config.json", `${JSON.stringify(defaultRepoConfig(), null, 2)}\n`);
  put("rules.md", RULES);
  put("settings.json", `${JSON.stringify({ allow: [], deny: [] }, null, 2)}\n`);
  const hooks = join(dir, "hooks");
  if (!existsSync(hooks)) {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, ".gitkeep"), "");
    written.push(`${REPO_DIRNAME}/hooks/`);
  }
  return { written };
}
