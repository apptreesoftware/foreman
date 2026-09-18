import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stackPorts } from "../src/ports.ts";
import { waitForHttp } from "./http.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const stateDir = process.env.FOREMAN_STATE_DIR ?? join(homedir(), ".foreman");
const pidFile = join(stateDir, "serve.json");
const logDir = join(stateDir, "logs");

/**
 * The URLs to wait on and the env each server needs. Dev ports normally; the role ports when
 * the foreman set `TONE_WEB_PORT`/`TONE_API_PORT` for an isolated session (#228), and the same
 * override is how CI's e2e job runs its own servers — either way they cannot collide with the
 * ports the owner needs for `pnpm dev` on the same Mac.
 */
/**
 * The local development token-encryption key, the same value `apps/api/.env.example` carries.
 * Not a secret: it seals the fixture Zoom account's tokens in a served api and nothing else.
 */
export const DEV_INTEGRATIONS_KEY = "OmWZjvgZmEF6ik9VeU3NcpHtZzsi68iz6/8LsE+9uGg=";

export function serveConfig(env: NodeJS.ProcessEnv): {
  webUrl: string;
  apiHealthUrl: string;
  apiEnv: Record<string, string>;
  webEnv: Record<string, string>;
} {
  const ports = stackPorts(env);
  return {
    webUrl: ports.webUrl,
    apiHealthUrl: `${ports.apiUrl}/health`,
    apiEnv: {
      PORT: String(ports.api),
      WEB_ORIGIN: ports.webUrl,
      // A served api never has ANTHROPIC_API_KEY (stripped below), so it answers the organize
      // job from the recorded fixture (#43); without this, `validateEnv` refuses to boot a
      // worker that would need the key. Set AI_FIXTURE yourself to override.
      AI_FIXTURE: env.AI_FIXTURE ?? "1",
      // A served api has no Zoom app either, and `.env.local` (from dev-env) carries neither
      // of these, so Zoom runs from its fixture under the dev key (#95). Set either to override.
      ZOOM_FIXTURE: env.ZOOM_FIXTURE ?? "1",
      INTEGRATIONS_KEY: env.INTEGRATIONS_KEY ?? DEV_INTEGRATIONS_KEY,
    },
    webEnv: { TONE_WEB_PORT: String(ports.web) },
  };
}

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
  const cfg = serveConfig(process.env);
  const pids = {
    api: launch("api", "@tone/api", cfg.apiEnv),
    web: launch("web", "@tone/web", cfg.webEnv),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(pidFile, JSON.stringify(pids));
  const [apiOk, webOk] = await Promise.all([
    waitForHttp(cfg.apiHealthUrl),
    waitForHttp(cfg.webUrl),
  ]);
  if (!apiOk || !webOk) {
    await stop();
    throw new Error(
      `servers did not come up (api=${apiOk} web=${webOk}); see ${logDir}/serve-*.log`,
    );
  }
  process.stdout.write(`api ${cfg.apiHealthUrl} ok, web ${cfg.webUrl} ok\n`);
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
  const cfg = serveConfig(process.env);
  const [a, w] = await Promise.all([
    waitForHttp(cfg.apiHealthUrl, { timeoutMs: 1500 }),
    waitForHttp(cfg.webUrl, { timeoutMs: 1500 }),
  ]);
  process.stdout.write(
    `api=${a ? "up" : "down"} web=${w ? "up" : "down"} pidfile=${existsSync(pidFile)}\n`,
  );
}

// Only dispatch when run as a script: serve.test.ts imports serveConfig from here.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "start") await start();
  else if (cmd === "stop") await stop();
  else if (cmd === "status") await status();
  else {
    process.stderr.write("usage: serve start|stop|status\n");
    process.exit(2);
  }
}
