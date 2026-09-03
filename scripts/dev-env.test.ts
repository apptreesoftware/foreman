import { describe, expect, it } from "vitest";
import { parseStatusEnv, renderEnvFiles } from "./dev-env.ts";

const status = `API_URL="http://127.0.0.1:55321"\nANON_KEY="anon.jwt"\nSERVICE_ROLE_KEY="service.jwt"\nDB_URL="postgresql://x"\n`;

describe("dev-env", () => {
  it("parses supabase status -o env", () => {
    expect(parseStatusEnv(status)).toMatchObject({
      API_URL: "http://127.0.0.1:55321",
      ANON_KEY: "anon.jwt",
    });
  });
  it("accepts the newer PUBLISHABLE_KEY / SECRET_KEY names", () => {
    const f = renderEnvFiles({
      API_URL: "http://127.0.0.1:55321",
      PUBLISHABLE_KEY: "pk",
      SECRET_KEY: "sk",
    });
    expect(f.web).toContain("VITE_SUPABASE_ANON_KEY=pk");
    expect(f.api).toContain("SUPABASE_SERVICE_ROLE_KEY=sk");
  });
  it("renders both env files with the fixed ports", () => {
    const f = renderEnvFiles(parseStatusEnv(status));
    expect(f.api).toContain("PORT=3005");
    expect(f.api).toContain("WEB_ORIGIN=http://localhost:8082");
    expect(f.api).toContain("SUPABASE_URL=http://127.0.0.1:55321");
    expect(f.api).toContain("SUPABASE_SERVICE_ROLE_KEY=service.jwt");
    expect(f.api).not.toContain("ANTHROPIC_API_KEY=");
    expect(f.web).toContain("VITE_SUPABASE_URL=http://127.0.0.1:55321");
    expect(f.web).toContain("VITE_SUPABASE_ANON_KEY=anon.jwt");
    expect(f.web).toContain("VITE_API_URL=http://localhost:3005");
  });
  it("throws when keys are missing", () => {
    expect(() => renderEnvFiles({ API_URL: "x" })).toThrow(/ANON_KEY/);
  });
});
