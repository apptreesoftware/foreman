import { describe, expect, it } from "vitest";
import { issue, snapshot } from "../test/helpers.ts";
import { adoptActions } from "./adopt.ts";

describe("adoptActions", () => {
  it("adopts an open agent-ready issue that is not on the board", () => {
    const s = snapshot({ issues: [issue({ number: 7, itemId: null, status: null })] });
    expect(adoptActions(s)).toEqual([{ type: "adopt", issue: 7 }]);
  });
  it("leaves an issue that already has a project item alone", () => {
    const s = snapshot({ issues: [issue({ number: 7, status: "Backlog" })] });
    expect(adoptActions(s)).toEqual([]);
  });
  it("ignores issues that are closed, epics, or not agent-ready", () => {
    const s = snapshot({
      issues: [
        issue({ number: 1, itemId: null, status: null, state: "CLOSED" }),
        issue({
          number: 2,
          itemId: null,
          status: null,
          labels: ["phase:1", "epic", "agent-ready"],
        }),
        issue({ number: 3, itemId: null, status: null, labels: ["phase:1", "size:S"] }),
      ],
    });
    expect(adoptActions(s)).toEqual([]);
  });
});
