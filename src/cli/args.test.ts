import { describe, expect, it } from "vitest";
import { parseCli, parsePhase } from "./args.ts";

describe("parseCli", () => {
  it("reads -p before the subcommand", () => {
    expect(parseCli(["-p", "widgets", "status", "--watch"])).toMatchObject({
      instance: "widgets",
      cmd: "status",
      args: { watch: true },
    });
  });
  it("reads --instance after the subcommand too", () => {
    expect(parseCli(["status", "--instance", "widgets"]).instance).toBe("widgets");
  });
  it("add takes name and flags", () => {
    expect(
      parseCli([
        "add",
        "widgets",
        "--repo",
        "acme/widgets",
        "--repo-dir",
        "~/w",
        "--web-port",
        "8091",
      ]),
    ).toMatchObject({
      cmd: "add",
      positionals: ["widgets"],
      args: { repo: "acme/widgets", "repo-dir": "~/w", "web-port": "8091" },
    });
  });
  it("epic new takes title, phase, spec, agent-ready", () => {
    const c = parseCli([
      "epic",
      "new",
      "--title",
      "Phase 3",
      "--phase",
      "3",
      "--spec",
      "docs/x.md",
      "--agent-ready",
    ]);
    expect(c).toMatchObject({
      cmd: "epic",
      positionals: ["new"],
      args: { title: "Phase 3", phase: "3", spec: "docs/x.md", "agent-ready": true },
    });
  });
  it("run takes --once and --dry-run", () => {
    expect(parseCli(["run", "--once", "--dry-run"]).args).toEqual({ once: true, "dry-run": true });
  });
  it("model and cap carry an optional value", () => {
    expect(parseCli(["model", "sonnet"]).positionals).toEqual(["sonnet"]);
    expect(parseCli(["cap"]).positionals).toEqual([]);
  });
  it("launchd and hooks take a verb", () => {
    expect(parseCli(["launchd", "install"]).positionals).toEqual(["install"]);
    expect(parseCli(["hooks", "run", "preflight"]).positionals).toEqual(["run", "preflight"]);
  });
  it("--phase takes a positive whole number and refuses anything else by name", () => {
    expect(parsePhase("3")).toBe(3);
    for (const bad of ["one", "1.5", "0", "-2", "", " ", "3x"])
      expect(() => parsePhase(bad)).toThrow(
        `--phase must be a positive whole number, got "${bad}"`,
      );
  });
  it("no command or an unknown one is help", () => {
    expect(parseCli([]).cmd).toBe("help");
    expect(() => parseCli(["frobnicate"])).toThrow(/unknown command "frobnicate"/);
  });
});
