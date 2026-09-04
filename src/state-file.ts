import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ActivitySchema } from "./stream.ts";

export const StopModeSchema = z.enum(["stop", "abort"]);
export type StopMode = z.infer<typeof StopModeSchema>;

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

export const BoardSchema = z.object({
  at: z.string(),
  waiting: z.array(WaitItemSchema),
  pipeline: z.array(PipelineRowSchema),
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
}): ForemanState {
  return {
    version: 1,
    ...o,
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
