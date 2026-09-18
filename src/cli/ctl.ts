import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ctlCap, ctlGo, ctlModel, ctlStop } from "../ctl.ts";
import { realExec } from "../exec.ts";
import { GitHub } from "../github.ts";
import type { Instance } from "../instance.ts";
import { launchdInstalled, launchdUid } from "../launchd-status.ts";
import { buildSnapshot, realCtx } from "../loop.ts";
import { describeNext, formatNext } from "../next.ts";
import type { InterruptInput } from "../release.ts";
import { ledgerInterrupt } from "../release.ts";
import { loadRepoConfigSafe } from "../repo-config.ts";
import { readSessions } from "../sessions.ts";
import { readState } from "../state-file.ts";
import { describeStatus, formatStatus } from "../status.ts";
import { launchdLabel } from "./launchd.ts";

export type CtlCommand = "status" | "next" | "stop" | "abort" | "go" | "model" | "cap";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runCtl(
  instance: Instance,
  cmd: CtlCommand,
  o: { watch: boolean; json: boolean; value: string | null },
): Promise<void> {
  const uid = launchdUid();
  const label = launchdLabel(instance.name);
  const STATE_DIR = instance.dir;
  const stopFile = join(STATE_DIR, "STOP");
  const cfg = loadConfig(instance.configPath);
  // A mistyped `.foreman/config.json` must not take `status`, `stop`, `abort` or `go` away: those
  // are the operator's controls, and they are most needed exactly when something is wrong. Warn
  // once, name the file, and carry on with the defaults.
  const { config: repo, error: repoError } = loadRepoConfigSafe(cfg.repoDir);
  if (repoError) process.stderr.write(`warning: ${repoError}; using defaults\n`);

  function statusReport() {
    return describeStatus({
      state: readState(STATE_DIR),
      now: new Date().toISOString(),
      pidAlive,
      stopPresent: existsSync(stopFile),
      launchdInstalled: false, // filled in below for the one-shot form
      sessions: readSessions(STATE_DIR),
      maxSessionsPerDay: cfg.maxSessionsPerDay,
      wallClockMinutes: cfg.wallClockMinutes,
      host: cfg.host,
      stallMinutes: cfg.stallMinutes,
      repo: cfg.repo,
      configModel: cfg.model,
      modelChoices: repo.models,
    });
  }

  async function status(): Promise<void> {
    const installed = await launchdInstalled(label);
    const render = () => {
      const r = { ...statusReport(), launchdInstalled: installed };
      return o.json ? `${JSON.stringify(r, null, 2)}\n` : formatStatus(r);
    };
    if (!o.watch) {
      process.stdout.write(render());
      return;
    }
    for (;;) {
      process.stdout.write(`\x1b[2J\x1b[H${render()}\n(watching; ctrl-c to exit)\n`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function next(): Promise<void> {
    if (cfg.project === undefined)
      throw new Error(`project is not set; run foreman -p ${instance.name} init`);
    const gh = new GitHub(
      { repo: cfg.repo, owner: cfg.owner, project: cfg.project },
      realExec,
      true,
    );
    const defaultBranch = await gh.defaultBranch();
    const ctx = realCtx(
      cfg,
      gh,
      await gh.viewerLogin(),
      true,
      STATE_DIR,
      {
        signal: new AbortController().signal,
        stopMode: () => null,
        state: null,
      },
      repo,
      defaultBranch,
      instance.name,
    );
    process.stdout.write(formatNext(describeNext(await buildSnapshot(ctx), repo)));
  }

  /** POSTs to the running daemon's page, which owns state.json while it lives. */
  async function postToDaemon(path: string, body: unknown, fallback: string): Promise<string> {
    const r = await fetch(`http://127.0.0.1:${cfg.webPort}/api/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok: boolean; message?: string; error?: string };
    if (!r.ok || !j.ok) throw new Error(j.error ?? `daemon refused (${r.status})`);
    return j.message ?? fallback;
  }

  const deps = {
    stateDir: STATE_DIR,
    host: cfg.host,
    login: "",
    now: () => new Date().toISOString(),
    pidAlive,
    kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    touchStop: () => writeFileSync(stopFile, ""),
    removeStop: () => {
      if (existsSync(stopFile)) unlinkSync(stopFile);
    },
    launchdInstalled: () => launchdInstalled(label),
    launchdKickstart: async () => {
      await realExec("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
    },
    release: async (i: InterruptInput) => {
      const gh = new GitHub(
        { repo: cfg.repo, owner: cfg.owner, project: cfg.project },
        realExec,
        false,
      );
      return ledgerInterrupt(gh, { ...i, login: i.login || (await gh.viewerLogin()) });
    },
    out: (line: string) => process.stdout.write(`${line}\n`),
    startCommand: `foreman -p ${instance.name} start`,
    configModel: cfg.model,
    configCap: cfg.maxSessionsPerDay,
    postModel: (model: string) => postToDaemon("model", { model }, `next session runs ${model}`),
    postCap: (maxSessionsPerDay: number | null) =>
      postToDaemon(
        "cap",
        { maxSessionsPerDay },
        `cap is now ${maxSessionsPerDay ?? "the configured value"}`,
      ),
  };

  switch (cmd) {
    case "status":
      await status();
      break;
    case "next":
      await next();
      break;
    case "stop":
      await ctlStop(deps, "stop");
      break;
    case "abort":
      await ctlStop(deps, "abort");
      break;
    case "go":
      await ctlGo(deps);
      break;
    case "model":
      await ctlModel(deps, o.value);
      break;
    case "cap":
      // A non-numeric value other than `default` becomes NaN, which ctlCap refuses by name.
      await ctlCap(deps, o.value === null || o.value === "default" ? o.value : Number(o.value));
      break;
  }
}
