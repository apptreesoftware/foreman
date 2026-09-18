import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function renderPlist(o: {
  label: string;
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
  <array><string>${esc(o.foremanBin)}</string><string>-p</string><string>${esc(o.instance)}</string><string>run</string></array>
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
      foremanBin,
      instance: i.name,
      stateDir: i.dir,
      home: homedir(),
      path: `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
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
