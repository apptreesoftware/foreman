import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import {
  checkEnv,
  countSessionsToday,
  ensureRoleStack,
  graphqlBudget,
  localDate,
  preflight,
} from "./preflight.ts";

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
  it("fails when the GraphQL budget is nearly spent", async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === "gh" && args[1] === "graphql"
        ? {
            code: 0,
            stdout: '{"data":{"rateLimit":{"remaining":12,"resetAt":"2026-09-04T18:00:00Z"}}}',
            stderr: "",
          }
        : okExec(cmd, args);
    const r = await preflight(cfg, deps({ exec }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("12 points left");
  });
  it("passes on a healthy GraphQL budget", async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === "gh" && args[1] === "graphql"
        ? {
            code: 0,
            stdout: '{"data":{"rateLimit":{"remaining":4800,"resetAt":"2026-09-04T18:00:00Z"}}}',
            stderr: "",
          }
        : okExec(cmd, args);
    expect((await preflight(cfg, deps({ exec }))).ok).toBe(true);
  });
  it("does not block when the budget cannot be read", async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === "gh" && args[1] === "graphql"
        ? { code: 1, stdout: "", stderr: "unreadable" }
        : okExec(cmd, args);
    expect((await preflight(cfg, deps({ exec }))).ok).toBe(true);
  });
  it("parks on a quota that is already exhausted, which gh reports as an error (#387)", async () => {
    // GitHub answers `rateLimit` itself with an error once the hour's points are gone, and gh
    // exits non-zero. Read as "cannot tell", it let the tick through to die inside listIssues.
    const exec: Exec = async (cmd, args) =>
      cmd === "gh" && args[1] === "graphql"
        ? {
            code: 1,
            stdout:
              '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit","message":"API rate limit already exceeded for user ID 9000800."}]}',
            stderr: "gh: API rate limit already exceeded for user ID 9000800.",
          }
        : okExec(cmd, args);
    const r = await preflight(cfg, deps({ exec }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("GitHub GraphQL budget low: 0 points left");
  });
  it("reads an exhausted quota as zero points, not as unreadable", async () => {
    const rateLimited: Exec = async () => ({
      code: 1,
      stdout: '{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit"}]}',
      stderr: "",
    });
    expect(await graphqlBudget(rateLimited)).toEqual({ remaining: 0, limit: 5000, resetAt: "" });
  });
  it("still reads a plain gh failure as unreadable, so being offline never parks the daemon", async () => {
    const offline: Exec = async () => ({
      code: 1,
      stdout: "",
      stderr: "dial tcp: lookup api.github.com: no such host",
    });
    expect(await graphqlBudget(offline)).toBeNull();
    const notJson: Exec = async () => ({ code: 1, stdout: "<html>502</html>", stderr: "" });
    expect(await graphqlBudget(notJson)).toBeNull();
  });
  it("fails when docker is down", async () => {
    const exec: Exec = async (cmd, args) =>
      cmd === "docker" ? { code: 1, stdout: "", stderr: "no daemon" } : okExec(cmd, args);
    expect((await preflight(cfg, deps({ exec }))).ok).toBe(false);
  });
});

describe("ensureRoleStack", () => {
  const fs = () => {
    const made: string[] = [];
    return { made, mkdirp: (p: string) => made.push(p) };
  };
  const recording = (over: (cmd: string, args: string[]) => number = () => 0) => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      const code = over(cmd, args);
      return { code, stdout: "", stderr: code === 0 ? "" : "boom" };
    };
    return { calls, exec };
  };

  // --delete, not `cp -R`: a migration deleted on main must disappear from the copy too, or the
  // role stack keeps applying it forever.
  it("mirrors the config, applies the role rewrite, and leaves a running stack alone", async () => {
    const { calls, exec } = recording();
    const f = fs();
    const warning = await ensureRoleStack(cfg, "/state", { exec, mkdirp: f.mkdirp });
    expect(warning).toBeNull();
    expect(f.made).toEqual(["/state/val-stack/supabase"]);
    expect(calls).toEqual([
      "rsync -a --delete --exclude .branches --exclude .temp /r/packages/db/supabase/ /state/val-stack/supabase/",
      "bash /r/packages/db/scripts/role-config.sh /state/val-stack/supabase/config.toml",
      "supabase status -o env --workdir /state/val-stack",
    ]);
  });

  it("starts the stack when it is down", async () => {
    const { calls, exec } = recording((_cmd, args) => (args[0] === "status" ? 1 : 0));
    expect(await ensureRoleStack(cfg, "/state", { exec, mkdirp: () => {} })).toBeNull();
    expect(calls).toContain("supabase start --workdir /state/val-stack");
  });

  it("warns rather than parking the daemon when the stack will not start", async () => {
    const { exec } = recording((cmd) => (cmd === "supabase" ? 1 : 0));
    const w = await ensureRoleStack(cfg, "/state", { exec, mkdirp: () => {} });
    expect(w).toContain("tone_tonic_val");
  });

  it("warns when the config cannot be copied", async () => {
    const { exec } = recording((cmd) => (cmd === "rsync" ? 1 : 0));
    expect(await ensureRoleStack(cfg, "/state", { exec, mkdirp: () => {} })).toContain(
      "tone_tonic_val",
    );
  });

  it("preflight reports it as a warning, never as a failure", async () => {
    const r = await preflight(cfg, deps());
    expect(r.ok).toBe(true);
  });
});

describe("localDate", () => {
  it("formats yyyy-mm-dd", () => expect(localDate(new Date(2026, 8, 3))).toBe("2026-09-03"));
});
