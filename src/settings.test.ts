import { describe, expect, it } from "vitest";
import { readBaseSettings } from "./prompts.ts";

const settings = readBaseSettings();
const allow = settings.permissions.allow;
const deny = settings.permissions.deny;

describe("settings/headless.json, the base headless allowlist", () => {
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
      "Bash(git *)",
      "Bash(gh issue *)",
      "Bash(gh pr create*)",
      "Bash(gh pr review*)",
      "Bash(node *)",
      "Bash(echo *)",
    ])
      expect(allow, rule).toContain(rule);
  });
  /**
   * What a repository needs beyond this — its package manager, its database CLI, its browser MCP
   * server — goes in its own `.foreman/settings.json` and is appended at dispatch. The base file
   * names no repository's tooling, so it fits any of them.
   */
  it("names no one repository's tooling", () => {
    for (const rule of [
      "Bash(pnpm *)",
      "Bash(pnpx *)",
      "Bash(supabase *)",
      "Bash(npx playwright *)",
      "mcp__playwright",
    ])
      expect(allow, rule).not.toContain(rule);
    expect(
      allow.some((r) => r.startsWith("mcp__")),
      "no MCP rule",
    ).toBe(false);
    expect(
      deny.some((r) => /docker|supabase|orb /.test(r)),
      "no repo-specific deny",
    ).toBe(false);
  });
  it("denies merges, pushes to the default branch, sudo and gh api", () => {
    for (const rule of [
      "Bash(gh pr merge*)",
      "Bash(git push origin main*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.claude.json)",
      "Bash(gh api *)",
    ])
      expect(deny, rule).toContain(rule);
  });
  /** A repository whose default branch is `master` gets the same protection as one on `main`. */
  it("protects master as well as main", () => {
    for (const rule of [
      "Bash(git push origin master*)",
      "Bash(git push -u origin master*)",
      "Bash(git push * master*)",
      "Bash(git push origin HEAD:master*)",
      "Bash(git checkout master*)",
      "Bash(git switch master*)",
      "Bash(git branch -D master*)",
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
  it("protects the instance config the daemon owns, and its whole directory from writes", () => {
    expect(deny).toContain("Read(~/.foreman/*/foreman.json)");
    expect(deny.some((r) => r.startsWith("Read(~/.foreman/**"))).toBe(false);
    expect(deny).toContain("Edit(~/.foreman/**)");
    expect(deny).toContain("Write(~/.foreman/**)");
  });

  /**
   * The deny list used to name `Bash(cat ~/.ssh*)`, `Bash(cp …)`, `Bash(mv …)` and the same three
   * for `~/.aws`, `~/.claude` and the instance config — one rule per command that might print a
   * file. That enumeration cannot hold: `sed -n`, `grep`, `head`, `tail` and `diff` are all
   * allowlisted and all read a file just as well, an absolute path or a leading `../` evades
   * every `~/`-prefixed pattern, and each new allowlisted command would need three more rules.
   *
   * The decision was to stop pretending: the exposure is **accepted and documented** rather than
   * papered over. A role session runs as the owner's user with `git` and `gh` credentials already
   * in force, so the machine's secrets are within its reach by construction; the deny list's job
   * is to stop the destructive and the irreversible, not to be a sandbox. The `Read`/`Edit`/
   * `Write` rules above are kept because those are tool-scoped and do hold.
   *
   * This test exists so the enumeration is not quietly reintroduced one command at a time.
   */
  it("does not enumerate per-command denies for the sensitive paths", () => {
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
