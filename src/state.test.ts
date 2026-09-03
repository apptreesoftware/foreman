import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import { plan } from "./state.ts";

describe("plan", () => {
  it("resume wins over everything", () => {
    const busy = issue({
      number: 1,
      status: "In Progress",
      comments: [comment(fmt.claimed("mac-a", hoursAgo(1), "builder", 1))],
    });
    const actions = plan(
      snapshot({
        issues: [busy, issue({ number: 2 })],
        prs: [pr({ issue: 3, labels: ["reviewer:approved", "validator:passed"] })],
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("resume");
  });
  it("emits one claim for the best candidate", () => {
    const actions = plan(
      snapshot({
        issues: [
          issue({ number: 2, labels: ["phase:1", "agent-ready", "size:L"] }),
          issue({ number: 3, labels: ["phase:1", "agent-ready", "size:S"] }),
        ],
      }),
    );
    expect(actions.filter((a) => a.type === "claim")).toEqual([
      { type: "claim", issue: 3, role: "builder", pr: null, round: 1 },
    ]);
  });
  it("idles when nothing is eligible", () => {
    expect(plan(snapshot())).toEqual([{ type: "idle", reason: "nothing eligible" }]);
  });
});
