import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultRepoConfig,
  loadRepoConfig,
  loadRepoConfigSafe,
  resolveTargetBranch,
} from "./repo-config.ts";

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
  it("a thrown message starts with the file path", () => {
    const dir = repo('{"cheks": []}');
    expect(() => loadRepoConfig(dir)).toThrow(join(dir, ".foreman", "config.json"));
  });
});

describe("targetBranch", () => {
  it("is absent by default, so the scaffold never writes it", () => {
    expect(defaultRepoConfig().targetBranch).toBeUndefined();
    expect("targetBranch" in defaultRepoConfig()).toBe(false);
    expect(JSON.stringify(defaultRepoConfig())).not.toContain("targetBranch");
  });
  it("is read when set", () => {
    expect(loadRepoConfig(repo('{"targetBranch": "v2"}')).targetBranch).toBe("v2");
  });
  it("refuses an empty name", () => {
    expect(() => loadRepoConfig(repo('{"targetBranch": ""}'))).toThrow(/targetBranch/);
  });
});

describe("resolveTargetBranch", () => {
  it("a configured branch wins and asks GitHub nothing", async () => {
    let asked = 0;
    const gh = async () => {
      asked++;
      return "main";
    };
    expect(await resolveTargetBranch({ ...defaultRepoConfig(), targetBranch: "v2" }, gh)).toBe(
      "v2",
    );
    expect(asked).toBe(0);
  });
  it("absent, it is the repository's GitHub default branch", async () => {
    expect(await resolveTargetBranch(defaultRepoConfig(), async () => "trunk")).toBe("trunk");
  });
  it("absent, a failing lookup throws for the caller to handle", async () => {
    await expect(
      resolveTargetBranch(defaultRepoConfig(), async () => {
        throw new Error("gh down");
      }),
    ).rejects.toThrow("gh down");
  });
});

describe("loadRepoConfigSafe", () => {
  it("a typo gives the defaults plus one error naming the file and the key", () => {
    const dir = repo('{"cheks": []}');
    const r = loadRepoConfigSafe(dir);
    expect(r.config).toEqual(defaultRepoConfig());
    expect(r.error).toContain(join(dir, ".foreman", "config.json"));
    expect(r.error).toContain("cheks");
    expect(r.error).not.toContain("\n");
  });
  it("unparseable JSON gives the defaults plus an error naming the file", () => {
    const dir = repo("not json");
    const r = loadRepoConfigSafe(dir);
    expect(r.config).toEqual(defaultRepoConfig());
    expect(r.error).toContain(join(dir, ".foreman", "config.json"));
  });
  it("a good file (or none) has no error", () => {
    expect(loadRepoConfigSafe(repo('{"setup": null}'))).toEqual({
      config: { ...defaultRepoConfig(), setup: null },
      error: null,
    });
    expect(loadRepoConfigSafe(repo()).error).toBeNull();
  });
});
