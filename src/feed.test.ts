import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFeed,
  FEED_LIMIT_MAX,
  type FeedEntry,
  feedPath,
  isSessionId,
  readFeed,
} from "./feed.ts";

const sid = "144ba520-6c0f-4195-ae18-c67de1443b31";
const tool = (i: number): FeedEntry => ({
  t: `2026-09-04T13:27:${String(i).padStart(2, "0")}.000Z`,
  kind: "tool",
  name: "Read",
  summary: `src/file${i}.ts`,
  subagent: false,
});

describe("feed", () => {
  it("isSessionId accepts a uuid and rejects a path", () => {
    expect(isSessionId(sid)).toBe(true);
    expect(isSessionId("../../etc/passwd")).toBe(false);
    expect(isSessionId("")).toBe(false);
  });
  it("appends then reads back in order, creating the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-feed-"));
    appendFeed(dir, sid, tool(1));
    appendFeed(dir, sid, tool(2));
    expect(readFileSync(feedPath(dir, sid), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(readFeed(dir, sid).map((e) => (e.kind === "tool" ? e.summary : ""))).toEqual([
      "src/file1.ts",
      "src/file2.ts",
    ]);
  });
  it("returns the last `limit` entries and caps limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-feed-"));
    for (let i = 0; i < 10; i++) appendFeed(dir, sid, tool(i));
    expect(readFeed(dir, sid, 3).map((e) => (e.kind === "tool" ? e.summary : ""))).toEqual([
      "src/file7.ts",
      "src/file8.ts",
      "src/file9.ts",
    ]);
    expect(readFeed(dir, sid, 10_000)).toHaveLength(10);
    expect(FEED_LIMIT_MAX).toBe(500);
  });
  it("skips a torn last line and returns [] for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-feed-"));
    appendFeed(dir, sid, tool(1));
    appendFileSync(feedPath(dir, sid), '{"t":"2026-09-04T13:28:00.000Z","kind":"to');
    expect(readFeed(dir, sid)).toHaveLength(1);
    expect(readFeed(dir, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});
