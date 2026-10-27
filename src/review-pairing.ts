import type { Snapshot } from "./types.ts";

const REVIEW_COMMENT = /^Phase review: #(\d+)/m;
/** The title `roles/phase-closer.md` gives a phase review: `Phase <N> review: <epic title>`. */
export const PHASE_REVIEW_TITLE = /^Phase .+ review: (.+)$/;
const PHASE_PREFIX = /^Phase [^:]+:\s*/;

/**
 * Which open epic each phase review issue belongs to: review issue number → epic number. The
 * phase-closer links the review from the epic with a `Phase review: #<n>` comment, which is the
 * truth when present; otherwise the epic's title (its `Phase <X>:` prefix dropped) inside the
 * review's title. Never by `phase:<N>` alone — several open epics can share a phase number.
 */
export function pairReviews(s: Snapshot): Map<number, number> {
  const pairs = new Map<number, number>();
  const epics = s.epics
    .filter((e) => e.state === "OPEN")
    .flatMap((e) => {
      const i = s.issues.find((x) => x.number === e.number);
      return i ? [i] : [];
    });
  for (const e of epics) {
    for (const c of e.comments) {
      const m = REVIEW_COMMENT.exec(c.body);
      if (m) pairs.set(Number(m[1]), e.number);
    }
  }
  for (const r of s.issues) {
    if (pairs.has(r.number) || r.labels.includes("epic")) continue;
    const m = PHASE_REVIEW_TITLE.exec(r.title);
    if (!m) continue;
    const owner = epics.find((e) => {
      const name = e.title.replace(PHASE_PREFIX, "").trim();
      return name.length > 0 && (m[1] ?? "").includes(name);
    });
    if (owner) pairs.set(r.number, owner.number);
  }
  return pairs;
}
