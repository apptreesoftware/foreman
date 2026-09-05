import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import {
  applyRoleConfig,
  branchFor,
  buildArgs,
  buildPrompt,
  childEnv,
  type DispatchRequest,
  dispatchWithRetry,
  ensureWorktree,
  MAX_ATTEMPTS,
  needsIsolatedStack,
  parseResult,
  realSpawn,
  restoreRoleConfig,
  runSession,
  type Spawner,
  slugify,
  transcriptPath,
  trustWorktree,
} from "./dispatch.ts";
import type { Exec } from "./exec.ts";
import { emptyActivity } from "./stream.ts";

const cfg = parseConfig(
  JSON.stringify({
    repo: "o/r",
    project: 2,
    host: "mac-a",
    repoDir: "/repo",
    workDir: "/work",
    slackUser: "m",
    maxTurns: 50,
    wallClockMinutes: 1,
  }),
);
const req: DispatchRequest = {
  role: "builder",
  issue: 42,
  pr: null,
  title: "[Foreman] Add thing",
  specPath: "docs/s.md",
  worktree: "/work/42",
  branch: "feat/42-add-thing",
  sessionId: "33333333-3333-3333-3333-333333333333",
  resume: false,
  attempt: 1,
  round: 1,
  notes: "",
  isolated: false,
  rebase: false,
};
const okJson = (extra = "") =>
  `{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":1.25,"duration_ms":6000,"session_id":"${req.sessionId}","result":"done","structured_output":{"outcome":"pr_opened","pr":77,"notes":"ok"},"permission_denials":[]${extra}}`;

