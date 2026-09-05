import { describe, expect, it } from "vitest";
import { serveConfig } from "./serve.ts";

describe("serveConfig", () => {
  it("uses the dev ports by default", () => {
    const c = serveConfig({});
    expect(c.webUrl).toBe("http://localhost:8082");
    expect(c.apiHealthUrl).toBe("http://localhost:3005/health");
    expect(c.apiEnv).toEqual({ PORT: "3005", WEB_ORIGIN: "http://localhost:8082" });
    expect(c.webEnv).toEqual({ TONE_WEB_PORT: "8082" });
  });

  it("follows TONE_WEB_PORT and TONE_API_PORT so CI and role sessions can use other ports", () => {
    const c = serveConfig({ TONE_WEB_PORT: "8182", TONE_API_PORT: "3105" });
    expect(c.webUrl).toBe("http://localhost:8182");
    expect(c.apiHealthUrl).toBe("http://localhost:3105/health");
    expect(c.apiEnv).toEqual({ PORT: "3105", WEB_ORIGIN: "http://localhost:8182" });
    expect(c.webEnv).toEqual({ TONE_WEB_PORT: "8182" });
  });
});
