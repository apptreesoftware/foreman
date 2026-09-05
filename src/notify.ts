import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Exec } from "./exec.ts";
import { log } from "./log.ts";

/**
 * Push notifications for the handful of foreman events that change what the owner has to do.
 * The page is localhost-only, so without these a merge, a blocked issue or a parked daemon is
 * invisible from a phone (#225).
 *
 * Two rules hold everywhere in this file:
 *
 * 1. Nothing here may fail a tick. Every send is wrapped; a dead webhook logs a warning.
 * 2. Only issue/PR numbers, titles and the foreman's own reason strings go out — never tool
 *    inputs, session transcripts, stderr excerpts or anything read out of the repo.
 */

export const NotifyConfigSchema = z.object({
  slackWebhookUrl: z.string().url().optional(),
  macos: z.boolean().optional(),
});
export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;

/** A slow webhook must never hold up a tick. */
export const SEND_TIMEOUT_MS = 5000;

/** A phone notification shows one line; titles and reasons are cut to this before it wraps. */
export const MAX_LINE = 160;

export const MACOS_TITLE = "Tone & Tonic foreman";

export type NotifyEvent =
  | { kind: "merged"; pr: number; issue: number; title: string }
  | { kind: "blocked"; issue: number; title: string; reason: string }
  | { kind: "decision"; issue: number; title: string }
  | { kind: "phase_closed"; epic: number; title: string; review: number | null }
  | { kind: "plan_drafted"; epic: number; title: string; pr: number | null }
  | { kind: "parked"; reason: string }
  | { kind: "resumed"; was: string };

/** What `syncDecisions` needs of an issue; `Issue` from types.ts satisfies it. */
export interface LabelledIssue {
  number: number;
  title: string;
  labels: string[];
}

export interface NotifyPort {
  send(event: NotifyEvent): Promise<void>;
  /** All open issues this tick; the decision-labelled ones are announced once each. */
  syncDecisions(issues: LabelledIssue[]): Promise<void>;
  /** This tick's preflight reason, or null when preflight passed. */
  syncParked(reason: string | null): Promise<void>;
}

export const noopNotify: NotifyPort = {
  async send() {},
  async syncDecisions() {},
  async syncParked() {},
};

/**
 * One line, collapsed and capped. A blocked reason is multi-line by construction (the role's
 * notes, a stack trace); only its first line is ever of use on a phone, and the cap is what
 * keeps an accidental transcript out of a notification.
 */
