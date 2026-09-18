import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTCOME_KINDS } from "./dispatch.ts";
import { PACKAGE_ROOT } from "./prompts.ts";

const dir = join(PACKAGE_ROOT, "roles");
const roles = ["builder", "reviewer", "validator", "phase-closer", "planner"] as const;
const groundRules = readFileSync(join(dir, "ground-rules.md"), "utf8");
/** What a role session is actually handed: the ground rules plus its own base file. */
const read = (r: string) => `${groundRules}\n${readFileSync(join(dir, `${r}.md`), "utf8")}`;
const files = ["ground-rules", ...roles];

describe("role prompts", () => {
  it("exist and are non-trivial", () => {
    for (const r of roles) {
      expect(existsSync(join(dir, `${r}.md`)), r).toBe(true);
      expect(read(r).length, r).toBeGreaterThan(1500);
    }
  });
  it("each names only its own outcomes", () => {
    const allowed: Record<string, string[]> = {
      builder: ["pr_opened", "blocked"],
      reviewer: ["approved", "changes_requested"],
      validator: ["passed", "failed"],
      "phase-closer": ["phase_closed"],
      planner: ["plan_drafted"],
    };
    for (const r of roles) {
      const text = read(r);
      for (const o of allowed[r] as string[])
        expect(text, `${r} mentions ${o}`).toContain(`\`${o}\``);
      for (const o of OUTCOME_KINDS.filter((k) => !(allowed[r] as string[]).includes(k)))
        expect(text, `${r} must not claim ${o}`).not.toContain(`\`${o}\``);
    }
  });
  it("shares the hard rules", () => {
    expect(groundRules).toContain("Never merge");
    expect(groundRules).toContain("default branch");
    expect(groundRules).toContain("ANTHROPIC_API_KEY");
    expect(groundRules).toContain("Never `cd`");
  });
  it("planner names the line the picker requires and the file the foreman applies", () => {
    const planner = readFileSync(join(dir, "planner.md"), "utf8");
    expect(planner).toContain("Parent epic: #<epic>");
    expect(planner).toContain(".issues.json");
  });
});

describe("the base prompts say nothing about one particular repository", () => {
  /**
   * The package ships these; a served repository adds its own in `.foreman/rules.md` and
   * `.foreman/roles/<role>.md`, which `composeRolePrompt` appends. Anything naming one repo's
   * package manager, database, chat tool or home directory belongs on that side, not here.
   */
  it("no base file names a repository's own tooling", () => {
    for (const f of files) {
      const text = readFileSync(join(dir, `${f}.md`), "utf8");
      for (const word of ["pnpm", "supabase", "Slack", "slack_", "notify-failed", "tone_tonic"])
        expect(text.includes(word), `${f}.md names ${word}`).toBe(false);
    }
  });
  it("every placeholder is one the composer fills", () => {
    for (const f of files) {
      const text = readFileSync(join(dir, `${f}.md`), "utf8");
      const found = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const p of found)
        expect(["checks", "plansDir", "specGlob"], `${f}.md uses {{${p}}}`).toContain(p);
    }
  });
});

describe("role prompts carry the config-denial convention", () => {
  it("the ground rules carry the whole convention sentence, not just needs-owner", () => {
    expect(groundRules).toContain("If an Edit/Write under");
    expect(groundRules).toContain("`.foreman/`");
    expect(groundRules).toContain("needs-owner");
    expect(groundRules).toContain("humans own");
  });

  /**
   * The other half of it: `gh … --body` with embedded newlines is denied, which cost builders a
   * turn on every PR while the prompt still prescribed the heredoc form. `--body-file` and a
   * scratch file at the worktree root are what get through.
   */
  it("every role is told to pass a multi-line body as a file", () => {
    for (const role of roles) {
      const text = read(role);
      expect(text, role).toContain("Never pass a multi-line body inline");
      expect(text, role).toContain(".gh-body.md");
      expect(text, role).toContain("--body-file");
    }
  });

  it("no role still prescribes the heredoc body that the allowlist denies", () => {
    for (const role of roles) {
      // Only the ground rule may name the form, and it names it as the thing not to do.
      const prescriptions = read(role)
        .split("\n")
        .filter((line) => line.includes('--body "$(cat'))
        .filter((line) => !line.includes("Never pass a multi-line body inline"));
      expect(prescriptions, role).toEqual([]);
    }
  });
});
