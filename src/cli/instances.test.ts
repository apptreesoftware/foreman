import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addInstance } from "./instances.ts";

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
  it("host defaults to the lowercased short hostname", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const i = addInstance({ name: "a", repo: "acme/a", repoDir: "/r/a", home });
    expect(JSON.parse(readFileSync(i.configPath, "utf8")).host).toMatch(/^[a-z0-9-]+$/);
  });
});