describe("names", () => {
  it("slugify strips the [Foreman] prefix and punctuation", () => {
    expect(slugify("[Foreman] `github.ts` gh wrapper: issues, labels")).toBe(
      "github-ts-gh-wrapper-issues-labels",
    );
    expect(slugify("A".repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it("branchFor", () => expect(branchFor(42, "Add thing")).toBe("feat/42-add-thing"));
  it("transcriptPath mirrors the CLI's project slug", () => {
    expect(transcriptPath("/Users/m/tone_tonic-work/42", "abc")).toMatch(
      /\/\.claude\/projects\/-Users-m-tone-tonic-work-42\/abc\.jsonl$/,
    );
  });
});

describe("buildArgs / buildPrompt", () => {
  it("uses dontAsk, json schema, session id and the role file", () => {
    const a = buildArgs(req, cfg);
    expect(a).toContain("-p");
    expect(a).toContain("--output-format");
    expect(a).toContain("stream-json");
    expect(a).toContain("--verbose");
    expect(a).not.toContain("json");
    expect(a).toContain("--json-schema");
    expect(a).toContain("--max-turns");
    expect(a).toContain("50");
    expect(a.join(" ")).toContain("--permission-mode dontAsk");
    expect(a.join(" ")).toContain("--permission-prompts none");
    expect(a.join(" ")).toContain("--setting-sources user,project");
    expect(a.join(" ")).toContain("--settings /work/42/.claude/headless-settings.json");
    expect(a.join(" ")).toContain("--session-id 33333333-3333-3333-3333-333333333333");
    expect(a.join(" ")).toContain("--append-system-prompt-file /work/42/.claude/roles/builder.md");
    expect(a.join(" ")).not.toContain("dangerously");
    // Always pinned, never inherited from the interactive CLI default (#210).
    expect(a.join(" ")).toContain("--model opus");
    expect(buildArgs(req, { ...cfg, model: "sonnet" }).join(" ")).toContain("--model sonnet");
  });
  it("a rebase round says so instead of announcing a fix round (#237)", () => {
    const p = buildPrompt({ ...req, round: 2, rebase: true, notes: "merge main" }, cfg);
    expect(p).toContain("rebase round");
    expect(p).toContain("git merge origin/main");
    expect(p).not.toContain("fix round");
    expect(buildPrompt({ ...req, round: 2, rebase: false }, cfg)).toContain("fix round 2");
  });
  it("switches to --resume on resume", () => {
    const a = buildArgs({ ...req, resume: true }, cfg).join(" ");
    expect(a).toContain("--resume 33333333-3333-3333-3333-333333333333");
    expect(a).not.toContain("--session-id");
  });
  it("prompt carries issue, branch, spec, round and notes", () => {
    const p = buildPrompt(req, cfg);
    for (const s of ["#42", "feat/42-add-thing", "docs/s.md", "o/r", "mac-a", "8082", "3005"])
      expect(p).toContain(s);
    expect(buildPrompt({ ...req, resume: true }, cfg)).toContain("resuming");
    expect(buildPrompt({ ...req, round: 2, notes: "fix the test" }, cfg)).toContain("fix the test");
  });
});

describe("childEnv", () => {
  it("strips billing variables", () => {
    const e = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(e.PATH).toBe("/bin");
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });
  it("adds the extra variables, and never lets them be a billing variable", () => {
    const e = childEnv({ PATH: "/bin" }, { TONE_WEB_PORT: "8182" });
    expect(e.TONE_WEB_PORT).toBe("8182");
    expect(e.PATH).toBe("/bin");
  });
});

describe("isolated role stack", () => {
  it("covers the sessions that reset the database or serve the app", () => {
    expect(needsIsolatedStack("reviewer")).toBe(true);
    expect(needsIsolatedStack("validator")).toBe(true);
    expect(needsIsolatedStack("planner")).toBe(false);
    expect(needsIsolatedStack("phase-closer")).toBe(false);
  });

  // The hazard is what the builder touches, not how the issue is labelled: `.claude/roles/builder.md`
  // tells every builder to run `pnpm db:reset` if it changed `packages/db`, so an `area:api` issue
  // that adds a migration would drop the owner's database. A builder never needs the owner's data
  // or ports, so it is isolated unconditionally.
  it("isolates every builder, whatever the issue is labelled", () => {
    expect(needsIsolatedStack("builder")).toBe(true);
  });

  it("points an isolated session's prompt at the role stack", () => {
    const p = buildPrompt({ ...req, role: "validator", isolated: true }, cfg);
    expect(p).toContain("web http://localhost:8182");
    expect(p).toContain("api http://localhost:3105");
    expect(p).toContain("http://127.0.0.1:55621 (project tone_tonic_val)");
    expect(p).toContain("config.toml");
    expect(p).not.toContain("8082");
    expect(p).not.toContain("3005");
    expect(p).not.toContain("55321");
  });

  it("leaves a non-isolated session on the dev stack", () => {
    const p = buildPrompt(req, cfg);
    expect(p).toContain("http://127.0.0.1:55321 (project tone_tonic)");
    expect(p).not.toContain("config.toml");
  });

  it("gives an isolated child the role ports and Supabase URL", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const spawn: Spawner = async (_c, _a, opts) => {
      seen.push(opts.env);
      return { code: 0, stdout: okJson(), stderr: "", timedOut: false, interrupted: false };
    };
    await runSession({ ...req, isolated: true }, cfg, { spawn, onAttempt: async () => {} });
    await runSession(req, cfg, { spawn, onAttempt: async () => {} });
    expect(seen[0]).toMatchObject({
      TONE_WEB_PORT: "8182",
      TONE_API_PORT: "3105",
      SUPABASE_API_URL: "http://127.0.0.1:55621",
    });
    expect(seen[1]?.TONE_WEB_PORT).toBeUndefined();
    expect(seen[1]?.SUPABASE_API_URL).toBeUndefined();
  });

  it("applyRoleConfig rewrites the worktree's config with the worktree's script", async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    await applyRoleConfig("/work/42", "/repo", exec, () => true);
    expect(calls[0]).toBe(
      "bash /work/42/packages/db/scripts/role-config.sh /work/42/packages/db/supabase/config.toml",
    );
  });

  it("falls back to the clone's script for a branch that predates it", async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    await applyRoleConfig("/work/42", "/repo", exec, () => false);
    expect(calls).toContain(
      "bash /repo/packages/db/scripts/role-config.sh /work/42/packages/db/supabase/config.toml",
    );
  });

  it("applyRoleConfig marks the rewritten config skip-worktree so a builder's `git add -A` leaves it alone", async () => {
    // The role prompt's standing instruction is `git add -A && git commit`, and a prompt sentence
    // cannot beat a wildcard add. The mechanical guard is the index flag: git add skips a
    // skip-worktree path, so the tone_tonic_val rewrite can never reach a commit.
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    await applyRoleConfig("/work/42", "/repo", exec, () => true);
    expect(calls).toEqual([
      "bash /work/42/packages/db/scripts/role-config.sh /work/42/packages/db/supabase/config.toml",
      "git -C /work/42 update-index --skip-worktree packages/db/supabase/config.toml",
    ]);
  });

  it("applyRoleConfig throws when the skip-worktree flag cannot be set", async () => {
    const exec: Exec = async (cmd) =>
      cmd === "git"
        ? { code: 1, stdout: "", stderr: "unable to mark file" }
        : { code: 0, stdout: "", stderr: "" };
    await expect(applyRoleConfig("/work/42", "/repo", exec, () => true)).rejects.toThrow(
      /skip-worktree/,
    );
  });

  it("restoreRoleConfig clears skip-worktree before checking the config out", async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    };
    await restoreRoleConfig("/work/42", exec);
    expect(calls).toEqual([
      "git -C /work/42 update-index --no-skip-worktree packages/db/supabase/config.toml",
      "git -C /work/42 checkout -- packages/db/supabase/config.toml",
    ]);
  });

  it("applyRoleConfig throws rather than let a session keep the dev config", async () => {
    const exec: Exec = async (cmd) =>
      cmd === "bash"
        ? { code: 1, stdout: "", stderr: "no such config" }
        : { code: 0, stdout: "", stderr: "" };
    await expect(applyRoleConfig("/work/42", "/repo", exec)).rejects.toThrow(
      /role-config\.sh failed/,
    );
  });

  it("restoreRoleConfig swallows a git failure", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "not a git repo" });
    await expect(restoreRoleConfig("/work/42", exec)).resolves.toBeUndefined();
  });
});

