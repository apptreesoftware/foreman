#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runEpicNew } from "../bootstrap/epic.ts";
import { runInit } from "../bootstrap/init.ts";
import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import type { Instance } from "../instance.ts";
import { listInstances, resolveInstance } from "../instance.ts";
import { launchdInstalled } from "../launchd-status.ts";
import { readState } from "../state-file.ts";
import { parseCli, USAGE } from "./args.ts";
import { runCtl } from "./ctl.ts";
import { runDaemon } from "./daemon.ts";
import { runHookCommand } from "./hooks.ts";
import { addInstance, formatList } from "./instances.ts";
import { launchdInstall, launchdLabel, launchdUninstall } from "./launchd.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawns `foreman -p <name> run` detached, with both streams appended to the instance's log. */
function start(instance: Instance, out: (s: string) => void): number {
  const st = readState(instance.dir);
  if (st && st.exitedAt === null && pidAlive(st.pid)) {
    out(`daemon already running (pid ${st.pid}); use foreman -p ${instance.name} restart`);
    return 1;
  }
  mkdirSync(join(instance.dir, "logs"), { recursive: true });
  const logFile = join(instance.dir, "logs", "foreman.log");
  const log = openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1] as string, "-p", instance.name, "run"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  out(`started foreman ${instance.name} (pid ${child.pid}); log: ${logFile}`);
  return 0;
}

/**
 * Stop, then start. `ctl stop` returns only once the daemon has posted its ledger comment and
 * exited, so the start that follows finds the port free and state.json consistent. The STOP file
 * that stop deliberately leaves is cleared here — `restart` means "come back up", so the new
 * daemon must not park on it. A plain `stop` still leaves it.
 */
async function restart(instance: Instance, out: (s: string) => void): Promise<number> {
  await runCtl(instance, "stop", { watch: false, json: false, value: null });
  const stopFile = join(instance.dir, "STOP");
  if (existsSync(stopFile)) unlinkSync(stopFile);
  return start(instance, out);
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const out = (s: string) => process.stdout.write(`${s}\n`);
  if (cli.cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cli.cmd === "add") {
    const [name] = cli.positionals;
    const repo = cli.args.repo;
    const repoDir = cli.args["repo-dir"];
    if (!name || typeof repo !== "string" || typeof repoDir !== "string")
      throw new Error(
        "usage: foreman add <name> --repo <owner/repo> --repo-dir <path> [--host <h>] [--web-port <n>]",
      );
    const i = addInstance({
      name,
      repo,
      repoDir,
      host: typeof cli.args.host === "string" ? cli.args.host : undefined,
      webPort: typeof cli.args["web-port"] === "string" ? Number(cli.args["web-port"]) : undefined,
    });
    out(`added ${i.name}: ${i.configPath}\nnext: foreman -p ${i.name} init`);
    return 0;
  }
  if (cli.cmd === "list") {
    process.stdout.write(
      formatList(listInstances(), (i) => {
        const s = readState(i.dir);
        let repo = "?";
        let port: number | null = null;
        try {
          const c = loadConfig(i.configPath);
          repo = c.repo;
          port = c.webPort;
        } catch {
          // An unreadable or invalid foreman.json still gets a row, so `list` shows the instance.
        }
        return { repo, daemon: s && pidAlive(s.pid) ? "running" : "stopped", port };
      }),
    );
    return 0;
  }
  const instance = resolveInstance({ flag: cli.instance, env: process.env, cwd: process.cwd() });
  const s = (k: string) => (typeof cli.args[k] === "string" ? (cli.args[k] as string) : null);
  const b = (k: string) => cli.args[k] === true;
  switch (cli.cmd) {
    case "init":
      return runInit(instance, out);
    case "epic": {
      if (cli.positionals[0] !== "new")
        throw new Error(
          "usage: foreman epic new --title <t> --phase <n> --spec <path> [--agent-ready]",
        );
      const title = s("title");
      const phase = s("phase");
      const spec = s("spec");
      if (!title || !phase || !spec) throw new Error("--title, --phase and --spec are required");
      return runEpicNew(
        instance,
        { title, phase: Number(phase), spec, agentReady: b("agent-ready") },
        out,
      );
    }
    case "run":
      return runDaemon(instance, { once: b("once"), dryRun: b("dry-run") });
    case "start":
      return start(instance, out);
    case "restart":
      return restart(instance, out);
    case "stop":
    case "abort":
    case "go":
    case "status":
    case "next":
    case "model":
    case "cap":
      await runCtl(instance, cli.cmd, {
        watch: b("watch"),
        json: b("json"),
        value: cli.positionals[0] ?? null,
      });
      return 0;
    case "logs": {
      const file = join(instance.dir, "logs", "foreman.log");
      if (!existsSync(file)) {
        out(`no log yet at ${file}`);
        return 1;
      }
      const r = spawn("tail", b("f") ? ["-f", file] : ["-n", "200", file], { stdio: "inherit" });
      return new Promise((resolve) => r.on("close", (c) => resolve(c ?? 0)));
    }
    case "page": {
      const cfg = loadConfig(instance.configPath);
      await realExec("open", [`http://127.0.0.1:${cfg.webPort}`]);
      return 0;
    }
    case "launchd": {
      const verb = cli.positionals[0];
      if (verb === "install") {
        out(await launchdInstall(instance, process.argv[1] as string));
        return 0;
      }
      if (verb === "uninstall") {
        out(await launchdUninstall(instance));
        return 0;
      }
      if (verb === "status") {
        const label = launchdLabel(instance.name);
        out((await launchdInstalled(label)) ? `${label} installed` : "not installed");
        return 0;
      }
      throw new Error("usage: foreman launchd install | uninstall | status");
    }
    case "hooks": {
      if (cli.positionals[0] !== "run" || !cli.positionals[1])
        throw new Error("usage: foreman hooks run <name>");
      return runHookCommand(instance, cli.positionals[1]);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`foreman: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
