import { describe, expect, it } from "vitest";
import { describeAttention } from "./attention.ts";
import type { Board, NeedsYouItem, OwnerItem, WaitItem } from "./state-file.ts";

const board = (over: Partial<Board> = {}): Board => ({
  at: "2026-09-05T10:00:00Z",
  waiting: [],
  pipeline: [],
  owner: [],
  needsYou: [],
  phases: [],
  issues: [],
  groups: [],
  explain: [],
  prs: [],
  ...over,
});

const owner = (epic: number, actions: OwnerItem["actions"]): OwnerItem => ({
  epic,
  title: `Phase ${epic}`,
  phase: 1,
  detail: "",
  actions,
  since: null,
  review: null,
});

const needs = (issue: number, over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  issue,
  title: `Task ${issue}`,
  labels: ["needs-owner"],
  since: "2026-09-01T00:00:00Z",
  itemId: null,
  reviewOf: null,
  phaseReview: false,
  ...over,
});

const wait = (
  kind: WaitItem["kind"],
  subject: string,
  detail: string,
  since: string | null = null,
) => ({
  kind,
  subject,
  detail,
  since,
});

describe("describeAttention", () => {
  it("counts approve and sign-off epics and unpaired needs-you issues, not start_planning", () => {
    const b = board({
      owner: [
        owner(1, ["approve_plan", "pause"]),
        owner(2, ["sign_off", "pause"]),
        owner(3, ["start_planning", "pause"]),
        owner(4, ["pause"]),
      ],
      needsYou: [needs(11), needs(12, { reviewOf: 2 }), needs(13, { labels: ["blocked"] })],
    });
    expect(describeAttention(b).needsYou).toBe(4);
  });

  it("moves stop, preflight, cap and paused into banners", () => {
    const b = board({
      waiting: [
        wait("stop", "STOP", "STOP file present; ctl go to resume"),
        wait("preflight", "preflight", "gh not authenticated"),
        wait("cap", "cap", "20 of 20 sessions today"),
        wait("paused", "phase 3", "phase 3 paused (foreman:pause on #30)"),
        wait("ci", "PR #276", "PR #276 checks pending"),
      ],
    });
    const a = describeAttention(b);
    expect(a.banners.map((w) => w.kind)).toEqual(["stop", "preflight", "cap", "paused"]);
    expect(a.waitRows.map((w) => w.kind)).toEqual(["ci"]);
    expect(a.waiting).toBe(1);
  });

  it("drops human waits whose subject is on Needs you and keeps the rest", () => {
    const b = board({
      owner: [owner(93, ["sign_off", "pause"]), owner(77, ["start_planning", "pause"])],
      needsYou: [needs(609, { labels: ["blocked"] })],
      waiting: [
        wait("human", "epic #93", "epic #93 awaits owner sign-off"),
        wait("human", "#609", "#609 blocked: depends on #608"),
        wait("human", "#41", "#41 is agent-ready but Status Backlog"),
        wait(
          "human",
          "phase 13",
          "phase 13 held: 1 blocked tasks need you before any new build starts",
        ),
      ],
    });
    expect(describeAttention(b).waitRows.map((w) => w.subject)).toEqual(["#41", "phase 13"]);
  });

  it("merges dependency rows for one issue", () => {
    const b = board({
      waiting: [
        wait("dependency", "#270", "#270 waits on #268"),
        wait("dependency", "#271", "#271 waits on #269"),
        wait("dependency", "#270", "#270 waits on #269", "2026-09-02T00:00:00Z"),
      ],
    });
    expect(describeAttention(b).waitRows).toEqual([
      wait("dependency", "#270", "#270 waits on #268 and #269", "2026-09-02T00:00:00Z"),
      wait("dependency", "#271", "#271 waits on #269"),
    ]);
  });

  it("lists three or more dependencies with commas", () => {
    const b = board({
      waiting: [
        wait("dependency", "#9", "#9 waits on #1"),
        wait("dependency", "#9", "#9 waits on #2"),
        wait("dependency", "#9", "#9 waits on #3"),
      ],
    });
    expect(describeAttention(b).waitRows[0]?.detail).toBe("#9 waits on #1, #2 and #3");
  });

  it("is all zeros and empty for a null board", () => {
    expect(describeAttention(null)).toEqual({ needsYou: 0, waiting: 0, banners: [], waitRows: [] });
  });
});
