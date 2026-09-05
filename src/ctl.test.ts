import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CtlDeps, ctlCap, ctlGo, ctlModel, ctlStop } from "./ctl.ts";
import { initialState, readState, writeState } from "./state-file.ts";

const current = {
  issue: 5,
  title: "t",
  role: "builder",
  pr: null,
  round: 1,
  attempt: 1,
  sessionId: "s-5",
  resume: false,
  worktree: "/w/5",
  branch: "feat/5-t",
  childPid: 200,
  startedAt: "2026-09-04T05:00:00.000Z",
  deadlineAt: "2026-09-04T06:30:00.000Z",
  activity: null,
};

function deps(over: Partial<CtlDeps> & { alive?: number[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tt-ctl-"));
  const alive = new Set(over.alive ?? []);
  const log = { kills: [] as string[], out: [] as string[], releases: [] as string[], stop: false };
  const d: CtlDeps = {
    stateDir: dir,
    host: "mac-a",
    login: "matthewtsmith",
    now: () => "2026-09-04T05:12:00.000Z",
    pidAlive: (pid) => alive.has(pid),
    kill: (pid, sig) => {
      log.kills.push(`${sig} ${pid}`);
      if (sig === "SIGTERM" || sig === "SIGKILL") alive.delete(pid);
      if (sig === "SIGUSR1") alive.delete(pid);
    },
    sleep: async () => {},
    touchStop: () => {
      log.stop = true;
    },
    removeStop: () => {
      log.stop = false;
    },
    launchdInstalled: async () => false,
    launchdKickstart: async () => {
      log.out.push("kickstart");
    },
    release: async (i) => {
      log.releases.push(`${i.mode} #${i.issue}`);
      return [];
    },
    out: (l) => {
      log.out.push(l);
    },
    startCommand: "pnpm --filter @tone/foreman start",
    configModel: "opus",
    configCap: 20,
    postModel: async (m) => {
      log.out.push(`posted ${m}`);
      return `next session runs ${m}`;
    },
    postCap: async (c) => {
      log.out.push(`posted cap ${c}`);
      return `cap is now ${c ?? "the configured value"}`;
    },
    ...over,
  };
  return { d, dir, log, alive };
}
const base = () =>
  initialState({
    pid: 100,
    host: "mac-a",
    configPath: "/c",
    dryRun: false,
    startedAt: "2026-09-04T04:00:00.000Z",
  });

describe("ctlStop", () => {
  it("stop: touches STOP, SIGTERMs a live daemon, waits, reports the interrupted session", async () => {
    const { d, dir, log } = deps({ alive: [100, 200] });
    writeState(dir, { ...base(), current });
    // Simulate the daemon finishing its bookkeeping when it gets the signal.
    d.kill = (pid, sig) => {
      log.kills.push(`${sig} ${pid}`);
      writeState(dir, { ...base(), exitedAt: "2026-09-04T05:12:05.000Z" });
      d.pidAlive = () => false;
    };
    await ctlStop(d, "stop");
    expect(log.stop).toBe(true);
    expect(log.kills).toEqual(["SIGTERM 100"]);
    expect(log.out.join("\n")).toContain("interrupted builder #5 session s-5");
    expect(log.releases).toEqual([]);
  });
  it("abort: sends SIGUSR1", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    await ctlStop(d, "abort");
    expect(log.kills).toEqual(["SIGUSR1 100"]);
    expect(log.out.join("\n")).toContain("no session was running");
  });
  it("dead daemon with an orphan child: kills the child; stop warns, abort releases", async () => {
    const a = deps({ alive: [200] });
    writeState(a.dir, { ...base(), current });
    await ctlStop(a.d, "stop");
    expect(a.log.kills[0]).toBe("SIGTERM 200");
    expect(a.log.out.join("\n")).toContain("claim on #5 may still be open");
    expect(a.log.releases).toEqual([]);

    const b = deps({ alive: [200] });
    writeState(b.dir, { ...base(), current });
    await ctlStop(b.d, "abort");
    expect(b.log.releases).toEqual(["abort #5"]);
    expect(readState(b.dir)?.current).toBeNull();
    expect(readState(b.dir)?.unfinished).toBeNull();
  });
  it("abort completes an unfinished release left by the daemon", async () => {
    const { d, dir, log } = deps();
    writeState(dir, { ...base(), exitedAt: "x", unfinished: { ...current, mode: "abort" } });
    await ctlStop(d, "abort");
    expect(log.releases).toEqual(["abort #5"]);
    expect(readState(dir)?.unfinished).toBeNull();
  });
  it("reports a daemon that does not exit in time", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    d.kill = () => {}; // ignores the signal
    await ctlStop(d, "stop");
    expect(log.out.join("\n")).toContain("did not exit");
  });
  it("no state file: still touches STOP and says so", async () => {
    const { d, log } = deps();
    await ctlStop(d, "stop");
    expect(log.stop).toBe(true);
    expect(log.out.join("\n")).toContain("no state file");
  });
});

