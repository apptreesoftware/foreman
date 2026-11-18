import { describe, expect, it } from "vitest";
import { comment, hoursAgo } from "../test/helpers.ts";
import { parseBlocks, settledAnswer } from "./decisions.ts";

describe("parseBlocks", () => {
  it("reads the task from a `Blocks: #N` line", () => {
    expect(parseBlocks("## Question\nX?\n\n## Recommendation\nA\n\nBlocks: #57\n")).toBe(57);
  });
  it("is null without the line, or when it is not on a line of its own", () => {
    expect(parseBlocks("Context: this blocks #57")).toBeNull();
    expect(parseBlocks("Blocks: #57 and #58")).toBeNull();
    expect(parseBlocks("")).toBeNull();
  });
});

describe("settledAnswer", () => {
  it("is the earliest `Settled:` first line, trimmed", () => {
    const cs = [
      comment("Settled: A — later answer", hoursAgo(1)),
      comment("Settled:  B — Use REST \nby Jane via decisions page", hoursAgo(2)),
      comment("I prefer B", hoursAgo(3)),
    ];
    expect(settledAnswer(cs)).toBe("B — Use REST");
  });
  it("is null when nobody settled through the page", () => {
    expect(settledAnswer([comment("go with B")])).toBeNull();
  });
  it("caps a very long answer at 500 characters", () => {
    expect(settledAnswer([comment(`Settled: ${"x".repeat(900)}`)])?.length).toBe(500);
  });
});
