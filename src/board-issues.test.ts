import { describe, expect, it } from "vitest";
import { epic, issue, pr, snapshot } from "../test/helpers.ts";
import { describeBoardIssues } from "./board-issues.ts";

// An epic as the snapshot carries it twice: once as an Epic, once as its open issue (the title).
const withEpic = (e: ReturnType<typeof epic>, title = `Phase ${e.phase}: work`) =>
  issue({ number: e.number, title, labels: e.labels, body: "" });

const task = (over: Parameters<typeof issue>[0] = {}) =>
  issue({ body: "## Depends on\nNone", labels: ["agent-ready"], ...over });

describe("describeBoardIssues", () => {
  it("lists open non-epic issues, off-board ones with status null", () => {
    const e = epic({ number: 10, phase: 1, taskNumbers: [11, 12] });
    const s = snapshot({
      epics: [e],
      issues: [withEpic(e), task({ number: 11 }), task({ number: 12, status: null, itemId: null })],
    });
    const { issues } = describeBoardIssues(s);
    expect(issues.map((i) => i.issue)).toEqual([11, 12]);
    expect(issues.find((i) => i.issue === 12)?.status).toBeNull();
  });

  it("groups by taskNumbersOf, including a Parent epic line", () => {
    const e = epic({ number: 10, phase: 1, taskNumbers: [] });
    const s = snapshot({
      epics: [e],
      issues: [withEpic(e), task({ number: 11, body: "Parent epic: #10" })],
    });
    expect(describeBoardIssues(s).issues[0]?.group).toBe("epic:10");
  });

  it("falls back to the single open epic with the issue's phase label", () => {
    const e = epic({ number: 10, phase: 7, labels: ["epic", "phase:7", "plan-approved"] });
    const s = snapshot({
      epics: [e],
      issues: [withEpic(e), task({ number: 11, labels: ["phase:7"] })],
    });
    expect(describeBoardIssues(s).issues[0]?.group).toBe("epic:10");
  });

  it("puts a shared-phase issue in an unlinked group", () => {
    const a = epic({ number: 10, phase: 10, labels: ["epic", "phase:10"] });
    const b = epic({ number: 20, phase: 10, labels: ["epic", "phase:10"] });
    const s = snapshot({
      epics: [a, b],
      issues: [withEpic(a), withEpic(b), task({ number: 11, labels: ["phase:10"] })],
    });
    const { issues, groups } = describeBoardIssues(s);
    expect(issues[0]?.group).toBe("phase:10:unlinked");
    expect(groups.find((g) => g.key === "phase:10:unlinked")).toMatchObject({
      kind: "unlinked",
      epic: null,
      phase: 10,
      title: "Phase 10 · not linked to an epic",
    });
  });

  it("puts an issue whose phase has no open epic in a closed group", () => {
    const s = snapshot({ epics: [], issues: [task({ number: 11, labels: ["phase:4"] })] });
    const { issues, groups } = describeBoardIssues(s);
    expect(issues[0]?.group).toBe("phase:4:closed");
    expect(groups).toEqual([
      expect.objectContaining({
        key: "phase:4:closed",
        kind: "closed",
        title: "Phase 4 · epic closed",
      }),
    ]);
  });

  it("puts an issue with neither in No phase", () => {
    const s = snapshot({ epics: [], issues: [task({ number: 11, labels: [] })] });
    const { issues, groups } = describeBoardIssues(s);
    expect(issues[0]?.group).toBe("none");
    expect(groups).toEqual([
      expect.objectContaining({ key: "none", kind: "none", title: "No phase" }),
    ]);
  });

  it("gives every open epic a group with its state, even with no issues", () => {
    const mk = (number: number, extra: string[]) =>
      epic({ number, phase: number, labels: ["epic", `phase:${number}`, ...extra] });
    const epics = [
      mk(1, ["needs-owner", "plan-approved"]),
      mk(2, ["needs-owner"]),
      mk(3, ["plan-approved", "foreman:pause"]),
      mk(4, ["agent-ready"]),
      mk(5, []),
    ];
    const s = snapshot({ epics, issues: epics.map((e) => withEpic(e, `Epic ${e.number}`)) });
    const { groups } = describeBoardIssues(s);
    expect(groups.map((g) => [g.key, g.title, g.state, g.paused])).toEqual([
      ["epic:1", "Epic 1", "signoff_waiting", false],
      ["epic:2", "Epic 2", "plan_waiting", false],
      ["epic:3", "Epic 3", "building", true],
      ["epic:4", "Epic 4", "planning", false],
      ["epic:5", "Epic 5", "not_started", false],
    ]);
  });

  it("orders epic groups by phase, then unlinked and closed groups, then No phase", () => {
    const a = epic({ number: 30, phase: 9, labels: ["epic", "phase:9"] });
    const b = epic({ number: 20, phase: 7, labels: ["epic", "phase:7"] });
    const s = snapshot({
      epics: [a, b],
      issues: [
        withEpic(a),
        withEpic(b),
        task({ number: 41, labels: [] }),
        task({ number: 42, labels: ["phase:4"] }),
      ],
    });
    expect(describeBoardIssues(s).groups.map((g) => g.key)).toEqual([
      "epic:20",
      "epic:30",
      "phase:4:closed",
      "none",
    ]);
  });

  it("fills pr, dependsOn, openDependsOn, blocked, model, effort and the display labels", () => {
    const e = epic({ number: 10, phase: 7, taskNumbers: [268, 269] });
    const s = snapshot({
      epics: [e],
      prs: [pr({ number: 276, issue: 268 })],
      issues: [
        withEpic(e),
        task({
          number: 268,
          body: "## Depends on\n- #269\n- #250",
          labels: [
            "blocked",
            "size:L",
            "area:web",
            "agent-ready",
            "model:sonnet",
            "effort:xhigh",
            "phase:7",
          ],
        }),
        task({ number: 269 }),
      ],
    });
    expect(describeBoardIssues(s).issues[0]).toEqual({
      issue: 268,
      title: "Task 268",
      status: "Ready",
      labels: ["blocked", "size:L", "area:web"],
      group: "epic:10",
      pr: 276,
      dependsOn: [269, 250],
      openDependsOn: [269],
      blocked: true,
      model: "sonnet",
      effort: "xhigh",
    });
  });

  it("lists closed task numbers as doneTasks", () => {
    const e = epic({ number: 10, phase: 1, taskNumbers: [1, 2, 3] });
    const s = snapshot({ epics: [e], issues: [withEpic(e), task({ number: 3 })] });
    expect(describeBoardIssues(s).groups[0]?.doneTasks).toEqual([1, 2]);
  });
});
