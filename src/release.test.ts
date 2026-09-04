import { describe, expect, it } from "vitest";
import { issue } from "../test/helpers.ts";
import { fmt } from "./ledger.ts";
import { ledgerInterrupt, withTimeout } from "./release.ts";

function fakeGh(status: "In Progress" | "In Review" | "Ready") {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push(`${name} ${a.map(String).join(" ")}`);
    };
  return {
    calls,
    gh: {
      comment: rec("comment"),
      unassign: rec("unassign"),
      setStatus: rec("setStatus"),
      getIssue: async (n: number) => issue({ number: n, status, itemId: `PVTI_${n}` }),
    },
  };
}
const base = {
  host: "mac-a",
  login: "matthewtsmith",
  issue: 7,
  role: "builder",
  round: 1,
  sessionId: "s-1",
  minutes: 12,
};

describe("ledgerInterrupt", () => {
  it("stop posts only the interrupted comment", async () => {
    const { gh, calls } = fakeGh("In Progress");
    await ledgerInterrupt(gh, { ...base, mode: "stop" });
    expect(calls).toEqual([`comment issue 7 ${fmt.interrupted("s-1", "mac-a", 12)}`]);
  });
  it("abort releases, unassigns and resets a round-1 builder to Ready", async () => {
    const { gh, calls } = fakeGh("In Progress");
    await ledgerInterrupt(gh, { ...base, mode: "abort" });
    expect(calls).toEqual([
      `comment issue 7 ${fmt.aborted("mac-a")}`,
      "unassign 7 matthewtsmith",
      "setStatus PVTI_7 Ready",
    ]);
  });
  it("abort leaves status alone for reviewers and later rounds", async () => {
    const a = fakeGh("In Review");
    await ledgerInterrupt(a.gh, { ...base, mode: "abort", role: "reviewer" });
    expect(a.calls.some((c) => c.startsWith("setStatus"))).toBe(false);
    const b = fakeGh("In Progress");
    await ledgerInterrupt(b.gh, { ...base, mode: "abort", round: 2 });
    expect(b.calls.some((c) => c.startsWith("setStatus"))).toBe(false);
  });
  it("withTimeout rejects a hung call", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "gh comment")).rejects.toThrow(
      "gh comment timed out after 10ms",
    );
    await expect(withTimeout(Promise.resolve(1), 10, "x")).resolves.toBe(1);
  });
});
