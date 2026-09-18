import type { Exec } from "./exec.ts";

/**
 * The approved plan is read from `origin/main`, never from the clone's working tree: nothing
 * else in the daemon pulls `repoDir`, so a merged plan PR would otherwise stay invisible until
 * a human ran `git pull` (#189).
 */
export async function fetchOrigin(exec: Exec, repoDir: string): Promise<boolean> {
  const r = await exec("git", ["-C", repoDir, "fetch", "origin", "--prune"]);
  return r.code === 0;
}

/** Repo-relative `*.issues.json` paths tracked on `origin/<defaultBranch>`. */
export async function listPlanFilesOnMain(
  exec: Exec,
  repoDir: string,
  planDir: string,
  defaultBranch: string,
): Promise<string[]> {
  const r = await exec("git", [
    "-C",
    repoDir,
    "ls-tree",
    "-r",
    "--name-only",
    `${defaultBranch}`,
    "--",
    planDir,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".issues.json"));
}

export async function readPlanFileOnMain(
  exec: Exec,
  repoDir: string,
  repoRelPath: string,
  defaultBranch: string,
): Promise<string | null> {
  const r = await exec("git", ["-C", repoDir, "show", `${defaultBranch}:${repoRelPath}`]);
  return r.code === 0 ? r.stdout : null;
}
