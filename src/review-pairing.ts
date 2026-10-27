import type { Snapshot } from "./types.ts";

const REVIEW_COMMENT = /^Phase review: #(\d+)/gm;
/** The title `roles/phase-closer.md` gives a phase review: `Phase <N> review: <epic title>`. */
export const PHASE_REVIEW_TITLE = /^Phase .+ review: (.+)$/;
const PHASE_PREFIX = /^Phase [^:]+:\s*/;

/**
 * Which open epic each phase review issue belongs to: review issue number → epic number. Only an
 * epic waiting on its sign-off (`needs-owner` and `plan-approved`) takes a review, and only one —
 * the page shows the pair on that epic's Sign off row, so anything else has to keep its own row.
 * The phase-closer links the review from the epic with a `Phase review: #<n>` comment, which wins
 * when present (the newest one); otherwise the review's title must name the epic exactly, with or
 * without the epic's `Phase <X>:` prefix. Never by `phase:<N>` alone — several open epics can
 * share a phase number — and never by a substring, which would let an epic called "UI" swallow
 * an unrelated review.
 */
export function pairReviews(s: Snapshot): Map<number, number> {
  const pairs = new Map<number, number>();
  const signOff = s.epics
    .filter(
      (e) =>
        e.state === "OPEN" &&
        e.labels.includes("needs-owner") &&
        e.labels.includes("plan-approved"),
    )
    .flatMap((e) => {
      const i = s.issues.find((x) => x.number === e.number);
      return i ? [i] : [];
    });
  const isReview = (n: number) => {
    const r = s.issues.find((x) => x.number === n);
    return r !== undefined && !r.labels.includes("epic");
  };
  const taken = new Set<number>();
  for (const e of signOff) {
    const linked = [...e.comments]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((c) => [...c.body.matchAll(REVIEW_COMMENT)].map((m) => Number(m[1])))
      .filter(isReview);
    const newest = linked[linked.length - 1];
    if (newest !== undefined && !pairs.has(newest)) {
      pairs.set(newest, e.number);
      taken.add(e.number);
    }
  }
  for (const r of s.issues) {
    if (pairs.has(r.number) || r.labels.includes("epic")) continue;
    const named = PHASE_REVIEW_TITLE.exec(r.title)?.[1]?.trim();
    if (!named) continue;
    const owner = signOff.find(
      (e) =>
        !taken.has(e.number) &&
        (named === e.title.trim() || named === e.title.replace(PHASE_PREFIX, "").trim()),
    );
    if (owner) {
      pairs.set(r.number, owner.number);
      taken.add(owner.number);
    }
  }
  return pairs;
}
