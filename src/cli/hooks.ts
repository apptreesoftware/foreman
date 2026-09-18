import { loadConfig } from "../config.ts";
import { realExec } from "../exec.ts";
import { HOOK_NAMES, type HookName, runHook } from "../hooks.ts";
import type { Instance } from "../instance.ts";

export async function runHookCommand(instance: Instance, name: string): Promise<number> {
  if (!(HOOK_NAMES as readonly string[]).includes(name))
    throw new Error(`unknown hook "${name}"; one of ${HOOK_NAMES.join(", ")}`);
  const cfg = loadConfig(instance.configPath);
  const r = await runHook(
    name as HookName,
    cfg.repoDir,
    { instance: instance.name, stateDir: instance.dir, repoDir: cfg.repoDir },
    realExec,
    { log: (l) => process.stderr.write(`${l}\n`) },
  );
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (!r.ran) process.stderr.write(`no executable ${name} hook in ${cfg.repoDir}/.foreman/hooks\n`);
  return r.code;
}
