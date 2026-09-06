import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActivitySchema } from "./stream.ts";

export const StopModeSchema = z.enum(["stop", "abort"]);
export type StopMode = z.infer<typeof StopModeSchema>;

/**
 * Order is the wait list's rank: what stops this Mac acting at all comes first, then the live
 * blockers on work in flight, and last `phase_gate` — a background label gate on a phase that has
 * not started, which must never headline the Now card ahead of a real blocker (#206).
 */
export const WAIT_KINDS = [
  "stop",
  "preflight",
  "cap",
  "paused",
  "human",
  "ci",
  "review_cycle",
  "dependency",
  "other_host",
  "phase_gate",
] as const;
export const WaitItemSchema = z.object({
  kind: z.enum(WAIT_KINDS),
  subject: z.string(),
  detail: z.string(),
  since: z.string().nullable(),
});
export type WaitItem = z.infer<typeof WaitItemSchema>;

export const StageStateSchema = z.enum(["done", "active", "pending", "failed", "skipped"]);
export type StageState = z.infer<typeof StageStateSchema>;
export const PipelineRowSchema = z.object({
  issue: z.number().int(),
  title: z.string(),
  phase: z.number().int(),
  status: z.string().nullable(),
  pr: z.number().int().nullable(),
  stages: z.object({
    build: StageStateSchema,
    review: StageStateSchema,
    validate: StageStateSchema,
    ci: z.enum(["success", "pending", "failure", "none"]),
    merge: StageStateSchema,
  }),
  claim: z
    .object({ host: z.string(), role: z.string(), round: z.number().int(), at: z.string() })
    .nullable(),
  fixRound: z.number().int(),
  blocked: z.boolean(),
  /** The issue's `model:<name>` label, so the row can say which model its sessions run as. */
  model: z.string().nullable().default(null),
});
export type PipelineRow = z.infer<typeof PipelineRowSchema>;

/** GitHub's hourly GraphQL budget, sampled around each tick and attributed (#198). */
export const BudgetReportSchema = z.object({
  at: z.string(),
  remaining: z.number().int(),
  limit: z.number().int(),
  resetAt: z.string(),
  tickReads: z.number().int(),
  actionSpend: z.number().int(),
  betweenTicks: z.number().int(),
});
export type BudgetReport = z.infer<typeof BudgetReportSchema>;

/**
 * The models the page and `ctl model` offer as one-click choices (#210). Not a whitelist of what
 * is *allowed* — `foreman.json` and `ctl model <name>` accept any name matching `ModelSchema`, so
 * a dated model id still works and this list never has to be right about the future.
 */
export const MODEL_CHOICES = ["opus", "sonnet", "haiku", "fable"] as const;
/**
 * The name that clears the override instead of setting one, so `model` in foreman.json is
 * reachable again after a click. Nothing is actually dispatched under this name.
 */
export const MODEL_DEFAULT = "default";
/** Conservative shape check: an alias or a dated model id, never a flag or a path. */
export const ModelSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);
/**
 * The label that pins one issue's sessions to a model, outranking the live override and
 * `foreman.json`. A label has to exist in the repo, so the page offers only `MODEL_CHOICES`
 * here (plus `MODEL_DEFAULT`, which removes the label); `gh issue edit --add-label` can still
 * attach any `model:<name>` whose name passes `ModelSchema`.
 */
export const MODEL_LABEL_PREFIX = "model:";
export const TaskModelChoiceSchema = z.enum([...MODEL_CHOICES, MODEL_DEFAULT]);
export type TaskModelChoice = z.infer<typeof TaskModelChoiceSchema>;

/**
 * Daily session caps the page and `ctl cap` offer as one-click choices (#213). As with
 * `MODEL_CHOICES`, any value passing `CapSchema` is accepted; these are only the shortcuts.
 */
export const CAP_CHOICES = [20, 40, 60, 100] as const;
/** A day's worth of sessions, bounded: a typo of 100000 must not uncap the Mac by accident. */
export const CapSchema = z.number().int().min(1).max(500);

/** The label gates a human owns; the page turns each into a button (#198). */
export const OWNER_ACTIONS = [
  "sign_off",
  "approve_plan",
  "start_planning",
  "pause",
  "unpause",
] as const;
export const OwnerActionSchema = z.enum(OWNER_ACTIONS);
export type OwnerAction = z.infer<typeof OwnerActionSchema>;

export const OwnerItemSchema = z.object({
  epic: z.number().int(),
  title: z.string(),
  phase: z.number(),
  detail: z.string(),
  actions: z.array(OwnerActionSchema),
});
export type OwnerItem = z.infer<typeof OwnerItemSchema>;

/**
 * The labels that put a non-epic issue on the Needs you card: two the owner has to answer, and
 * one the owner has to clear. Order is the order they are listed in on a row.
 */
export const NEEDS_YOU_LABELS = ["decision", "needs-owner", "blocked"] as const;
export const NeedsYouItemSchema = z.object({
  issue: z.number().int(),
  title: z.string(),
  /** Which of `NEEDS_YOU_LABELS` the issue carries; `blocked` is what offers the Unblock button. */
  labels: z.array(z.string()),
  /** The issue's `updatedAt`, so the page and `ctl status` can say how long it has waited. */
  since: z.string(),
  /** Project item id, so Unblock can set Status Ready without another read; null when off board. */
  itemId: z.string().nullable(),
});
export type NeedsYouItem = z.infer<typeof NeedsYouItemSchema>;

/**
 * One task of a phase as the tick saw it. A closed task has left the snapshot, so it keeps only
 * its number (`title` is `#<n>`), and the page offers it no model button.
 */
