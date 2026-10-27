import { parseDependsOn, phaseOf } from "./github.ts";
import { taskNumbersOf } from "./phase-progress.ts";
import {
  type BoardGroup,
  type BoardIssue,
  EFFORT_LABEL_PREFIX,
  MODEL_LABEL_PREFIX,
} from "./state-file.ts";
import type { Epic, Snapshot } from "./types.ts";

const SHOWN_LABEL = /^(blocked|size:.+|area:.+)$/;

function epicState(e: Epic): BoardGroup["state"] {
  const has = (l: string) => e.labels.includes(l);
  // needs-owner means two things; plan-approved tells them apart, as on the Owner gates.
  if (has("needs-owner")) return has("plan-approved") ? "signoff_waiting" : "plan_waiting";
  if (has("plan-approved")) return "building";
  if (has("agent-ready")) return "planning";
  return "not_started";
}

const labelValue = (labels: string[], prefix: string) =>
  labels.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? null;

/**
 * Every open issue on the Board tab, grouped under the epic it belongs to. The epic is the open
 * one whose task set (sub-issues plus `Parent epic:` lines) includes the issue; failing that, the
 * only open epic with the issue's `phase:<N>` label. Issues neither rule places are grouped by
 * phase — `unlinked` when several open epics share it, `closed` when none is open — or "No phase".
 * Computed from the snapshot the tick already has, so the tab costs no GitHub reads.
 */
export function describeBoardIssues(s: Snapshot): { issues: BoardIssue[]; groups: BoardGroup[] } {
  const open = new Set(s.issues.map((i) => i.number));
  const epics = s.epics
    .filter((e) => e.state === "OPEN")
    .sort((a, b) => a.phase - b.phase || a.number - b.number);
  const tasksOf = new Map(epics.map((e) => [e.number, taskNumbersOf(e, s.issues)]));
  const titleOf = (n: number) => s.issues.find((i) => i.number === n)?.title ?? `#${n}`;

  const groups = new Map<string, BoardGroup>();
  for (const e of epics) {
    groups.set(`epic:${e.number}`, {
      key: `epic:${e.number}`,
      kind: "epic",
      epic: e.number,
      phase: e.phase,
      title: titleOf(e.number),
      state: epicState(e),
      paused: e.labels.includes("foreman:pause"),
      doneTasks: [...(tasksOf.get(e.number) ?? [])]
        .filter((n) => !open.has(n))
        .sort((a, b) => a - b),
    });
  }
  const extra = (key: string, kind: BoardGroup["kind"], phase: number | null, title: string) => {
    if (!groups.has(key))
      groups.set(key, {
        key,
        kind,
        epic: null,
        phase,
        title,
        state: null,
        paused: false,
        doneTasks: [],
      });
    return key;
  };
  const groupOf = (n: number, labels: string[]): string => {
    const owner = epics.find((e) => tasksOf.get(e.number)?.has(n));
    if (owner) return `epic:${owner.number}`;
    const phase = phaseOf(labels);
    if (phase === null) return extra("none", "none", null, "No phase");
    const same = epics.filter((e) => e.phase === phase);
    if (same.length === 1) return `epic:${(same[0] as Epic).number}`;
    return same.length > 1
      ? extra(
          `phase:${phase}:unlinked`,
          "unlinked",
          phase,
          `Phase ${phase} · not linked to an epic`,
        )
      : extra(`phase:${phase}:closed`, "closed", phase, `Phase ${phase} · epic closed`);
  };

  const issues: BoardIssue[] = s.issues
    .filter((i) => i.state === "OPEN" && !i.labels.includes("epic"))
    .sort((a, b) => a.number - b.number)
    .map((i) => {
      const dependsOn = parseDependsOn(i.body);
      return {
        issue: i.number,
        title: i.title,
        status: i.status,
        labels: i.labels.filter((l) => SHOWN_LABEL.test(l)),
        group: groupOf(i.number, i.labels),
        pr: s.prs.find((p) => p.issue === i.number)?.number ?? null,
        dependsOn,
        openDependsOn: dependsOn.filter((d) => open.has(d)),
        blocked: i.labels.includes("blocked"),
        model: labelValue(i.labels, MODEL_LABEL_PREFIX),
        effort: labelValue(i.labels, EFFORT_LABEL_PREFIX),
      };
    });

  const rank = (g: BoardGroup) => (g.kind === "epic" ? 0 : g.kind === "none" ? 2 : 1);
  const ordered = [...groups.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      // Epic groups keep the epic order above; the phase groups sort by phase.
      (rank(a) === 1 ? (a.phase ?? 0) - (b.phase ?? 0) : 0),
  );
  return { issues, groups: ordered };
}
