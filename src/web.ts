import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { FEED_LIMIT_DEFAULT, type FeedEntry, isSessionId } from "./feed.ts";
import { log } from "./log.ts";
import type { NextReport } from "./next.ts";
import type { StatusReport } from "./status.ts";

export type WebCommand = "stop" | "abort" | "go";

export interface WebDeps {
  port: number;
  status: () => StatusReport;
  next: () => Promise<NextReport>;
  act: (cmd: WebCommand) => Promise<string>;
  feed: (sessionId: string, limit: number) => FeedEntry[];
  /** Page HTML; defaults to src/web.html. Injectable for tests. */
  html?: string;
}

export function isLocalHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function send(res: http.ServerResponse, code: number, body: string, type: string): void {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
const json = (res: http.ServerResponse, code: number, v: unknown) =>
  send(res, code, JSON.stringify(v), "application/json; charset=utf-8");

export function createWebServer(d: WebDeps): http.Server {
  const html = d.html ?? readFileSync(join(import.meta.dirname, "web.html"), "utf8");
  const server = http.createServer(async (req, res) => {
    const bound = (server.address() as AddressInfo | null)?.port ?? d.port;
    const u = new URL(req.url ?? "/", "http://localhost");
    const url = u.pathname;
    try {
      // Spec §7: every route is localhost-only, not just the POST actions.
      if (!isLocalHost(req.headers.host, bound))
        return json(res, 403, { ok: false, error: "localhost only" });
      if (req.method === "GET" && url === "/")
        return send(res, 200, html, "text/html; charset=utf-8");
      if (req.method === "GET" && url === "/api/status") return json(res, 200, d.status());
      if (req.method === "GET" && url === "/api/next") return json(res, 200, await d.next());
      if (req.method === "GET" && url === "/api/feed") {
        const session = u.searchParams.get("session") ?? "";
        if (!isSessionId(session)) return json(res, 400, { ok: false, error: "bad session id" });
        const limit =
          Number(u.searchParams.get("limit") ?? FEED_LIMIT_DEFAULT) || FEED_LIMIT_DEFAULT;
        return json(res, 200, { session, entries: d.feed(session, limit) });
      }
      const m = /^\/api\/(stop|abort|go)$/.exec(url);
      if (m) {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const cmd = m[1] as WebCommand;
        return json(res, 200, { ok: true, message: await d.act(cmd) });
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return server;
}

/** Listens on 127.0.0.1:<port>. A busy port is a warning, not a failure. */
export function startWebServer(d: WebDeps): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = createWebServer(d);
    server.once("error", (err: NodeJS.ErrnoException) => {
      log("warn", "web page not started", { port: d.port, error: err.code ?? err.message });
      resolve(null);
    });
    server.listen(d.port, "127.0.0.1", () => {
      log("info", "web page listening", { url: `http://127.0.0.1:${d.port}` });
      resolve(server);
    });
  });
}
