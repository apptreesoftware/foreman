import { parseArgs } from "node:util";

export const CTL_COMMANDS = ["status", "next", "stop", "abort", "go", "model", "cap"] as const;
export type CtlCommand = (typeof CTL_COMMANDS)[number];
export const USAGE =
  "usage: ctl status [--watch] [--json] | next | stop | abort | go | model [<name>] | cap [<n>|default]  [-p <instance>]";

export function parseCtlArgs(argv: string[]): {
  cmd: CtlCommand;
  watch: boolean;
  json: boolean;
  instance: string | undefined;
  /** For `model` and `cap`: the value to set, or null to just report the current one. */
  value: string | null;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      watch: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      instance: { type: "string", short: "p" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || !(CTL_COMMANDS as readonly string[]).includes(cmd)) throw new Error(USAGE);
  return {
    cmd: cmd as CtlCommand,
    watch: values.watch,
    json: values.json,
    instance: values.instance,
    value: positionals[1] ?? null,
  };
}
