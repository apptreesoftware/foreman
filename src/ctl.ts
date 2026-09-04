import { KILL_GRACE_MS } from "./dispatch.ts";
import type { InterruptInput } from "./release.ts";
import { GH_TIMEOUT_MS } from "./release.ts";
import {
  type CurrentSession,
  MODEL_CHOICES,
  MODEL_DEFAULT,
  ModelSchema,
  readState,
  type StopMode,
  writeState,
} from "./state-file.ts";

export interface CtlDeps {
  stateDir: string;
  host: string;
  login: string;
  now: () => string;
  pidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  touchStop: () => void;
  removeStop: () => void;
  launchdInstalled: () => Promise<boolean>;
  launchdKickstart: () => Promise<void>;
  release: (i: InterruptInput) => Promise<string[]>;
  out: (line: string) => void;
  startCommand: string;
  /** `model` from foreman.json, so `ctl model` can name what an override is hiding. */
  configModel: string;
  /** POSTs /api/model to a running daemon, which owns state.json while it lives. */
  postModel: (model: string) => Promise<string>;
}

// Worst case: the daemon's interrupt path kills the child (KILL_GRACE_MS) and then makes up to
// three sequential gh calls in ledgerInterrupt's abort branch (comment, unassign, setStatus),
// each bounded by GH_TIMEOUT_MS, plus slack for everything in between.
export const EXIT_WAIT_MS = KILL_GRACE_MS + 3 * GH_TIMEOUT_MS + 30_000;
export const CHILD_WAIT_MS = 30_000;
export const POLL_MS = 500;

const minutesSince = (iso: string, now: string) =>
  Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));

async function waitUntil(d: CtlDeps, pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let polls = 0;
  while (!pred()) {
    if (Date.now() >= deadline || polls++ > ms / POLL_MS) return false;
    await d.sleep(POLL_MS);
  }
  return true;
}

async function killChild(d: CtlDeps, c: CurrentSession): Promise<void> {
  if (!c.childPid || !d.pidAlive(c.childPid)) return;
  d.out(`ORPHAN child ${c.childPid} for #${c.issue}: sending SIGTERM`);
  d.kill(c.childPid, "SIGTERM");
  const pid = c.childPid;
  if (!(await waitUntil(d, () => !d.pidAlive(pid), CHILD_WAIT_MS))) {
    d.out(`child ${pid} still alive after ${CHILD_WAIT_MS / 1000}s: sending SIGKILL`);
    d.kill(pid, "SIGKILL");
  }
}

async function releaseLocally(d: CtlDeps, c: CurrentSession, mode: StopMode): Promise<void> {
  const writes = await d.release({
    mode,
    host: d.host,
    login: d.login,
    issue: c.issue,
    role: c.role,
    round: c.round,
    sessionId: c.sessionId,
    minutes: minutesSince(c.startedAt, d.now()),
  });
  for (const w of writes) d.out(`ledger: ${w}`);
  const s = readState(d.stateDir);
  if (s) writeState(d.stateDir, { ...s, current: null, unfinished: null });
}

export async function ctlStop(d: CtlDeps, mode: StopMode): Promise<void> {
  d.touchStop();
  d.out("STOP file present: no new dispatch on this Mac");
  const s = readState(d.stateDir);
  if (!s) {
    d.out("no state file: the daemon predates ctl or never ran; nothing to signal");
    return;
  }
  if (d.pidAlive(s.pid)) {
    const before = s.current;
    d.kill(s.pid, mode === "stop" ? "SIGTERM" : "SIGUSR1");
    d.out(`sent ${mode} to daemon pid ${s.pid}; waiting for it to exit`);
    const exited = await waitUntil(
      d,
      () => !d.pidAlive(s.pid) || (readState(d.stateDir)?.exitedAt ?? null) !== null,
      EXIT_WAIT_MS,
    );
    if (!exited) {
      d.out(
        `daemon pid ${s.pid} did not exit within ${EXIT_WAIT_MS / 1000}s; it may still be finishing bookkeeping — re-run ctl status`,
      );
      return;
    }
    const after = readState(d.stateDir);
    if (before)
      d.out(
        `${mode === "stop" ? "interrupted" : "aborted"} ${before.role} #${before.issue} session ${before.sessionId}`,
      );
    else d.out("daemon exited; no session was running");
    if (after?.unfinished) {
      if (mode === "abort") await releaseLocally(d, after.unfinished, "abort");
      else
        d.out(
          `bookkeeping for #${after.unfinished.issue} is unfinished; run ctl abort to release it`,
        );
    }
    return;
  }
  d.out(`daemon not running (pid ${s.pid} ${s.exitedAt ? "exited" : "dead"})`);
  const pending = s.unfinished ?? s.current;
  if (s.current) await killChild(d, s.current);
  if (!pending) return;
  if (mode === "abort") await releaseLocally(d, pending, "abort");
  else d.out(`claim on #${pending.issue} may still be open; ctl abort releases it`);
}

/**
 * Reads or sets the model the next session runs as. A live daemon owns state.json — its in-memory
 * copy would overwrite anything written underneath it — so a set goes through the page's
 * `/api/model` while it is running, and straight to the file only when it is not.
 */
export async function ctlModel(d: CtlDeps, model: string | null): Promise<void> {
  const s = readState(d.stateDir);
  if (model === null) {
    const current = s?.model ?? d.configModel;
    d.out(
      `model ${current} ${s?.model ? `(override; foreman.json says ${d.configModel})` : "(foreman.json)"}`,
    );
    d.out(
      `choices: ${MODEL_CHOICES.join(", ")}, ${MODEL_DEFAULT}   (any model name is accepted; ${MODEL_DEFAULT} clears an override)`,
    );
    return;
  }
  if (!ModelSchema.safeParse(model).success) {
    d.out(`${model} is not a model name; expected something like ${MODEL_CHOICES.join(", ")}`);
    return;
  }
  if (s && d.pidAlive(s.pid)) {
    d.out(await d.postModel(model));
    return;
  }
  if (!s) {
    d.out(
      `no state file: the daemon has never run here. Set "model": "${model}" in foreman.json instead.`,
    );
    return;
  }
  const next = model === MODEL_DEFAULT ? null : model;
  writeState(d.stateDir, { ...s, model: next });
  d.out(
    next
      ? `model set to ${next}; it applies when the daemon next starts`
      : `override cleared; foreman.json's ${d.configModel} applies when the daemon next starts`,
  );
}

export async function ctlGo(d: CtlDeps): Promise<void> {
  d.removeStop();
  d.out("STOP file removed");
  const s = readState(d.stateDir);
  if (s && d.pidAlive(s.pid)) {
    d.kill(s.pid, "SIGUSR2");
    d.out("tick requested");
    return;
  }
  if (await d.launchdInstalled()) {
    await d.launchdKickstart();
    d.out("launchd agent kickstarted");
    return;
  }
  d.out(`daemon not running; start it with: ${d.startCommand}`);
}
