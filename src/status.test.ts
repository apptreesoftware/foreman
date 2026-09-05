import { describe, expect, it } from "vitest";
import { CAP_CHOICES, initialState, MODEL_CHOICES } from "./state-file.ts";
import { describeStatus, formatStatus, type StatusInput } from "./status.ts";
import { emptyActivity } from "./stream.ts";

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
  activity: null,
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
    stallMinutes: 5,
    repo: "o/r",
    configModel: "opus",
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
  it("reports the config model, and the live override when one is set", () => {
    const fromConfig = describeStatus(input());
    expect(fromConfig.model).toEqual({
      current: "opus",
      configured: "opus",
      source: "config",
      choices: MODEL_CHOICES,
    });
    const overridden = describeStatus(input({ state: { ...state(), model: "sonnet" } }));
    expect(overridden.model.current).toBe("sonnet");
    expect(overridden.model.source).toBe("override");
    expect(formatStatus(overridden)).toContain("model  sonnet (override; foreman.json says opus)");
    expect(formatStatus(fromConfig)).toContain("model  opus");
  });
  it("reports nowPhase: session, between_ticks, ticking, idle", () => {
    const sleeping = {
      ...state(),
      lastTickAt: "2026-09-04T05:09:00.000Z",
      nextTickAt: "2026-09-04T05:14:00.000Z",
      lastPlan: ["claim#143"],
    };
    expect(describeStatus(input({ state: { ...sleeping, current } })).nowPhase).toBe("session");
    expect(describeStatus(input({ state: sleeping })).nowPhase).toBe("between_ticks");
    // The next tick is due, so the daemon is inside an iteration rather than asleep.
    expect(
      describeStatus(input({ state: { ...sleeping, nextTickAt: "2026-09-04T05:09:30.000Z" } }))
        .nowPhase,
    ).toBe("ticking");
    expect(
      describeStatus(input({ state: { ...sleeping, lastPlan: ["idle(nothing eligible)"] } }))
        .nowPhase,
    ).toBe("idle");
    // A daemon that is not running has no tick coming, whatever the last plan said.
    expect(describeStatus(input({ state: sleeping, pidAlive: () => false })).nowPhase).toBe("idle");
  });
  it("is parked, with the reason, when the last preflight failed", () => {
    const capped = {
      ...state(),
      lastTickAt: "2026-09-04T05:09:00.000Z",
      nextTickAt: "2026-09-04T05:14:00.000Z",
      lastPlan: ["claim#143"],
      lastPreflight: { ok: false, reason: "daily session cap reached (20/20)" },
    };
    const r = describeStatus(input({ state: capped }));
    expect(r.nowPhase).toBe("parked");
    expect(formatStatus(r)).toContain("now    parked · daily session cap reached (20/20)");
    // A running session still outranks it: the tick that started it had a healthy preflight.
    expect(describeStatus(input({ state: { ...capped, current } })).nowPhase).toBe("session");
  });
  it("reports the config cap, and the live override when one is set", () => {
    const fromConfig = describeStatus(input());
    expect(fromConfig.cap).toEqual({
      current: 20,
      configured: 20,
      source: "config",
      choices: CAP_CHOICES,
    });
    expect(fromConfig.today.cap).toBe(20);
    const raised = describeStatus(input({ state: { ...state(), maxSessionsPerDay: 50 } }));
    expect(raised.cap.current).toBe(50);
    expect(raised.cap.source).toBe("override");
    expect(raised.today.cap).toBe(50);
    expect(formatStatus(raised)).toContain("of 50 sessions");
  });
  it("counts the cap wait against the override, not the configured cap", () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      t: `2026-09-04T0${i < 10 ? 0 : 1}:0${i % 10}:00.000Z`,
      host: "mac-a",
      role: "builder",
      issue: i,
      sessionId: `s-${i}`,
      attempt: 1,
      costUsd: 1,
      outcome: "pr_opened",
    }));
    // At the configured cap of 20 the daemon is capped; raising it to 50 must clear that wait.
    const atCap = describeStatus(input({ sessions }));
    expect((atCap.board?.waiting ?? []).some((w) => w.kind === "cap")).toBe(true);
    const raised = describeStatus(
      input({ sessions, state: { ...state(), maxSessionsPerDay: 50 } }),
    );
    expect((raised.board?.waiting ?? []).some((w) => w.kind === "cap")).toBe(false);
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
  it("says between ticks, with the next tick time, while asleep with work planned", () => {
    const text = formatStatus(
      describeStatus(
        input({
          state: {
            ...state(),
            lastTickAt: "2026-09-04T05:09:00.000Z",
            nextTickAt: "2026-09-04T05:14:00.000Z",
            lastPlan: ["claim#143"],
          },
        }),
      ),
    );
    expect(text).toContain("now    between ticks · next 05:14:00Z");
    expect(text).not.toContain("now    idle");
  });
  it("says idle only when the last plan found nothing eligible", () => {
    const text = formatStatus(
      describeStatus(
        input({
          state: {
            ...state(),
            lastTickAt: "2026-09-04T05:09:00.000Z",
            nextTickAt: "2026-09-04T05:14:00.000Z",
            lastPlan: ["idle(nothing eligible)"],
          },
        }),
      ),
    );
    expect(text).toContain("now    idle");
  });
  it("hints when there is no state file", () => {
    const text = formatStatus(describeStatus(input({ state: null })));
    expect(text).toContain("predates this feature");
  });
});

