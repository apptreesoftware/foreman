import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTCOME_KINDS } from "./dispatch.ts";

const dir = join(import.meta.dirname, "../../../.claude/roles");
const roles = ["builder", "reviewer", "validator", "phase-closer", "planner"] as const;
const read = (r: string) => readFileSync(join(dir, `${r}.md`), "utf8");

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
    for (const r of roles) {
      const text = read(r);
      expect(text).toContain("Never merge");
      expect(text).toContain("main");
      expect(text).toContain("ANTHROPIC_API_KEY");
      expect(text, `${r} forbids cd`).toContain("Never `cd`");
    }
  });
  it("keeps the shared preamble byte-identical across roles", () => {
    const preamble = (r: string) => read(r).slice(0, read(r).indexOf("## Role:"));
    for (const r of roles) expect(preamble(r), r).toBe(preamble("builder"));
  });
  it("validator and phase-closer know the URLs, logins and artifacts dir", () => {
    for (const s of [
      "http://localhost:8082",
      "teacher@local.test",
      "student@local.test",
      "password123",
      "~/.tone_tonic/artifacts",
      ".validation-artifacts",
    ])
      expect(read("validator")).toContain(s);
    for (const s of ["slack_send_message", "notify-failed", "signed-off", "http://localhost:8082"])
      expect(read("phase-closer")).toContain(s);
    expect(read("planner")).toContain(".issues.json");
    expect(read("planner")).toContain("superpowers:writing-plans");
  });
});

describe("role prompts carry the .claude/ denial convention", () => {
  it("every role carries the whole convention sentence, not just needs-owner", () => {
    for (const role of roles) {
      const text = read(role);
      expect(text, role).toContain("If an Edit/Write under");
      expect(text, role).toContain("`.claude/` is denied");
      expect(text, role).toContain("needs-owner");
      expect(text, role).toContain("humans own");
      expect(text, role).toContain("decision #165");
    }
  });
});
