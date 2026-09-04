import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectSettings = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../.claude/settings.json"), "utf8"),
);
const settings = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../.claude/headless-settings.json"), "utf8"),
);
const allow: string[] = settings.permissions.allow;
const deny: string[] = settings.permissions.deny;

describe(".claude/settings.json (interactive/project settings)", () => {
  it("enables project MCP servers", () => {
    expect(projectSettings.enableAllProjectMcpServers).toBe(true);
  });
  it("carries no permission rules, so interactive sessions are unaffected", () => {
    expect(projectSettings.permissions).toBeUndefined();
  });
});

describe(".claude/headless-settings.json headless allowlist", () => {
  it("enables project MCP servers for headless sessions", () => {
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });
  it("allows the tools roles need", () => {
    for (const rule of [
      "Edit",
      "Write",
      "Read",
      "Glob",
      "Grep",
      "Bash(pnpm *)",
      "Bash(git *)",
      "Bash(gh issue *)",
      "Bash(gh pr create*)",
      "Bash(gh pr review*)",
      "Bash(supabase *)",
      "Bash(npx playwright *)",
      "Bash(node *)",
      "Bash(echo *)",
      "mcp__playwright",
      "mcp__claude_ai_Slack__slack_send_message",
      "mcp__claude_ai_Slack__slack_search_users",
    ])
      expect(allow, rule).toContain(rule);
  });
  it("denies merges, pushes to main, sudo, docker and foreign supabase projects", () => {
    for (const rule of [
      "Bash(gh pr merge*)",
      "Bash(git push origin main*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(sudo *)",
      "Bash(docker *)",
      "Bash(supabase stop*)",
      "Bash(rm -rf /*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.claude.json)",
      "Bash(gh api *)",
      "Bash(cat ~/.ssh*)",
    ])
      expect(deny, rule).toContain(rule);
  });
  it("never allows raw curl to arbitrary hosts or WebFetch", () => {
    expect(allow.some((r) => r.startsWith("WebFetch"))).toBe(false);
    expect(allow.some((r) => r.startsWith("Bash(curl"))).toBe(false);
  });
  it("never allows gh api or a raw env dump", () => {
    expect(allow).not.toContain("Bash(env)");
    expect(allow.some((r) => r.startsWith("Bash(gh api"))).toBe(false);
  });
  it("protects only foreman.json under ~/.tone_tonic, not the whole directory", () => {
    expect(deny).toContain("Bash(cat ~/.tone_tonic/foreman.json*)");
    expect(deny).toContain("Bash(cp ~/.tone_tonic/foreman.json*)");
    expect(deny).toContain("Bash(mv ~/.tone_tonic/foreman.json*)");
    expect(deny).not.toContain("Bash(cat ~/.tone_tonic*)");
    expect(deny).not.toContain("Bash(cp ~/.tone_tonic*)");
    expect(deny).not.toContain("Bash(mv ~/.tone_tonic*)");
  });
});

describe("read-only utilities are allowed for role sessions", () => {
  it("allows tail, head, grep, pwd and true", () => {
    for (const rule of ["Bash(tail *)", "Bash(grep *)", "Bash(head *)", "Bash(pwd)", "Bash(true)"])
      expect(allow, rule).toContain(rule);
  });
  it("never allows find: -exec runs arbitrary commands past the deny list", () => {
    expect(allow.some((r) => r.startsWith("Bash(find"))).toBe(false);
  });
  it("never allows a bare shell that would run arbitrary commands past the deny list", () => {
    for (const prefix of ["Bash(sh", "Bash(bash", "Bash(zsh", "Bash(xargs", "Bash(env "])
      expect(
        allow.some((r) => r.startsWith(prefix)),
        prefix,
      ).toBe(false);
  });
});
