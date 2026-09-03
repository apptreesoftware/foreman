import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function parseStatusEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

export function renderEnvFiles(v: Record<string, string>): { api: string; web: string } {
  const url = v.API_URL ?? "http://127.0.0.1:55321";
  const anon = v.ANON_KEY ?? v.PUBLISHABLE_KEY;
  const service = v.SERVICE_ROLE_KEY ?? v.SECRET_KEY;
  if (!anon)
    throw new Error(
      "supabase status did not report ANON_KEY/PUBLISHABLE_KEY; is Supabase running?",
    );
  if (!service) throw new Error("supabase status did not report SERVICE_ROLE_KEY/SECRET_KEY");
  return {
    api: `PORT=3005\nWEB_ORIGIN=http://localhost:8082\nSUPABASE_URL=${url}\nSUPABASE_SERVICE_ROLE_KEY=${service}\n`,
    web: `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\nVITE_API_URL=http://localhost:3005\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, "..", "..", "..");
  const text = execFileSync("supabase", ["status", "-o", "env"], {
    cwd: join(root, "packages", "db"),
    encoding: "utf8",
  });
  const files = renderEnvFiles(parseStatusEnv(text));
  writeFileSync(join(root, "apps", "api", ".env.local"), files.api);
  writeFileSync(join(root, "apps", "web", ".env.local"), files.web);
  process.stdout.write("wrote apps/api/.env.local and apps/web/.env.local\n");
}
