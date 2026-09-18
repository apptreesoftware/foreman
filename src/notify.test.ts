import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "./exec.ts";
import {
  createNotifier,
  formatEvent,
  MAX_LINE,
  macosTitle,
  type NotifyEvent,
  noopNotify,
  notifyStatePath,
  SEND_TIMEOUT_MS,
} from "./notify.ts";
import type { Issue } from "./types.ts";

const stateDir = () => mkdtempSync(join(tmpdir(), "tt-notify-"));

interface Post {
  url: string;
  text: string;
  hasSignal: boolean;
}

function recorder() {
  const posts: Post[] = [];
  const runs: string[][] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    posts.push({
      url: String(url),
      text: JSON.parse(String(init?.body)).text,
      hasSignal: Boolean(init?.signal),
    });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const exec: Exec = async (cmd, args) => {
    runs.push([cmd, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { posts, runs, fetchImpl, exec };
}

const deps = (dir: string, r: ReturnType<typeof recorder>) => ({
  fetch: r.fetchImpl,
  exec: r.exec,
  stateDir: dir,
  repo: "o/r",
  host: "mac-a",
  instance: "widgets",
});

const HOOK = "https://hooks.slack.com/services/T000/B000/xxx";

const issueLike = (over: Partial<Issue>): Issue =>
  ({ number: 1, title: "t", labels: [], ...over }) as Issue;

describe("formatEvent", () => {
  const fmt = (e: NotifyEvent) => formatEvent(e, { repo: "o/r", host: "mac-a" });

  it("names the PR, the issue it closes, and links the PR", () => {
    expect(fmt({ kind: "merged", pr: 9, issue: 3, title: "feat(db): lessons" })).toBe(
      "merged #9 → closes #3: feat(db): lessons https://github.com/o/r/pull/9",
    );
  });
  it("blocked carries only the first line of the reason", () => {
    expect(
      fmt({
        kind: "blocked",
        issue: 3,
        title: "feat(db): lessons",
        reason: "migration conflicts with #14\n\nstack trace: /Users/x/secret\nmore",
      }),
    ).toBe(
      "blocked #3 feat(db): lessons — migration conflicts with #14 https://github.com/o/r/issues/3",
    );
  });
  it("blocked drops the title separator when the tick's snapshot had no title", () => {
    expect(fmt({ kind: "blocked", issue: 3, title: "", reason: "no reviewer outcome" })).toBe(
      "blocked #3 — no reviewer outcome https://github.com/o/r/issues/3",
    );
  });
  it("truncates a long reason instead of pasting a transcript", () => {
    const line = fmt({ kind: "blocked", issue: 3, title: "t", reason: "x".repeat(1000) });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(MAX_LINE * 3);
    expect(line).not.toContain("x".repeat(MAX_LINE + 1));
  });
  it("decision, phase closed, plan drafted each link the thing to open", () => {
    expect(fmt({ kind: "decision", issue: 40, title: "Decision: seed shape" })).toBe(
      "decision needed #40: Decision: seed shape https://github.com/o/r/issues/40",
    );
    expect(fmt({ kind: "phase_closed", epic: 10, title: "Phase 1", review: 55 })).toBe(
      "phase 10 closed: Phase 1 — review #55 https://github.com/o/r/issues/55",
    );
    expect(fmt({ kind: "plan_drafted", epic: 10, title: "Phase 1", pr: 77 })).toBe(
      "plan drafted for #10: Phase 1 https://github.com/o/r/pull/77",
    );
  });
  it("falls back to the epic link when the review issue or plan PR is unknown", () => {
    expect(fmt({ kind: "phase_closed", epic: 10, title: "Phase 1", review: null })).toBe(
      "phase 10 closed: Phase 1 — review issue on the epic https://github.com/o/r/issues/10",
    );
    expect(fmt({ kind: "plan_drafted", epic: 10, title: "Phase 1", pr: null })).toBe(
      "plan drafted for #10: Phase 1 https://github.com/o/r/issues/10",
    );
  });
  it("parked and resumed name the host and the reason", () => {
    expect(fmt({ kind: "parked", reason: "daily session cap reached (20/20)" })).toBe(
      "foreman parked on mac-a: daily session cap reached (20/20)",
    );
    expect(fmt({ kind: "resumed", was: "STOP file present" })).toBe(
      "foreman resumed on mac-a (was: STOP file present)",
    );
  });
});

describe("createNotifier delivery", () => {
  it("does nothing at all when neither channel is configured", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier(undefined, deps(dir, r));
    await n.send({ kind: "parked", reason: "STOP file present" });
    await n.syncParked("STOP file present");
    await n.syncDecisions([issueLike({ number: 40, labels: ["decision"] })]);
    expect(r.posts).toEqual([]);
    expect(r.runs).toEqual([]);
    expect(existsSync(notifyStatePath(dir))).toBe(false);
  });

  it("posts one line to the Slack webhook with a timeout", async () => {
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(stateDir(), r));
    await n.send({ kind: "merged", pr: 9, issue: 3, title: "feat(db): lessons" });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.url).toBe(HOOK);
    expect(r.posts[0]?.text).toContain("merged #9 → closes #3");
    expect(r.posts[0]?.hasSignal).toBe(true);
    expect(r.runs).toEqual([]);
    expect(SEND_TIMEOUT_MS).toBe(5000);
  });

  it("shows a macOS notification, escaping quotes so osascript cannot be broken out of", async () => {
    const r = recorder();
    const n = createNotifier({ macos: true }, deps(stateDir(), r));
    await n.send({ kind: "blocked", issue: 3, title: 'a "quoted" \\ title', reason: "why" });
    expect(r.runs).toHaveLength(1);
    const [cmd, flag, script] = r.runs[0] as string[];
    expect(cmd).toBe("osascript");
    expect(flag).toBe("-e");
    expect(script).toContain(`with title "${macosTitle("widgets")}"`);
    expect(script).toContain('a \\"quoted\\" \\\\ title');
    expect(r.posts).toEqual([]);
  });

  it("uses both channels when both are configured", async () => {
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK, macos: true }, deps(stateDir(), r));
    await n.send({ kind: "resumed", was: "gh is not authenticated" });
    expect(r.posts).toHaveLength(1);
    expect(r.runs).toHaveLength(1);
  });

  it("a throwing fetch, a non-2xx response and a failing osascript never propagate", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const rejecting = (async () => new Response("no_service", { status: 404 })) as typeof fetch;
    const failingExec: Exec = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const base = deps(stateDir(), recorder());
    for (const over of [
      { fetch: throwing },
      { fetch: rejecting },
      { exec: failingExec, fetch: throwing },
    ]) {
      const n = createNotifier({ slackWebhookUrl: HOOK, macos: true }, { ...base, ...over });
      await expect(n.send({ kind: "parked", reason: "preflight" })).resolves.toBeUndefined();
    }
  });
});

