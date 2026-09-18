import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureProject, STATUS_OPTIONS } from "./board.ts";
import { ensureLabels, LABELS, modelLabels } from "./labels.ts";
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

describe("board", () => {
  it("creates, links and sets the five Status options when project is unset", async () => {
    const { gh, calls } = api();
    const r = await ensureProject(gh, {
      owner: "acme",
      repo: "acme/widgets",
      project: null,
      title: "widgets",
    });
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
      (await ensureProject(gh, { owner: "acme", repo: "acme/widgets", project: 3, title: "w" }))
        .drift,
    ).toEqual([]);
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
    expect(matchesGlob("docs/**/*.md", "src/a.md")).toBe(false);
    expect(matchesGlob("docs/**/*.md", "docs/a.txt")).toBe(false);
  });
  it("epicBody carries the Spec section parseSpecPath reads", async () => {
    const { epicBody } = await import("./epic.ts");
    const { parseSpecPath } = await import("../phase.ts");
    expect(parseSpecPath(epicBody("docs/specs/a.md"))).toBe("docs/specs/a.md");
  });
});
