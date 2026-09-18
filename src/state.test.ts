import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, pr, snapshot } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import { defaultRepoConfig } from "./repo-config.ts";
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
  it("claims a rebase for an approved PR that conflicts with main, flagged for the prompt (#237)", () => {
    const actions = plan(
      snapshot({
        issues: [issue({ number: 3, status: "In Review", labels: ["phase:1", "area:infra"] })],
        prs: [
          pr({
            number: 30,
            issue: 3,
            labels: ["reviewer:approved", "validator:skipped"],
            mergeable: "CONFLICTING",
          }),
        ],
      }),
    );
    expect(actions.filter((a) => a.type === "merge")).toEqual([]);
    expect(actions.filter((a) => a.type === "claim")).toEqual([
      { type: "claim", issue: 3, role: "builder", pr: 30, round: 1, rebase: true },
    ]);
  });
  it("idles when nothing is eligible", () => {
    expect(plan(snapshot())).toEqual([{ type: "idle", reason: "nothing eligible" }]);
  });
});

describe("plan with an approved infra-only PR", () => {
  it("skips the validator and does not claim a validate job in the same iteration, when the repo's skip list names infra", () => {
    const infra = issue({ number: 40, status: "In Review", labels: ["phase:1", "area:infra"] });
    const actions = plan(
      snapshot({
        issues: [infra],
        prs: [pr({ number: 9, issue: 40, labels: ["reviewer:approved"] })],
      }),
      {
        ...defaultRepoConfig(),
        validator: { skipLabels: ["area:infra", "area:db", "area:shared"] },
      },
    );
    expect(actions).toContainEqual({ type: "skip_validator", pr: 9, issue: 40 });
    expect(actions.some((a) => a.type === "claim")).toBe(false);
  });
  it("with the default empty skip list, an infra-only PR still gets a validate claim", () => {
    const infra = issue({ number: 40, status: "In Review", labels: ["phase:1", "area:infra"] });
    const actions = plan(
      snapshot({
        issues: [infra],
        prs: [pr({ number: 9, issue: 40, labels: ["reviewer:approved"] })],
      }),
    );
    expect(actions.some((a) => a.type === "skip_validator")).toBe(false);
    expect(actions.some((a) => a.type === "claim" && a.role === "validator")).toBe(true);
  });
});
