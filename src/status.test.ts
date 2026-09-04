import { describe, expect, it } from "vitest";
import { initialState } from "./state-file.ts";
import { describeStatus, formatStatus, type StatusInput } from "./status.ts";

const now = "2026-09-04T05:10:00.000Z";
const state = () =>
  initialState({
    pid: 100,
    host: "mac-a",
    configPath: "/c",
    dryRun: false,
    startedAt: "2026-09-04T04:00:00.000Z",
  });
const current = {
  issue: 146,
  title: "[P0] Follow-up polish",
  role: "builder",
  pr: 175,
  round: 1,
  attempt: 1,
  sessionId: "4b05b405-bc8c-4212-8f22-f5749af9c07b",
  resume: false,
  worktree: "/w/146",
  branch: "feat/146-x",
  childPid: 200,
  startedAt: "2026-09-04T04:58:00.000Z",
  deadlineAt: "2026-09-04T06:28:00.000Z",
};
function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    state: state(),
    now,
    pidAlive: (pid) => pid === 100,
    stopPresent: false,
    launchdInstalled: false,
    sessions: [],
    maxSessionsPerDay: 20,
    wallClockMinutes: 90,
    host: "mac-a",
    ...over,
  };
}

describe("describeStatus", () => {
  it("RUNNING with uptime and a current session", () => {
    const r = describeStatus(input({ state: { ...state(), current } }));
    expect(r.daemon).toBe("RUNNING");
    expect(r.uptimeMinutes).toBe(70);
    expect(r.current?.elapsedMinutes).toBe(12);
    expect(r.current?.limitMinutes).toBe(90);
    expect(r.orphan).toBeNull();
  });
  it("STOPPED when exitedAt is set and the pid is dead", () => {
    const r = describeStatus(
      input({ state: { ...state(), exitedAt: now }, pidAlive: () => false }),
    );
    expect(r.daemon).toBe("STOPPED");
    expect(r.uptimeMinutes).toBeNull();
  });
  it("CRASHED plus ORPHAN when the daemon died but the child lives", () => {
    const r = describeStatus(
      input({ state: { ...state(), current }, pidAlive: (pid) => pid === 200 }),
    );
    expect(r.daemon).toBe("CRASHED");
    expect(r.orphan).toEqual({ pid: 200, issue: 146 });
  });
  it("UNKNOWN without a state file", () => {
    const r = describeStatus(input({ state: null }));
    expect(r.daemon).toBe("UNKNOWN");
    expect(r.pid).toBeNull();
  });
  it("today's count and spend come from the session log", () => {
    const e = (t: string, costUsd: number) => ({
      t,
      host: "mac-a",
      role: "reviewer",
      issue: 1,
      sessionId: "s",
      attempt: 1,
      costUsd,
      outcome: "approved",
    });
    const r = describeStatus(
      input({ sessions: [e("2026-09-04T01:00:00.000Z", 1), e("2026-09-04T02:00:00.000Z", 2)] }),
    );
    expect(r.today).toEqual({ count: 2, cap: 20, spendUsd: 3 });
    expect(r.recent).toHaveLength(2);
    expect(r.recent[0]?.t).toBe("2026-09-04T02:00:00.000Z"); // newest first
  });
});

describe("formatStatus", () => {
  it("prints the headline, the session and the orphan warning", () => {
    const text = formatStatus(
      describeStatus(
        input({
          state: { ...state(), current, lastPlan: ["plan#10"] },
          pidAlive: (pid) => pid === 200,
          stopPresent: true,
        }),
      ),
    );
    expect(text).toContain("foreman mac-a   CRASHED");
    expect(text).toContain("STOP: present");
    expect(text).toContain("builder #146 round 1 attempt 1");
    expect(text).toContain("12m of 90m");
    expect(text).toContain("ORPHAN child 200 still running for #146");
    expect(text).toContain("next   plan#10");
  });
  it("hints when there is no state file", () => {
    const text = formatStatus(describeStatus(input({ state: null })));
    expect(text).toContain("predates this feature");
  });
});
