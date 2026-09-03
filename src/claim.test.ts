import { describe, expect, it } from "vitest";
import { comment, hoursAgo, issue, snapshot } from "../test/helpers.ts";
import { isStale, reclaimActions, resolveConflict, resumeAction } from "./claim.ts";
import { fmt } from "./ledger.ts";

describe("resumeAction", () => {
  it("resumes this host's open claim with its session id", () => {
    const i = issue({
      number: 7,
      status: "In Progress",
      comments: [
        comment(fmt.claimed("mac-a", hoursAgo(2), "builder", 1), hoursAgo(2)),
        comment(
          fmt.session("22222222-2222-2222-2222-222222222222", "mac-a", "builder", 1),
          hoursAgo(2),
        ),
      ],
    });
    expect(resumeAction(snapshot({ issues: [i] }))).toEqual({
      type: "resume",
      issue: 7,
      role: "builder",
      sessionId: "22222222-2222-2222-2222-222222222222",
      pr: null,
    });
  });
  it("resumes with sessionId null when the claim never got a session", () => {
    const i = issue({
      number: 7,
      comments: [comment(fmt.claimed("mac-a", hoursAgo(2), "reviewer", 1))],
    });
    expect(resumeAction(snapshot({ issues: [i] }))?.sessionId).toBeNull();
  });
  it("ignores other hosts", () => {
    const i = issue({ comments: [comment(fmt.claimed("mac-b", hoursAgo(2), "builder", 1))] });
    expect(resumeAction(snapshot({ issues: [i] }))).toBeNull();
  });
});

describe("resolveConflict", () => {
  it("alphabetically first host keeps the issue", () => {
    const claims = [
      { host: "mac-b", at: hoursAgo(1), role: "builder" as const, round: 1 },
      { host: "mac-a", at: hoursAgo(1), role: "builder" as const, round: 1 },
    ];
    expect(resolveConflict(claims, "mac-a")).toBe("keep");
    expect(resolveConflict(claims, "mac-b")).toBe("release");
    expect(resolveConflict(claims.slice(0, 1), "mac-b")).toBe("keep");
  });
});

describe("stale claims", () => {
  const stale = issue({
    number: 8,
    status: "In Progress",
    updatedAt: hoursAgo(5),
    comments: [comment(fmt.claimed("mac-b", hoursAgo(5), "builder", 1), hoursAgo(5))],
  });
  it("is stale after two hours without comment or commit", () => {
    expect(isStale(stale, null, hoursAgo(0))).toBe(true);
    expect(isStale(stale, hoursAgo(1), hoursAgo(0))).toBe(false);
    expect(
      isStale(
        {
          ...stale,
          comments: [comment(fmt.claimed("mac-b", hoursAgo(1), "builder", 1), hoursAgo(1))],
        },
        null,
        hoursAgo(0),
      ),
    ).toBe(false);
  });
  it("emits a reclaim action for another host's stale claim", () => {
    expect(reclaimActions(snapshot({ issues: [stale] }))).toEqual([
      { type: "reclaim", issue: 8, fromHost: "mac-b" },
    ]);
  });
});