describe("live activity and board", () => {
  const activity = {
    ...emptyActivity(),
    turns: 23,
    lastEventAt: "2026-09-04T05:09:48.000Z",
    lastTool: {
      name: "Edit",
      summary: "docs/plan.md",
      at: "2026-09-04T05:09:48.000Z",
      subagent: false,
    },
    lastText: { text: "Now I'll write the plan.", at: "2026-09-04T05:09:00.000Z" },
    tokens: { input: 41_200, output: 6_100, cacheRead: 0, cacheWrite: 0 },
  };
  it("computes silentMinutes from lastEventAt and flags a stall at the threshold", () => {
    const fresh = describeStatus(
      input({ state: { ...state(), current: { ...current, activity } } }),
    );
    expect(fresh.current?.silentMinutes).toBe(0);
    expect(fresh.current?.stalled).toBe(false);
    const quiet = describeStatus(
      input({
        state: {
          ...state(),
          current: {
            ...current,
            activity: { ...activity, lastEventAt: "2026-09-04T05:05:00.000Z" },
          },
        },
      }),
    );
    expect(quiet.current?.silentMinutes).toBe(5);
    expect(quiet.current?.stalled).toBe(true);
    const none = describeStatus(input({ state: { ...state(), current } }));
    expect(none.current?.silentMinutes).toBe(12); // falls back to startedAt
  });
  it("never shows STALLED for a pre-#178 daemon with no activity, even past the threshold", () => {
    const r = describeStatus(input({ state: { ...state(), current } }));
    expect(r.current?.activity).toBeNull();
    expect(r.current?.silentMinutes).toBe(12); // >= stallMinutes (5)
    expect(r.current?.stalled).toBe(false);
  });
  it("marks the tick as blocked by the session", () => {
    expect(describeStatus(input({ state: { ...state(), current } })).tick?.blockedBySession).toBe(
      true,
    );
    expect(describeStatus(input()).tick?.blockedBySession).toBe(false);
  });
  it("layers live STOP/preflight/cap waits over the stored board", () => {
    const board = {
      at: now,
      waiting: [
        { kind: "ci" as const, subject: "PR #1", detail: "PR #1 checks pending", since: null },
      ],
      pipeline: [],
      owner: [],
      explain: [],
      prs: [],
    };
    const r = describeStatus(input({ state: { ...state(), board }, stopPresent: true }));
    expect(r.board?.waiting.map((w) => w.kind)).toEqual(["stop", "ci"]);
    const noBoard = describeStatus(input({ stopPresent: true }));
    expect(noBoard.board?.waiting.map((w) => w.kind)).toEqual(["stop"]);
    const capped = describeStatus(
      input({
        state: {
          ...state(),
          board,
          lastPreflight: { ok: false, reason: "daily session cap reached (20/20)" },
        },
        sessions: Array.from({ length: 20 }, (_, i) => ({
          t: now,
          host: "mac-a",
          role: "builder",
          issue: i,
          sessionId: "s",
          attempt: 1,
          costUsd: 1,
          outcome: "pr_opened",
        })),
      }),
    );
    expect(capped.board?.waiting.map((w) => w.kind)).toEqual(["cap", "ci"]);
  });
  it("overlays the running session onto the board (own-session visibility)", () => {
    const board = {
      at: now,
      waiting: [
        {
          kind: "review_cycle" as const,
          subject: "PR #175",
          detail: "PR #175 fix round 2 queued",
          since: null,
        },
      ],
      pipeline: [],
      owner: [],
      explain: [],
      prs: [],
    };
    const r = describeStatus(input({ state: { ...state(), board, current } }));
    expect(r.board?.pipeline[0]).toMatchObject({
      issue: 146,
      pr: 175,
      claim: { host: "mac-a", role: "builder", round: 1, at: current.startedAt },
      stages: { build: "active" },
    });
    expect(r.board?.waiting).toEqual([]);
  });
  it("formatStatus prints doing, stalled and waiting lines", () => {
    const board = {
      at: now,
      waiting: [
        {
          kind: "human" as const,
          subject: "epic #10",
          detail: "epic #10 awaits plan-approved",
          since: null,
        },
      ],
      pipeline: [],
      owner: [],
      explain: [],
      prs: [],
    };
    const text = formatStatus(
      describeStatus(
        input({
          state: {
            ...state(),
            board,
            current: {
              ...current,
              activity: { ...activity, lastEventAt: "2026-09-04T05:03:00.000Z" },
            },
          },
        }),
      ),
    );
    expect(text).toContain(
      "doing  Edit docs/plan.md  (7m ago)  turns 23  tokens 41.2k in / 6.1k out",
    );
    expect(text).toContain('       "Now I\'ll write the plan."');
    expect(text).toContain("STALLED  no output for 7m (limit 90m; ctl stop to interrupt)");
    expect(text).toContain("waiting  epic #10 awaits plan-approved");
  });
});
