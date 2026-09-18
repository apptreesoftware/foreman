import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realExec } from "../exec.ts";
import type { Instance } from "../instance.ts";
import { launchdInstalled, launchdUid } from "../launchd-status.ts";

export function launchdLabel(name: string): string {
  return `com.apptreesoftware.foreman.${name}`;
}

export function plistPath(label: string, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * The plist's `PATH`. launchd starts from a clean environment, so this is the whole of it: the
 * standard locations, plus the directory of the `node` that ran `launchd install`. Without that
 * last entry an `nvm`-only Mac has no `node` or `npx` on any of the others, and every role session
 * the daemon spawns would fail to find them even though the daemon itself is running.
 */
export function plistEnvPath(home = homedir(), execPath = process.execPath): string {
  const dirs = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const nodeDir = dirname(execPath);
  if (!dirs.includes(nodeDir)) dirs.push(nodeDir);
  return dirs.join(":");
}

export function renderPlist(o: {
  label: string;
  /** The interpreter, spelled out: launchd posix_spawns argv[0] itself and resolves no shebang. */
  node: string;
  foremanBin: string;
  instance: string;
  stateDir: string;
  home: string;
  path: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(o.node)}</string><string>${esc(o.foremanBin)}</string><string>-p</string><string>${esc(o.instance)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${esc(o.home)}</string><key>PATH</key><string>${esc(o.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(join(o.stateDir, "logs", "foreman.out.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.stateDir, "logs", "foreman.err.log"))}</string>
</dict>
</plist>
`;
}

/** The billing env vars never reach the plist: launchd starts from a clean environment, and `runDaemon` refuses to start if one is set. */
export async function launchdInstall(i: Instance, foremanBin: string): Promise<string> {
  const label = launchdLabel(i.name);
  mkdirSync(join(i.dir, "logs"), { recursive: true });
  const p = plistPath(label);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    p,
    renderPlist({
      label,
      // The node running this command, by absolute path: a bare `foreman` would leave launchd to
      // exec a file that may not be executable and a `#!/usr/bin/env node` it cannot resolve from
      // the plist's PATH. A node moved by `nvm use` needs `launchd install` run again.
      node: process.execPath,
      foremanBin,
      instance: i.name,
      stateDir: i.dir,
      home: homedir(),
      path: plistEnvPath(),
    }),
  );
  if (await launchdInstalled(label))
    await realExec("launchctl", ["bootout", `gui/${launchdUid()}/${label}`]);
  const r = await realExec("launchctl", ["bootstrap", `gui/${launchdUid()}`, p]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  return `installed ${label} (${p})`;
}

export async function launchdUninstall(i: Instance): Promise<string> {
  const label = launchdLabel(i.name);
  if (await launchdInstalled(label))
    await realExec("launchctl", ["bootout", `gui/${launchdUid()}/${label}`]);
  const p = plistPath(label);
  if (existsSync(p)) unlinkSync(p);
  return `removed ${label}`;
}
