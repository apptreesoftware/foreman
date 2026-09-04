import { parseArgs } from "node:util";

export const CTL_COMMANDS = ["status", "next", "stop", "abort", "go"] as const;
export type CtlCommand = (typeof CTL_COMMANDS)[number];
export const USAGE =
  "usage: ctl status [--watch] [--json] | next | stop | abort | go  [--config <path>]";

export function parseCtlArgs(argv: string[]): {
  cmd: CtlCommand;
  watch: boolean;
  json: boolean;
  config: string | undefined;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      watch: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      config: { type: "string" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || !(CTL_COMMANDS as readonly string[]).includes(cmd)) throw new Error(USAGE);
  return { cmd: cmd as CtlCommand, watch: values.watch, json: values.json, config: values.config };
}
