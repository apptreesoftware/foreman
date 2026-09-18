import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeRolePrompt,
  composeSettings,
  PACKAGE_ROOT,
  readRepoRules,
  worktreeDenies,
  writeSessionFiles,
} from "./prompts.ts";
import { defaultRepoConfig } from "./repo-config.ts";

const fixtureRepo = join(import.meta.dirname, "../test/fixtures/repo");

describe("composeRolePrompt", () => {
  const parts = {
    groundRules: "# Ground\n{{checks}}\n",
    base: "## Role: builder\n{{plansDir}} {{specGlob}}\n",
    rules: "house\n",
    roleRules: "builder-only\n",
    checks: ["pnpm lint", "pnpm test"],
    plansDir: "docs/plans",
    specGlob: "docs/**/*.md",
  };
  it("orders ground rules, base, house rules, role rules", () => {
    const p = composeRolePrompt("builder", parts);
    const at = (s: string) => p.indexOf(s);
    expect(at("# Ground")).toBeLessThan(at("## Role: builder"));
    expect(at("## Role: builder")).toBeLessThan(at("## House rules"));
    expect(at("## House rules")).toBeLessThan(at("house"));
    expect(at("house")).toBeLessThan(at("## builder rules"));
    expect(at("## builder rules")).toBeLessThan(at("builder-only"));
  });
  it("fills every placeholder", () => {
    const p = composeRolePrompt("builder", parts);
    expect(p).toContain("`pnpm lint`, `pnpm test`");
    expect(p).toContain("docs/plans docs/**/*.md");
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });
  it("omits the House rules and role sections when the repository has none", () => {
    const p = composeRolePrompt("builder", { ...parts, rules: null, roleRules: null });
    expect(p).not.toContain("## House rules");
    expect(p).not.toContain("## builder rules");
  });
});

describe("composeSettings", () => {
  const base = {
    enableAllProjectMcpServers: true,
    permissions: { allow: ["Read"], deny: ["Bash(gh pr merge*)"] },
  };
  it("appends repository allow and deny", () => {
    const s = composeSettings(base, { allow: ["Bash(pnpm *)"], deny: ["Bash(supabase stop*)"] });
    expect(s.permissions.allow).toEqual(["Read", "Bash(pnpm *)"]);
    expect(s.permissions.deny).toEqual(["Bash(gh pr merge*)", "Bash(supabase stop*)"]);
  });
  it("a repository allow cannot cancel a base deny", () => {
    const s = composeSettings(base, { allow: ["Bash(gh pr merge*)"] });
    expect(s.permissions.deny).toContain("Bash(gh pr merge*)");
    expect(s.permissions.allow).not.toContain("Bash(gh pr merge*)");
  });
  it("dedupes and tolerates null", () => {
    expect(composeSettings(base, { deny: ["Bash(gh pr merge*)"] }).permissions.deny).toEqual([
      "Bash(gh pr merge*)",
    ]);
    expect(composeSettings(base, null)).toEqual(base);
  });
});

describe("readRepoRules", () => {
  it("reads rules.md, roles/<role>.md and settings.json from the worktree", () => {
    const r = readRepoRules(fixtureRepo, "validator");
    expect(r.rules).toContain("supabase stop");
    expect(r.roleRules).toContain("@acme/serve");
    expect(r.settings?.allow).toEqual(["Bash(pnpm *)", "Bash(supabase *)"]);
  });
  it("a malformed settings.json throws with the file path in the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "bad-settings-"));
    mkdirSync(join(dir, ".foreman"));
    const file = join(dir, ".foreman", "settings.json");
    writeFileSync(file, "{ not json");
    expect(() => readRepoRules(dir, "builder")).toThrow(file);
  });
  it("a non-array allow throws instead of spreading its characters into the allow list", () => {
    const dir = mkdtempSync(join(tmpdir(), "bad-allow-"));
    mkdirSync(join(dir, ".foreman"));
    const file = join(dir, ".foreman", "settings.json");
    writeFileSync(file, '{"allow": "x"}');
    expect(() => readRepoRules(dir, "builder")).toThrow(file);
    expect(() => readRepoRules(dir, "builder")).toThrow(/allow/);
  });
  it("is all null for a role without a file, and for a repo without .foreman", () => {
    expect(readRepoRules(fixtureRepo, "builder").roleRules).toBeNull();
    expect(readRepoRules(mkdtempSync(join(tmpdir(), "bare-")), "builder")).toEqual({
      rules: null,
      roleRules: null,
      settings: null,
    });
  });
});

describe("writeSessionFiles", () => {
  it("writes <stateDir>/roles/<role>.md and <stateDir>/settings.json from the shipped bases", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const out = writeSessionFiles(stateDir, fixtureRepo, "validator", {
      ...defaultRepoConfig(),
      checks: ["echo ok"],
    });
    expect(out.promptPath).toBe(join(stateDir, "roles", "validator.md"));
    expect(out.settingsPath).toBe(join(stateDir, "settings.json"));
    const prompt = readFileSync(out.promptPath, "utf8");
    expect(prompt).toContain("## Role: validator");
    expect(prompt).toContain("`echo ok`");
    expect(prompt).toContain("@acme/serve");
    const settings = JSON.parse(readFileSync(out.settingsPath, "utf8"));
    expect(settings.permissions.allow).toContain("Bash(pnpm *)");
    expect(settings.permissions.deny).toContain("Bash(gh pr merge*)");
  });
  it("denies the session writes to its own branch's .foreman/ and .claude/", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "state-"));
    const out = writeSessionFiles(stateDir, fixtureRepo, "builder", defaultRepoConfig());
    const settings = JSON.parse(readFileSync(out.settingsPath, "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(worktreeDenies(fixtureRepo)));
    // Exactly two leading slashes: `//` is Claude Code's absolute-path prefix and the path that
    // follows it has none of its own. `///Users/…` loses one character to the parser and then
    // matches nothing at all.
    const rules = worktreeDenies("/Users/me/.worktrees/123");
    expect(rules).toEqual([
      "Edit(//Users/me/.worktrees/123/.foreman/**)",
      "Write(//Users/me/.worktrees/123/.foreman/**)",
      "Edit(//Users/me/.worktrees/123/.claude/**)",
      "Write(//Users/me/.worktrees/123/.claude/**)",
    ]);
    for (const r of [...rules, ...worktreeDenies(fixtureRepo)]) expect(r).not.toMatch(/\(\/\/\//);
  });
  it("PACKAGE_ROOT holds roles/ and settings/", () => {
    expect(existsSync(join(PACKAGE_ROOT, "roles", "ground-rules.md"))).toBe(true);
    expect(existsSync(join(PACKAGE_ROOT, "settings", "headless.json"))).toBe(true);
  });
});
