import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NextReport } from "./next.ts";
import type { StatusReport } from "./status.ts";
import { createWebServer, isLocalHost } from "./web.ts";

const report: StatusReport = {
  host: "mac-a",
  daemon: "RUNNING",
  pid: 1,
  uptimeMinutes: 3,
  launchdInstalled: false,
  stopPresent: false,
  tick: null,
  current: null,
  orphan: null,
  stopping: null,
  unfinished: null,
  lastPlan: ["plan#10"],
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
  const server = createWebServer({
    port: 0,
    status: () => report,
    next: async () => nextReport,
    act: async (cmd) => {
      acts.push(cmd);
      return `did ${cmd}`;
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
