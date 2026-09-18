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
  planPhaseNumber,
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
        "docs/superpowers/plans",
      ),
    ).toBe("docs/superpowers/plans/2026-09-10-phase-01-plan.issues.json");
  });
  it("planPhaseNumber prefers the epic's phase label, zero-padded", () => {
    expect(planPhaseNumber(["epic", "phase:1"], "docs/sandbox.md")).toBe("01");
    expect(planPhaseNumber(["phase:12"], "docs/sandbox.md")).toBe("12");
  });
  it("planPhaseNumber falls back to the spec path, then gives up", () => {
    expect(planPhaseNumber(["epic"], "docs/specs/2026-09-03-phase-07-billing-design.md")).toBe(
      "07",
    );
    expect(planPhaseNumber(["epic"], "docs/sandbox.md")).toBeNull();
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
  it("plans an epic the owner labelled agent-ready", () => {
    const reviewing = {
      ...done,
      status: "In Review" as const,
      labels: ["epic", "phase:1", "plan-approved", "needs-owner"],
    };
    const next = epic({
      number: 200,
      phase: 2,
      labels: ["epic", "phase:2", "agent-ready"],
      status: "Backlog",
    });
    expect(nextUnplannedEpic([reviewing, next])?.number).toBe(200);
    expect(phaseActions(snapshot({ epics: [reviewing, next], issues: [] }))).toEqual([
      { type: "plan", epic: 200 },
    ]);
  });
  it("plans nothing while no epic is labelled agent-ready", () => {
    const next = epic({ number: 200, phase: 2, labels: ["epic", "phase:2"], status: "Backlog" });
    expect(nextUnplannedEpic([next])).toBeNull();
    expect(phaseActions(snapshot({ epics: [next], issues: [] }))).toEqual([]);
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

describe("nextUnplannedEpic", () => {
  const ready = (over = {}) =>
    epic({
      number: 200,
      phase: 2,
      labels: ["epic", "phase:2", "agent-ready"],
      status: "Backlog",
      ...over,
    });

  it("skips an epic whose plan is already approved", () => {
    expect(
      nextUnplannedEpic([ready({ labels: ["epic", "phase:2", "agent-ready", "plan-approved"] })]),
    ).toBeNull();
  });
  it("skips an epic that already awaits the owner", () => {
    expect(
      nextUnplannedEpic([ready({ labels: ["epic", "phase:2", "agent-ready", "needs-owner"] })]),
    ).toBeNull();
  });
  it("holds while another epic's drafted plan awaits the owner", () => {
    const drafted = epic({
      number: 150,
      phase: 1,
      labels: ["epic", "phase:1", "needs-owner"],
      status: "In Review",
    });
    expect(nextUnplannedEpic([drafted, ready()])).toBeNull();
  });
  it("does not count a phase awaiting sign-off as a drafted plan", () => {
    const signOff = epic({
      number: 150,
      phase: 1,
      labels: ["epic", "phase:1", "plan-approved", "needs-owner"],
      status: "In Review",
    });
    expect(nextUnplannedEpic([signOff, ready()])?.number).toBe(200);
  });
  it("holds while an approved phase is still being built", () => {
    const building = epic({
      number: 150,
      phase: 1,
      labels: ["epic", "phase:1", "plan-approved"],
      status: "In Progress",
    });
    expect(nextUnplannedEpic([building, ready()])).toBeNull();
  });
  it("takes the lowest phase among several agent-ready epics", () => {
    const later = ready({ number: 300, phase: 3, labels: ["epic", "phase:3", "agent-ready"] });
    expect(nextUnplannedEpic([later, ready()])?.number).toBe(200);
  });
  it("ignores a closed epic", () => {
    expect(nextUnplannedEpic([ready({ state: "CLOSED" })])).toBeNull();
  });
});
