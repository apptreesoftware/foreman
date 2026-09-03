import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { checkEnv, countSessionsToday, localDate, preflight } from "./preflight.ts";

const cfg = parseConfig(
  JSON.stringify({
    repo: "o/r",
    project: 2,
    host: "h",
    repoDir: "/r",
    workDir: "/w",
    slackUser: "m",
    maxSessionsPerDay: 2,
  }),
);
const okExec: Exec = async (cmd, args) => {
  if (cmd === "claude" && args[0] === "auth")
    return {
      code: 0,
      stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}',
      stderr: "",
    };
  return { code: 0, stdout: "ok", stderr: "" };
};
const deps = (over: Partial<Parameters<typeof preflight>[1]> = {}) => ({
  env: {},
  exec: okExec,
  stateDir: mkdtempSync(join(tmpdir(), "tt-")),
  now: new Date(),
  ...over,
});

describe("checkEnv", () => {
  it("returns the offending variable", () => {
    expect(checkEnv({ ANTHROPIC_API_KEY: "x" })).toBe("ANTHROPIC_API_KEY");
    expect(checkEnv({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("CLAUDE_CODE_USE_BEDROCK");
    expect(checkEnv({ PATH: "/bin" })).toBeNull();
  });
});

describe("preflight", () => {
  it("passes with a subscription login", async () => {
    expect((await preflight(cfg, deps())).ok).toBe(true);
  });
  it("fails on API-key auth", async () => {
    const exec: Exec = async () => ({
      code: 0,
      stdout: '{"loggedIn":true,"authMethod":"apiKey"}',
      stderr: "",
    });
    const r = await preflight(cfg, deps({ exec }));
    expect(r.ok).toBe(false);
  });
  it("fails when STOP exists", async () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "STOP"), "");
    expect((await preflight(cfg, d)).ok).toBe(false);
  });
  it("fails when the daily cap is reached", async () => {
    const d = deps();
    const t = d.now.toISOString();
    writeFileSync(join(d.stateDir, "sessions.log"), `{"t":"${t}"}\n{"t":"${t}"}\n`);
    expect(countSessionsToday(d.stateDir, d.now)).toBe(2);
    expect((await preflight(cfg, d)).ok).toBe(false);
  });
  it("fails when docker is down", async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === "docker" ? { code: 1, stdout: "", stderr: "no daemon" } : okExec(cmd, args);
    expect((await preflight(cfg, deps({ exec }))).ok).toBe(false);
  });
});

describe("localDate", () => {
  it("formats yyyy-mm-dd", () => expect(localDate(new Date(2026, 8, 3))).toBe("2026-09-03"));
});
