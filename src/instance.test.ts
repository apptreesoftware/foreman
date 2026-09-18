import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstanceError, instanceDir, listInstances, resolveInstance } from "./instance.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "foreman-home-"));
}
function add(h: string, name: string, repoDir = `/repos/${name}`): void {
  mkdirSync(join(h, name), { recursive: true });
  writeFileSync(
    join(h, name, "foreman.json"),
    JSON.stringify({ repo: `acme/${name}`, project: 1, host: "mac-a", repoDir }),
  );
}

describe("instance layout", () => {
  it("instanceDir is <home>/<name>", () => {
    expect(instanceDir("widgets", "/h")).toBe("/h/widgets");
  });
  it("listInstances returns only directories holding foreman.json, sorted by name", () => {
    const h = home();
    add(h, "zeta");
    add(h, "alpha");
    mkdirSync(join(h, "not-an-instance"));
    expect(listInstances(h).map((i) => i.name)).toEqual(["alpha", "zeta"]);
    expect(listInstances(h)[0]?.configPath).toBe(join(h, "alpha", "foreman.json"));
  });
  it("listInstances on a missing home is empty", () => {
    expect(listInstances(join(home(), "nope"))).toEqual([]);
  });
});

describe("resolveInstance", () => {
  it("prefers the -p flag", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    const i = resolveInstance({ flag: "b", env: {}, cwd: "/", home: h });
    expect(i.name).toBe("b");
    expect(i.dir).toBe(join(h, "b"));
  });
  it("rejects an unknown -p name, listing the known ones", () => {
    const h = home();
    add(h, "a");
    expect(() => resolveInstance({ flag: "zzz", env: {}, cwd: "/", home: h })).toThrow(
      /no instance "zzz".*a/s,
    );
  });
  it("then FOREMAN_INSTANCE", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    expect(resolveInstance({ env: { FOREMAN_INSTANCE: "a" }, cwd: "/", home: h }).name).toBe("a");
  });
  it("then the instance whose repoDir contains cwd", () => {
    const h = home();
    add(h, "a", "/repos/a");
    add(h, "b", "/repos/b");
    expect(resolveInstance({ env: {}, cwd: "/repos/b/.worktrees/12/src", home: h }).name).toBe("b");
  });
  it("then the sole instance", () => {
    const h = home();
    add(h, "only");
    expect(resolveInstance({ env: {}, cwd: "/", home: h }).name).toBe("only");
  });
  it("otherwise errors naming every instance", () => {
    const h = home();
    add(h, "a");
    add(h, "b");
    expect(() => resolveInstance({ env: {}, cwd: "/", home: h })).toThrow(InstanceError);
    expect(() => resolveInstance({ env: {}, cwd: "/", home: h })).toThrow(/a, b/);
  });
  it("errors when there are none, saying how to add one", () => {
    expect(() => resolveInstance({ env: {}, cwd: "/", home: home() })).toThrow(/foreman add/);
  });
  it("FOREMAN_CONFIG names a config file outside the layout", () => {
    const h = home();
    const dir = mkdtempSync(join(tmpdir(), "elsewhere-"));
    writeFileSync(join(dir, "foreman.json"), "{}");
    const i = resolveInstance({
      env: { FOREMAN_CONFIG: join(dir, "foreman.json") },
      cwd: "/",
      home: h,
    });
    expect(i.dir).toBe(dir);
    expect(i.configPath).toBe(join(dir, "foreman.json"));
  });
});
