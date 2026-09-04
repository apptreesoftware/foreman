import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FeedEntry } from "./feed.ts";
import type { NextReport } from "./next.ts";
import { MODEL_CHOICES } from "./state-file.ts";
import type { StatusReport } from "./status.ts";
import { createWebServer, isLocalHost } from "./web.ts";

const report: StatusReport = {
  host: "mac-a",
  repo: "o/r",
  daemon: "RUNNING",
  pid: 1,
  uptimeMinutes: 3,
  launchdInstalled: false,
  stopPresent: false,
  model: { current: "opus", configured: "opus", source: "config", choices: MODEL_CHOICES },
  tick: null,
  current: null,
  orphan: null,
  stopping: null,
  unfinished: null,
  lastPlan: ["plan#10"],
  board: null,
  budget: null,
  recent: [],
  today: { count: 0, cap: 20, spendUsd: 0 },
};
const nextReport: NextReport = {
  actions: ["idle(x)"],
  stopAt: null,
  explain: ["idle: x"],
  prs: [],
};

describe("web server", () => {
  const acts: string[] = [];
  const owned: string[] = [];
  const models: string[] = [];
  const sid = "144ba520-6c0f-4195-ae18-c67de1443b31";
  const entries: FeedEntry[] = Array.from({ length: 5 }, (_, i) => ({
    t: `2026-09-04T13:27:0${i}.000Z`,
    kind: "tool" as const,
    name: "Read",
    summary: `f${i}`,
    subagent: false,
  }));
  const server = createWebServer({
    port: 0,
    status: () => report,
    next: async () => nextReport,
    act: async (cmd) => {
      acts.push(cmd);
      return `did ${cmd}`;
    },
    feed: (session, limit) => (session === sid ? entries.slice(-limit) : []),
    owner: async (epic, action) => {
      owned.push(`${action} ${epic}`);
      return `did ${action} on #${epic}`;
    },
    ownerItems: () => [
      { epic: 124, title: "Phase 0.5", phase: 0, detail: "d", actions: ["sign_off", "pause"] },
    ],
    setModel: async (model) => {
      models.push(model);
      return `next session runs ${model}`;
    },
    html: "<title>Foreman</title>",
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("serves the page and the status json", async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<title>Foreman</title>");
    const s = await fetch(`${base}/api/status`);
    expect(await s.json()).toMatchObject({ daemon: "RUNNING", lastPlan: ["plan#10"] });
  });
  it("computes next on demand", async () => {
    const r = await fetch(`${base}/api/next`);
    expect(await r.json()).toEqual(nextReport);
  });
  it("POST actions call the controller and reject foreign hosts", async () => {
    const r = await fetch(`${base}/api/stop`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, message: "did stop" });
    expect(acts).toEqual(["stop"]);
    // fetch forbids a custom Host header, so use node:http for the foreign-host case.
    const bad = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/api/go",
          method: "POST",
          headers: { host: "evil.example:80" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(bad).toBe(403);
    const get = await fetch(`${base}/api/go`);
    expect(get.status).toBe(405);
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });
  it("rejects a foreign Host on GET /api/status too", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/api/status",
          method: "GET",
          headers: { host: "evil.example:80" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(403);
  });
  it("serves the feed with a limit", async () => {
    const r = await fetch(`${base}/api/feed?session=${sid}&limit=2`);
    expect(await r.json()).toEqual({ session: sid, entries: entries.slice(-2) });
    const all = await (await fetch(`${base}/api/feed?session=${sid}`)).json();
    expect(all.entries).toHaveLength(5);
  });
  it("performs an owner action on a listed epic", async () => {
    const r = await fetch(`${base}/api/owner`, {
      method: "POST",
      body: JSON.stringify({ epic: 124, action: "sign_off" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, message: "did sign_off on #124" });
    expect(owned).toEqual(["sign_off 124"]);
  });
  it("refuses an unknown action, an unlisted epic, and an action the epic does not offer", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/owner`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ epic: 124, action: "delete_everything" })).status).toBe(400);
    expect((await post({ epic: 999, action: "sign_off" })).status).toBe(400);
    expect((await post({ epic: 124, action: "approve_plan" })).status).toBe(400);
    expect((await post({ action: "sign_off" })).status).toBe(400);
    expect((await fetch(`${base}/api/owner`)).status).toBe(405);
    expect(owned).toEqual(["sign_off 124"]);
  });
  it("sets the model, and refuses anything that is not a plain model name", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/model`, { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ model: "sonnet" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: "next session runs sonnet" });
    // A dated model id is a legitimate choice, so the check is a shape, not a fixed list.
    expect((await post({ model: "claude-haiku-4-5-20251001" })).status).toBe(200);
    expect((await post({ model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await post({ model: "../../etc/passwd" })).status).toBe(400);
    expect((await post({ model: "" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/model`)).status).toBe(405);
    expect(models).toEqual(["sonnet", "claude-haiku-4-5-20251001"]);
  });
  it("rejects a session id that is not a uuid", async () => {
    const r = await fetch(`${base}/api/feed?session=../etc/passwd`);
    expect(r.status).toBe(400);
  });
});

describe("isLocalHost", () => {
  it("accepts loopback names with the right port only", () => {
    expect(isLocalHost("127.0.0.1:8090", 8090)).toBe(true);
    expect(isLocalHost("localhost:8090", 8090)).toBe(true);
    expect(isLocalHost("localhost:8091", 8090)).toBe(false);
    expect(isLocalHost("evil.example:8090", 8090)).toBe(false);
    expect(isLocalHost(undefined, 8090)).toBe(false);
  });
});

describe("web.html", () => {
  it("has the five sections and escapes through esc()", () => {
    const html = readFileSync(join(import.meta.dirname, "web.html"), "utf8");
    for (const id of ["now", "waiting", "owner", "pipeline", "feed", "recent", "tick"])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain("const esc =");
    expect(html).toContain("/api/feed?session=");
  });
  it("offers the model choices and confirms before POSTing one", () => {
    const html = readFileSync(join(import.meta.dirname, "web.html"), "utf8");
    expect(html).toContain('rows.push(["model", modelControl(r.model)])');
    expect(html).toContain("window.confirm(`Run foreman sessions as ");
    expect(html).toContain('data-model="');
    expect(html).toContain('fetch("/api/model"');
  });
});