export function oneLine(s: string, max = MAX_LINE): string {
  const first = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

export function formatEvent(e: NotifyEvent, o: { repo: string; host: string }): string {
  const { repo } = o;
  const t = (s: string) => oneLine(s);
  switch (e.kind) {
    case "merged":
      return `merged #${e.pr} → closes #${e.issue}: ${t(e.title)} ${prUrl(repo, e.pr)}`;
    case "blocked": {
      // The title is missing when the issue was not in the tick's snapshot; skip it rather than
      // rendering the double space its separator would leave.
      const title = t(e.title);
      return `blocked #${e.issue}${title === "" ? "" : ` ${title}`} — ${t(e.reason)} ${issueUrl(
        repo,
        e.issue,
      )}`;
    }
    case "decision":
      return `decision needed #${e.issue}: ${t(e.title)} ${issueUrl(repo, e.issue)}`;
    case "phase_closed":
      return e.review === null
        ? `phase ${e.epic} closed: ${t(e.title)} — review issue on the epic ${issueUrl(repo, e.epic)}`
        : `phase ${e.epic} closed: ${t(e.title)} — review #${e.review} ${issueUrl(repo, e.review)}`;
    case "plan_drafted":
      return `plan drafted for #${e.epic}: ${t(e.title)} ${
        e.pr === null ? issueUrl(repo, e.epic) : prUrl(repo, e.pr)
      }`;
    case "parked":
      return `foreman parked on ${o.host}: ${t(e.reason)}`;
    case "resumed":
      return `foreman resumed on ${o.host} (was: ${t(e.was)})`;
  }
}

/**
 * Dedup state, so a parked daemon announces itself once per spell rather than once per tick and
 * a decision issue is announced once rather than for as long as it stays open.
 *
 * `decisions: null` means "never synced": the first sync seeds the list silently, so enabling
 * notifications on a repo with a decision backlog does not replay it.
 */
export const NotifyStateSchema = z.object({
  version: z.literal(1),
  decisions: z.array(z.number().int()).nullable().default(null),
  /** The reason the current parked spell is on now; null when the daemon is not parked. */
  parked: z.string().nullable().default(null),
});
export type NotifyState = z.infer<typeof NotifyStateSchema>;

export function notifyStatePath(stateDir: string): string {
  return join(stateDir, "notify.json");
}

/** Null when the file is missing or unreadable; a bad file must not stop the daemon. */
export function readNotifyState(stateDir: string): NotifyState | null {
  const p = notifyStatePath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = NotifyStateSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Temp file then rename, like state.json, so a reader never sees a partial file. */
export function writeNotifyState(stateDir: string, s: NotifyState): void {
  mkdirSync(stateDir, { recursive: true });
  const p = notifyStatePath(stateDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, p);
}

export interface NotifierDeps {
  fetch: typeof fetch;
  exec: Exec;
  stateDir: string;
  repo: string;
  host: string;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function postSlack(url: string, text: string, f: typeof fetch): Promise<void> {
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Never log the URL: an incoming webhook URL is the credential.
    if (!res.ok) log("warn", "slack notification rejected", { status: res.status });
  } catch (err) {
    log("warn", "slack notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function postMacos(text: string, exec: Exec): Promise<void> {
  const script = `display notification "${escapeAppleScript(text)}" with title "${escapeAppleScript(
    MACOS_TITLE,
  )}"`;
  try {
    const r = await exec("osascript", ["-e", script], { timeoutMs: SEND_TIMEOUT_MS });
    if (r.code !== 0)
      log("warn", "macos notification failed", { stderr: oneLine(r.stderr, MAX_LINE) });
  } catch (err) {
    log("warn", "macos notification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createNotifier(cfg: NotifyConfig | undefined, deps: NotifierDeps): NotifyPort {
  const webhook = cfg?.slackWebhookUrl;
  const macos = cfg?.macos === true;
  // With neither channel configured the foreman behaves exactly as it did before #225: no sends,
  // and no notify.json on disk either.
  if (!webhook && !macos) return noopNotify;

  const patch = (p: Partial<NotifyState>): void => {
    const prev = readNotifyState(deps.stateDir) ?? {
      version: 1 as const,
      decisions: null,
      parked: null,
    };
    try {
      writeNotifyState(deps.stateDir, { ...prev, ...p });
    } catch (err) {
      // A state file we cannot write means events repeat; that beats failing the tick.
      log("warn", "notify state write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const send = async (event: NotifyEvent): Promise<void> => {
    const text = formatEvent(event, { repo: deps.repo, host: deps.host });
    if (webhook) await postSlack(webhook, text, deps.fetch);
    if (macos) await postMacos(text, deps.exec);
  };

  return {
    send,
    async syncDecisions(issues) {
      const open = issues.filter((i) => i.labels.includes("decision"));
      const prev = readNotifyState(deps.stateDir);
      const numbers = open.map((i) => i.number);
      if (prev?.decisions == null) {
        patch({ decisions: numbers });
        return;
      }
      const seen = new Set(prev.decisions);
      for (const i of open.filter((i) => !seen.has(i.number)))
        await send({ kind: "decision", issue: i.number, title: i.title });
      // Only the still-open ones are kept, so a decision issue that is closed and reopened is
      // announced again — which is the right answer; it is a fresh call on the owner.
      if (numbers.join() !== prev.decisions.join()) patch({ decisions: numbers });
    },
    async syncParked(reason) {
      const parked = readNotifyState(deps.stateDir)?.parked ?? null;
      if (reason === null) {
        if (parked === null) return; // healthy tick: nothing to say and nothing to write
        await send({ kind: "resumed", was: parked });
        patch({ parked: null });
        return;
      }
      if (parked === null) {
        await send({ kind: "parked", reason });
        patch({ parked: reason });
        return;
      }
      // Still the same spell: record what it is parked on now (so the resume line is accurate)
      // but stay quiet — the point of the spell is that this fires once, not once per tick.
      if (parked !== reason) patch({ parked: reason });
    },
  };
}
