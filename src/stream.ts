import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { FeedEntry } from "./feed.ts";

export const ActivitySchema = z.object({
  startedAt: z.string().nullable(),
  model: z.string().nullable(),
  turns: z.number().int(),
  events: z.number().int(),
  lastEventAt: z.string().nullable(),
  lastMessageId: z.string().nullable(),
  lastTool: z
    .object({ name: z.string(), summary: z.string(), at: z.string(), subagent: z.boolean() })
    .nullable(),
  lastText: z.object({ text: z.string(), at: z.string() }).nullable(),
  lastError: z.object({ tool: z.string(), at: z.string() }).nullable(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  rateLimit: z
    .object({ fiveHour: z.number(), sevenDay: z.number(), resetsAt: z.string() })
    .nullable(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export function emptyActivity(): Activity {
  return {
    startedAt: null,
    model: null,
    turns: 0,
    events: 0,
    lastEventAt: null,
    lastMessageId: null,
    lastTool: null,
    lastText: null,
    lastError: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    rateLimit: null,
  };
}

export const SUMMARY_MAX = 120;
export const TEXT_MAX = 300;

export function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function rel(p: unknown, worktree: string): string {
  if (typeof p !== "string") return "";
  return isAbsolute(p) && (p === worktree || p.startsWith(`${worktree}/`))
    ? relative(worktree, p) || "."
    : p;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");
type Input = Record<string, unknown>;

/** One line, ≤ SUMMARY_MAX chars, never the raw input. */
export function summarizeToolUse(name: string, input: unknown, worktree: string): string {
  const i = (input && typeof input === "object" ? input : {}) as Input;
  let s: string;
  switch (name) {
    case "Bash":
      s = str(i.description) || str(i.command);
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      s = rel(i.file_path ?? i.notebook_path, worktree);
      break;
    case "Grep":
    case "Glob": {
      const p = rel(i.path, worktree);
      s = p ? `${str(i.pattern)} in ${p}` : str(i.pattern);
      break;
    }
    case "Skill":
      s = str(i.skill);
      break;
    case "Agent":
      s = str(i.description);
      break;
    default: {
      // Any MCP tool, whatever servers a repository configures: `mcp__<server>__<tool>` reads
      // as `<server>:<tool>`. The inputs are never summarised — an MCP tool's arguments are
      // arbitrary and may carry the body of a message — so only the name goes to the feed.
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      s = mcp ? `${mcp[1]}:${mcp[2]}` : name;
    }
  }
  return cut(s || name, SUMMARY_MAX);
}

export interface FoldResult {
  activity: Activity;
  entries: FeedEntry[];
}

interface Block {
  type?: string;
  name?: string;
  input?: unknown;
  text?: string;
  is_error?: boolean;
}
interface Msg {
  id?: string;
  content?: Block[];
  usage?: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Pure and total: any line the folder does not understand only bumps `events`. */
export function foldEvent(a: Activity, line: string, nowIso: string, worktree: string): FoldResult {
  const next: Activity = { ...a, events: a.events + 1 };
  const entries: FeedEntry[] = [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { activity: next, entries };
  }
  if (!j || typeof j !== "object") return { activity: next, entries };
  const at = typeof j.timestamp === "string" ? j.timestamp : nowIso;

  if (j.type === "system" && j.subtype === "init") {
    next.startedAt = nowIso;
    next.model = str(j.model) || null;
    entries.push({ t: nowIso, kind: "init", model: next.model ?? "" });
    return { activity: next, entries };
  }

  if (j.type === "rate_limit_event") {
    const info = (j.rate_limit_info ?? {}) as Record<string, unknown>;
    const w = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>;
    const five = w.five_hour ?? {};
    const seven = w.seven_day ?? {};
    if (typeof five.utilization === "number") {
      next.rateLimit = {
        fiveHour: five.utilization,
        sevenDay: num(seven.utilization),
        resetsAt: new Date(num(five.resetsAt) * 1000).toISOString(),
      };
      entries.push({
        t: at,
        kind: "rate_limit",
        fiveHour: five.utilization,
        sevenDay: num(seven.utilization),
      });
    }
    return { activity: next, entries };
  }

  if (j.type === "assistant") {
    const m = (j.message ?? {}) as Msg;
    next.lastEventAt = at;
    if (m.id && m.id !== a.lastMessageId) {
      next.turns = a.turns + 1;
      next.lastMessageId = m.id;
      const u = m.usage ?? {};
      next.tokens = {
        input: a.tokens.input + num(u.input_tokens),
        output: a.tokens.output + num(u.output_tokens),
        cacheRead: a.tokens.cacheRead + num(u.cache_read_input_tokens),
        cacheWrite: a.tokens.cacheWrite + num(u.cache_creation_input_tokens),
      };
    }
    const subagent = j.parent_tool_use_id != null;
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && typeof b.name === "string") {
        const summary = `${subagent ? "↳ " : ""}${summarizeToolUse(b.name, b.input, worktree)}`;
        next.lastTool = { name: b.name, summary, at, subagent };
        entries.push({ t: at, kind: "tool", name: b.name, summary, subagent });
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const text = cut(b.text, TEXT_MAX);
        next.lastText = { text, at };
        entries.push({ t: at, kind: "text", text });
      }
    }
    return { activity: next, entries };
  }

  if (j.type === "user") {
    const m = (j.message ?? {}) as Msg;
    next.lastEventAt = at;
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_result" && b.is_error) {
        const tool = a.lastTool?.name ?? "unknown";
        next.lastError = { tool, at };
        entries.push({ t: at, kind: "tool_error", name: tool });
      }
    }
    return { activity: next, entries };
  }

  return { activity: next, entries };
}
