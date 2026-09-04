import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { describeWaiting, liveWaits, type WaitingInput } from "./waiting.ts";

const base: WaitingInput = {
  host: "mac-a",
  preflight: { ok: true, reason: null },
  stopPresent: false,
  todayCount: 3,
  cap: 20,
};
const kinds = (s: Parameters<typeof describeWaiting>[0], i = base) =>
  describeWaiting(s, i).map((w) => `${w.kind}:${w.subject}`);

describe("liveWaits", () => {
  it("STOP wins over the preflight reason; cap is reported", () => {
    expect(
      liveWaits({
        ...base,
        stopPresent: true,
        preflight: { ok: false, reason: "STOP file present" },
      }).map((w) => w.kind),
    ).toEqual(["stop"]);
    expect(
      liveWaits({ ...base, preflight: { ok: false, reason: "docker is not responding" } })[0],
    ).toMatchObject({ kind: "preflight", detail: "docker is not responding" });
    expect(liveWaits({ ...base, todayCount: 20 })[0]).toMatchObject({
      kind: "cap",
      detail: "20 of 20 sessions today",
    });
    expect(liveWaits(base)).toEqual([]);
  });
});

describe("describeWaiting", () => {
  it("is empty when nothing blocks", () => {
    expect(kinds(snapshot({ issues: [issue({ number: 1 })] }))).toEqual([]);
  });
  it("paused phase", () => {
    const s = snapshot({
      epics: [epic({ number: 10, phase: 1, labels: ["epic", "phase:1", "foreman:pause"] })],
    });
    expect(describeWaiting(s, base)[0]).toMatchObject({
      kind: "paused",
      subject: "phase 1",
      detail: "phase 1 paused (foreman:pause on #10)",
    });
  });
  it("ignores a closed epic with a stale foreman:pause label", () => {
    const s = snapshot({
      epics: [
        epic({
          number: 10,
          phase: 1,
          state: "CLOSED",
          labels: ["epic", "phase:1", "foreman:pause"],
        }),
      ],
    });
    expect(kinds(s)).toEqual([]);
  });
  it("human: plan-approved, owner sign-off, blocked issue", () => {
    const e10 = issue({
      number: 10,
      labels: ["epic", "phase:1", "needs-owner"],
      status: "In Review",
      comments: [
        comment(
          "session abc finished on mac-a: outcome=plan_drafted turns=3 cost=$1.00 duration=9m",
        ),
      ],
    });
    const e12 = issue({
      number: 12,
      labels: ["epic", "phase:0", "plan-approved", "needs-owner"],
    });
    const b = issue({
      number: 5,
      labels: ["phase:1", "blocked"],
      comments: [comment("blocked by builder: migration conflicts\nmore")],
    });
    const s = snapshot({
      issues: [e10, e12, b],
      epics: [
        epic({
          number: 10,
          phase: 1,
          labels: ["epic", "phase:1", "needs-owner"],
          status: "In Review",
        }),
        epic({
          number: 12,
          phase: 0,
          labels: ["epic", "phase:0", "plan-approved", "needs-owner"],
        }),
      ],
    });
    const w = describeWaiting(s, base);
    expect(w.map((x) => x.detail)).toEqual([
      "epic #12 awaits owner sign-off",
      "epic #10 awaits plan-approved",
      "#5 blocked: migration conflicts",
    ]);
  });
  it("human: the planner waits for agent-ready on the next epic", () => {
    const s = snapshot({
      issues: [issue({ number: 20, labels: ["epic", "phase:2"], status: "Backlog" })],
      epics: [epic({ number: 20, phase: 2, labels: ["epic", "phase:2"], status: "Backlog" })],
    });
    expect(describeWaiting(s, base).map((x) => x.detail)).toEqual([
      "epic #20 awaits agent-ready before the planner runs",
    ]);
  });
  it("stays quiet about agent-ready while a phase is being built", () => {
    const s = snapshot({
      issues: [issue({ number: 20, labels: ["epic", "phase:2"], status: "Backlog" })],
      epics: [
        epic({ number: 10, phase: 1, labels: ["epic", "phase:1", "plan-approved"] }),
        epic({ number: 20, phase: 2, labels: ["epic", "phase:2"], status: "Backlog" }),
      ],
    });
    expect(describeWaiting(s, base).map((x) => x.detail)).toEqual([]);
  });
  it("ci pending and failed on In Review PRs without a claim", () => {
    const i1 = issue({ number: 1, status: "In Review" });
    const i2 = issue({ number: 2, status: "In Review" });
    const s = snapshot({
      issues: [i1, i2],
      prs: [
        pr({ number: 11, issue: 1, checks: "pending" }),
        pr({ number: 12, issue: 2, checks: "failure" }),
      ],
    });
    expect(describeWaiting(s, base).map((w) => w.detail)).toEqual([
      "PR #11 checks pending",
      "PR #12 checks failed",
    ]);
  });
  it("review_cycle when a fix round is still allowed", () => {
    const i1 = issue({
      number: 1,
      status: "In Review",
      comments: [
        comment("claimed by mac-a at x role=builder round=1"),
        comment("session s finished on mac-a: outcome=pr_opened turns=1 cost=$1 duration=1m"),
      ],
    });
    const s = snapshot({
      issues: [i1],
      prs: [pr({ number: 11, issue: 1, labels: ["reviewer:changes"] })],
    });
    expect(describeWaiting(s, base)[0]).toMatchObject({
      kind: "review_cycle",
      detail: "PR #11 fix round 2 queued",
    });
  });
  it("dependency on an open issue", () => {
    const dep = issue({ number: 3, status: "In Progress" });
    const i = issue({ number: 4, body: "## Depends on\n#3\n\n## Spec\ndocs/x.md" });
    expect(describeWaiting(snapshot({ issues: [dep, i] }), base)[0]).toMatchObject({
      kind: "dependency",
      subject: "#4",
      detail: "#4 waits on #3",
    });
  });
  it("other host claim", () => {
    const i = issue({
      number: 7,
      status: "In Progress",
      comments: [
        comment("claimed by mac-b at 2026-09-04T13:02:00Z role=builder round=1", hoursAgo(1)),
      ],
    });
    expect(describeWaiting(snapshot({ issues: [i] }), base)[0]).toMatchObject({
      kind: "other_host",
      subject: "#7",
      detail: "#7 claimed by mac-b (builder round 1)",
      since: "2026-09-04T13:02:00Z",
    });
    expect(describeWaiting(snapshot({ issues: [i] }), { ...base, host: "mac-b" })).toEqual([]);
  });
  it("orders stop/preflight/cap first, then paused, human, ci, review_cycle, dependency, other_host", () => {
    const i1 = issue({ number: 1, status: "In Review" });
    const dep = issue({ number: 3, status: "In Progress" });
    const i4 = issue({ number: 4, body: "## Depends on\n#3\n\n## Spec\ndocs/x.md" });
    const s = snapshot({
      issues: [i1, dep, i4],
      prs: [pr({ number: 11, issue: 1, checks: "pending" })],
      epics: [epic({ number: 10, labels: ["epic", "phase:1", "foreman:pause", "plan-approved"] })],
    });
    expect(kinds(s, { ...base, stopPresent: true })).toEqual([
      "stop:STOP",
      "paused:phase 1",
      "ci:PR #11",
      "dependency:#4",
    ]);
  });
});
