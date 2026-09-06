import { modelOf } from "./github.ts";
import { fixRound, openClaim } from "./ledger.ts";
import { mergeDecision } from "./merge.ts";
import { issuePhase, validatorRequired } from "./pick.ts";
import type { PipelineRow, StageState } from "./state-file.ts";
import type { Snapshot } from "./types.ts";

const STATUS_RANK: Record<string, number> = { "In Progress": 0, "In Review": 1 };

export function describePipeline(s: Snapshot): PipelineRow[] {
  const rows: PipelineRow[] = [];
  for (const i of s.issues) {
    if (i.state !== "OPEN" || i.labels.includes("epic")) continue;
    const pr = s.prs.find((p) => p.issue === i.number && !p.isDraft) ?? null;
    if (i.status !== "In Progress" && i.status !== "In Review" && !pr) continue;
    const open = openClaim(i.comments);
    const role = open?.claim.role ?? null;
    const has = (l: string) => pr?.labels.includes(l) ?? false;

    const build: StageState = pr ? "done" : role === "builder" ? "active" : "pending";
    const review: StageState = has("reviewer:approved")
      ? "done"
      : has("reviewer:changes")
        ? "failed"
        : role === "reviewer"
          ? "active"
          : "pending";
    let validate: StageState = "pending";
    if (has("validator:passed")) validate = "done";
    else if (has("validator:skipped")) validate = "skipped";
    else if (has("validator:failed")) validate = "failed";
    else if (role === "validator") validate = "active";
    else if (review === "done" && !validatorRequired(i.labels)) validate = "skipped";
    const merge: StageState = pr && mergeDecision(pr, i).ok ? "active" : "pending";

    rows.push({
      issue: i.number,
      title: i.title,
      phase: issuePhase(i),
      status: i.status,
      pr: pr?.number ?? null,
      stages: { build, review, validate, ci: pr?.checks ?? "none", merge },
      claim: open
        ? {
            host: open.claim.host,
            role: open.claim.role,
            round: open.claim.round,
            at: open.claim.at,
          }
        : null,
      fixRound: fixRound(i.comments),
      blocked: i.labels.includes("blocked"),
      model: modelOf(i.labels),
    });
  }
  return rows.sort(
    (a, b) =>
      a.phase - b.phase ||
      (STATUS_RANK[a.status ?? ""] ?? 2) - (STATUS_RANK[b.status ?? ""] ?? 2) ||
      a.issue - b.issue,
  );
}
