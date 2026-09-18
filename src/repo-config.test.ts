import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRepoConfig, loadRepoConfig } from "./repo-config.ts";

function repo(json?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  if (json !== undefined) {
    mkdirSync(join(dir, ".foreman"));
    writeFileSync(join(dir, ".foreman", "config.json"), json);
  }
  return dir;
}

describe("repo config", () => {
  it("defaults reproduce today's constants, with an empty validator skip list", () => {
    const d = defaultRepoConfig();
    expect(d.setup).toBe("pnpm install");
    expect(d.checks).toEqual(["pnpm lint", "pnpm typecheck", "pnpm test"]);
    expect(d.plans).toEqual({ dir: "docs/superpowers/plans", specGlob: "docs/**/*.md" });
    expect(d.validator.skipLabels).toEqual([]);
    expect(d.limits).toEqual({
      fixRounds: 2,
      ciReruns: 1,
      blockedPerPhase: 2,
      staleHours: 2,
      attempts: 3,
    });
    expect(d.models).toEqual(["opus", "sonnet", "haiku", "fable"]);
  });
  it("a missing file is the defaults", () => {
    expect(loadRepoConfig(repo())).toEqual(defaultRepoConfig());
  });
  it("a partial file overrides only what it names", () => {
    const c = loadRepoConfig(
      repo('{"setup": null, "limits": {"fixRounds": 3}, "validator": {"skipLabels": ["area:db"]}}'),
    );
    expect(c.setup).toBeNull();
    expect(c.limits.fixRounds).toBe(3);
    expect(c.limits.ciReruns).toBe(1);
    expect(c.validator.skipLabels).toEqual(["area:db"]);
    expect(c.checks).toEqual(defaultRepoConfig().checks);
  });
  it("rejects a malformed file loudly", () => {
    expect(() => loadRepoConfig(repo('{"limits": {"fixRounds": "two"}}'))).toThrow(/fixRounds/);
    expect(() => loadRepoConfig(repo("not json"))).toThrow();
  });
  it("rejects an unknown key so a typo is not silently ignored", () => {
    expect(() => loadRepoConfig(repo('{"check": []}'))).toThrow(/check/);
  });
});
