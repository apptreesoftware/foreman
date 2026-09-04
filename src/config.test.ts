import { describe, expect, it } from "vitest";
import { expandHome, parseConfig } from "./config.ts";

const base = {
  repo: "matthewtsmith/tone_tonic",
  project: 2,
  host: "matthew-mbp",
  repoDir: "~/Projects/musicworld",
  workDir: "~/tone_tonic-work",
  slackUser: "matthew",
};

describe("parseConfig", () => {
  it("applies defaults and derives owner", () => {
    const cfg = parseConfig(JSON.stringify(base));
    expect(cfg.owner).toBe("matthewtsmith");
    expect(cfg.pollSeconds).toBe(120);
    expect(cfg.maxSessionsPerDay).toBe(20);
    expect(cfg.maxTurns).toBe(200);
    expect(cfg.wallClockMinutes).toBe(90);
    expect(cfg.workDir.startsWith("/")).toBe(true);
  });
  it("rejects a bad repo", () => {
    expect(() => parseConfig(JSON.stringify({ ...base, repo: "nope" }))).toThrow();
  });
  it("defaults webPort to 8090 and accepts an override", () => {
    expect(parseConfig(JSON.stringify(base)).webPort).toBe(8090);
    expect(parseConfig(JSON.stringify({ ...base, webPort: 8091 })).webPort).toBe(8091);
  });
});

describe("expandHome", () => {
  it("expands ~/", () => expect(expandHome("~/x")).not.toContain("~"));
  it("leaves absolute paths", () => expect(expandHome("/a/b")).toBe("/a/b"));
});
