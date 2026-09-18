import { mergeDecision } from "./merge.ts";
import { matchedSkipLabels } from "./pick.ts";
import { defaultRepoConfig, type RepoConfig } from "./repo-config.ts";
import { plan } from "./state.ts";
import type { Action, Snapshot } from "./types.ts";

export interface NextReport {
  actions: string[];
  /** Index of the first action that would start a claude session; null when none would. */
  stopAt: number | null;
  explain: string[];
  prs: Array<{
    pr: number;
    issue: number | null;
    status: string;
    checks: string;
    labels: string[];
    reason: string;
  }>;
}

const SESSION_ACTIONS = new Set(["claim", "resume", "reclaim", "phase_close", "plan"]);

export function actionName(a: Action): string {
  return a.type === "idle" ? `idle(${a.reason})` : `${a.type}#${"issue" in a ? a.issue : a.epic}`;
}

function explain(a: Action, s: Snapshot, repo: RepoConfig): string {
  const title = (n: number) => s.issues.find((i) => i.number === n)?.title ?? "";
  switch (a.type) {
    case "plan":
      return `${actionName(a)}: planner on epic #${a.epic} "${title(a.epic)}" (lowest open epic labelled agent-ready; nothing building, no plan awaiting the owner)`;
    case "phase_close":
      return `${actionName(a)}: phase-closer on epic #${a.epic} "${title(a.epic)}" (every task closed)`;
    case "apply_plan":
      return `${actionName(a)}: create/update task issues from the approved plan of epic #${a.epic}`;
    case "claim":
      return `${actionName(a)}: ${a.role} on #${a.issue} "${title(a.issue)}" ${a.rebase ? "rebase" : `round ${a.round}`}${a.pr ? ` (PR #${a.pr})` : ""}`;
    case "resume":
      return `${actionName(a)}: resume ${a.role} session ${a.sessionId ?? "(fresh id)"} on #${a.issue}`;
    case "reclaim":
      return `${actionName(a)}: reclaim #${a.issue} from ${a.fromHost} (idle for 2h)`;
    case "merge":
      return `${actionName(a)}: squash-merge PR #${a.pr} (CI green, approved, validated)`;
    case "ci_rerun":
      return `${actionName(a)}: rerun the failed jobs of PR #${a.pr} at ${a.sha.slice(0, 7)} (no session, one free retry per push)`;
    case "skip_validator": {
      const labels = s.issues.find((i) => i.number === a.issue)?.labels ?? [];
      return `${actionName(a)}: label PR #${a.pr} validator:skipped (issue carries only ${matchedSkipLabels(labels, repo.validator.skipLabels).join(", ")})`;
    }
    case "block":
      return `${actionName(a)}: label #${a.issue} blocked (${a.reason})`;
    case "release":
      return `${actionName(a)}: release claim on #${a.issue} (${a.reason})`;
    case "idle":
      return `idle: ${a.reason}`;
  }
}

export function describeNext(s: Snapshot, repo: RepoConfig = defaultRepoConfig()): NextReport {
  const actions = plan(s, repo);
  const stopIdx = actions.findIndex((a) => SESSION_ACTIONS.has(a.type));
  return {
    actions: actions.map(actionName),
    stopAt: stopIdx === -1 ? null : stopIdx,
    explain: actions.map((a) => explain(a, s, repo)),
    prs: s.prs.map((p) => {
      const issue = p.issue === null ? undefined : s.issues.find((i) => i.number === p.issue);
      const d = issue ? mergeDecision(p, issue) : { ok: false as const, reason: "no open issue" };
      return {
        pr: p.number,
        issue: p.issue,
        status: issue?.status ?? "–",
        checks: p.checks,
        labels: p.labels,
        reason: d.ok ? "eligible to merge" : d.reason,
      };
    }),
  };
}

export function formatNext(r: NextReport): string {
  const lines: string[] = [];
  lines.push(
    `plan   ${r.actions.map((a, i) => (i === r.stopAt ? `${a}  ← would stop here` : a)).join("\n       ")}`,
  );
  for (const e of r.explain) lines.push(`       ${e}`);
  lines.push(
    r.prs.length
      ? `PRs    ${r.prs
          .map(
            (p) =>
              `#${p.pr} → ${p.issue === null ? "?" : `#${p.issue}`}  status ${p.status}  checks ${p.checks}  labels [${p.labels.join(",")}]   ${
                p.reason === "eligible to merge" ? p.reason : `not eligible: ${p.reason}`
              }`,
          )
          .join("\n       ")}`
      : "PRs    none open",
  );
  return `${lines.join("\n")}\n`;
}
