import { describe, expect, it } from "vitest";
import { comment, epic, issue, snapshot } from "../test/helpers.ts";
import { pairReviews } from "./review-pairing.ts";

const SIGN_OFF = ["needs-owner", "plan-approved"];
const epicIssue = (number: number, title: string, phase: number, comments: string[] = []) =>
  issue({
    number,
    title,
    labels: ["epic", `phase:${phase}`, ...SIGN_OFF],
    body: "",
    comments: comments.map((c) => comment(c)),
  });
const review = (number: number, title: string, phase: number) =>
  issue({ number, title, labels: [`phase:${phase}`, "needs-owner"], body: "" });
const epicOf = (number: number, phase: number, labels: string[] = SIGN_OFF) =>
  epic({ number, phase, labels: ["epic", `phase:${phase}`, ...labels] });

describe("pairReviews", () => {
  it("pairs by the epic's Phase review comment", () => {
    const s = snapshot({
      epics: [epicOf(514, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Billing", 10, ["Phase review: #571"]),
        review(571, "Something else entirely", 10),
      ],
    });
    expect(pairReviews(s).get(571)).toBe(514);
  });

  it("pairs by title with the epic's Phase prefix removed", () => {
    const s = snapshot({
      epics: [epicOf(525, 10)],
      issues: [
        epicIssue(525, "Phase 10b: Reports and exports", 10),
        review(573, "Phase 10b review: Reports and exports", 10),
      ],
    });
    expect(pairReviews(s).get(573)).toBe(525);
  });

  it("pairs a review whose title repeats the epic's full title", () => {
    const s = snapshot({
      epics: [epicOf(575, 10)],
      issues: [
        epicIssue(575, "Phase 10c: Team plans", 10),
        review(594, "Phase 10c review: Phase 10c: Team plans", 10),
      ],
    });
    expect(pairReviews(s).get(594)).toBe(575);
  });

  it("pairs a review whose phase token differs from its epic's", () => {
    const s = snapshot({
      epics: [epicOf(514, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Billing", 10),
        review(571, "Phase 10 review: Phase 10a: Billing", 10),
      ],
    });
    expect(pairReviews(s).get(571)).toBe(514);
  });

  it("does not pair two epics that share a phase number by label", () => {
    const s = snapshot({
      epics: [epicOf(514, 10), epicOf(525, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Billing", 10),
        epicIssue(525, "Phase 10b: Reports and exports", 10),
        review(573, "Phase 10b review: Reports and exports", 10),
      ],
    });
    const pairs = pairReviews(s);
    expect(pairs.get(573)).toBe(525);
    expect([...pairs.values()]).not.toContain(514);
  });

  it("leaves a review unpaired when no open epic matches", () => {
    const s = snapshot({
      epics: [],
      issues: [review(336, "Phase 3 review: Onboarding", 3)],
    });
    expect(pairReviews(s).size).toBe(0);
  });

  it("does not pair on a title that only contains the epic's name", () => {
    // The review's own epic is closed; an open epic called "UI" must not swallow it.
    const s = snapshot({
      epics: [epicOf(900, 9)],
      issues: [epicIssue(900, "Phase 9: UI", 9), review(336, "Phase 3 review: Auth UI polish", 3)],
    });
    expect(pairReviews(s).size).toBe(0);
  });

  it("pairs only with an epic that is waiting on its sign-off", () => {
    const s = snapshot({
      epics: [epicOf(900, 9, ["plan-approved"])],
      issues: [
        issue({
          number: 900,
          title: "Phase 9: Search",
          labels: ["epic", "phase:9", "plan-approved"],
          body: "",
          comments: [comment("Phase review: #950")],
        }),
        review(950, "Phase 9 review: Search", 9),
      ],
    });
    expect(pairReviews(s).size).toBe(0);
  });

  it("pairs one review per epic, so a second review keeps its own row", () => {
    const s = snapshot({
      epics: [epicOf(514, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Billing", 10, ["Phase review: #571"]),
        review(571, "Phase 10a review: Billing", 10),
        review(572, "Phase 10a review: Billing", 10),
      ],
    });
    const pairs = pairReviews(s);
    expect(pairs.get(571)).toBe(514);
    expect(pairs.has(572)).toBe(false);
  });

  it("prefers the comment over a title match", () => {
    const s = snapshot({
      epics: [epicOf(514, 10), epicOf(525, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Billing", 10, ["Phase review: #573"]),
        epicIssue(525, "Phase 10b: Reports and exports", 10),
        review(573, "Phase 10b review: Reports and exports", 10),
      ],
    });
    expect(pairReviews(s).get(573)).toBe(514);
  });
});
