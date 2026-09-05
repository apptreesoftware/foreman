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

export const BoardSchema = z.object({
  at: z.string(),
  waiting: z.array(WaitItemSchema),
  pipeline: z.array(PipelineRowSchema),
  // Older state.json files predate this field; default keeps them readable.
  owner: z.array(OwnerItemSchema).default([]),
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