export const PhaseTaskSchema = z.object({
  issue: z.number().int(),
  title: z.string(),
  status: z.string().nullable(),
  closed: z.boolean(),
  /** The issue's `model:<name>` label, or null when the global model applies. */
  model: z.string().nullable(),
});
export type PhaseTask = z.infer<typeof PhaseTaskSchema>;

/**
 * How far one approved phase has come and what it has cost (#226). Computed inside the tick from
 * the snapshot plus `sessions.log`/`merges.log`, so the card is free of extra GitHub reads.
 */
export const PhaseProgressSchema = z.object({
  epic: z.number().int(),
  phase: z.number(),
  title: z.string(),
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
  spendUsd: z.number(),
  /** Sessions logged against this phase's tasks, so the spend has a denominator. */
  sessions: z.number().int(),
  /** Median claim→merge minutes of the merged tasks; null until one has merged. */
  medianMergeMinutes: z.number().nullable(),
  mergedTasks: z.number().int(),
  /** Every task of the phase, by number, so the page can offer a per-task model (#259). */
  tasks: z.array(PhaseTaskSchema).default([]),
});
export type PhaseProgress = z.infer<typeof PhaseProgressSchema>;

export const BoardSchema = z.object({
  at: z.string(),
  waiting: z.array(WaitItemSchema),
  pipeline: z.array(PipelineRowSchema),
  // Older state.json files predate this field; default keeps them readable.
  owner: z.array(OwnerItemSchema).default([]),
  // Same: added in #224, and an older file must still parse.
  needsYou: z.array(NeedsYouItemSchema).default([]),
  // Same: added in #226.
  phases: z.array(PhaseProgressSchema).default([]),
  explain: z.array(z.string()),
  prs: z.array(
    z.object({
      pr: z.number().int(),
      issue: z.number().int().nullable(),
      status: z.string(),
      checks: z.string(),
      labels: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});
export type Board = z.infer<typeof BoardSchema>;

export const CurrentSessionSchema = z.object({
  issue: z.number().int(),
  title: z.string(),
  role: z.string(),
  pr: z.number().int().nullable(),
  round: z.number().int(),
  attempt: z.number().int(),
  sessionId: z.string(),
  resume: z.boolean(),
  worktree: z.string(),
  branch: z.string(),
  childPid: z.number().int().nullable(),
  startedAt: z.string(),
  deadlineAt: z.string(),
  activity: ActivitySchema.nullable().default(null),
});
export type CurrentSession = z.infer<typeof CurrentSessionSchema>;

export const ForemanStateSchema = z.object({
  version: z.literal(1),
  pid: z.number().int(),
  host: z.string(),
  configPath: z.string(),
  dryRun: z.boolean(),
  startedAt: z.string(),
  exitedAt: z.string().nullable(),
  lastTickAt: z.string().nullable(),
  nextTickAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  lastPreflight: z.object({ ok: z.boolean(), reason: z.string().nullable() }).nullable(),
  lastPlan: z.array(z.string()).nullable(),
  current: CurrentSessionSchema.nullable(),
  stopping: z.object({ mode: StopModeSchema, at: z.string() }).nullable(),
  unfinished: CurrentSessionSchema.extend({ mode: StopModeSchema }).nullable(),
  board: BoardSchema.nullable().default(null),
  budget: BudgetReportSchema.nullable().default(null),
  /**
   * Live model override set from the page or `ctl model`; null means "use `model` from
   * foreman.json". Older state.json files predate this field; the default keeps them readable.
   */
  model: z.string().nullable().default(null),
  /**
   * Live daily-cap override set from the page or `ctl cap`; null means "use `maxSessionsPerDay`
   * from foreman.json". Read per tick, so raising it un-parks a capped daemon without a restart
   * (#213). Older state.json files predate this field; the default keeps them readable.
   */
  maxSessionsPerDay: z.number().int().nullable().default(null),
});
export type ForemanState = z.infer<typeof ForemanStateSchema>;

export function statePath(stateDir: string): string {
  return join(stateDir, "state.json");
}

export function initialState(o: {
  pid: number;
  host: string;
  configPath: string;
  dryRun: boolean;
  startedAt: string;
  /** Carried over from the previous state.json so a restart keeps the owner's model choice. */
  model?: string | null;
  /** Carried over from the previous state.json, like `model`, so a restart keeps the override. */
  maxSessionsPerDay?: number | null;
}): ForemanState {
  return {
    version: 1,
    ...o,
    // After the spread: an omitted override arrives as undefined, which the schema rejects.
    model: o.model ?? null,
    maxSessionsPerDay: o.maxSessionsPerDay ?? null,
    exitedAt: null,
    lastTickAt: null,
    nextTickAt: null,
    consecutiveFailures: 0,
    lastPreflight: null,
    lastPlan: null,
    current: null,
    stopping: null,
    unfinished: null,
    board: null,
    budget: null,
  };
}

/** Null when the file is missing, unparsable, or from another schema version. */
export function readState(stateDir: string): ForemanState | null {
  const p = statePath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = ForemanStateSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write to a temp file then rename, so a reader never sees a partial file. */
export function writeState(stateDir: string, state: ForemanState): void {
  mkdirSync(stateDir, { recursive: true });
  const p = statePath(stateDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p);
}

export class StateStore {
  constructor(
    private readonly stateDir: string,
    private state: ForemanState,
  ) {
    writeState(stateDir, state);
  }
  get(): ForemanState {
    return this.state;
  }
  patch(p: Partial<ForemanState>): ForemanState {
    this.state = { ...this.state, ...p };
    writeState(this.stateDir, this.state);
    return this.state;
  }
}
