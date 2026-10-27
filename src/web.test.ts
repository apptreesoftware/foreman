import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FeedEntry } from "./feed.ts";
import type { NextReport } from "./next.ts";
import type { SessionRange } from "./session-history.ts";
import { CAP_CHOICES, EFFORT_LEVELS, MODEL_CHOICES } from "./state-file.ts";
import type { StatusReport } from "./status.ts";
import {
  basicAuthorization,
  createWebServer,
  isLocalHost,
  listenAddresses,
  startWebServer,
  type WebDeps,
} from "./web.ts";

const report: StatusReport = {
  host: "mac-a",
  repo: "o/r",
  now: "2026-09-04T13:27:00.000Z",
  daemon: "RUNNING",
  pid: 1,
  uptimeMinutes: 3,
  launchdInstalled: false,
  stopPresent: false,
  nowPhase: "idle",
  model: { current: "opus", configured: "opus", source: "config", choices: MODEL_CHOICES },
  cap: { current: 20, configured: 20, source: "config", choices: CAP_CHOICES },
  effort: { default: "high", levels: EFFORT_LEVELS },
  tick: null,
  current: null,
  orphan: null,
  stopping: null,
  unfinished: null,
  lastPlan: ["plan#10"],
  board: null,
  budget: null,
  attention: { needsYou: 0, waiting: 0, banners: [], waitRows: [] },
  instance: "widgets",
  theme: { current: "indigo", choices: ["indigo", "violet", "teal", "mono"] },
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
  const caps: (number | null)[] = [];
  const unblocked: number[] = [];
  const taskModels: string[] = [];
  const taskEfforts: string[] = [];
  const themes: string[] = [];
  const ranges: SessionRange[] = [];
  let refreshes = 0;
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
      {
        epic: 124,
        title: "Phase 0.5",
        phase: 0,
        detail: "d",
        actions: ["sign_off", "pause"],
        since: null,
        review: null,
      },
    ],
    needsYouItems: () => [
      {
        issue: 5,
        title: "Task 5",
        labels: ["blocked"],
        since: "2026-09-03T03:00:00Z",
        itemId: "PVTI_5",
        reviewOf: null,
        phaseReview: false,
      },
      {
        issue: 171,
        title: "Task 171",
        labels: ["needs-owner"],
        since: "2026-09-03T10:00:00Z",
        itemId: null,
        reviewOf: null,
        phaseReview: false,
      },
    ],
    unblock: async (issue) => {
      unblocked.push(issue);
      return `#${issue} unblocked`;
    },
    setModel: async (model) => {
      models.push(model);
      return `next session runs ${model}`;
    },
    sessions: (range) => {
      ranges.push(range);
      return {
        ...range,
        totals: { spendUsd: 0, sessions: 0, issues: 0 },
        daily: [],
        byRole: [],
        byIssue: [],
      };
    },
    setTheme: async (theme) => {
      themes.push(theme);
      return `theme is now ${theme}`;
    },
    setCap: async (cap) => {
      caps.push(cap);
      return `cap is now ${cap ?? "the configured value"}`;
    },
    refresh: async () => {
      refreshes += 1;
      return "project re-read; tick requested";
    },
    pickerTasks: () => [
      { issue: 101, model: null, effort: null },
      { issue: 102, model: "sonnet", effort: null },
      // On the Board tab but not on the project board: still a picker target.
      { issue: 103, model: null, effort: null },
    ],
    setTaskModel: async (issue, model) => {
      taskModels.push(`${issue} ${model}`);
      return `#${issue} runs as ${model}`;
    },
    modelChoices: () => [...MODEL_CHOICES],
    setTaskEffort: async (issue, effort) => {
      taskEfforts.push(`${issue} ${effort}`);
      return `#${issue} runs at ${effort} effort`;
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
  it("refreshes the project on demand, POST only", async () => {
    const r = await fetch(`${base}/api/refresh`, { method: "POST" });
    expect(await r.json()).toEqual({ ok: true, message: "project re-read; tick requested" });
    expect(refreshes).toBe(1);
    expect((await fetch(`${base}/api/refresh`)).status).toBe(405);
    expect(refreshes).toBe(1);
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
  it("serves the session history for a valid range and refuses a bad one", async () => {
    const all = await fetch(`${base}/api/sessions`);
    expect(all.status).toBe(200);
    expect((await all.json()).totals).toEqual({ spendUsd: 0, sessions: 0, issues: 0 });
    expect((await fetch(`${base}/api/sessions?from=2026-10-01&to=2026-10-26`)).status).toBe(200);
    const bad = await fetch(`${base}/api/sessions?from=nope`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "bad range" });
    expect((await fetch(`${base}/api/sessions?from=2026-10-27&to=2026-10-01`)).status).toBe(400);
    expect(ranges).toEqual([
      { from: null, to: null },
      { from: "2026-10-01", to: "2026-10-26" },
    ]);
  });
  it("sets the page theme to one of the four, and nothing else", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/theme`, { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ theme: "violet" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: "theme is now violet" });
    const bad = await post({ theme: "pink" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "bad theme" });
    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/theme`)).status).toBe(405);
    expect(themes).toEqual(["violet"]);
  });
  it("raises the daily cap, and refuses anything that is not a sane session count", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/cap`, { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ maxSessionsPerDay: 50 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: "cap is now 50" });
    expect((await post({ maxSessionsPerDay: 0 })).status).toBe(400);
    expect((await post({ maxSessionsPerDay: -5 })).status).toBe(400);
    expect((await post({ maxSessionsPerDay: 100000 })).status).toBe(400);
    expect((await post({ maxSessionsPerDay: 12.5 })).status).toBe(400);
    expect((await post({ maxSessionsPerDay: "50" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/cap`)).status).toBe(405);
    // `null` is the one non-number accepted: it clears the override.
    expect((await post({ maxSessionsPerDay: null })).status).toBe(200);
    expect(caps).toEqual([50, null]);
  });
  it("sets a task's model when the board lists the task, and offers only the label choices", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/task-model`, { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ issue: 101, model: "sonnet" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: "#101 runs as sonnet" });
    expect((await post({ issue: 102, model: "default" })).status).toBe(200);
    expect((await post({ issue: 103, model: "haiku" })).status).toBe(200);
    // A label has to exist in the repo, so unlike /api/model only the one-click names pass.
    expect((await post({ issue: 101, model: "claude-haiku-4-5-20251001" })).status).toBe(400);
    expect((await post({ issue: 101, model: "--dangerously-skip-permissions" })).status).toBe(400);
    // Not a task of any phase on the board: refused before it reaches GitHub.
    const absent = await post({ issue: 999, model: "sonnet" });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ ok: false, error: "#999 is not a task on the board" });
    expect((await post({ issue: "101", model: "sonnet" })).status).toBe(400);
    expect((await post({ model: "sonnet" })).status).toBe(400);
    expect((await fetch(`${base}/api/task-model`)).status).toBe(405);
    expect(taskModels).toEqual(["101 sonnet", "102 default", "103 haiku"]);
  });
  it("sets a task's effort when the board lists the task, and only Claude Code's levels", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/task-effort`, { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ issue: 101, effort: "xhigh" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, message: "#101 runs at xhigh effort" });
    expect((await post({ issue: 102, effort: "default" })).status).toBe(200);
    expect((await post({ issue: 103, effort: "low" })).status).toBe(200);
    // The effort reaches `claude` as argv: anything but a level is refused.
    expect((await post({ issue: 101, effort: "ultra" })).status).toBe(400);
    expect((await post({ issue: 101, effort: "--dangerously-skip-permissions" })).status).toBe(400);
    // Not a task of any phase on the board: refused before it reaches GitHub.
    expect((await post({ issue: 999, effort: "low" })).status).toBe(400);
    expect((await post({ effort: "low" })).status).toBe(400);
    expect((await fetch(`${base}/api/task-effort`)).status).toBe(405);
    expect(taskEfforts).toEqual(["101 xhigh", "102 default", "103 low"]);
  });
  it("unblocks an issue the board lists as blocked", async () => {
    const r = await fetch(`${base}/api/unblock`, {
      method: "POST",
      body: JSON.stringify({ issue: 5 }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, message: "#5 unblocked" });
    expect(unblocked).toEqual([5]);
  });
  it("refuses an issue the board does not list as blocked", async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/unblock`, { method: "POST", body: JSON.stringify(body) });
    // Listed, but waiting on the owner rather than blocked: nothing to remove.
    expect((await post({ issue: 171 })).status).toBe(400);
    expect((await post({ issue: 999 })).status).toBe(400);
    expect((await post({ issue: "5" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/unblock`)).status).toBe(405);
    expect(unblocked).toEqual([5]);
  });
  it("rejects a session id that is not a uuid", async () => {
    const r = await fetch(`${base}/api/feed?session=../etc/passwd`);
    expect(r.status).toBe(400);
  });
});

