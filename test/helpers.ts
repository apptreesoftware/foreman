import type { Comment, Epic, Issue, PullRequest, Snapshot } from "../src/types.ts";

let n = 1000;
export const now = "2026-09-03T12:00:00Z";
export const hoursAgo = (h: number) => new Date(Date.parse(now) - h * 3600_000).toISOString();

export function comment(body: string, createdAt = hoursAgo(1), author = "acme"): Comment {
  return { author, body, createdAt };
}

export function issue(over: Partial<Issue> = {}): Issue {
  const number = over.number ?? n++;
  return {
    number,
    title: `Task ${number}`,
    body: "## Depends on\nNone\n\n## Spec\ndocs/x.md\n\nParent epic: #1",
    state: "OPEN",
    labels: ["phase:1", "agent-ready", "size:S", "area:web"],
    assignees: [],
    comments: [],
    updatedAt: hoursAgo(3),
    status: "Ready",
    itemId: `PVTI_${number}`,
    ...over,
  };
}

export function pr(over: Partial<PullRequest> = {}): PullRequest {
  const number = over.number ?? n++;
  return {
    number,
    title: `PR ${number}`,
    body: `Closes #${over.issue ?? 1}`,
    headRefName: `feat/${over.issue ?? 1}-x`,
    headSha: `${String(number).padStart(4, "0")}beefbeefbeefbeefbeefbeefbeefbeefbeef`.slice(0, 40),
    labels: [],
    isDraft: false,
    checks: "success",
    mergeable: "MERGEABLE",
    issue: over.issue ?? 1,
    updatedAt: hoursAgo(1),
    ...over,
  };
}

export function epic(over: Partial<Epic> = {}): Epic {
  return {
    number: over.number ?? n++,
    phase: 1,
    labels: ["epic", "phase:1", "plan-approved"],
    status: "In Progress",
    state: "OPEN",
    taskNumbers: [],
    directionCritical: false,
    specPath: null,
    ...over,
  };
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    host: "mac-a",
    now,
    issues: [],
    prs: [],
    epics: [epic()],
    branchLastCommitAt: {},
    ...over,
  };
}
