import type { Board, WaitItem } from "./state-file.ts";

/** Waits that stop this Mac taking any new work; the page shows them as banners, not rows. */
export const BANNER_KINDS = ["stop", "preflight", "cap", "paused"] as const;

/** What the page's navigation badges, banners and Waiting on tab show. */
export interface Attention {
  /** The Needs you badge: decisions only the owner can make. */
  needsYou: number;
  /** The Waiting on badge; always `waitRows.length`. */
  waiting: number;
  banners: WaitItem[];
  waitRows: WaitItem[];
}

const numberIn = (subject: string) => {
  const m = /#(\d+)/.exec(subject);
  return m ? Number(m[1]) : null;
};

const list = (ns: string[]) =>
  ns.length < 2 ? (ns[0] ?? "") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;

/**
 * Turns the board into what the page counts and lists, so the badge and the rows it counts can
 * never disagree. A `human` wait for an issue or epic already on Needs you is not repeated on
 * Waiting on, and one issue's dependency waits read as one row.
 */
export function describeAttention(board: Board | null): Attention {
  if (!board) return { needsYou: 0, waiting: 0, banners: [], waitRows: [] };
  const gated = board.owner.filter((o) =>
    o.actions.some((a) => a === "approve_plan" || a === "sign_off"),
  );
  const needsYou = gated.length + board.needsYou.filter((n) => n.reviewOf === null).length;
  // Every issue or epic that has a row of its own on Needs you, Ready to plan included.
  const onNeedsYou = new Set([
    ...board.owner
      .filter((o) => o.actions.some((a) => a !== "pause" && a !== "unpause"))
      .map((o) => o.epic),
    ...board.needsYou.map((n) => n.issue),
  ]);
  const isBanner = (w: WaitItem) => (BANNER_KINDS as readonly string[]).includes(w.kind);
  const banners = board.waiting.filter(isBanner);
  const waitRows: WaitItem[] = [];
  const deps = new Map<string, { row: WaitItem; on: string[] }>();
  for (const w of board.waiting) {
    if (isBanner(w)) continue;
    const n = numberIn(w.subject);
    if (w.kind === "human" && n !== null && onNeedsYou.has(n)) continue;
    if (w.kind === "dependency") {
      const on = w.detail.slice(w.detail.lastIndexOf(" ") + 1);
      const seen = deps.get(w.subject);
      if (seen) {
        seen.on.push(on);
        const since = [seen.row.since, w.since].filter((x): x is string => x !== null).sort()[0];
        seen.row.since = since ?? null;
        seen.row.detail = `${w.subject} waits on ${list(seen.on)}`;
        continue;
      }
      const row = { ...w };
      deps.set(w.subject, { row, on: [on] });
      waitRows.push(row);
      continue;
    }
    waitRows.push(w);
  }
  return { needsYou, waiting: waitRows.length, banners, waitRows };
}
