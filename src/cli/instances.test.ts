import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addInstance, parseWebPort } from "./instances.ts";

describe("addInstance", () => {
  it("writes foreman.json with the first free port from 8090", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const a = addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "mac-a", home });
    const b = addInstance({ name: "b", repo: "acme/b", repoDir: "/r/b", host: "mac-a", home });
    expect(JSON.parse(readFileSync(a.configPath, "utf8"))).toEqual({
      repo: "acme/a",
      host: "mac-a",
      repoDir: "/r/a",
      webPort: 8090,
    });
    expect(JSON.parse(readFileSync(b.configPath, "utf8")).webPort).toBe(8091);
  });
  it("refuses a duplicate name or port", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "h", webPort: 9000, home });
    expect(() =>
      addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", host: "h", home }),
    ).toThrow(/exists/);
    expect(() =>
      addInstance({ name: "b", repo: "acme/b", repoDir: "/r/b", host: "h", webPort: 9000, home }),
    ).toThrow(/9000.*a/);
  });
  it("refuses a --web-port that is not a port, and writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    // `Number("8O91")` — a capital O for a zero — is NaN, which JSON.stringify writes as null.
    expect(() =>
      addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", webPort: Number("8O91"), home }),
    ).toThrow(/whole number from 1 to 65535/);
    expect(() =>
      addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", webPort: 70000, home }),
    ).toThrow(/whole number from 1 to 65535/);
    expect(existsSync(join(home, "a", "foreman.json"))).toBe(false);
  });
  it("parseWebPort quotes what was typed", () => {
    expect(parseWebPort("8091")).toBe(8091);
    expect(() => parseWebPort("8O91")).toThrow(/got "8O91"/);
  });
  it("host defaults to the lowercased short hostname", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const i = addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", home });
    expect(JSON.parse(readFileSync(i.configPath, "utf8")).host).toMatch(/^[a-z0-9-]+$/);
  });
});
