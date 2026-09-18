import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Every instance lives at `~/.foreman/<name>/`; the name is what `-p` and launchd use. */
export const FOREMAN_HOME = join(homedir(), ".foreman");
export const CONFIG_FILENAME = "foreman.json";

export interface Instance {
  name: string;
  /** The state dir: state.json, sessions.log, STOP, logs/, activity/, artifacts/ all live here. */
  dir: string;
  configPath: string;
}

export class InstanceError extends Error {}

export function instanceDir(name: string, home = FOREMAN_HOME): string {
  return join(home, name);
}

export function instanceFor(name: string, home = FOREMAN_HOME): Instance {
  const dir = instanceDir(name, home);
  return { name, dir, configPath: join(dir, CONFIG_FILENAME) };
}

/** `readdirSync`, treating an unreadable dir (permissions, a concurrent delete, ...) as empty. */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function listInstances(home = FOREMAN_HOME): Instance[] {
  if (!existsSync(home)) return [];
  return readEntries(home)
    .filter((d) => d.isDirectory() && existsSync(join(home, d.name, CONFIG_FILENAME)))
    .map((d) => instanceFor(d.name, home))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `resolve()`, canonicalised through symlinks when the path exists on disk. */
function canonicalise(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // Doesn't exist yet (e.g. a configured repoDir that has not been cloned) — compare as given.
    return resolved;
  }
}

function within(child: string, parent: string): boolean {
  const c = canonicalise(child);
  const p = canonicalise(parent);
  return c === p || c.startsWith(p + sep);
}

/** `repoDir` from an instance's config, or null when the file is unreadable. */
export function repoDirOfInstance(i: Instance): string | null {
  try {
    const raw = JSON.parse(readFileSync(i.configPath, "utf8")) as { repoDir?: unknown };
    if (typeof raw.repoDir !== "string") return null;
    return raw.repoDir.startsWith("~/") ? join(homedir(), raw.repoDir.slice(2)) : raw.repoDir;
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  flag?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  repoDirOf?: (i: Instance) => string | null;
}

/**
 * Spec §4.2: `-p`, then `FOREMAN_INSTANCE`, then the instance whose repoDir contains cwd, then
 * the sole instance. `FOREMAN_CONFIG` is the escape hatch for a config outside the layout.
 */
export function resolveInstance(o: ResolveOptions): Instance {
  const home = o.home ?? FOREMAN_HOME;
  const repoDirOf = o.repoDirOf ?? repoDirOfInstance;
  if (o.env.FOREMAN_CONFIG) {
    const configPath = resolve(o.env.FOREMAN_CONFIG);
    const dir = dirname(configPath);
    return { name: basename(dir), dir, configPath };
  }
  const all = listInstances(home);
  const names = all.map((i) => i.name).join(", ");
  const byName = (name: string): Instance => {
    const hit = all.find((i) => i.name === name);
    if (!hit)
      throw new InstanceError(
        `no instance "${name}" under ${home}${all.length ? ` (have: ${names})` : ""}`,
      );
    return hit;
  };
  if (o.flag) return byName(o.flag);
  if (o.env.FOREMAN_INSTANCE) return byName(o.env.FOREMAN_INSTANCE);
  const byCwd = all.find((i) => {
    const repoDir = repoDirOf(i);
    return repoDir !== null && within(o.cwd, repoDir);
  });
  if (byCwd) return byCwd;
  if (all.length === 1) return all[0] as Instance;
  if (all.length === 0)
    throw new InstanceError(
      `no instances under ${home}; run: foreman add <name> --repo <owner/repo> --repo-dir <path>`,
    );
  throw new InstanceError(`several instances (${names}); pass -p <name> or set FOREMAN_INSTANCE`);
}

export function writeInstanceConfig(i: Instance, cfg: Record<string, unknown>): void {
  mkdirSync(i.dir, { recursive: true });
  writeFileSync(i.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}
