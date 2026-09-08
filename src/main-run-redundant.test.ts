import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `.github` has no test runner of its own, so the script the `changes` job runs is tested here,
 * the way `role-config.test.ts` covers `packages/db/scripts/role-config.sh` (#392).
 *
 * The script's only outside dependency is `gh`, so each case puts a stub `gh` at the front of
 * PATH. The stub answers one canned value per API path and fails for anything it was not given,
 * which is also how the "gh is broken" case is written.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const script = join(repoRoot, ".github", "scripts", "main-run-redundant.sh");
const workflow = join(repoRoot, ".github", "workflows", "ci.yml");

const REPO = "matthewtsmith/tone_tonic";
const PUSHED = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);

/** The API paths the script asks for, in the order it needs them. */
const paths = {
  pulls: `repos/${REPO}/commits/${PUSHED}/pulls`,
  pr: `repos/${REPO}/pulls/390`,
  pushedCommit: `repos/${REPO}/commits/${PUSHED}`,
  headCommit: `repos/${REPO}/commits/${HEAD}`,
  runs: `repos/${REPO}/actions/workflows/ci.yml/runs`,
};

/** Everything green: a PR, matching trees, one successful `ci` run. */
function redundantPush(): Record<string, string> {
  return {
    [paths.pulls]: "390",
    [paths.pr]: HEAD,
    [paths.pushedCommit]: TREE,
    [paths.headCommit]: TREE,
    [paths.runs]: "1",
  };
}

/**
 * Runs the script with a stub `gh` that returns `answers[path]` for the path in its arguments.
 * A path with no answer makes the stub exit non-zero, so a test can drop one call to prove the
 * script treats a failed call as "not redundant".
 */
function verdict(answers: Record<string, string>, sha = PUSHED): string {
  const dir = mkdtempSync(join(tmpdir(), "tt-main-run-redundant-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      // The path is whichever argument looks like one; a query string is cut off so a test names
      // the path once rather than repeating the script's paging parameters.
      "path=",
      'for arg in "$@"; do case "$arg" in repos/*) path=$(printf %s "$arg" | cut -d? -f1);; esac; done',
      'case "$path" in',
      ...Object.entries(answers).map(([path, value]) => `  ${path}) echo '${value}'; exit 0;;`),
      "esac",
      'echo "stub gh has no answer for $path" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return execFileSync("bash", [script, sha], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO },
  }).trim();
}

describe("main-run-redundant.sh", () => {
  it("is committed executable, like the other CI scripts", () => {
    const mode = execFileSync("git", ["ls-files", "-s", ".github/scripts/main-run-redundant.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(mode.split(" ")[0]).toBe("100755");
  });

  it("says true when the pushed tree is a PR head that ci already passed", () => {
    expect(verdict(redundantPush())).toBe("true");
  });

  it("says false when the merge produced a different tree from the PR head", () => {
    expect(verdict({ ...redundantPush(), [paths.headCommit]: "d".repeat(40) })).toBe("false");
  });

  it("says false when the commit has no pull request", () => {
    expect(verdict({ ...redundantPush(), [paths.pulls]: "" })).toBe("false");
  });

  it("says false when the PR head has no successful ci run", () => {
    expect(verdict({ ...redundantPush(), [paths.runs]: "0" })).toBe("false");
  });

  it("says false, and exits 0, when gh cannot answer at all", () => {
    expect(verdict({})).toBe("false");
  });

  it("says false when it is given no commit to look at", () => {
    expect(verdict(redundantPush(), "")).toBe("false");
  });
});

describe("the changes job in ci.yml", () => {
  const yaml = readFileSync(workflow, "utf8");

  it("asks the script about a push before it looks at the diff", () => {
    expect(yaml).toContain(".github/scripts/main-run-redundant.sh");
    expect(yaml).toMatch(/if:\s*github\.event_name == 'push'/);
  });

  it("turns every job off when the script says the run is redundant", () => {
    // The four outputs must all be false together: one left true would run a job against a tree
    // that was already proved, which is the cost this issue exists to remove.
    expect(yaml).toMatch(
      /REDUNDANT["']? = ["']?true["']?[\s\S]{0,400}?code=false\\ndb=false\\napp=false\\nimage=false/,
    );
  });
});
