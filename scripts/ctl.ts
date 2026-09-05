import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig, STATE_DIR } from "../src/config.ts";
import { ctlCap, ctlGo, ctlModel, ctlStop } from "../src/ctl.ts";
import { realExec } from "../src/exec.ts";
import { GitHub } from "../src/github.ts";
import { LAUNCHD_LABEL, launchdInstalled, launchdUid } from "../src/launchd-status.ts";
import { buildSnapshot, realCtx } from "../src/loop.ts";
import { describeNext, formatNext } from "../src/next.ts";
import type { InterruptInput } from "../src/release.ts";
import { ledgerInterrupt } from "../src/release.ts";
import { readSessions } from "../src/sessions.ts";
import { readState } from "../src/state-file.ts";
import { describeStatus, formatStatus } from "../src/status.ts";
import { parseCtlArgs, USAGE } from "./ctl-args.ts";

const uid = launchdUid();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const stopFile = join(STATE_DIR, "STOP");

let args: ReturnType<typeof parseCtlArgs>;
try {
  args = parseCtlArgs(process.argv.slice(2));
} catch {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const cfg = loadConfig(args.config);

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
  });
}

async function status(): Promise<void> {
  const installed = await launchdInstalled();
  const render = () => {
    const r = { ...statusReport(), launchdInstalled: installed };
    return args.json ? `${JSON.stringify(r, null, 2)}\n` : formatStatus(r);
  };
  if (!args.watch) {
    process.stdout.write(render());
    return;
  }
  for (;;) {
    process.stdout.write(`\x1b[2J\x1b[H${render()}\n(watching; ctrl-c to exit)\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function next(): Promise<void> {
  const gh = new GitHub({ repo: cfg.repo, owner: cfg.owner, project: cfg.project }, realExec, true);
  const ctx = realCtx(cfg, gh, await gh.viewerLogin(), true, STATE_DIR, {
    signal: new AbortController().signal,
    stopMode: () => null,
    state: null,
  });
  process.stdout.write(formatNext(describeNext(await buildSnapshot(ctx))));
}

function ghForRelease() {
  return new GitHub({ repo: cfg.repo, owner: cfg.owner, project: cfg.project }, realExec, false);
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
  launchdInstalled,
  launchdKickstart: async () => {
    await realExec("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]);
  },
  release: async (i: InterruptInput) => {
    const gh = ghForRelease();
    return ledgerInterrupt(gh, { ...i, login: i.login || (await gh.viewerLogin()) });
  },
  out: (line: string) => process.stdout.write(`${line}\n`),
  startCommand: `pnpm --filter @tone/foreman start   (config: ${args.config ?? process.env.TONE_FOREMAN_CONFIG ?? DEFAULT_CONFIG_PATH})`,
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

switch (args.cmd) {
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
    await ctlModel(deps, args.value);
    break;
  case "cap":
    // A non-numeric value other than `default` becomes NaN, which ctlCap refuses by name.
    await ctlCap(
      deps,
      args.value === null || args.value === "default" ? args.value : Number(args.value),
    );
    break;
}