describe("web server with webAuth", () => {
  const auth = { user: "me", password: "correct horse" };
  const acts: string[] = [];
  const server = createWebServer({
    port: 0,
    auth,
    status: () => report,
    next: async () => nextReport,
    act: async (cmd) => {
      acts.push(cmd);
      return `did ${cmd}`;
    },
    feed: () => [],
    owner: async () => "",
    ownerItems: () => [],
    needsYouItems: () => [],
    unblock: async () => "",
    setModel: async () => "",
    sessions: () => ({
      from: null,
      to: null,
      totals: { spendUsd: 0, sessions: 0, issues: 0 },
      daily: [],
      byRole: [],
      byIssue: [],
    }),
    setTheme: async () => "",
    setCap: async () => "",
    refresh: async () => "",
    pickerTasks: () => [],
    setTaskModel: async () => "",
    modelChoices: () => [],
    setTaskEffort: async () => "",
    html: "<title>Foreman</title>",
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  /** node:http so the Host header can be set; returns status, body and the challenge header. */
  const raw = (path: string, headers: Record<string, string>, method = "GET") =>
    new Promise<{ status: number; body: string; challenge: string | undefined }>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method, headers },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              challenge: res.headers["www-authenticate"],
            }),
          );
        },
      );
      req.end();
    });

  it("challenges a request with no credentials, even for the page itself", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    expect(page.headers.get("www-authenticate")).toBe('Basic realm="foreman"');
    expect(await page.json()).toEqual({ ok: false, error: "unauthorized" });
    const status = await fetch(`${base}/api/status`);
    expect(status.status).toBe(401);
    const post = await fetch(`${base}/api/stop`, { method: "POST" });
    expect(post.status).toBe(401);
    expect(acts).toEqual([]);
  });
  it("refuses a wrong password, a wrong user and a non-Basic scheme", async () => {
    const wrong = Buffer.from("me:wrong password").toString("base64");
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: `Basic ${wrong}` } })).status,
    ).toBe(401);
    const user = Buffer.from("you:correct horse").toString("base64");
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: `Basic ${user}` } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/api/status`, { headers: { authorization: "Bearer x" } })).status,
    ).toBe(401);
  });
  it("accepts the right credentials from any Host, so a tunnel can reach the page", async () => {
    const headers = { host: "abc.ngrok.app", authorization: basicAuthorization(auth) };
    const status = await raw("/api/status", headers);
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual(report);
    const page = await raw("/", headers);
    expect(page.status).toBe(200);
    expect(page.body).toBe("<title>Foreman</title>");
    const post = await raw("/api/stop", headers, "POST");
    expect(post.status).toBe(200);
    expect(acts).toEqual(["stop"]);
  });
  it("still accepts the right credentials on localhost", async () => {
    const r = await fetch(`${base}/api/status`, {
      headers: { authorization: basicAuthorization(auth) },
    });
    expect(r.status).toBe(200);
  });
});

describe("basicAuthorization", () => {
  it("encodes user:password the way a browser does", () => {
    expect(basicAuthorization({ user: "me", password: "correct horse" })).toBe(
      `Basic ${Buffer.from("me:correct horse").toString("base64")}`,
    );
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
  it("accepts nothing beyond loopback when webHosts is absent or empty", () => {
    expect(isLocalHost("mini:8090", 8090)).toBe(false);
    expect(isLocalHost("mini:8090", 8090, [])).toBe(false);
  });
  it("accepts each webHosts entry at the page's port, and nothing else", () => {
    const hosts = ["mini", "100.84.252.56", "fd7a:115c::1"];
    expect(isLocalHost("mini:8090", 8090, hosts)).toBe(true);
    expect(isLocalHost("MINI:8090", 8090, hosts)).toBe(true);
    expect(isLocalHost("100.84.252.56:8090", 8090, hosts)).toBe(true);
    expect(isLocalHost("127.0.0.1:8090", 8090, hosts)).toBe(true);
    expect(isLocalHost("mini:8091", 8090, hosts)).toBe(false);
    expect(isLocalHost("mini", 8090, hosts)).toBe(false);
    expect(isLocalHost("evil.example:8090", 8090, hosts)).toBe(false);
    expect(isLocalHost("mini.evil.example:8090", 8090, hosts)).toBe(false);
  });
  it("expects an IPv6 entry in brackets, the way a browser sends it", () => {
    const hosts = ["fd7a:115c::1"];
    expect(isLocalHost("[fd7a:115c::1]:8090", 8090, hosts)).toBe(true);
    expect(isLocalHost("fd7a:115c::1:8090", 8090, hosts)).toBe(false);
    expect(isLocalHost("[fd7a:115c::1]:8091", 8090, hosts)).toBe(false);
  });
});

describe("listenAddresses", () => {
  it("is loopback alone when webHosts is absent", () => {
    expect(listenAddresses(undefined)).toEqual(["127.0.0.1"]);
    expect(listenAddresses([])).toEqual(["127.0.0.1"]);
  });
  it("adds the IP literals, never the hostnames, and binds each address once", () => {
    expect(
      listenAddresses(["mini", "100.84.252.56", "fd7a:115c::1", "127.0.0.1", "100.84.252.56"]),
    ).toEqual(["127.0.0.1", "100.84.252.56", "fd7a:115c::1"]);
  });
});

describe("web server with webHosts", () => {
  const deps: WebDeps = {
    port: 0,
    hosts: ["mini", "::1"],
    status: () => report,
    next: async () => nextReport,
    act: async () => "",
    feed: () => [],
    owner: async () => "",
    ownerItems: () => [],
    needsYouItems: () => [],
    unblock: async () => "",
    setModel: async () => "",
    sessions: () => ({
      from: null,
      to: null,
      totals: { spendUsd: 0, sessions: 0, issues: 0 },
      daily: [],
      byRole: [],
      byIssue: [],
    }),
    setTheme: async () => "",
    setCap: async () => "",
    refresh: async () => "",
    pickerTasks: () => [],
    setTaskModel: async () => "",
    modelChoices: () => [],
    setTaskEffort: async () => "",
    html: "<title>Foreman</title>",
  };

  /** node:http so the Host header can be set. */
  const get = (address: string, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: address, port, path: "/api/status", headers: { host } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("answers a listed Host and still refuses a foreign one", async () => {
    const server = createWebServer(deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await get("127.0.0.1", port, `mini:${port}`)).toBe(200);
      expect(await get("127.0.0.1", port, `[::1]:${port}`)).toBe(200);
      expect(await get("127.0.0.1", port, `evil.example:${port}`)).toBe(403);
    } finally {
      server.close();
    }
  });

  it("listens on loopback and on each IP literal, and closes them together", async () => {
    const server = await startWebServer(deps);
    if (!server) throw new Error("web page not started");
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await get("127.0.0.1", port, `127.0.0.1:${port}`)).toBe(200);
      expect(await get("::1", port, `[::1]:${port}`)).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
    await expect(get("::1", port, `[::1]:${port}`)).rejects.toThrow();
  });

  it("warns and keeps loopback when an extra address cannot be bound", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    // 192.0.2.0/24 is reserved for documentation, so no interface ever holds it.
    const server = await startWebServer({ ...deps, hosts: ["192.0.2.1"] });
    spy.mockRestore();
    if (!server) throw new Error("web page not started");
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await get("127.0.0.1", port, `127.0.0.1:${port}`)).toBe(200);
      const warn = lines.map((l) => JSON.parse(l)).find((l) => l.level === "warn");
      expect(warn).toMatchObject({ msg: "web page not started", address: "192.0.2.1" });
    } finally {
      server.close();
    }
  });
});

describe("web.html", () => {
  const html = readFileSync(join(import.meta.dirname, "web.html"), "utf8");

  it("routes five tabs by location.hash", () => {
    for (const tab of ["dashboard", "needs-you", "waiting", "board", "session"]) {
      expect(html).toContain(`data-tab="${tab}"`);
      expect(html).toContain(`href="#${tab}"`);
    }
    expect(html).toContain("location.hash");
  });
  it("carries the four themes, light and dark, with readable buttons", () => {
    for (const t of ["indigo", "violet", "teal", "mono"])
      expect(html).toContain(`[data-theme="${t}"]`);
    for (const hex of ["#4263EB", "#6E56CF", "#22B8CF", "#EDEDEF", "#3B5BDB", "#0B7285", "#5B8DEF"])
      expect(html).toContain(hex);
    expect(html).toContain("prefers-color-scheme");
    expect(html).toContain("@container");
    expect(html).toContain('post("/api/theme"');
  });
  it("renders the dashboard from the status report and escapes through esc()", () => {
    expect(html).toContain("const esc =");
    expect(html).toContain("r.attention");
    expect(html).toContain("r.instance");
    expect(html).toContain('r.nowPhase === "between_ticks"');
    expect(html).toContain('label: "between ticks"');
    expect(html).toContain('r.nowPhase === "parked"');
    expect(html).toContain("/api/feed?session=");
    expect(html).toContain('fetch("/api/next")');
    expect(html).toContain('post("/api/refresh")');
    expect(html).toContain(`Confirm $${"{cmd}"}?`);
    expect(html).toContain("Back to live");
  });
  it("puts every reason the foreman is idle in a banner", () => {
    expect(html).toContain("no state.json: restart the daemon");
    expect(html).toContain("run ctl abort");
    expect(html).toContain("no output for");
    expect(html).toContain("r.attention?.banners");
  });
  it("no longer has the old right-hand cards", () => {
    for (const id of ["tick", "recent", "phases", "owner"])
      expect(html).not.toContain(`id="${id}"`);
  });
});
