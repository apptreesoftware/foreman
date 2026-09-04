import { realExec } from "./exec.ts";

export const LAUNCHD_LABEL = "com.tonetonic.foreman";

/** The user id launchd agents run under; falls back to macOS's first-user id when unavailable. */
export function launchdUid(): number {
  return process.getuid?.() ?? 501;
}

/** True when the launchd agent is bootstrapped, whether or not it is currently running. */
export async function launchdInstalled(): Promise<boolean> {
  const r = await realExec("launchctl", ["print", `gui/${launchdUid()}/${LAUNCHD_LABEL}`]);
  return r.code === 0;
}
