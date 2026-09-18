import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProject, STATUS_OPTIONS } from "./board.ts";
import { ensureLabels, ensurePlanLabels, LABELS, modelLabels } from "./labels.ts";
import { scaffoldRepoDir } from "./scaffold.ts";

function api(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const gh = {
    listLabels: async () => ["epic", "blocked"],
    createLabel: async (l: { name: string }) => {
      calls.push(`label ${l.name}`);
    },
    createProject: async (_o: string, t: string) => {
      calls.push(`create ${t}`);
      return 7;
    },
    linkProject: async (n: number) => {
      calls.push(`link ${n}`);
    },
    projectFields: async () => ({
      projectId: "PVT_1",
      status: {
        id: "F1",
        options: [
          { id: "o1", name: "Todo" },
          { id: "o2", name: "Done" },
        ],
      },
    }),
    setStatusOptions: async (f: string, names: string[]) => {
      calls.push(`options ${f} ${names.join("|")}`);
    },
    ...over,
  };
  return { gh, calls };
}

describe("labels", () => {
  it("creates only the missing labels, including model:<m>", async () => {
    const { gh, calls } = api();
    const r = await ensureLabels(gh, ["opus", "sonnet"]);
    expect(calls).not.toContain("label epic");
    expect(calls).toContain("label agent-ready");
    expect(calls).toContain("label model:sonnet");
    expect(r.created).toHaveLength(LABELS.length - 2 + 2);
  });
  it("is idempotent", async () => {
    const all = [...LABELS.map((l) => l.name), ...modelLabels(["opus"]).map((l) => l.name)];
    const { gh, calls } = api({ listLabels: async () => all });
    await ensureLabels(gh, ["opus"]);
    expect(calls).toEqual([]);
  });
});

describe("ensurePlanLabels", () => {
  it("creates the phase and area labels a plan invents, and nothing it already has", async () => {
    const { gh, calls } = api();
    const r = await ensurePlanLabels(gh, ["phase:1", "area:docs", "size:S", "epic", "phase:1"]);
    expect(calls).toEqual(["label phase:1", "label area:docs", "label size:S"]);
    expect(r.created).toEqual(["phase:1", "area:docs", "size:S"]);
  });
  it("reads no labels at all for a plan that names none", async () => {
    let reads = 0;
    const { gh, calls } = api({
      listLabels: async () => {
        reads++;
        return [];
      },
    });
    await ensurePlanLabels(gh, []);
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("board", () => {
  it("creates, links and sets the five Status options when project is unset", async () => {
    const { gh, calls } = api();
    const created: number[] = [];
    const r = await ensureProject(gh, {
      owner: "acme",
      repo: "acme/widgets",
      project: null,
      title: "widgets",
      onCreated: (n) => created.push(n),
    });
    expect(created).toEqual([7]);
    expect(r).toEqual({ number: 7, created: true, drift: [] });
    expect(calls).toEqual(["create widgets", "link 7", `options F1 ${STATUS_OPTIONS.join("|")}`]);
  });
  it("reports drift instead of editing an existing project", async () => {
    const { gh, calls } = api();
    const r = await ensureProject(gh, {
      owner: "acme",
      repo: "acme/widgets",
      project: 3,
      title: "widgets",
      onCreated: () => expect.unreachable("nothing is created when the project is known"),
    });
    expect(r.created).toBe(false);
    expect(r.drift).toEqual([
      "Status options are Todo, Done; expected Backlog, Ready, In Progress, In Review, Done",
    ]);
    expect(calls).toEqual([]);
  });
  it("an existing project with the right options has no drift", async () => {
    const { gh } = api({
      projectFields: async () => ({
        projectId: "P",
        status: { id: "F", options: STATUS_OPTIONS.map((n, i) => ({ id: String(i), name: n })) },
      }),
    });
    expect(
      (
        await ensureProject(gh, {
          owner: "acme",
          repo: "acme/widgets",
          project: 3,
          title: "w",
          onCreated: () => undefined,
        })
      ).drift,
    ).toEqual([]);
  });
  it("records the number before linking, so a failed link leaves no orphan board", async () => {
    const { gh } = api({
      linkProject: async () => {
        throw new Error("gh project link failed");
      },
    });
    const created: number[] = [];
    await expect(
      ensureProject(gh, {
        owner: "acme",
        repo: "acme/widgets",
        project: null,
        title: "widgets",
        onCreated: (n) => created.push(n),
      }),
    ).rejects.toThrow("gh project link failed");
    expect(created).toEqual([7]);
  });
});

describe("scaffold", () => {
  it("writes config.json, rules.md, settings.json and an empty hooks dir once", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-"));
    const first = scaffoldRepoDir(dir);
    expect(first.written.sort()).toEqual([
      ".foreman/config.json",
      ".foreman/hooks/",
      ".foreman/rules.md",
      ".foreman/settings.json",
    ]);
    expect(JSON.parse(readFileSync(join(dir, ".foreman", "config.json"), "utf8")).setup).toBe(
      "pnpm install",
    );
    expect(existsSync(join(dir, ".foreman", "hooks"))).toBe(true);
    expect(scaffoldRepoDir(dir).written).toEqual([]);
  });
});

describe("epic new", () => {
  it("matchesGlob handles docs/**/*.md", async () => {
    const { matchesGlob } = await import("./epic.ts");
    expect(matchesGlob("docs/**/*.md", "docs/specs/a.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "docs/a.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "docs/a/b/c.md")).toBe(true);
    expect(matchesGlob("docs/**/*.md", "docs/superpowers/specs/2026-09-17-x-design.md")).toBe(true);
    expect(matchesGlob("docs/**", "docs/a/b.md")).toBe(true);
    expect(matchesGlob("docs/?.md", "docs/.md")).toBe(false);
    expect(matchesGlob("docs/**/*.md", "src/a.md")).toBe(false);
    expect(matchesGlob("docs/**/*.md", "docs/a.txt")).toBe(false);
  });
  it("epicBody carries the Spec section parseSpecPath reads", async () => {
    const { epicBody } = await import("./epic.ts");
    const { parseSpecPath } = await import("../phase.ts");
    expect(parseSpecPath(epicBody("docs/specs/a.md"))).toBe("docs/specs/a.md");
  });
});
