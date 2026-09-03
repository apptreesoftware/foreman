import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import {
  nextUnplannedEpic,
  PlanIssuesSchema,
  parseDirectionCritical,
  parseSpecPath,
  phaseActions,
  phaseComplete,
  planIssuesPath,
} from "./phase.ts";

describe("parsers", () => {
  it("parseDirectionCritical", () => {
    expect(parseDirectionCritical("# X\n\n**Date:** 1\n**Direction-critical:** yes\n")).toBe(true);
    expect(parseDirectionCritical("**Direction-critical:** no")).toBe(false);
    expect(parseDirectionCritical("nothing")).toBe(false);
  });
  it("parseSpecPath", () => {
    expect(parseSpecPath("## Spec\n`docs/superpowers/specs/2026-09-03-a.md`\n")).toBe(
      "docs/superpowers/specs/2026-09-03-a.md",
    );
    expect(parseSpecPath("## Spec\ndocs/x/y.md § 3")).toBe("docs/x/y.md");
    expect(parseSpecPath("")).toBeNull();
  });
  it("planIssuesPath sits next to the plan", () => {
    expect(
      planIssuesPath(
        "docs/superpowers/specs/2026-09-03-phase-01-identity-roster-design.md",
        "2026-09-10",
      ),
    ).toBe("docs/superpowers/plans/2026-09-10-phase-01-plan.issues.json");
  });
  it("PlanIssuesSchema", () => {
    expect(
      PlanIssuesSchema.parse({ epic: 150, tasks: [{ title: "t", body: "b", labels: ["phase:1"] }] })
        .tasks,
    ).toHaveLength(1);
  });
});

describe("phaseComplete", () => {
  it("is true when every task is closed", () => {
    const e = epic({ number: 100, taskNumbers: [101, 102] });
    expect(phaseComplete(e, [issue({ number: 101, state: "CLOSED" })])).toBe(true);
    expect(phaseComplete(e, [issue({ number: 101 })])).toBe(false);
    expect(phaseComplete(epic({ taskNumbers: [] }), [])).toBe(false);
  });
});

describe("phaseActions", () => {
  const done = epic({ number: 100, phase: 1, taskNumbers: [101], status: "In Progress" });
  it("closes a complete phase once", () => {
    expect(phaseActions(snapshot({ epics: [done], issues: [] }))).toEqual([
      { type: "phase_close", epic: 100 },
    ]);
    const closing = {
      ...done,
      status: "In Review" as const,
      labels: [...done.labels, "needs-owner"],
    };
    expect(phaseActions(snapshot({ epics: [closing], issues: [] }))).toEqual([]);
  });
  it("does not close while a phase-closer claim is open on the epic", () => {
    const epicIssue = issue({
      number: 100,
      labels: ["epic", "phase:1"],
      comments: [comment(fmt.claimed("mac-a", hoursAgo(1), "phase-closer", 1))],
    });
    expect(phaseActions(snapshot({ epics: [done], issues: [epicIssue] }))).toEqual([]);
  });
  it("plans the next unapproved phase when the current one is in review", () => {
    const reviewing = {
      ...done,
      status: "In Review" as const,
      labels: ["epic", "phase:1", "needs-owner"],
    };
    const next = epic({ number: 200, phase: 2, labels: ["epic", "phase:2"], status: "Backlog" });
    expect(nextUnplannedEpic([reviewing, next], [])?.number).toBe(200);
    expect(phaseActions(snapshot({ epics: [reviewing, next], issues: [] }))).toEqual([
      { type: "plan", epic: 200 },
    ]);
  });
  it("does not re-plan after a planner session finished", () => {
    const reviewing = {
      ...done,
      status: "In Review" as const,
      labels: ["epic", "phase:1", "needs-owner"],
    };
    const next = epic({ number: 200, phase: 2, labels: ["epic", "phase:2"], status: "Backlog" });
    const nextIssue = issue({
      number: 200,
      labels: ["epic", "phase:2"],
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(3), "planner", 1), hoursAgo(3)),
        comment(fmt.finished("x", "mac-a", "plan_drafted", 1, 0, 1), hoursAgo(2)),
      ],
    });
    expect(phaseActions(snapshot({ epics: [reviewing, next], issues: [nextIssue] }))).toEqual([]);
  });
  it("applies an approved plan once", () => {
    const approved = epic({
      number: 200,
      phase: 2,
      labels: ["epic", "phase:2", "plan-approved"],
      status: "Backlog",
    });
    expect(
      phaseActions(
        snapshot({
          epics: [approved],
          issues: [issue({ number: 200, labels: ["epic", "phase:2", "plan-approved"] })],
        }),
      ),
    ).toEqual([{ type: "apply_plan", epic: 200 }]);
    const applied = issue({
      number: 200,
      labels: ["epic", "phase:2", "plan-approved"],
      comments: [comment(fmt.planApplied("mac-a"))],
    });
    expect(phaseActions(snapshot({ epics: [approved], issues: [applied] }))).toEqual([]);
  });
});
