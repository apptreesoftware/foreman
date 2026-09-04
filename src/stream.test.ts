import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyActivity, foldEvent, summarizeToolUse } from "./stream.ts";

const lines = readFileSync(join(import.meta.dirname, "../test/fixtures/stream.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const now = "2026-09-04T13:40:00.000Z";
const wt = "/work/10";

function foldAll(ls: string[]) {
  let a = emptyActivity();
  const entries = [];
  for (const l of ls) {
    const r = foldEvent(a, l, now, wt);
    a = r.activity;
    entries.push(...r.entries);
  }
  return { a, entries };
}

describe("summarizeToolUse", () => {
  it("prefers Bash description over command", () => {
    expect(summarizeToolUse("Bash", { command: "ls", description: "List files" }, wt)).toBe(
      "List files",
    );
    expect(summarizeToolUse("Bash", { command: "ls -la" }, wt)).toBe("ls -la");
  });
  it("relativises file paths inside the worktree", () => {
    expect(summarizeToolUse("Edit", { file_path: "/work/10/src/a.ts" }, wt)).toBe("src/a.ts");
    expect(summarizeToolUse("Read", { file_path: "/etc/hosts" }, wt)).toBe("/etc/hosts");
  });
  it("handles Grep/Glob, Skill, Agent, playwright, slack, unknown", () => {
    expect(summarizeToolUse("Grep", { pattern: "foo", path: "/work/10/src" }, wt)).toBe(
      "foo in src",
    );
    expect(summarizeToolUse("Glob", { pattern: "**/*.ts" }, wt)).toBe("**/*.ts");
    expect(summarizeToolUse("Skill", { skill: "superpowers:writing-plans" }, wt)).toBe(
      "superpowers:writing-plans",
    );
    expect(summarizeToolUse("Agent", { description: "Find callers" }, wt)).toBe("Find callers");
    expect(
      summarizeToolUse("mcp__playwright__browser_navigate", { url: "http://localhost:8082" }, wt),
    ).toBe("browser_navigate http://localhost:8082");
    expect(
      summarizeToolUse("mcp__claude_ai_Slack__slack_send_message", { text: "secret" }, wt),
    ).toBe("slack_send_message");
    expect(summarizeToolUse("Whatever", { x: 1 }, wt)).toBe("Whatever");
  });
  it("collapses whitespace and cuts at 120 chars", () => {
    const s = summarizeToolUse("Bash", { command: `a\n${"b".repeat(200)}` }, wt);
    expect(s.length).toBe(120);
    expect(s.startsWith("a b")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("foldEvent", () => {
  it("counts every line as an event and tolerates garbage", () => {
    const { a } = foldAll(["this is not json", "{}", '{"type":"nope"}']);
    expect(a.events).toBe(3);
    expect(a.turns).toBe(0);
  });
  it("records init", () => {
    const { a, entries } = foldAll(lines.slice(0, 2));
    expect(a.model).toBe("claude-sonnet-5");
    expect(a.startedAt).toBe(now);
    expect(entries).toEqual([{ t: now, kind: "init", model: "claude-sonnet-5" }]);
  });
  it("counts turns per message id and sums usage once per message", () => {
    const { a } = foldAll(lines);
    expect(a.turns).toBe(4); // msg_1..msg_4
    expect(a.tokens).toEqual({ input: 20, output: 913, cacheRead: 3020, cacheWrite: 100 });
  });
  it("tracks the last tool, text, error and event time", () => {
    const { a } = foldAll(lines.slice(0, 9));
    expect(a.lastTool).toEqual({
      name: "Write",
      summary: "docs/superpowers/plans/2026-09-04-phase-01-plan.md",
      at: "2026-09-04T13:30:54.000Z",
      subagent: false,
    });
    expect(a.lastText).toEqual({
      text: "Now I'll write the plan.",
      at: "2026-09-04T13:30:54.000Z",
    });
    expect(a.lastError).toEqual({ tool: "Write", at: "2026-09-04T13:30:55.000Z" });
    expect(a.lastEventAt).toBe("2026-09-04T13:30:55.000Z");
  });
  it("marks subagent tool use and reads rate limits", () => {
    const { a } = foldAll(lines);
    expect(a.lastTool?.name).toBe("mcp__claude_ai_Slack__slack_send_message");
    const grep = foldAll(lines.slice(0, 10)).a.lastTool;
    expect(grep).toMatchObject({
      name: "Grep",
      summary: "↳ is_class_teacher in packages/db",
      subagent: true,
    });
    expect(a.rateLimit).toEqual({
      fiveHour: 0.06,
      sevenDay: 0.33,
      resetsAt: "2026-09-04T18:10:00.000Z",
    });
  });
  it("emits feed entries without thinking, raw inputs or slack bodies", () => {
    const { entries } = foldAll(lines);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual([
      "init",
      "tool",
      "rate_limit",
      "text",
      "tool",
      "tool_error",
      "tool",
      "tool",
    ]);
    const json = JSON.stringify(entries);
    expect(json).not.toContain("secret plan");
    expect(json).not.toContain("# Phase 1 plan");
    expect(json).not.toContain("private message body");
  });
  it("ignores the result line (runSession reports it from the parsed result)", () => {
    const before = foldAll(lines.slice(0, 12)).a;
    const r = foldEvent(before, lines[12] as string, now, wt);
    expect(r.entries).toEqual([]);
    expect(r.activity).toEqual({ ...before, events: before.events + 1 });
  });
  it("never throws on non-string name in tool_use block", () => {
    const a = emptyActivity();
    const r = foldEvent(
      a,
      '{"type":"assistant","message":{"id":"x","content":[{"type":"tool_use","name":123,"input":{}}]}}',
      now,
      wt,
    );
    expect(r.entries).toEqual([]);
    expect(r.activity.events).toBe(1);
  });
  it("never throws on non-string text in text block", () => {
    const a = emptyActivity();
    const r = foldEvent(
      a,
      '{"type":"assistant","message":{"id":"y","content":[{"type":"text","text":42}]}}',
      now,
      wt,
    );
    expect(r.entries).toEqual([]);
    expect(r.activity.events).toBe(1);
  });
  it("never throws when an assistant message's content is not an array", () => {
    const a = emptyActivity();
    const r = foldEvent(a, '{"type":"assistant","message":{"id":"z","content":{}}}', now, wt);
    expect(r.entries).toEqual([]);
    expect(r.activity.events).toBe(1);
  });
  it("never throws on a null block inside a user message's content array", () => {
    const a = emptyActivity();
    const r = foldEvent(a, '{"type":"user","message":{"content":[null]}}', now, wt);
    expect(r.entries).toEqual([]);
    expect(r.activity.events).toBe(1);
  });
});

describe("summarizeToolUse", () => {
  it("respects worktree boundary when relativising", () => {
    expect(summarizeToolUse("Read", { file_path: "/work/10/src/a.ts" }, "/work/1")).toBe(
      "/work/10/src/a.ts",
    );
  });
});
