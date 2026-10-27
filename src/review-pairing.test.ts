import { describe, expect, it } from "vitest";
import { comment, epic, issue, snapshot } from "../test/helpers.ts";
import { pairReviews } from "./review-pairing.ts";

const epicIssue = (number: number, title: string, phase: number, comments: string[] = []) =>
  issue({
    number,
    title,
    labels: ["epic", `phase:${phase}`, "plan-approved", "needs-owner"],
    body: "",
    comments: comments.map((c) => comment(c)),
  });
const review = (number: number, title: string, phase: number) =>
  issue({ number, title, labels: [`phase:${phase}`, "needs-owner"], body: "" });
const epicOf = (number: number, phase: number) =>
  epic({ number, phase, labels: ["epic", `phase:${phase}`, "plan-approved", "needs-owner"] });

describe("pairReviews", () => {
  it("pairs by the epic's Phase review comment", () => {
    const s = snapshot({
      epics: [epicOf(514, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Families and wards", 10, ["Phase review: #571"]),
        review(571, "Something else entirely", 10),
      ],
    });
    expect(pairReviews(s).get(571)).toBe(514);
  });

  it("pairs by title with the epic's Phase prefix removed", () => {
    const s = snapshot({
      epics: [epicOf(525, 10)],
      issues: [
        epicIssue(525, "Phase 10b: Services, tuition and enrollment", 10),
        review(573, "Phase 10b review: Services, tuition and enrollment", 10),
      ],
    });
    expect(pairReviews(s).get(573)).toBe(525);
  });

  it("pairs a review whose title repeats the epic's full title", () => {
    const s = snapshot({
      epics: [epicOf(575, 10)],
      issues: [
        epicIssue(575, "Phase 10c: Platform subscriptions", 10),
        review(594, "Phase 10c review: Phase 10c: Platform subscriptions", 10),
      ],
    });
    expect(pairReviews(s).get(594)).toBe(575);
  });

  it("does not pair two epics that share a phase number by label", () => {
    const s = snapshot({
      epics: [epicOf(514, 10), epicOf(525, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Families and wards", 10),
        epicIssue(525, "Phase 10b: Services, tuition and enrollment", 10),
        review(573, "Phase 10b review: Services, tuition and enrollment", 10),
      ],
    });
    const pairs = pairReviews(s);
    expect(pairs.get(573)).toBe(525);
    expect([...pairs.values()]).not.toContain(514);
  });

  it("leaves a review unpaired when no open epic matches", () => {
    const s = snapshot({
      epics: [],
      issues: [review(336, "Phase 3 review: Lesson creation and AI organization", 3)],
    });
    expect(pairReviews(s).size).toBe(0);
  });

  it("prefers the comment over a title match", () => {
    const s = snapshot({
      epics: [epicOf(514, 10), epicOf(525, 10)],
      issues: [
        epicIssue(514, "Phase 10a: Families and wards", 10, ["Phase review: #573"]),
        epicIssue(525, "Phase 10b: Services, tuition and enrollment", 10),
        review(573, "Phase 10b review: Services, tuition and enrollment", 10),
      ],
    });
    expect(pairReviews(s).get(573)).toBe(514);
  });
});
