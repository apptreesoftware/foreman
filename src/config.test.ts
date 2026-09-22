import { describe, expect, it } from "vitest";
import { expandHome, parseConfig } from "./config.ts";

const base = {
  repo: "acme/widgets",
  project: 2,
  host: "matthew-mbp",
  repoDir: "~/Projects/musicworld",
  workDir: "~/widgets-work",
};

describe("parseConfig", () => {
  it("applies defaults and derives owner", () => {
    const cfg = parseConfig(JSON.stringify(base));
    expect(cfg.owner).toBe("acme");
    expect(cfg.pollSeconds).toBe(300);
    expect(cfg.minGraphqlPoints).toBe(500);
    expect(cfg.maxSessionsPerDay).toBe(20);
    expect(cfg.maxTurns).toBe(200);
    expect(cfg.wallClockMinutes).toBe(90);
    expect(cfg.workDir.startsWith("/")).toBe(true);
  });
  it("defaults model to opus, so a session never inherits the CLI default", () => {
    expect(parseConfig(JSON.stringify(base)).model).toBe("opus");
    expect(parseConfig(JSON.stringify({ ...base, model: "sonnet" })).model).toBe("sonnet");
    expect(() => parseConfig(JSON.stringify({ ...base, model: "" }))).toThrow();
  });
  it("defaults workDir to <repoDir>/.worktrees, and an explicit value still wins", () => {
    const { workDir: _omitted, ...noWorkDir } = base;
    const cfg = parseConfig(JSON.stringify({ ...noWorkDir, repoDir: "/r" }));
    expect(cfg.workDir).toBe("/r/.worktrees");
    // The default follows repoDir through ~ expansion rather than keeping a literal tilde.
    const home = parseConfig(JSON.stringify(noWorkDir));
    expect(home.workDir).toBe(`${home.repoDir}/.worktrees`);
    expect(home.workDir).not.toContain("~");
    expect(parseConfig(JSON.stringify({ ...noWorkDir, workDir: "/elsewhere" })).workDir).toBe(
      "/elsewhere",
    );
  });
  it("rejects a bad repo", () => {
    expect(() => parseConfig(JSON.stringify({ ...base, repo: "nope" }))).toThrow();
  });
  it("defaults webPort to 8090 and accepts an override", () => {
    expect(parseConfig(JSON.stringify(base)).webPort).toBe(8090);
    expect(parseConfig(JSON.stringify({ ...base, webPort: 8091 })).webPort).toBe(8091);
  });
  it("notify is optional, and both channels parse", () => {
    expect(parseConfig(JSON.stringify(base)).notify).toBeUndefined();
    const cfg = parseConfig(
      JSON.stringify({
        ...base,
        notify: { slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/xxx", macos: true },
      }),
    );
    expect(cfg.notify?.slackWebhookUrl).toBe("https://hooks.slack.com/services/T0/B0/xxx");
    expect(cfg.notify?.macos).toBe(true);
    // Either channel alone is a valid block.
    expect(parseConfig(JSON.stringify({ ...base, notify: { macos: true } })).notify?.macos).toBe(
      true,
    );
  });
  it("rejects a slackWebhookUrl that is not a URL", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...base, notify: { slackWebhookUrl: "T0/B0/xxx" } })),
    ).toThrow();
  });
  it("stallMinutes defaults to 5 and must be ≥ 1", () => {
    const base = {
      repo: "o/r",
      project: 2,
      host: "h",
      repoDir: "/r",
      workDir: "/w",
    };
    expect(parseConfig(JSON.stringify(base)).stallMinutes).toBe(5);
    expect(parseConfig(JSON.stringify({ ...base, stallMinutes: 8 })).stallMinutes).toBe(8);
    expect(() => parseConfig(JSON.stringify({ ...base, stallMinutes: 0 }))).toThrow();
  });
});

describe("expandHome", () => {
  it("expands ~/", () => expect(expandHome("~/x")).not.toContain("~"));
  it("leaves absolute paths", () => expect(expandHome("/a/b")).toBe("/a/b"));
});

describe("webAuth", () => {
  it("is absent by default and accepted when both user and password are set", () => {
    expect(parseConfig(JSON.stringify(base)).webAuth).toBeUndefined();
    const cfg = parseConfig(
      JSON.stringify({ ...base, webAuth: { user: "me", password: "correct horse" } }),
    );
    expect(cfg.webAuth).toEqual({ user: "me", password: "correct horse" });
  });
  it("rejects a short password and a missing user", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...base, webAuth: { user: "me", password: "short" } })),
    ).toThrow();
    expect(() =>
      parseConfig(JSON.stringify({ ...base, webAuth: { password: "correct horse" } })),
    ).toThrow();
  });
});

describe("webHosts", () => {
  it("is absent by default and accepts hostnames and IP literals", () => {
    expect(parseConfig(JSON.stringify(base)).webHosts).toBeUndefined();
    const cfg = parseConfig(JSON.stringify({ ...base, webHosts: ["mini", "100.84.252.56"] }));
    expect(cfg.webHosts).toEqual(["mini", "100.84.252.56"]);
  });
  it("rejects an empty entry and a non-list", () => {
    expect(() => parseConfig(JSON.stringify({ ...base, webHosts: [""] }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ ...base, webHosts: "mini" }))).toThrow();
  });
});
