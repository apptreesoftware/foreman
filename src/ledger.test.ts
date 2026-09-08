import { describe, expect, it } from "vitest";
import { comment, hoursAgo } from "../test/helpers.ts";
import { ciRerunCount, fixRound, fmt, lastActivityAt, openClaim, parseClaim } from "./ledger.ts";

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

describe("operator interrupt comments", () => {
  const id = "4b05b405-bc8c-4212-8f22-f5749af9c07b";
  const claimed = comment(
    fmt.claimed("mac-a", "2026-09-03T10:00:00Z", "builder", 1),
    "2026-09-03T10:00:00Z",
  );
  const session = comment(fmt.session(id, "mac-a", "builder", 1), "2026-09-03T10:00:10Z");
  it("interrupted keeps the claim open with its session id", () => {
    const stopped = comment(fmt.interrupted(id, "mac-a", 12), "2026-09-03T10:12:00Z");
    expect(fmt.interrupted(id, "mac-a", 12)).toBe(
      `session ${id} interrupted on mac-a: stopped by operator after 12m`,
    );
    const open = openClaim([claimed, session, stopped]);
    expect(open?.claim.host).toBe("mac-a");
    expect(open?.sessionId).toBe(id);
  });
  it("aborted closes the claim", () => {
    const released = comment(fmt.aborted("mac-a"), "2026-09-03T10:12:00Z");
    expect(fmt.aborted("mac-a")).toBe("released by mac-a: aborted by operator");
    expect(openClaim([claimed, session, released])).toBeNull();
  });
});

describe("ci rerun ledger (#362)", () => {
  const sha = "1111111111111111111111111111111111111111";
  const other = "2222222222222222222222222222222222222222";

  it("counts only the reruns recorded for this head commit", () => {
    const cs = [
      comment(fmt.ciRerun("mac-a", other)),
      comment(fmt.ciRerun("mac-a", sha)),
      comment(fmt.ciRerun("mac-b", sha)),
    ];
    expect(ciRerunCount(cs, sha)).toBe(2);
    expect(ciRerunCount(cs, other)).toBe(1);
    expect(ciRerunCount(cs, "3333333333333333333333333333333333333333")).toBe(0);
    expect(ciRerunCount(cs, "")).toBe(0);
  });

  it("does not close an open claim: a rerun happens beside a session, not instead of one", () => {
    const cs = [
      comment(fmt.claimed("mac-a", "2026-09-03T10:00:00Z", "builder", 1)),
      comment(fmt.ciRerun("mac-a", sha)),
    ];
    expect(openClaim(cs)?.claim.role).toBe("builder");
  });
});
