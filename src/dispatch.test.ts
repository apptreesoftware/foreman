import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import {
  branchFor,
  buildArgs,
  buildPrompt,
  childEnv,
  type DispatchRequest,
  dispatchWithRetry,
  ensureWorktree,
  MAX_ATTEMPTS,
  parseResult,
  realSpawn,
  runSession,
  type Spawner,
  slugify,
  transcriptPath,
  trustWorktree,
} from "./dispatch.ts";
import type { Exec } from "./exec.ts";

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
    expect(a).toContain("json");
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
