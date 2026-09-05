/**
 * The two stacks a Tone & Tonic process can talk to (#228).
 *
 * `dev` is the owner's: Supabase project `tone_tonic` on 553xx, web 8082, api 3005. `role` is the
 * one a foreman role session gets: project `tone_tonic_val` on 556xx (see
 * `packages/db/scripts/role-config.sh`), web 8182, api 3105 — so a session that runs
 * `pnpm db:reset` or starts the app never wipes the owner's data or takes their ports.
 *
 * The foreman puts `TONE_WEB_PORT`, `TONE_API_PORT` and `SUPABASE_API_URL` in an isolated
 * session's environment; `scripts/serve.ts` and `scripts/dev-env.ts` read them back through
 * `stackPorts()`, so the same scripts serve both stacks.
 */

export const DEV_SUPABASE_PROJECT = "tone_tonic";
export const DEV_SUPABASE_API_URL = "http://127.0.0.1:55321";
export const DEV_WEB_PORT = 8082;
export const DEV_API_PORT = 3005;

export const ROLE_SUPABASE_PROJECT = "tone_tonic_val";
export const ROLE_SUPABASE_API_URL = "http://127.0.0.1:55621";
export const ROLE_WEB_PORT = 8182;
export const ROLE_API_PORT = 3105;

/** A malformed or out-of-range value falls back rather than serving on port NaN. */
export function portFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export interface StackPorts {
  web: number;
  api: number;
  webUrl: string;
  apiUrl: string;
  supabaseUrl: string;
}

/** The stack the current process serves: the role stack when the foreman set the vars, else dev. */
export function stackPorts(env: NodeJS.ProcessEnv = process.env): StackPorts {
  const web = portFromEnv(env.TONE_WEB_PORT, DEV_WEB_PORT);
  const api = portFromEnv(env.TONE_API_PORT, DEV_API_PORT);
  return {
    web,
    api,
    webUrl: `http://localhost:${web}`,
    apiUrl: `http://localhost:${api}`,
    supabaseUrl: env.SUPABASE_API_URL || DEV_SUPABASE_API_URL,
  };
}

/** The environment an isolated role session runs with. */
export function roleSessionEnv(): Record<string, string> {
  return {
    TONE_WEB_PORT: String(ROLE_WEB_PORT),
    TONE_API_PORT: String(ROLE_API_PORT),
    SUPABASE_API_URL: ROLE_SUPABASE_API_URL,
  };
}
