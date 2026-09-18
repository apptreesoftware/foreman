import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
  it("listInstances on an unreadable home is empty, not a throw", () => {
    const h = home();
    add(h, "a");
    // Root ignores directory permissions, so this assertion is meaningless there.
    if (process.getuid?.() === 0) return;
    chmodSync(h, 0o000);
    try {
      expect(listInstances(h)).toEqual([]);
    } finally {
      chmodSync(h, 0o755);
    }
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
  it("matches a cwd through a symlink on either side", () => {
    const real = mkdtempSync(join(tmpdir(), "foreman-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "foreman-link-"));
    const link = join(linkParent, "repo");
    symlinkSync(real, link);
    // A second, unrelated instance in each home so a match can only come from the symlink
    // comparison actually working, not from the "sole instance" fallback masking a miss.
    // repoDir configured as the symlink; cwd is the real (dereferenced) path.
    const h = home();
    add(h, "a", link);
    add(h, "other", "/repos/other");
    expect(resolveInstance({ env: {}, cwd: real, home: h }).name).toBe("a");
    // The reverse: repoDir is the real path; cwd goes through the symlink.
    const h2 = home();
    add(h2, "b", real);
    add(h2, "other", "/repos/other");
    expect(resolveInstance({ env: {}, cwd: link, home: h2 }).name).toBe("b");
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
