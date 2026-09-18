import { needsYouItems } from "./needs-you.ts";
import { describeNext } from "./next.ts";
import { ownerItems } from "./owner.ts";
import { phaseProgress } from "./phase-progress.ts";
import { describePipeline } from "./pipeline.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
import type { MergeRecord, SessionLogEntry } from "./sessions.ts";
import type { Board, CurrentSession, PipelineRow } from "./state-file.ts";
import type { Snapshot } from "./types.ts";
import { describeWaiting, type WaitingInput } from "./waiting.ts";

/** The local logs the phase card is aggregated from; empty is a valid (first-run) input. */
export interface BoardLogs {
  sessions: SessionLogEntry[];
  merges: MergeRecord[];
}

/** Everything the page shows between ticks, from the snapshot the planner already fetched. */
export function describeBoard(
  s: Snapshot,
  i: WaitingInput,
  logs: BoardLogs = { sessions: [], merges: [] },
  repo: RepoConfig = defaultRepoConfig(),
): Board {
  const next = describeNext(s, repo);
  return {
    at: s.now,
    waiting: describeWaiting(s, i, repo),
    pipeline: describePipeline(s, repo),
    owner: ownerItems(s),
    needsYou: needsYouItems(s),
    phases: phaseProgress(s, logs.sessions, logs.merges),
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
          model: null,
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
