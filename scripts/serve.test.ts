import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_INTEGRATIONS_KEY, serveConfig } from "./serve.ts";

describe("serveConfig", () => {
  it("uses the dev ports by default", () => {
    const c = serveConfig({});
    expect(c.webUrl).toBe("http://localhost:8082");
    expect(c.apiHealthUrl).toBe("http://localhost:3005/health");
    expect(c.apiEnv).toEqual({
      PORT: "3005",
      WEB_ORIGIN: "http://localhost:8082",
      AI_FIXTURE: "1",
      ZOOM_FIXTURE: "1",
      INTEGRATIONS_KEY: DEV_INTEGRATIONS_KEY,
    });
    expect(c.webEnv).toEqual({ TONE_WEB_PORT: "8082" });
  });

  it("follows TONE_WEB_PORT and TONE_API_PORT so CI and role sessions can use other ports", () => {
    const c = serveConfig({ TONE_WEB_PORT: "8182", TONE_API_PORT: "3105" });
    expect(c.webUrl).toBe("http://localhost:8182");
    expect(c.apiHealthUrl).toBe("http://localhost:3105/health");
    expect(c.apiEnv).toEqual({
      PORT: "3105",
      WEB_ORIGIN: "http://localhost:8182",
      AI_FIXTURE: "1",
      ZOOM_FIXTURE: "1",
      INTEGRATIONS_KEY: DEV_INTEGRATIONS_KEY,
    });
    expect(c.webEnv).toEqual({ TONE_WEB_PORT: "8182" });
  });

  it("runs the served api on the organize fixture unless told otherwise", () => {
    // The key is stripped from a served api, so a worker off the fixture could never boot (#43).
    expect(serveConfig({}).apiEnv.AI_FIXTURE).toBe("1");
    expect(serveConfig({ AI_FIXTURE: "0" }).apiEnv.AI_FIXTURE).toBe("0");
  });

  it("runs the served api on the Zoom fixture with the dev key unless told otherwise", () => {
    // A role session has no Zoom app, and `.env.local` (from dev-env) carries neither value (#95).
    expect(serveConfig({}).apiEnv.ZOOM_FIXTURE).toBe("1");
    expect(serveConfig({ ZOOM_FIXTURE: "0" }).apiEnv.ZOOM_FIXTURE).toBe("0");
    expect(serveConfig({ INTEGRATIONS_KEY: "mine" }).apiEnv.INTEGRATIONS_KEY).toBe("mine");
    expect(DEV_INTEGRATIONS_KEY).toBe(
      /^INTEGRATIONS_KEY=(.+)$/m.exec(
        readFileSync(
          join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env.example"),
          "utf8",
        ),
      )?.[1],
    );
  });
});
