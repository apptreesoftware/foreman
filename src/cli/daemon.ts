import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { Controller, Mutex } from "../control.ts";
import { realExec } from "../exec.ts";
import { readFeed } from "../feed.ts";
import { GitHub } from "../github.ts";
import { fileHookLog } from "../hooks.ts";
import type { Instance } from "../instance.ts";
import { launchdInstalled } from "../launchd-status.ts";
import { log } from "../log.ts";
import { buildSnapshot, ensureLogin, realCtx, runForever, runOnce } from "../loop.ts";
import { applyUnblock, applyUnblockToBoard } from "../needs-you.ts";
import { describeNext } from "../next.ts";
import { applyOwnerAction, applyOwnerActionToBoard } from "../owner.ts";
import { checkEnv, preflight } from "../preflight.ts";
import { loadRepoConfigSafe } from "../repo-config.ts";
import { readSessions } from "../sessions.ts";
import { initialState, MODEL_DEFAULT, readState, StateStore } from "../state-file.ts";
import { describeStatus } from "../status.ts";
import { applyTaskModel, applyTaskModelToBoard, phaseTasks } from "../task-model.ts";
import { startWebServer } from "../web.ts";
import { launchdLabel } from "./launchd.ts";

export async function runDaemon(
  instance: Instance,
  o: { once: boolean; dryRun: boolean },
): Promise<never> {
  const bad = checkEnv(process.env);
  if (bad) {
    process.stderr.write(
      `foreman: ${bad} is set. Unset it; the foreman only runs on subscription auth.\n`,
    );
    process.exit(2);
  }

  const STATE_DIR = instance.dir;
  const cfg = loadConfig(instance.configPath);
  // Every tick reads the board; without one there is nothing to run, and `init` is what makes it.
  if (cfg.project === undefined) {
    process.stderr.write(`foreman: project is not set; run foreman -p ${instance.name} init\n`);
    process.exit(2);
  }
  // Spec §4.4: the launchd wrapper this daemon replaced pulled the clone before starting, and
  // nothing else updates it — `config.json` is read once per process from `repoDir` and the hooks
  // resolve under it, so without this a merged PR that changes either takes effect only after a
  // manual pull. Best-effort and never fatal: an offline Mac, a dirty clone or a diverged branch
  // all mean "carry on with the clone as it is". Skipped for `--once`, which must not touch the
  // working tree an operator is debugging in.
  if (!o.once) {
    const pull = await realExec("git", ["-C", cfg.repoDir, "pull", "--ff-only"]);
    if (pull.code !== 0)
      log("warn", "repo pull failed; continuing with the clone as it is", {
        stderr: pull.stderr.trim().slice(-500),
      });
  }

  // The daemon, unlike ctl, refuses to run on a repo config it cannot read: it would otherwise
  // work the repository by a different process than the repository asked for. launchd restarts it
  // every 60 s, so the line has to name the file — `foreman.err.log` is all the operator gets.
  const { config: repo, error: repoError } = loadRepoConfigSafe(cfg.repoDir);
  if (repoError) {
    process.stderr.write(`foreman: ${repoError}\n`);
    process.exit(2);
  }
  const once = o.once;
  const dryRun = o.dryRun;
  const hookLog = fileHookLog(STATE_DIR);

  const result = await preflight(cfg, {
    env: process.env,
    exec: realExec,
    stateDir: STATE_DIR,
    now: new Date(),
    repoDir: cfg.repoDir,
    instance: instance.name,
    hookLog,
  });
  if (!result.ok) {
    log(once ? "error" : "warn", "preflight failed", { reason: result.reason });
    // A long-running daemon keeps going: runOnce re-checks preflight every tick, and the page
    // stays up so the operator can see why it is idle. --once reports and exits.
    if (once) process.exit(1);
  } else log("info", "preflight ok", { host: cfg.host, once, dryRun, warnings: result.warnings });

  const gh = new GitHub(
    { repo: cfg.repo, owner: cfg.owner, project: cfg.project },
    realExec,
    dryRun,
  );
  // Same reasoning as the login block below: a failed, not-yet-authenticated or rate-limited `gh`
  // must not keep the daemon from starting. "main" is the fallback until a later tick's own gh
  // calls succeed; nothing here is a write, so a wrong guess costs nothing but a retried rebase.
  let defaultBranch = "main";
  try {
    defaultBranch = await gh.defaultBranch();
  } catch (err) {
    log("warn", "gh default branch unavailable; assuming main", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (once) {
    const login = await gh.viewerLogin();
    const ctx = realCtx(
      cfg,
      gh,
      login,
      dryRun,
      STATE_DIR,
      {
        signal: new AbortController().signal,
        stopMode: () => null,
        state: null,
      },
      repo,
      defaultBranch,
      instance.name,
      hookLog,
    );
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
      configPath: instance.configPath,
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
  const ctx = realCtx(
    cfg,
    gh,
    login,
    dryRun,
    STATE_DIR,
    {
      signal: controller.signal,
      stopMode: () => controller.stopMode,
      state: store,
    },
    repo,
    defaultBranch,
    instance.name,
    hookLog,
  );
  const stopFile = join(STATE_DIR, "STOP");
  // Computed once at startup: whether the launchd agent is bootstrapped never changes for the life
  // of this process, so there is no need to re-check it on every status request.
  const launchdIsInstalled = await launchdInstalled(launchdLabel(instance.name));
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
        modelChoices: repo.models,
      }),
    next: () => lock.run(async () => describeNext(await buildSnapshot(ctx), repo)),
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
    refresh: async () => {
      // Every read carries its own board Status, so there is no cache left to drop (#387); the
      // button's remaining job is to make the tick happen now rather than at the end of the poll
      // interval — including a poll the idle backoff has stretched.
      controller.wake();
      log("info", "project refresh requested");
      return "project re-read; tick requested";
    },
    ownerItems: () => store.get().board?.owner ?? [],
    phaseTasks: () => phaseTasks(store.get().board),
    setTaskModel: async (issue, model) => {
      // The stored task row says which label is on the issue now, so the swap costs at most two
      // label edits and no GitHub read. Read per dispatch by runRole's modelFor(), so it applies
      // to the issue's next session and never to one already running (#259).
      const current = phaseTasks(store.get().board).find((t) => t.issue === issue)?.model ?? null;
      const message = await applyTaskModel(gh, { issue, current }, model);
      log("info", "task model set", { issue, model, was: current });
      const board = store.get().board;
      if (board) store.patch({ board: applyTaskModelToBoard(board, issue, model) });
      return message;
    },
    modelChoices: () => repo.models,
    needsYouItems: () => store.get().board?.needsYou ?? [],
    unblock: async (issue) => {
      // The stored row carries the project item id the tick already read, so the gate costs one
      // label edit, one status write and one comment — no extra GitHub read.
      const item = store.get().board?.needsYou.find((n) => n.issue === issue) ?? null;
      const message = await applyUnblock(gh, {
        issue,
        itemId: item?.itemId ?? null,
        host: cfg.host,
      });
      log("info", "unblocked", { issue });
      // Same reason as the owner gate: reflect it locally so the button goes now (#204), and wake
      // the loop so the next tick can actually pick the issue up.
      const board = store.get().board;
      if (board) store.patch({ board: applyUnblockToBoard(board, issue) });
      controller.wake();
      return message;
    },
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
}
