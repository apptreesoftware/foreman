import { describe, expect, it } from "vitest";
import { epic, issue, pr, snapshot } from "../test/helpers.ts";
import { describeNext, formatNext } from "./next.ts";

describe("describeNext", () => {
  it("explains a planner dispatch and an ineligible PR", () => {
    const s = snapshot({
      issues: [
        issue({
          number: 10,
          title: "Phase 1: Identity",
          labels: ["epic", "phase:1", "agent-ready"],
          status: "Backlog",
        }),
        issue({
          number: 146,
          title: "Polish",
          labels: ["phase:0", "agent-ready"],
          status: "Backlog",
        }),
      ],
      prs: [pr({ number: 175, issue: 146 })],
      epics: [
        epic({
          number: 10,
          phase: 1,
          labels: ["epic", "phase:1", "agent-ready"],
          status: "Backlog",
        }),
      ],
    });
    const r = describeNext(s);
    expect(r.actions).toEqual(["plan#10"]);
    expect(r.stopAt).toBe(0);
    expect(r.explain[0]).toContain('planner on epic #10 "Phase 1: Identity"');
    expect(r.prs).toEqual([
      {
        pr: 175,
        issue: 146,
        status: "Backlog",
        checks: "success",
        labels: [],
        reason: "issue status Backlog",
      },
    ]);
    const text = formatNext(r);
    expect(text).toContain("plan#10  ← would stop here");
    expect(text).toContain(
      "#175 → #146  status Backlog  checks success  labels []   not eligible: issue status Backlog",
    );
  });
  it("marks a mergeable PR and puts stopAt after the non-session actions", () => {
    const s = snapshot({
      issues: [
        issue({ number: 1, status: "In Review", labels: ["phase:1", "area:db"] }),
        issue({ number: 2, status: "Ready", labels: ["phase:1", "agent-ready", "size:S"] }),
      ],
      prs: [pr({ number: 9, issue: 1, labels: ["reviewer:approved", "validator:skipped"] })],
    });
    const r = describeNext(s);
    expect(r.actions).toEqual(["merge#1", "claim#2"]);
    expect(r.stopAt).toBe(1);
    expect(r.prs[0]?.reason).toBe("eligible to merge");
    expect(r.explain[1]).toContain("builder on #2");
  });
  it("idle", () => {
    const r = describeNext(snapshot({ epics: [] }));
    expect(r.actions).toEqual(["idle(nothing eligible)"]);
    expect(r.stopAt).toBeNull();
  });
});
