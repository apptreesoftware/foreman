import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG_PATH, loadConfig, STATE_DIR } from "./config.ts";
import { Controller, Mutex } from "./control.ts";
import { realExec } from "./exec.ts";
import { GitHub } from "./github.ts";
import { launchdInstalled } from "./launchd-status.ts";
import { log } from "./log.ts";
import { buildSnapshot, ensureLogin, realCtx, runForever, runOnce } from "./loop.ts";
import { describeNext } from "./next.ts";
import { checkEnv, preflight } from "./preflight.ts";
import { readSessions } from "./sessions.ts";
import { initialState, StateStore } from "./state-file.ts";
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
const store = new StateStore(
  STATE_DIR,
  initialState({
    pid: process.pid,
    host: cfg.host,
    configPath,
    dryRun,
    startedAt: new Date().toISOString(),
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
});

let crashed = false;
try {
  await runForever(ctx, {
    sleep: (ms) => controller.sleep(ms),
    lock: (fn) => lock.run(fn),
    iterate: async (c) => {
      await ensureLogin(c);
      await runOnce(c);
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
