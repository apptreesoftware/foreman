import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stackPorts } from "../src/ports.ts";
import { waitForHttp } from "./http.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const stateDir = join(homedir(), ".tone_tonic");
const pidFile = join(stateDir, "serve.json");
const logDir = join(stateDir, "logs");
// Dev ports normally; the role ports when the foreman set TONE_WEB_PORT/TONE_API_PORT for an
// isolated session, so a validator never takes the ports the owner needs for `pnpm dev` (#228).
const ports = stackPorts();
const WEB = ports.webUrl;
const API = `${ports.apiUrl}/health`;
const STRIPPED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_AWS_API_KEY",
];

function launch(name: string, filter: string, extraEnv: Record<string, string> = {}): number {
  mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, `serve-${name}.log`), "a");
  const env = { ...process.env, ...extraEnv };
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  const child = spawn("pnpm", ["--filter", filter, "dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${name}`);
  return child.pid;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function start(): Promise<void> {
  if (existsSync(pidFile)) await stop();
  const pids = {
    api: launch("api", "@tone/api", { PORT: String(ports.api), WEB_ORIGIN: WEB }),
    web: launch("web", "@tone/web", { TONE_WEB_PORT: String(ports.web) }),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(pidFile, JSON.stringify(pids));
  const [apiOk, webOk] = await Promise.all([waitForHttp(API), waitForHttp(WEB)]);
  if (!apiOk || !webOk) {
    await stop();
    throw new Error(
      `servers did not come up (api=${apiOk} web=${webOk}); see ${logDir}/serve-*.log`,
    );
  }
  process.stdout.write(`api ${API} ok, web ${WEB} ok\n`);
}

async function stop(): Promise<void> {
  if (!existsSync(pidFile)) return;
  try {
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { api: number; web: number };
    killGroup(pids.api);
    killGroup(pids.web);
  } catch (e) {
    process.stderr.write(
      `warning: ${pidFile} is unreadable or corrupt (${(e as Error).message}); removing it\n`,
    );
  }
  unlinkSync(pidFile);
  await new Promise((r) => setTimeout(r, 1500));
  process.stdout.write("stopped\n");
}

async function status(): Promise<void> {
  const [a, w] = await Promise.all([
    waitForHttp(API, { timeoutMs: 1500 }),
    waitForHttp(WEB, { timeoutMs: 1500 }),
  ]);
  process.stdout.write(
    `api=${a ? "up" : "down"} web=${w ? "up" : "down"} pidfile=${existsSync(pidFile)}\n`,
  );
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") await stop();
else if (cmd === "status") await status();
else {
  process.stderr.write("usage: serve start|stop|status\n");
  process.exit(2);
}
