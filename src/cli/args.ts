import { parseArgs } from "node:util";

export const COMMANDS = [
  "add",
  "list",
  "init",
  "epic",
  "run",
  "start",
  "stop",
  "restart",
  "abort",
  "go",
  "status",
  "next",
  "model",
  "cap",
  "logs",
  "page",
  "launchd",
  "hooks",
  "help",
] as const;
export type Command = (typeof COMMANDS)[number];

export interface Cli {
  instance?: string;
  cmd: Command;
  args: Record<string, string | boolean>;
  positionals: string[];
}

export const USAGE = `foreman — one daemon per repository, driven by claude -p

  foreman add <name> --repo <owner/repo> --repo-dir <path> [--host <h>] [--web-port <n>]
  foreman list
  foreman [-p <name>] init
  foreman [-p <name>] epic new --title <t> --phase <n> --spec <path> [--agent-ready]
  foreman [-p <name>] run [--once] [--dry-run]     run the daemon in the foreground
  foreman [-p <name>] start | stop | abort | go | restart
  foreman [-p <name>] status [--watch] [--json] | next
  foreman [-p <name>] model [<name>|default] | cap [<n>|default]
  foreman [-p <name>] logs [-f] | page
  foreman [-p <name>] launchd install | uninstall | status
  foreman [-p <name>] hooks run <preflight|session-env|before-session|after-session>

The instance is -p, else FOREMAN_INSTANCE, else the one whose repoDir contains the cwd, else the only one.
`;

const OPTIONS = {
  instance: { type: "string", short: "p" },
  repo: { type: "string" },
  "repo-dir": { type: "string" },
  host: { type: "string" },
  "web-port": { type: "string" },
  title: { type: "string" },
  phase: { type: "string" },
  spec: { type: "string" },
  "agent-ready": { type: "boolean" },
  once: { type: "boolean" },
  "dry-run": { type: "boolean" },
  watch: { type: "boolean" },
  json: { type: "boolean" },
  f: { type: "boolean" },
} as const;

export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [cmd, ...rest] = positionals;
  if (!cmd) return { cmd: "help", args: {}, positionals: [] };
  if (!(COMMANDS as readonly string[]).includes(cmd))
    throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  const { instance, ...args } = values;
  const defined = Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined),
  ) as Record<string, string | boolean>;
  return { instance, cmd: cmd as Command, args: defined, positionals: rest };
}
