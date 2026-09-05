import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG_PATH, loadConfig, STATE_DIR } from "./config.ts";
import { Controller, Mutex } from "./control.ts";
import { realExec } from "./exec.ts";
import { readFeed } from "./feed.ts";
import { GitHub } from "./github.ts";
import { launchdInstalled } from "./launchd-status.ts";
import { log } from "./log.ts";
import { buildSnapshot, ensureLogin, realCtx, runForever, runOnce } from "./loop.ts";
import { describeNext } from "./next.ts";
import { applyOwnerAction, applyOwnerActionToBoard } from "./owner.ts";
import { checkEnv, preflight } from "./preflight.ts";
import { readSessions } from "./sessions.ts";
import { initialState, MODEL_DEFAULT, readState, StateStore } from "./state-file.ts";
import { describeStatus } from "./status.ts";
import { startWebServer } from "./web.ts";

const bad = checkEnv(process.env);
if (bad) {
  process.stderr.write(
    `foreman: ${bad} is set. Unset it; the foreman only runs on subscription auth.\n`,
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    config: { type: "string" },
  },
});

const cfg = loadConfig(values.config);
const configPath = values.config ?? process.env.TONE_FOREMAN_CONFIG ?? DEFAULT_CONFIG_PATH;
const once = values.once;
const dryRun = values["dry-run"];

const result = await preflight(cfg, {
  env: process.env,
  exec: realExec,
  stateDir: STATE_DIR,
  now: new Date(),
});
if (!result.ok) {
  log(once ? "error" : "warn", "preflight failed", { reason: result.reason });
  // A long-running daemon keeps going: runOnce re-checks preflight every tick, and the page
  // stays up so the operator can see why it is idle. --once reports and exits.
  if (once) process.exit(1);
} else log("info", "preflight ok", { host: cfg.host, once, dryRun, warnings: result.warnings });

const gh = new GitHub({ repo: cfg.repo, owner: cfg.owner, project: cfg.project }, realExec, dryRun);

if (once) {
  const login = await gh.viewerLogin();
  const ctx = realCtx(cfg, gh, login, dryRun, STATE_DIR, {
    signal: new AbortController().signal,
    stopMode: () => null,
    state: null,
  });
  await runOnce(ctx);
  process.exit(0);
}

// Long-running daemon: a failed or not-yet-authenticated `gh` must not keep it from starting —
// state.json and the page have to come up so the operator can see why it is idle. Resolve the
// login best-effort here; ensureLogin() retries it (and mutates ctx.login) each tick until it
// succeeds. Preflight's `gh auth status` check inside runOnce keeps any write from reaching
// GitHub while the login is still empty.
let login = "";
try {
  login = await gh.viewerLogin();
} catch (err) {
  log("warn", "gh login unavailable; will retry each tick", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Long-running daemon: owns state.json, the web page, and the signal handlers.
const previous = readState(STATE_DIR);
const store = new StateStore(
  STATE_DIR,
  initialState({
    pid: process.pid,
    host: cfg.host,
    configPath,
    dryRun,
    startedAt: new Date().toISOString(),
    // A restart must not silently revert the owner's overrides back to foreman.json (#210, #213).
    model: previous?.model ?? null,
    maxSessionsPerDay: previous?.maxSessionsPerDay ?? null,
  }),
);
const controller = new Controller((mode) => {
  log("info", "operator requested", { mode });
  store.patch({ stopping: { mode, at: new Date().toISOString() } });
});
controller.install();
const lock = new Mutex();
const ctx = realCtx(cfg, gh, login, dryRun, STATE_DIR, {
  signal: controller.signal,
  stopMode: () => controller.stopMode,
  state: store,
});
const stopFile = join(STATE_DIR, "STOP");
// Computed once at startup: whether the launchd agent is bootstrapped never changes for the life
// of this process, so there is no need to re-check it on every status request.
const launchdIsInstalled = await launchdInstalled();
const web = await startWebServer({
  port: cfg.webPort,
  status: () =>
    describeStatus({
      state: store.get(),
      now: new Date().toISOString(),
      pidAlive: () => true,
      stopPresent: existsSync(stopFile),
      launchdInstalled: launchdIsInstalled,
      sessions: readSessions(STATE_DIR),
      maxSessionsPerDay: cfg.maxSessionsPerDay,
      wallClockMinutes: cfg.wallClockMinutes,
      host: cfg.host,
      stallMinutes: cfg.stallMinutes,
      repo: cfg.repo,
      configModel: cfg.model,
    }),
  next: () => lock.run(async () => describeNext(await buildSnapshot(ctx))),
  act: async (cmd) => {
    if (cmd === "go") {
      if (existsSync(stopFile)) unlinkSync(stopFile);
      controller.wake();
      return "STOP removed; tick requested";
    }
    writeFileSync(stopFile, "");
    controller.request(cmd);
    return `${cmd} requested; STOP file present`;
  },
  feed: (session, limit) => readFeed(STATE_DIR, session, limit),
  setModel: async (model) => {
    // Read per dispatch by runRole's modelFor(), so a session already running keeps the model it
    // started with and the next one picks this up — no restart (#210).
    const next = model === MODEL_DEFAULT ? null : model;
    store.patch({ model: next });
    log("info", "model set", { model: next, configured: cfg.model });
    return `next session runs ${next ?? cfg.model}`;
  },
  setCap: async (maxSessionsPerDay) => {
    // Read per tick by runOnce's capFor(), so raising it while parked on the cap lets the very
    // next tick run — no restart, and the sleep is cut short so it happens now (#213).
    store.patch({ maxSessionsPerDay });
    log("info", "cap set", { maxSessionsPerDay, configured: cfg.maxSessionsPerDay });
    controller.wake();
    return `cap is now ${maxSessionsPerDay ?? `the configured ${cfg.maxSessionsPerDay}`}`;
  },
  ownerItems: () => store.get().board?.owner ?? [],
  owner: async (epic, action) => {
    const message = await applyOwnerAction(gh, epic, action);
    log("info", "owner action", { epic, action });
    // The board is only rebuilt by a tick, and a tick that dispatched a session does not return
    // for up to wallClockMinutes, so reflect the gate locally instead of leaving the page
    // offering a button that has already been pressed (#204).
    const board = store.get().board;
    if (board) store.patch({ board: applyOwnerActionToBoard(board, epic, action) });
    // The board is rebuilt per tick, so wake the loop instead of leaving the page stale for a
    // whole poll interval. The tick that follows also acts on the label just written.
    controller.wake();
    return message;
  },
});

let crashed = false;
try {
  await runForever(ctx, {
    sleep: (ms) => controller.sleep(ms),
    lock: (fn) => lock.run(fn),
    iterate: async (c) => {
      await ensureLogin(c);
      return runOnce(c);
    },
  });
} catch (err) {
  crashed = true;
  log("error", "foreman loop crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
} finally {
  // Runs even when runForever throws, so a crashed daemon still leaves state.json consistent
  // (exitedAt set, current/stopping cleared) and closes the web server.
  store.patch({ exitedAt: new Date().toISOString(), stopping: null, current: null });
  web?.close();
}
log("info", "foreman exited", { mode: controller.stopMode });
process.exit(crashed ? 1 : 0);
