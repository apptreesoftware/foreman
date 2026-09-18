import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { firstIssue, REPO_DIRNAME, type RepoConfig } from "./repo-config.ts";
import type { Role } from "./types.ts";

/** `roles/` and `settings/` sit beside `src/` and beside `dist/`, one level up from this file. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface HeadlessSettings {
  enableAllProjectMcpServers: boolean;
  permissions: { allow: string[]; deny: string[] };
}
export interface RepoSettingsExtra {
  allow?: string[];
  deny?: string[];
}

/**
 * `.foreman/settings.json`. Strict and typed: a bare `JSON.parse` cast let `"allow": "x"` spread
 * its characters into the permission list, and malformed JSON threw an unattributed SyntaxError
 * in the middle of a dispatch.
 */
export const RepoSettingsExtraSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .strict();

export interface PromptParts {
  groundRules: string;
  base: string;
  rules: string | null;
  roleRules: string | null;
  checks: string[];
  plansDir: string;
  specGlob: string;
}

function fill(text: string, p: PromptParts): string {
  return text
    .replaceAll("{{checks}}", p.checks.map((c) => `\`${c}\``).join(", "))
    .replaceAll("{{plansDir}}", p.plansDir)
    .replaceAll("{{specGlob}}", p.specGlob);
}

export function composeRolePrompt(role: Role, p: PromptParts): string {
  const sections = [fill(p.groundRules, p).trimEnd(), fill(p.base, p).trimEnd()];
  if (p.rules) sections.push(`## House rules\n${p.rules.trimEnd()}`);
  if (p.roleRules) sections.push(`## ${role} rules\n${p.roleRules.trimEnd()}`);
  return `${sections.join("\n\n")}\n`;
}

/** Base plus repository, deduplicated; a repository allow never removes a base deny. */
export function composeSettings(
  base: HeadlessSettings,
  extra: RepoSettingsExtra | null,
): HeadlessSettings {
  const deny = [...new Set([...base.permissions.deny, ...(extra?.deny ?? [])])];
  const allow = [...new Set([...base.permissions.allow, ...(extra?.allow ?? [])])].filter(
    (r) => !deny.includes(r),
  );
  return { ...base, permissions: { allow, deny } };
}

function readIf(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function readRepoRules(
  worktree: string,
  role: Role,
): { rules: string | null; roleRules: string | null; settings: RepoSettingsExtra | null } {
  const dir = join(worktree, REPO_DIRNAME);
  const settingsPath = join(dir, "settings.json");
  const settingsText = readIf(settingsPath);
  let settings: RepoSettingsExtra | null = null;
  if (settingsText !== null) {
    try {
      settings = RepoSettingsExtraSchema.parse(JSON.parse(settingsText));
    } catch (err) {
      throw new Error(`${settingsPath}: ${firstIssue(err).replace(/\s+/g, " ")}`);
    }
  }
  return {
    rules: readIf(join(dir, "rules.md")),
    roleRules: readIf(join(dir, "roles", `${role}.md`)),
    settings,
  };
}

export function readBasePrompt(role: Role): { groundRules: string; base: string } {
  return {
    groundRules: readFileSync(join(PACKAGE_ROOT, "roles", "ground-rules.md"), "utf8"),
    base: readFileSync(join(PACKAGE_ROOT, "roles", `${role}.md`), "utf8"),
  };
}

export function readBaseSettings(): HeadlessSettings {
  return JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "settings", "headless.json"), "utf8"),
  ) as HeadlessSettings;
}

/**
 * The four deny rules that keep a session out of its own branch's `.foreman/` and `.claude/`.
 * Both are read back by the foreman and by Claude Code for the sessions that follow on that
 * branch: a builder that could append to `.foreman/settings.json` would widen the reviewer's and
 * validator's permissions, rewriting `rules.md` would rewrite the reviewer's House rules, and
 * `.claude/settings.json` is loaded via `--setting-sources user,project` and can define hooks.
 * The base deny list covers `~/.claude/**` and `~/.foreman/**`; these cover the worktree. `//` is
 * Claude Code's absolute-path form.
 */
export function worktreeDenies(worktree: string): string[] {
  return [
    `Edit(//${worktree}/.foreman/**)`,
    `Write(//${worktree}/.foreman/**)`,
    `Edit(//${worktree}/.claude/**)`,
    `Write(//${worktree}/.claude/**)`,
  ];
}

/** Spec §7: the files `claude -p` is pointed at, regenerated per dispatch from the worktree's `.foreman/`. */
export function writeSessionFiles(
  stateDir: string,
  worktree: string,
  role: Role,
  repo: RepoConfig,
): { promptPath: string; settingsPath: string } {
  const repoRules = readRepoRules(worktree, role);
  const prompt = composeRolePrompt(role, {
    ...readBasePrompt(role),
    rules: repoRules.rules,
    roleRules: repoRules.roleRules,
    checks: repo.checks,
    plansDir: repo.plans.dir,
    specGlob: repo.plans.specGlob,
  });
  const composed = composeSettings(readBaseSettings(), repoRules.settings);
  // Appended after the merge, so a repository `allow` cannot pre-empt them either.
  const settings = {
    ...composed,
    permissions: {
      ...composed.permissions,
      deny: [...new Set([...composed.permissions.deny, ...worktreeDenies(worktree)])],
    },
  };
  mkdirSync(join(stateDir, "roles"), { recursive: true });
  const promptPath = join(stateDir, "roles", `${role}.md`);
  const settingsPath = join(stateDir, "settings.json");
  writeFileSync(promptPath, prompt);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { promptPath, settingsPath };
}
