import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const StopModeSchema = z.enum(["stop", "abort"]);
export type StopMode = z.infer<typeof StopModeSchema>;

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
