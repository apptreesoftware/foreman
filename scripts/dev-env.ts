import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type StackPorts, stackPorts } from "../src/ports.ts";

export function parseStatusEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/**
 * `ports` defaults to the environment's stack: the owner's dev ports normally, the role ports
 * when the foreman set `TONE_WEB_PORT`/`TONE_API_PORT` for an isolated session (#228), and the
 * CI `e2e` job's ports when it sets the same variables. The Supabase URL comes from
 * `supabase status` either way, which reads the config in this worktree.
 */
export function renderEnvFiles(
  v: Record<string, string>,
  ports: StackPorts = stackPorts(),
): { api: string; web: string } {
  const url = v.API_URL ?? ports.supabaseUrl;
  const anon = v.ANON_KEY ?? v.PUBLISHABLE_KEY;
  const service = v.SERVICE_ROLE_KEY ?? v.SECRET_KEY;
  if (!anon)
    throw new Error(
      "supabase status did not report ANON_KEY/PUBLISHABLE_KEY; is Supabase running?",
    );
  if (!service) throw new Error("supabase status did not report SERVICE_ROLE_KEY/SECRET_KEY");
  return {
    // apps/api holds the anon key as well as the service-role one: the invites module sends
    // magic links through an anon-key client, which the admin API cannot do (#17).
    api: `PORT=${ports.api}\nWEB_ORIGIN=${ports.webUrl}\nSUPABASE_URL=${url}\nSUPABASE_SERVICE_ROLE_KEY=${service}\nSUPABASE_ANON_KEY=${anon}\n`,
    web: `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\nVITE_API_URL=${ports.apiUrl}\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, "..", "..", "..");
  // Run from this worktree's `packages/db`, so the Supabase project named in its `config.toml`
  // is the one reported — the isolated `tone_tonic_val` stack inside a role session.
  const text = execFileSync("supabase", ["status", "-o", "env"], {
    cwd: join(root, "packages", "db"),
    encoding: "utf8",
  });
  const ports = stackPorts();
  const files = renderEnvFiles(parseStatusEnv(text), ports);
  writeFileSync(join(root, "apps", "api", ".env.local"), files.api);
  writeFileSync(join(root, "apps", "web", ".env.local"), files.web);
  process.stdout.write(
    `wrote apps/api/.env.local and apps/web/.env.local (supabase ${parseStatusEnv(text).API_URL ?? ports.supabaseUrl}, web :${ports.web}, api :${ports.api})\n`,
  );
}
