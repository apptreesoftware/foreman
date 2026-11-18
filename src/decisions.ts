import type { Comment } from "./types.ts";

/** The decision layout's last line: the one task this decision blocks. */
const BLOCKS = /^Blocks: #(\d+)\s*$/m;
/** The first line of the comment the decisions page posts when someone settles. */
const SETTLED = /^Settled: (.+)$/;
const MAX_ANSWER = 500;

export function parseBlocks(body: string): number | null {
  const m = BLOCKS.exec(body);
  return m ? Number(m[1]) : null;
}

/**
 * The answer to quote on the resumed task: the earliest `Settled:` comment wins, so two people
 * settling at once resolve to whoever was first. Null when the decision was answered some other
 * way, e.g. closed by hand on GitHub.
 */
export function settledAnswer(comments: Comment[]): string | null {
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const first = (c.body.trim().split("\n")[0] ?? "").trim();
    const m = SETTLED.exec(first);
    if (m) return (m[1] as string).trim().slice(0, MAX_ANSWER);
  }
  return null;
}