describe("ctlModel", () => {
  it("with no argument, reports the model and where it came from", async () => {
    const a = deps();
    writeState(a.dir, base());
    await ctlModel(a.d, null);
    expect(a.log.out.join("\n")).toContain("model opus (foreman.json)");
    const b = deps();
    writeState(b.dir, { ...base(), model: "sonnet" });
    await ctlModel(b.d, null);
    expect(b.log.out.join("\n")).toContain("model sonnet (override; foreman.json says opus)");
  });
  it("posts to a live daemon, so the change lands without a restart", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    await ctlModel(d, "sonnet");
    expect(log.out).toContain("posted sonnet");
    expect(log.out.join("\n")).toContain("next session runs sonnet");
  });
  it("writes state.json itself when no daemon is running", async () => {
    const { d, dir, log } = deps();
    writeState(dir, base());
    await ctlModel(d, "haiku");
    expect(readState(dir)?.model).toBe("haiku");
    expect(log.out.join("\n")).not.toContain("posted");
  });
  it("clears the override with `default`, so foreman.json is reachable again", async () => {
    const { d, dir } = deps();
    writeState(dir, { ...base(), model: "sonnet" });
    await ctlModel(d, "default");
    expect(readState(dir)?.model).toBeNull();
  });
  it("refuses a name that is not a plain model name, and touches nothing", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    await ctlModel(d, "--dangerously-skip-permissions");
    expect(readState(dir)?.model).toBeNull();
    expect(log.out.join("\n")).toContain("not a model name");
    expect(log.out.join("\n")).not.toContain("posted");
  });
  it("says where to set it when there is no state file at all", async () => {
    const { d, log } = deps();
    await ctlModel(d, "sonnet");
    expect(log.out.join("\n")).toContain("foreman.json");
  });
});

describe("ctlCap", () => {
  it("with no argument, reports the cap and where it came from", async () => {
    const a = deps();
    writeState(a.dir, base());
    await ctlCap(a.d, null);
    expect(a.log.out.join("\n")).toContain("cap 20 (foreman.json)");
    const b = deps();
    writeState(b.dir, { ...base(), maxSessionsPerDay: 50 });
    await ctlCap(b.d, null);
    expect(b.log.out.join("\n")).toContain("cap 50 (override; foreman.json says 20)");
  });
  it("posts to a live daemon, so the next tick un-parks without a restart", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    await ctlCap(d, 50);
    expect(log.out).toContain("posted cap 50");
  });
  it("writes state.json itself when no daemon is running", async () => {
    const { d, dir } = deps();
    writeState(dir, base());
    await ctlCap(d, 40);
    expect(readState(dir)?.maxSessionsPerDay).toBe(40);
  });
  it("clears the override with `default`", async () => {
    const { d, dir } = deps();
    writeState(dir, { ...base(), maxSessionsPerDay: 50 });
    await ctlCap(d, "default");
    expect(readState(dir)?.maxSessionsPerDay).toBeNull();
  });
  it("refuses a cap that is not a sane session count, and touches nothing", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    for (const bad of [0, -5, 100000, 12.5]) await ctlCap(d, bad);
    expect(readState(dir)?.maxSessionsPerDay).toBeNull();
    expect(log.out.join("\n")).not.toContain("posted");
    expect(log.out.join("\n")).toContain("not a session count");
  });
});

describe("ctlGo", () => {
  it("removes STOP and wakes a live daemon", async () => {
    const { d, dir, log } = deps({ alive: [100] });
    writeState(dir, base());
    log.stop = true;
    await ctlGo(d);
    expect(log.stop).toBe(false);
    expect(log.kills).toEqual(["SIGUSR2 100"]);
  });
  it("kickstarts launchd when installed, else prints the start command", async () => {
    const a = deps({ launchdInstalled: async () => true });
    await ctlGo(a.d);
    expect(a.log.out).toContain("kickstart");
    const b = deps();
    await ctlGo(b.d);
    expect(b.log.out.join("\n")).toContain("pnpm --filter @tone/foreman start");
  });
});
