import { parseArgs } from "node:util";
import { loadConfig, STATE_DIR } from "./config.ts";
import { realExec } from "./exec.ts";
import { log } from "./log.ts";
import { checkEnv, preflight } from "./preflight.ts";

const bad = checkEnv(process.env);
if (bad) {
  process.stderr.write(
    `foreman: ${bad} is set. Unset it; the foreman only runs on subscription auth.\n`,
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    config: { type: "string" },
  },
});

const cfg = loadConfig(values.config);
const result = await preflight(cfg, {
  env: process.env,
  exec: realExec,
  stateDir: STATE_DIR,
  now: new Date(),
});
if (!result.ok) {
  log("error", "preflight failed", { reason: result.reason });
  process.exit(1);
}
log("info", "preflight ok", {
  host: cfg.host,
  once: values.once,
  dryRun: values["dry-run"],
  warnings: result.warnings,
});