describe("parseResult", () => {
  it("reads the last JSON line even after warnings", () => {
    const r = parseResult(`Ignoring 2 permissions.allow entries…\n${okJson()}\n`, false);
    expect(r.outcome).toEqual({ outcome: "pr_opened", pr: 77, notes: "ok" });
    expect(r.costUsd).toBe(1.25);
    expect(r.numTurns).toBe(3);
    expect(r.isError).toBe(false);
  });
  it("handles max turns and garbage", () => {
    const r = parseResult(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"total_cost_usd":9,"duration_ms":1,"session_id":"x","result":null}',
      false,
    );
    expect(r.subtype).toBe("error_max_turns");
    expect(r.outcome).toBeNull();
    const g = parseResult("nothing here", true);
    expect(g.subtype).toBe("no_result");
    expect(g.timedOut).toBe(true);
  });
  it("rejects an invalid structured outcome", () => {
    const r = parseResult(okJson().replace('"pr_opened"', '"banana"'), false);
    expect(r.outcome).toBeNull();
  });
});

describe("trustWorktree", () => {
  it("adds hasTrustDialogAccepted for the path", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tt-")), "claude.json");
    writeFileSync(
      file,
      JSON.stringify({ projects: { "/other": { allowedTools: [] } }, theme: "dark" }),
    );
    trustWorktree("/work/42", file);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.projects["/work/42"].hasTrustDialogAccepted).toBe(true);
    expect(j.projects["/other"].allowedTools).toEqual([]);
    expect(j.theme).toBe("dark");
  });
});

describe("ensureWorktree", () => {
  const record = (remoteHasBranch: boolean, dirExists: boolean) => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (args.includes("ls-remote"))
        return {
          code: 0,
          stdout: remoteHasBranch ? "abc\trefs/heads/feat/42-add-thing\n" : "",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, exec, exists: () => dirExists };
  };
  it("creates from origin/main when the branch is new", async () => {
    const r = record(false, false);
    await ensureWorktree(cfg, req.issue, req.branch, r.exec, r.exists);
    expect(r.calls).toContain("git -C /repo fetch origin --prune");
    expect(r.calls).toContain(
      "git -C /repo worktree add -B feat/42-add-thing /work/42 origin/main",
    );
    expect(r.calls.some((c) => c.startsWith("pnpm install"))).toBe(true);
  });
  it("tracks the remote branch when it exists (resume on another Mac)", async () => {
    const r = record(true, false);
    await ensureWorktree(cfg, req.issue, req.branch, r.exec, r.exists);
    expect(r.calls).toContain(
      "git -C /repo worktree add -B feat/42-add-thing /work/42 origin/feat/42-add-thing",
    );
  });
  it("reuses an existing worktree", async () => {
    const r = record(true, true);
    await ensureWorktree(cfg, req.issue, req.branch, r.exec, r.exists);
    expect(r.calls.some((c) => c.includes("worktree add"))).toBe(false);
    expect(r.calls).toContain("git -C /work/42 pull --ff-only");
  });
});

describe("dispatchWithRetry", () => {
  it("resumes after max-turns and stops at MAX_ATTEMPTS", async () => {
    const seen: boolean[] = [];
    const spawn: Spawner = async (_cmd, args) => {
      seen.push(args.includes("--resume"));
      return {
        code: 1,
        stdout:
          '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"total_cost_usd":1,"duration_ms":1,"session_id":"x","result":null}',
        stderr: "",
        timedOut: false,
        interrupted: false,
      };
    };
    const r = await dispatchWithRetry(req, cfg, { spawn, onAttempt: async () => {} });
    expect(seen).toEqual([false, true, true]);
    expect(seen).toHaveLength(MAX_ATTEMPTS);
    expect(r.outcome).toBeNull();
  });
  it("returns on the first successful outcome", async () => {
    let n = 0;
    const spawn: Spawner = async () => {
      n++;
      return { code: 0, stdout: okJson(), stderr: "", timedOut: false, interrupted: false };
    };
    const r = await dispatchWithRetry(req, cfg, { spawn, onAttempt: async () => {} });
    expect(n).toBe(1);
    expect(r.outcome?.outcome).toBe("pr_opened");
  });
  it("stops retrying when the signal aborts between attempts", async () => {
    const ac = new AbortController();
    let n = 0;
    const firstResult = {
      code: 1,
      stdout:
        '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":50,"total_cost_usd":1,"duration_ms":1,"session_id":"x","result":null}',
      stderr: "",
      timedOut: false,
      interrupted: false,
    };
    const spawn: Spawner = async () => {
      n++;
      // Abort lands after the first attempt returns, before dispatchWithRetry starts a retry.
      ac.abort();
      return firstResult;
    };
    const r = await dispatchWithRetry(req, cfg, {
      spawn,
      onAttempt: async () => {},
      signal: ac.signal,
    });
    expect(n).toBe(1);
    expect(r.subtype).toBe("error_max_turns");
    expect(r.outcome).toBeNull();
  });
});

