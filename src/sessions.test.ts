import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSession } from "./sessions.ts";

describe("appendSession", () => {
  it("appends one JSON line per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    appendSession(dir, {
      t: "2026-09-03T10:00:00.000Z",
      host: "h",
      role: "builder",
      issue: 1,
      sessionId: "s",
      attempt: 1,
      costUsd: 0.5,
      outcome: "pr_opened",
    });
    appendSession(dir, {
      t: "2026-09-03T11:00:00.000Z",
      host: "h",
      role: "reviewer",
      issue: 1,
      sessionId: "t",
      attempt: 1,
      costUsd: 0.1,
      outcome: "approved",
    });
    const lines = readFileSync(join(dir, "sessions.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).role).toBe("reviewer");
  });
});
