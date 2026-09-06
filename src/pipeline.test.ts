import { describe, expect, it } from "vitest";
import { comment, issue, pr, snapshot } from "../test/helpers.ts";
import { describePipeline } from "./pipeline.ts";

const claim = (host: string, role: string, round = 1) =>
  comment(`claimed by ${host} at 2026-09-04T13:00:00Z role=${role} round=${round}`);

describe("describePipeline", () => {
  it("carries the issue's model label so the page can show the override", () => {
    const s = snapshot({
      issues: [
        issue({ number: 3, status: "In Progress", labels: ["phase:1", "model:sonnet"] }),
        issue({ number: 4, status: "In Progress", labels: ["phase:1"] }),
      ],
    });
    expect(describePipeline(s).map((r) => [r.issue, r.model])).toEqual([
      [3, "sonnet"],
      [4, null],
    ]);
  });
  it("lists only in-flight, non-epic issues, sorted by phase then status then number", () => {
    const s = snapshot({
      issues: [
        issue({ number: 1, status: "Ready" }),
        issue({ number: 2, status: "In Review", labels: ["phase:2"] }),
        issue({ number: 3, status: "In Progress", labels: ["phase:1"] }),
        issue({ number: 4, status: "In Review", labels: ["phase:1"] }),
        issue({ number: 9, status: "In Progress", labels: ["epic", "phase:1"] }),
      ],
      prs: [pr({ number: 12, issue: 2 }), pr({ number: 14, issue: 4 })],
    });
    expect(describePipeline(s).map((r) => r.issue)).toEqual([3, 4, 2]);
  });
  it("builder claim: build active, rest pending, no PR", () => {
    const s = snapshot({
      issues: [issue({ number: 3, status: "In Progress", comments: [claim("mac-b", "builder")] })],
    });
    const r = describePipeline(s)[0];
    expect(r).toMatchObject({
      pr: null,
      stages: {
        build: "active",
        review: "pending",
        validate: "pending",
        ci: "none",
        merge: "pending",
      },
      claim: { host: "mac-b", role: "builder", round: 1, at: "2026-09-04T13:00:00Z" },
      fixRound: 1,
      blocked: false,
    });
  });
  it("PR open, reviewer claimed: build done, review active", () => {
    const i = issue({
      number: 4,
      status: "In Review",
      comments: [
        claim("mac-a", "builder"),
        comment("session s finished on mac-a: outcome=pr_opened turns=1 cost=$1 duration=1m"),
        claim("mac-a", "reviewer"),
      ],
    });
    const r = describePipeline(
      snapshot({ issues: [i], prs: [pr({ number: 14, issue: 4, checks: "pending" })] }),
    )[0];
    expect(r?.stages).toEqual({
      build: "done",
      review: "active",
      validate: "pending",
      ci: "pending",
      merge: "pending",
    });
  });
  it("approved + validator exempt area: validate skipped, merge active when CI green", () => {
    const i = issue({ number: 4, status: "In Review", labels: ["phase:1", "area:db"] });
    const r = describePipeline(
      snapshot({
        issues: [i],
        prs: [pr({ number: 14, issue: 4, labels: ["reviewer:approved", "validator:skipped"] })],
      }),
    )[0];
    expect(r?.stages).toEqual({
      build: "done",
      review: "done",
      validate: "skipped",
      ci: "success",
      merge: "active",
    });
  });
  it("approved, validator required but not yet run: validate pending", () => {
    const i = issue({ number: 4, status: "In Review", labels: ["phase:1", "area:web"] });
    const r = describePipeline(
      snapshot({ issues: [i], prs: [pr({ number: 14, issue: 4, labels: ["reviewer:approved"] })] }),
    )[0];
    expect(r?.stages).toMatchObject({ review: "done", validate: "pending", merge: "pending" });
  });
  it("changes requested and validator failed show failed; fix round and blocked carried", () => {
    const i = issue({
      number: 4,
      status: "In Review",
      labels: ["phase:1", "blocked"],
      comments: [
        claim("mac-a", "builder", 1),
        comment("session s finished on mac-a: outcome=pr_opened turns=1 cost=$1 duration=1m"),
        claim("mac-a", "builder", 2),
        comment("session t finished on mac-a: outcome=pr_opened turns=1 cost=$1 duration=1m"),
      ],
    });
    const r = describePipeline(
      snapshot({
        issues: [i],
        prs: [pr({ number: 14, issue: 4, labels: ["reviewer:changes", "validator:failed"] })],
      }),
    )[0];
    expect(r).toMatchObject({
      stages: { review: "failed", validate: "failed" },
      fixRound: 2,
      blocked: true,
      claim: null,
    });
  });
});