describe("interrupts", () => {
  it("realSpawn kills the child on abort and reports interrupted", async () => {
    const ac = new AbortController();
    let pid = 0;
    const p = realSpawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
      input: "",
      timeoutMs: 60_000,
      signal: ac.signal,
      onSpawn: (n) => {
        pid = n;
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(pid).toBeGreaterThan(0);
    ac.abort();
    const r = await p;
    expect(r.interrupted).toBe(true);
    expect(r.timedOut).toBe(false);
  });
  it("realSpawn kills immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await realSpawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
      input: "",
      timeoutMs: 60_000,
      signal: ac.signal,
    });
    expect(r.interrupted).toBe(true);
  });
  it("dispatchWithRetry does not retry an interrupted attempt", async () => {
    let n = 0;
    const spawn: Spawner = async () => {
      n++;
      return { code: 143, stdout: "", stderr: "", timedOut: false, interrupted: true };
    };
    const r = await dispatchWithRetry(req, cfg, { spawn, onAttempt: async () => {} });
    expect(n).toBe(1);
    expect(r.interrupted).toBe(true);
    expect(r.subtype).toBe("interrupted");
    expect(r.outcome).toBeNull();
    expect(r.sessionId).toBe(req.sessionId);
  });
  it("runSession passes signal and onSpawn through to the spawner", async () => {
    const ac = new AbortController();
    const seen: { signal?: AbortSignal; onSpawn?: unknown } = {};
    const spawn: Spawner = async (_c, _a, opts) => {
      seen.signal = opts.signal;
      seen.onSpawn = opts.onSpawn;
      return { code: 0, stdout: okJson(), stderr: "", timedOut: false, interrupted: false };
    };
    const onSpawn = () => {};
    await runSession(req, cfg, { spawn, onAttempt: async () => {}, signal: ac.signal, onSpawn });
    expect(seen.signal).toBe(ac.signal);
    expect(seen.onSpawn).toBe(onSpawn);
  });
});

describe("streaming", () => {
  const toolLine = (id: string, file: string) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        content: [{ type: "tool_use", id: `t_${id}`, name: "Read", input: { file_path: file } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      timestamp: "2026-09-04T13:27:20.000Z",
    });

  it("realSpawn delivers complete lines once each, across chunk boundaries", async () => {
    const seen: string[] = [];
    const script = `process.stdout.write('{"a":1}\\n{"b":'); setTimeout(() => process.stdout.write('2}\\n{"c":3}'), 50);`;
    const r = await realSpawn("node", ["-e", script], {
      cwd: process.cwd(),
      env: process.env,
      input: "",
      timeoutMs: 10_000,
      onStdoutLine: (l) => seen.push(l),
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(r.stdout).toBe('{"a":1}\n{"b":2}\n{"c":3}');
  });

  it("runSession folds lines into activity and reports the result entry", async () => {
    const lines = [toolLine("m1", "/work/42/a.ts"), toolLine("m2", "/work/42/b.ts"), okJson()];
    const spawn: Spawner = async (_c, _a, opts) => {
      for (const l of lines) opts.onStdoutLine?.(l);
      return { code: 0, stdout: lines.join("\n"), stderr: "", timedOut: false, interrupted: false };
    };
    const reports: Array<{ turns: number; kinds: string[] }> = [];
    const r = await runSession(req, cfg, {
      spawn,
      onAttempt: async () => {},
      onActivity: (a, entries) =>
        reports.push({ turns: a.turns, kinds: entries.map((e) => e.kind) }),
    });
    expect(r.outcome?.outcome).toBe("pr_opened");
    expect(reports.map((x) => x.turns)).toEqual([1, 2, 2, 2]);
    expect(reports.map((x) => x.kinds)).toEqual([["tool"], ["tool"], [], ["result"]]);
    expect(reports.at(-1)).toBeDefined();
  });

  it("emptyActivity is the starting point for every attempt", () => {
    expect(emptyActivity().turns).toBe(0);
  });
});