describe("syncParked", () => {
  it("fires once per parked spell, not per tick, and once again on resume", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncParked(null); // healthy: nothing to say, nothing to write
    expect(r.posts).toEqual([]);
    expect(existsSync(notifyStatePath(dir))).toBe(false);

    await n.syncParked("gh is not authenticated");
    await n.syncParked("gh is not authenticated");
    await n.syncParked("gh is not authenticated");
    expect(r.posts.map((p) => p.text)).toEqual([
      "foreman parked on mac-a: gh is not authenticated",
    ]);

    await n.syncParked(null);
    await n.syncParked(null);
    expect(r.posts).toHaveLength(2);
    expect(r.posts[1]?.text).toBe("foreman resumed on mac-a (was: gh is not authenticated)");

    await n.syncParked("STOP file present");
    expect(r.posts).toHaveLength(3);
  });

  it("a reason that changes mid-spell is recorded but not re-announced", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncParked("gh is not authenticated");
    await n.syncParked("daily session cap reached (20/20)");
    expect(r.posts).toHaveLength(1);
    await n.syncParked(null);
    expect(r.posts[1]?.text).toContain("was: daily session cap reached (20/20)");
  });
});

describe("syncDecisions", () => {
  const decision = (number: number, title: string) =>
    issueLike({ number, title, labels: ["decision", "needs-owner", "phase:1"] });

  it("seeds silently on the first run so a fresh install does not replay the backlog", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncDecisions([decision(40, "Decision: a"), decision(41, "Decision: b")]);
    expect(r.posts).toEqual([]);
    expect(JSON.parse(readFileSync(notifyStatePath(dir), "utf8")).decisions).toEqual([40, 41]);
  });

  it("announces each new decision issue exactly once", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncDecisions([decision(40, "Decision: a")]);
    await n.syncDecisions([decision(40, "Decision: a"), decision(41, "Decision: b")]);
    await n.syncDecisions([decision(40, "Decision: a"), decision(41, "Decision: b")]);
    expect(r.posts.map((p) => p.text)).toEqual([
      "decision needed #41: Decision: b https://github.com/o/r/issues/41",
    ]);
  });

  it("ignores issues without the decision label", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncDecisions([]);
    await n.syncDecisions([issueLike({ number: 7, title: "feat: x", labels: ["phase:1"] })]);
    expect(r.posts).toEqual([]);
  });

  it("re-announces a decision issue that was closed and reopened", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncDecisions([decision(40, "Decision: a")]);
    await n.syncDecisions([]); // closed: it drops out of the open snapshot
    await n.syncDecisions([decision(40, "Decision: a")]);
    expect(r.posts).toHaveLength(1);
  });

  it("keeps the parked spell when it writes the decision list", async () => {
    const dir = stateDir();
    const r = recorder();
    const n = createNotifier({ slackWebhookUrl: HOOK }, deps(dir, r));
    await n.syncParked("gh is not authenticated");
    await n.syncDecisions([decision(40, "Decision: a")]);
    await n.syncParked("gh is not authenticated");
    expect(r.posts).toHaveLength(1); // still the one park line
  });
});

describe("noopNotify", () => {
  it("satisfies the port without doing anything", async () => {
    await expect(noopNotify.send({ kind: "parked", reason: "x" })).resolves.toBeUndefined();
    await expect(noopNotify.syncParked(null)).resolves.toBeUndefined();
    await expect(noopNotify.syncDecisions([])).resolves.toBeUndefined();
  });
});
