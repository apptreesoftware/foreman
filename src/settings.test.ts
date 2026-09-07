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
    expect(deny).toContain("Read(~/.tone_tonic/foreman.json)");
    expect(deny.some((r) => r.startsWith("Read(~/.tone_tonic/**"))).toBe(false);
  });

  /**
   * #171. The deny list used to name `Bash(cat ~/.ssh*)`, `Bash(cp …)`, `Bash(mv …)` and the
   * same three for `~/.aws`, `~/.claude` and `foreman.json` — one rule per command that might
   * print a file. That enumeration cannot hold: `sed -n`, `grep`, `head`, `tail` and `diff` are
   * all allowlisted and all read a file just as well, an absolute path or a leading `../` evades
   * every `~/`-prefixed pattern, and each new allowlisted command would need three more rules.
   *
   * The decision on #171 was to stop pretending: the exposure is **accepted and documented**
   * rather than papered over. A role session runs as the owner's user with `git` and `gh`
   * credentials already in force, so the machine's secrets are within its reach by construction;
   * the deny list's job is to stop the destructive and the irreversible, not to be a sandbox.
   * The `Read`/`Edit`/`Write` rules below are kept because those are tool-scoped and do hold.
   *
   * This test exists so the enumeration is not quietly reintroduced one command at a time.
   */
  it("does not enumerate per-command denies for the sensitive paths (#171)", () => {
    const enumerated = deny.filter((rule) =>
      /^Bash\((cat|cp|mv|sed|grep|head|tail|diff|less|more|xxd|od|strings) /.test(rule),
    );
    expect(enumerated).toEqual([]);
  });

  it("keeps the tool-scoped denies, which are the ones that actually hold", () => {
    for (const rule of [
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.claude.json)",
      "Read(~/.claude/**)",
      "Read(~/.tone_tonic/foreman.json)",
      "Edit(~/.claude/**)",
      "Write(~/.claude/**)",
    ])
      expect(deny, rule).toContain(rule);
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
