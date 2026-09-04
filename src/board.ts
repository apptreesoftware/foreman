import { describeNext } from "./next.ts";
import { ownerItems } from "./owner.ts";
import { describePipeline } from "./pipeline.ts";
import type { Board, CurrentSession, PipelineRow } from "./state-file.ts";
import type { Snapshot } from "./types.ts";
import { describeWaiting, type WaitingInput } from "./waiting.ts";

/** Everything the page shows between ticks, from the snapshot the planner already fetched. */
export function describeBoard(s: Snapshot, i: WaitingInput): Board {
  const next = describeNext(s);
  return {
    at: s.now,
    waiting: describeWaiting(s, i),
    pipeline: describePipeline(s),
    owner: ownerItems(s),
    explain: next.explain,
    prs: next.prs,
  };
}

const STAGE_BY_ROLE: Partial<Record<string, keyof PipelineRow["stages"]>> = {
  builder: "build",
  reviewer: "review",
  validator: "validate",
};

/**
 * Overlays this Mac's own running session onto a board. The board is computed once per tick,
 * before the claim comment lands and while the tick is blocked on the session itself, so without
 * this the running session's issue never shows as active and "Waiting on" can list a
 * `review_cycle`/`dependency` item for the very issue being worked. Pure so it is unit-testable
 * without a snapshot.
 */
export function overlayCurrent(board: Board, current: CurrentSession, host: string): Board {
  const claim = { host, role: current.role, round: current.round, at: current.startedAt };
  const idx = board.pipeline.findIndex((r) => r.issue === current.issue);
  const stageKey = STAGE_BY_ROLE[current.role];
  const base: PipelineRow =
    idx >= 0
      ? (board.pipeline[idx] as PipelineRow)
      : {
          issue: current.issue,
          title: current.title,
          phase: 0,
          status: null,
          pr: current.pr,
          stages: {
            build: "pending",
            review: "pending",
            validate: "pending",
            ci: "none",
            merge: "pending",
          },
          claim: null,
          fixRound: current.round,
          blocked: false,
        };
  const row: PipelineRow = {
    ...base,
    claim,
    stages: stageKey ? { ...base.stages, [stageKey]: "active" } : base.stages,
  };
  const pipeline =
    idx >= 0 ? board.pipeline.map((r, k) => (k === idx ? row : r)) : [row, ...board.pipeline];
  const issueSubject = `#${current.issue}`;
  const prSubject = current.pr != null ? `PR #${current.pr}` : null;
  const waiting = board.waiting.filter(
    (w) =>
      !(
        (w.kind === "review_cycle" || w.kind === "dependency") &&
        (w.subject === issueSubject || w.subject === prSubject)
      ),
  );
  return { ...board, pipeline, waiting };
}
