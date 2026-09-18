import { realExec } from "./exec.ts";

/** The user id launchd agents run under; falls back to macOS's first-user id when unavailable. */
export function launchdUid(): number {
  return process.getuid?.() ?? 501;
}

/** True when the named launchd agent is bootstrapped, whether or not it is currently running. */
export async function launchdInstalled(label: string): Promise<boolean> {
  const r = await realExec("launchctl", ["print", `gui/${launchdUid()}/${label}`]);
  return r.code === 0;
}
