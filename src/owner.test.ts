import { describe, expect, it } from "vitest";
import { epic, issue, snapshot } from "../test/helpers.ts";
import { applyOwnerAction, ownerItems } from "./owner.ts";

const e = (over = {}) => epic({ number: 200, phase: 2, labels: ["epic", "phase:2"], ...over });
const snap = (epics: ReturnType<typeof epic>[]) =>
  snapshot({
    epics,
    issues: epics.map((x) =>
      issue({ number: x.number, title: `Phase ${x.phase}`, labels: x.labels }),
    ),
  });

describe("ownerItems", () => {
  it("offers sign-off on a phase awaiting the owner", () => {
    const items = ownerItems(
      snap([e({ labels: ["epic", "phase:2", "plan-approved", "needs-owner"] })]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.actions).toEqual(["sign_off", "pause"]);
    expect(items[0]?.detail).toContain("sign-off");
  });
  it("offers plan approval on a drafted plan", () => {
    const items = ownerItems(snap([e({ labels: ["epic", "phase:2", "needs-owner"] })]));
    expect(items[0]?.actions).toEqual(["approve_plan", "pause"]);
  });
  it("offers planning on an epic nobody has asked for yet", () => {
    const items = ownerItems(snap([e()]));
    expect(items[0]?.actions).toEqual(["start_planning", "pause"]);
  });
  it("offers resume instead of pause on a paused phase", () => {
    const items = ownerItems(snap([e({ labels: ["epic", "phase:2", "foreman:pause"] })]));
    expect(items[0]?.actions).toEqual(["start_planning", "unpause"]);
  });
  it("offers nothing but pause once a plan is approved and being built", () => {
    const items = ownerItems(snap([e({ labels: ["epic", "phase:2", "plan-approved"] })]));
    expect(items[0]?.actions).toEqual(["pause"]);
  });
  it("skips closed epics and sorts by phase", () => {
    const items = ownerItems(
      snap([
        e({ number: 300, phase: 3 }),
        e({ number: 100, phase: 1 }),
        e({ number: 400, phase: 4, state: "CLOSED" }),
      ]),
    );
    expect(items.map((i) => i.epic)).toEqual([100, 300]);
  });
});

describe("applyOwnerAction", () => {
  function fakeGh() {
    const calls: string[] = [];
    return {
      calls,
      gh: {
        addLabels: async (kind: string, n: number, l: string[]) => {
          calls.push(`addLabels ${kind} ${n} ${l.join(",")}`);
        },
        removeLabels: async (kind: string, n: number, l: string[]) => {
          calls.push(`removeLabels ${kind} ${n} ${l.join(",")}`);
        },
        closeIssue: async (n: number) => {
          calls.push(`closeIssue ${n}`);
        },
      },
    };
  }

  it("sign_off labels, clears needs-owner and closes the epic", async () => {
    const { gh, calls } = fakeGh();
    const msg = await applyOwnerAction(gh, 124, "sign_off");
    expect(calls).toEqual([
      "addLabels issue 124 signed-off",
      "removeLabels issue 124 needs-owner",
      "closeIssue 124",
    ]);
    expect(msg).toContain("#124");
  });
  it("approve_plan only labels; the foreman applies the plan on its next tick", async () => {
    const { gh, calls } = fakeGh();
    await applyOwnerAction(gh, 10, "approve_plan");
    expect(calls).toEqual(["addLabels issue 10 plan-approved"]);
  });
  it("start_planning labels agent-ready", async () => {
    const { gh, calls } = fakeGh();
    await applyOwnerAction(gh, 26, "start_planning");
    expect(calls).toEqual(["addLabels issue 26 agent-ready"]);
  });
  it("pause and unpause toggle foreman:pause", async () => {
    const { gh, calls } = fakeGh();
    await applyOwnerAction(gh, 26, "pause");
    await applyOwnerAction(gh, 26, "unpause");
    expect(calls).toEqual([
      "addLabels issue 26 foreman:pause",
      "removeLabels issue 26 foreman:pause",
    ]);
  });
});
