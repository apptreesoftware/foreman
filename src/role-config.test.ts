import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `packages/db` has no JS test runner — its `test` script is pgTAP (`supabase test db`) — so the
// shell script the foreman runs before a role session is tested here, next to the code that runs it.
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const script = join(repoRoot, "packages", "db", "scripts", "role-config.sh");
const devConfig = join(repoRoot, "packages", "db", "supabase", "config.toml");

function rewrite(times = 1): string {
  const config = join(mkdtempSync(join(tmpdir(), "tt-role-config-")), "config.toml");
  copyFileSync(devConfig, config);
  for (let i = 0; i < times; i++)
    execFileSync("bash", [script, config], { encoding: "utf8", cwd: repoRoot });
  return readFileSync(config, "utf8");
}

describe("role-config.sh", () => {
  it("is committed executable, like ci-config.sh", () => {
    const mode = execFileSync("git", ["ls-files", "-s", "packages/db/scripts/role-config.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(mode.split(" ")[0]).toBe("100755");
  });

  it("renames the project and moves every port into the 556xx block", () => {
    const out = rewrite();
    expect(out).toContain('project_id = "tone_tonic_val"');
    expect(out).not.toContain('project_id = "tone_tonic"');
    for (const port of [55620, 55621, 55622, 55623, 55624]) expect(out).toContain(String(port));
    expect(out).toContain("inspector_port = 8283");
    // Nothing may still point at the owner's dev stack, or a role session could reset it.
    expect(out).not.toMatch(/\b553\d\d\b/);
    expect(out).not.toContain("inspector_port = 8083");
  });

  it("is idempotent, so a re-applied worktree config stays on 556xx", () => {
    expect(rewrite(2)).toBe(rewrite(1));
  });

  it("fails loudly on a missing config", () => {
    expect(() =>
      execFileSync("bash", [script, "/nope/config.toml"], { cwd: repoRoot, stdio: "pipe" }),
    ).toThrow();
  });
});
