import { describe, expect, it } from "vitest";
import { comment, epic, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import {
  applyPlanActions,
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
  it("leaves an approved plan to applyPlanActions", () => {
    const approved = epic({
      number: 200,
      phase: 2,
      labels: ["epic", "phase:2", "plan-approved"],
      status: "Backlog",
    });
    expect(
      applyPlanActions(
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
    expect(applyPlanActions(snapshot({ epics: [approved], issues: [applied] }))).toEqual([]);
    // phaseActions never offers anything else for an approved epic still waiting on its plan.
    expect(
      phaseActions(
        snapshot({
          epics: [approved],
          issues: [issue({ number: 200, labels: ["epic", "phase:2", "plan-approved"] })],
        }),
      ),
    ).toEqual([]);
  });
});

describe("applyPlanActions", () => {
  const approved = epic({
    number: 200,
    phase: 9,
    labels: ["epic", "phase:9", "plan-approved", "needs-owner"],
    status: "In Review",
  });
  const epicIssue = issue({ number: 200, labels: ["epic", "phase:9", "plan-approved"] });
  const planPr = (over = {}) =>
    pr({
      number: 279,
      title: "docs(plan): phase 09 plan (#200)",
      body: "Refs #200",
      issue: null,
      ...over,
    });
  const run = (prs: ReturnType<typeof pr>[], issues = [epicIssue]) =>
    applyPlanActions(snapshot({ epics: [approved], issues, prs }));

  it("merges the plan PR and applies the plan in the same tick when its checks are green", () => {
    expect(run([planPr()])).toEqual([
      { type: "merge_plan", epic: 200, pr: 279 },
      { type: "apply_plan", epic: 200 },
    ]);
  });
  it("merges a plan PR on a repository with no CI at all", () => {
    expect(run([planPr({ checks: "none" })])[0]).toEqual({
      type: "merge_plan",
      epic: 200,
      pr: 279,
    });
  });
  it("waits while the plan PR's checks are pending", () => {
    expect(run([planPr({ checks: "pending" })])).toEqual([]);
  });
  it("reports a red plan PR on the epic once per head commit", () => {
    const red = planPr({ checks: "failure" });
    expect(run([red])).toEqual([
      { type: "plan_pr_stuck", epic: 200, pr: 279, sha: red.headSha, reason: "checks failed" },
    ]);
    const reported = issue({
      ...epicIssue,
      comments: [comment(fmt.planPrStuck("mac-a", 279, red.headSha, "checks failed"))],
    });
    expect(run([red], [reported])).toEqual([]);
    // A new push is a new chance, and a new report if it is red too.
    expect(run([planPr({ checks: "failure", headSha: "f".repeat(40) })], [reported])).toHaveLength(
      1,
    );
  });
  it("reports a plan PR that conflicts with main", () => {
    expect(run([planPr({ mergeable: "CONFLICTING" })])[0]).toMatchObject({
      type: "plan_pr_stuck",
      reason: "conflicts with main",
    });
  });
  it("applies straight away when no plan PR is open, as when it was merged by hand", () => {
    expect(run([pr({ number: 300, issue: 201 })])).toEqual([{ type: "apply_plan", epic: 200 }]);
  });
  it("ignores another epic's plan PR", () => {
    expect(run([planPr({ title: "docs(plan): phase 10 plan (#201)" })])).toEqual([
      { type: "apply_plan", epic: 200 },
    ]);
  });
  it("does nothing once the plan is applied or while the epic is claimed", () => {
    const applied = issue({ ...epicIssue, comments: [comment(fmt.planApplied("mac-a"))] });
    expect(run([planPr()], [applied])).toEqual([]);
    const claimed = issue({
      ...epicIssue,
      comments: [comment(fmt.claimed("mac-a", hoursAgo(1), "planner", 1))],
    });
    expect(run([planPr()], [claimed])).toEqual([]);
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
