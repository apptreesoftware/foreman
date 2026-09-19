import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { WebAuth } from "./config.ts";
import { FEED_LIMIT_DEFAULT, type FeedEntry, isSessionId } from "./feed.ts";
import { log } from "./log.ts";
import type { NextReport } from "./next.ts";
import {
  CapSchema,
  MODEL_DEFAULT,
  ModelSchema,
  type NeedsYouItem,
  type OwnerAction,
  OwnerActionSchema,
  type OwnerItem,
  type PhaseTask,
  type TaskModelChoice,
  TaskModelChoiceSchema,
} from "./state-file.ts";
import type { StatusReport } from "./status.ts";

export type WebCommand = "stop" | "abort" | "go";

export interface WebDeps {
  port: number;
  /**
   * HTTP Basic credentials. Set, every route demands them and the Host check is dropped, so a
   * tunnel can reach the page; absent, the page stays localhost-only (spec §7).
   */
  auth?: WebAuth;
  status: () => StatusReport;
  next: () => Promise<NextReport>;
  act: (cmd: WebCommand) => Promise<string>;
  feed: (sessionId: string, limit: number) => FeedEntry[];
  /** Applies an owner label gate; only ever called for an epic `ownerItems` currently offers. */
  owner: (epic: number, action: OwnerAction) => Promise<string>;
  /** The epics the page may act on, as of the last tick. */
  ownerItems: () => OwnerItem[];
  /** The non-epic issues waiting on the owner, as of the last tick; also the unblock allowlist. */
  needsYouItems: () => NeedsYouItem[];
  /** Clears `blocked` and moves the issue back to Ready; only called for a listed blocked issue. */
  unblock: (issue: number) => Promise<string>;
  /** Sets the model the next dispatch uses; the name has already passed `ModelSchema`. */
  setModel: (model: string) => Promise<string>;
  /** Sets the daily session cap the next tick enforces; null clears the override. */
  setCap: (maxSessionsPerDay: number | null) => Promise<string>;
  /** Drops the cached project board and wakes the loop, so the page shows the board as it is now. */
  refresh: () => Promise<string>;
  /** The open tasks of every phase on the board, as of the last tick; the task-model allowlist. */
  phaseTasks: () => PhaseTask[];
  /** Swaps the issue's `model:<name>` label; only called for a task `phaseTasks` lists (#259). */
  setTaskModel: (issue: number, model: TaskModelChoice) => Promise<string>;
  /** The repo's configured `models`; the task-model allowlist beyond `MODEL_DEFAULT`. */
  modelChoices: () => string[];
  /** Page HTML; defaults to src/web.html. Injectable for tests. */
  html?: string;
}

export function isLocalHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

/** The `Authorization` value a client sends for these credentials; what `ctl` uses too. */
export function basicAuthorization(auth: WebAuth): string {
  return `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`;
}

/** Constant-time on the encoded header, so neither a length nor a prefix leaks by timing. */
function authorized(header: string | undefined, auth: WebAuth): boolean {
  if (!header) return false;
  const want = Buffer.from(basicAuthorization(auth));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const OwnerRequestSchema = z.object({
  epic: z.number().int().positive(),
  action: OwnerActionSchema,
});

const UnblockRequestSchema = z.object({ issue: z.number().int().positive() });

const ModelRequestSchema = z.object({ model: ModelSchema });

// Only the one-click names: the label has to exist in the repo, and `default` removes it.
const TaskModelRequestSchema = z.object({
  issue: z.number().int().positive(),
  model: TaskModelChoiceSchema,
});

// `null` is the clear-the-override case; everything else must be a sane session count, so a
// fat-fingered 100000 cannot quietly uncap the Mac's daily spend.
const CapRequestSchema = z.object({ maxSessionsPerDay: CapSchema.nullable() });

/** Reads a small JSON body; anything unparsable (or over 8 KB) resolves to null. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8192) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
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
      if (d.auth) {
        // Credentials replace the Host check: a rebinding page never carries them, because the
        // browser caches Basic credentials per origin and the attacker's origin is not this one.
        if (!authorized(req.headers.authorization, d.auth)) {
          res.setHeader("www-authenticate", 'Basic realm="foreman"');
          return json(res, 401, { ok: false, error: "unauthorized" });
        }
      } else if (!isLocalHost(req.headers.host, bound)) {
        // Spec §7: every route is localhost-only, not just the POST actions.
        return json(res, 403, { ok: false, error: "localhost only" });
      }
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
      if (url === "/api/owner") {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const parsed = OwnerRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { ok: false, error: "bad request" });
        const { epic, action } = parsed.data;
        // The board is the allowlist: an epic the page is not offering, or an action it is not
        // offering for that epic, is refused rather than written to GitHub.
        const item = d.ownerItems().find((i) => i.epic === epic);
        if (!item?.actions.includes(action))
          return json(res, 400, { ok: false, error: `#${epic} does not offer ${action}` });
        return json(res, 200, { ok: true, message: await d.owner(epic, action) });
      }
      if (url === "/api/unblock") {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const parsed = UnblockRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { ok: false, error: "bad request" });
        const { issue } = parsed.data;
        // Same allowlist pattern as /api/owner: the board is the list of issues the page is
        // offering an Unblock for, so nothing else reaches GitHub.
        const item = d.needsYouItems().find((i) => i.issue === issue);
        if (!item?.labels.includes("blocked"))
          return json(res, 400, { ok: false, error: `#${issue} is not blocked` });
        return json(res, 200, { ok: true, message: await d.unblock(issue) });
      }
      if (url === "/api/model") {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const parsed = ModelRequestSchema.safeParse(await readJson(req));
        // A model name reaches `claude` as argv, so anything that is not a plain name — a flag,
        // a path, an empty string — is refused here rather than passed through.
        if (!parsed.success) return json(res, 400, { ok: false, error: "bad model name" });
        return json(res, 200, { ok: true, message: await d.setModel(parsed.data.model) });
      }
      if (url === "/api/task-model") {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const parsed = TaskModelRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { ok: false, error: "bad request" });
        const { issue, model } = parsed.data;
        // Same allowlist pattern as /api/owner: only a task the board lists under a phase.
        if (!d.phaseTasks().some((t) => t.issue === issue))
          return json(res, 400, { ok: false, error: `#${issue} is not a task on the board` });
        // TaskModelChoiceSchema now accepts any well-formed name; the repo's configured models
        // are the actual allowlist, checked here so a typo'd model does not reach a label.
        if (model !== MODEL_DEFAULT && !d.modelChoices().includes(model))
          return json(res, 400, { ok: false, error: "model not offered" });
        return json(res, 200, { ok: true, message: await d.setTaskModel(issue, model) });
      }
      if (url === "/api/cap") {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        const parsed = CapRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json(res, 400, { ok: false, error: "bad cap" });
        return json(res, 200, { ok: true, message: await d.setCap(parsed.data.maxSessionsPerDay) });
      }
      if (url === "/api/refresh") {
        // No body and no allowlist: the button only re-reads GitHub and wakes the loop, so there
        // is nothing to validate and nothing it can write (#249).
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        return json(res, 200, { ok: true, message: await d.refresh() });
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
