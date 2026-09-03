import { describe, expect, it } from "vitest";
import { comment, hoursAgo } from "../test/helpers.ts";
import { fixRound, fmt, lastActivityAt, openClaim, parseClaim } from "./ledger.ts";

describe("ledger", () => {
  it("round-trips a claim", () => {
    const c = parseClaim(fmt.claimed("mac-a", "2026-09-03T10:00:00Z", "builder", 1));
    expect(c).toEqual({ host: "mac-a", at: "2026-09-03T10:00:00Z", role: "builder", round: 1 });
    expect(parseClaim("Claiming")).toBeNull();
  });
  it("finds the open claim and its session id", () => {
    const cs = [
      comment(fmt.claimed("mac-a", hoursAgo(5), "builder", 1), hoursAgo(5)),
      comment(
        fmt.session("11111111-1111-1111-1111-111111111111", "mac-a", "builder", 1),
        hoursAgo(5),
      ),
    ];
    expect(openClaim(cs)).toEqual({
      claim: { host: "mac-a", at: hoursAgo(5), role: "builder", round: 1 },
      sessionId: "11111111-1111-1111-1111-111111111111",
    });
  });
  it("closes the claim on finished/released/reclaimed/merged", () => {
    for (const end of [
      fmt.finished("x", "mac-a", "pr_opened", 10, 1.5, 12),
      fmt.released("mac-a", "conflict"),
      fmt.reclaimed("mac-a", "mac-b", hoursAgo(0)),
      fmt.merged("mac-b"),
    ]) {
      const cs = [
        comment(fmt.claimed("mac-a", hoursAgo(5), "builder", 1), hoursAgo(5)),
        comment(end, hoursAgo(1)),
      ];
      expect(openClaim(cs)).toBeNull();
    }
  });
  it("tracks fix rounds and last activity", () => {
    const cs = [
      comment(fmt.claimed("mac-a", hoursAgo(9), "builder", 1), hoursAgo(9)),
      comment(fmt.finished("x", "mac-a", "pr_opened", 1, 0, 1), hoursAgo(8)),
      comment(fmt.claimed("mac-a", hoursAgo(4), "builder", 2), hoursAgo(4)),
    ];
    expect(fixRound(cs)).toBe(2);
    expect(lastActivityAt(cs)).toBe(hoursAgo(4));
    expect(fixRound([])).toBe(1);
  });
});
