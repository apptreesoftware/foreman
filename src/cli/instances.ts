import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { type Instance, instanceFor, listInstances, writeInstanceConfig } from "../instance.ts";

const FIRST_PORT = 8090;

const portError = (got: unknown) =>
  `--web-port must be a whole number from 1 to 65535, got ${JSON.stringify(got)}`;

const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * `--web-port` as typed. `Number()` alone turns a typo into NaN, which JSON.stringify writes to
 * foreman.json as `null` — an instance every later `loadConfig` rejects — so it is rejected here,
 * quoting the input rather than the coerced value.
 */
export function parseWebPort(input: string): number {
  const p = Number(input);
  if (!validPort(p)) throw new Error(portError(input));
  return p;
}

/** The instance's configured web port; null when its foreman.json cannot be read at all. */
function portOf(i: Instance): number | null {
  try {
    const p = (JSON.parse(readFileSync(i.configPath, "utf8")) as { webPort?: unknown }).webPort;
    return typeof p === "number" ? p : FIRST_PORT;
  } catch {
    return null;
  }
}

export function addInstance(o: {
  name: string;
  repo: string;
  repoDir: string;
  host?: string;
  webPort?: number;
  home?: string;
}): Instance {
  const i = instanceFor(o.name, o.home);
  if (existsSync(i.configPath)) throw new Error(`instance "${o.name}" exists (${i.configPath})`);
  const taken = new Map<number, string>();
  for (const other of listInstances(o.home)) {
    const p = portOf(other);
    if (p !== null) taken.set(p, other.name);
  }
  let webPort = o.webPort;
  if (webPort === undefined) {
    webPort = FIRST_PORT;
    while (taken.has(webPort)) webPort++;
  } else {
    // NaN would defeat the duplicate check below as well as the config it writes, so it stops here.
    if (!validPort(webPort)) throw new Error(portError(webPort));
    if (taken.has(webPort))
      throw new Error(`web port ${webPort} is used by instance "${taken.get(webPort)}"`);
  }
  const host =
    o.host ??
    hostname()
      .split(".")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-") ??
    "mac";
  writeInstanceConfig(i, { repo: o.repo, host, repoDir: o.repoDir, webPort });
  return i;
}

export function formatList(
  instances: Instance[],
  detail: (i: Instance) => { repo: string; daemon: string; port: number | null },
): string {
  if (instances.length === 0)
    return "no instances; run: foreman add <name> --repo <owner/repo> --repo-dir <path>\n";
  return `${instances
    .map((i) => {
      const d = detail(i);
      return `${i.name.padEnd(16)} ${d.repo.padEnd(32)} ${d.daemon.padEnd(8)} :${d.port ?? "-"}`;
    })
    .join("\n")}\n`;
}
