import type { Exec } from "./exec.ts";
import { log } from "./log.ts";
import { MODEL_LABEL_PREFIX, ModelSchema } from "./state-file.ts";
import type {
  BoardItem,
  CheckState,
  Comment,
  Issue,
  Mergeable,
  PullRequest,
  Size,
  Status,
} from "./types.ts";

export interface GhConfig {
  repo: string;
  owner: string;
  project: number;
}
type Kind = "issue" | "pr";

const STATUSES: Status[] = ["Backlog", "Ready", "In Progress", "In Review", "Done"];

export function parseChecks(
  rollup: Array<{ status?: string | null; conclusion?: string | null }>,
): CheckState {
  if (rollup.length === 0) return "none";
  const bad = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "ERROR",
  ]);
  if (rollup.some((c) => c.conclusion && bad.has(c.conclusion))) return "failure";
  if (rollup.some((c) => c.status !== "COMPLETED")) return "pending";
  return "success";
}

export function parseClosesIssue(body: string): number | null {
  const m = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved):?\s+#(\d+)/i.exec(
    body,
  );
  return m ? Number(m[1]) : null;
}

/** GitHub computes this lazily, so a fresh push reads UNKNOWN for a while; treat that as mergeable. */
export function parseMergeable(raw: string | undefined): Mergeable {
  return raw === "CONFLICTING" ? "CONFLICTING" : raw === "MERGEABLE" ? "MERGEABLE" : "UNKNOWN";
}

/**
 * The paths an issue's **Touches** section names, one per entry: comma- or line-separated,
 * with or without list markers and backticks. "None" and a missing section are empty.
 */
export function parseTouches(body: string): string[] {
  const m = /## Touches\s*\n([\s\S]*?)(?:\n## |$)/.exec(body);
  if (!m) return [];
  return (m[1] ?? "")
    .split(/[,\n]/)
    .map((x) =>
      x
        .trim()
        .replace(/^[-*]\s*/, "")
        .replace(/`/g, "")
        .trim()
        .replace(/\/+$/, ""),
    )
    .filter((x) => x.length > 0 && x.toLowerCase() !== "none");
}

/** True when a path in one list is the other's path or a parent directory of it. */
export function touchesOverlap(a: string[], b: string[]): boolean {
  const within = (p: string, q: string) => p === q || p.startsWith(`${q}/`);
  return a.some((p) => b.some((q) => within(p, q) || within(q, p)));
}

export function parseDependsOn(body: string): number[] {
  const m = /## Depends on\s*\n([\s\S]*?)(?:\n## |$)/.exec(body);
  if (!m) return [];
  return [...(m[1] ?? "").matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
}

export function phaseOf(labels: string[]): number | null {
  const l = labels.find((x) => x.startsWith("phase:"));
  return l ? Number(l.slice(6)) : null;
}

export function sizeOf(labels: string[]): Size | null {
  const l = labels.find((x) => x.startsWith("size:"));
  const s = l?.slice(5);
  return s === "S" || s === "M" || s === "L" ? s : null;
}

/**
 * The model a `model:<name>` label pins the issue's sessions to (#259). The name reaches `claude`
 * as argv, so one that fails `ModelSchema` — a flag, a path, an empty string — reads as no label.
 */
export function modelOf(labels: string[]): string | null {
  const l = labels.find((x) => x.startsWith(MODEL_LABEL_PREFIX));
  const name = l?.slice(MODEL_LABEL_PREFIX.length);
  return name && ModelSchema.safeParse(name).success ? name : null;
}

function names(labels: Array<{ name: string }> | undefined): string[] {
  return (labels ?? []).map((l) => l.name);
}

const ISSUE_FIELDS = "number,title,body,state,labels,assignees,comments,updatedAt";

interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
}

export class GitHub {
  private statusCache: {
    fieldId: string;
    projectId: string;
    options: Record<string, string>;
  } | null = null;
  /**
   * `project item-list` is the most expensive read the foreman makes (GraphQL, paged 100 at a
   * time) and every issue read needs it for Status and item id. One copy per tick, dropped by
   * any write that changes the board (#192).
   */
  private boardCache: BoardItem[] | null = null;

  constructor(
    private readonly cfg: GhConfig,
    private readonly exec: Exec,
    readonly dryRun: boolean,
  ) {}

  private async gh(args: string[]): Promise<string> {
    const r = await this.exec("gh", args);
    if (r.code !== 0)
      throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  private async write(args: string[]): Promise<void> {
    if (this.dryRun) {
      log("info", "dry-run: gh", { args });
      return;
    }
    await this.gh(args);
  }

  async viewerLogin(): Promise<string> {
    return (JSON.parse(await this.gh(["api", "user"])) as { login: string }).login;
  }

  /** Drops the cached board; call after any write that changes an item's status or membership. */
  invalidateBoard(): void {
    this.boardCache = null;
  }

  async listBoard(): Promise<BoardItem[]> {
    if (this.boardCache) return this.boardCache;
    const out = JSON.parse(
      await this.gh([
        "project",
        "item-list",
        String(this.cfg.project),
        "--owner",
        this.cfg.owner,
        "--format",
        "json",
        "--limit",
        "500",
      ]),
    ) as {
      items: Array<{ id: string; status?: string; content?: { number?: number; type?: string } }>;
    };
    this.boardCache = out.items
      .filter((i) => i.content?.type === "Issue" && typeof i.content.number === "number")
      .map((i) => ({
        itemId: i.id,
        issue: i.content?.number as number,
        status: STATUSES.includes(i.status as Status) ? (i.status as Status) : null,
      }));
    return this.boardCache;
  }

  private toIssue(i: RawIssue, b: BoardItem | undefined): Issue {
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      labels: names(i.labels),
      assignees: (i.assignees ?? []).map((a) => a.login),
      comments: (i.comments ?? []).map(
        (c): Comment => ({ author: c.author?.login ?? "", body: c.body, createdAt: c.createdAt }),
      ),
      updatedAt: i.updatedAt,
      status: b?.status ?? null,
      itemId: b?.itemId ?? null,
    };
  }

  async listIssues(state: "open" | "all" = "open"): Promise<Issue[]> {
    const raw = JSON.parse(
      await this.gh([
        "issue",
        "list",
        "--repo",
        this.cfg.repo,
        "--state",
        state,
        "--limit",
        "500",
        "--json",
        ISSUE_FIELDS,
      ]),
    ) as RawIssue[];
    const board = new Map((await this.listBoard()).map((b) => [b.issue, b]));
    return raw.map((i) => this.toIssue(i, board.get(i.number)));
  }

  /**
   * One issue, one query. This used to call `listIssues("all")` — every claim, merge, resume
   * and plan re-downloaded every issue in the repo with all of its comments, which is what
   * spent the hourly GraphQL budget (#192).
   */
  async getIssue(n: number): Promise<Issue> {
    const raw = JSON.parse(
      await this.gh(["issue", "view", String(n), "--repo", this.cfg.repo, "--json", ISSUE_FIELDS]),
    ) as RawIssue;
    return this.toIssue(
      raw,
      (await this.listBoard()).find((b) => b.issue === n),
    );
  }

  async listOpenPRs(): Promise<PullRequest[]> {
    const raw = JSON.parse(
      await this.gh([
        "pr",
        "list",
        "--repo",
        this.cfg.repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,body,headRefName,labels,isDraft,mergeable,statusCheckRollup,updatedAt",
      ]),
    ) as Array<{
      number: number;
      title: string;
      body: string;
      headRefName: string;
      isDraft: boolean;
      mergeable?: string;
      updatedAt: string;
      labels: Array<{ name: string }>;
      statusCheckRollup: Array<{ status?: string; conclusion?: string | null }>;
    }>;
    return raw.map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      headRefName: p.headRefName,
      labels: names(p.labels),
      isDraft: p.isDraft,
      checks: parseChecks(p.statusCheckRollup ?? []),
      mergeable: parseMergeable(p.mergeable),
      issue: parseClosesIssue(p.body ?? ""),
      updatedAt: p.updatedAt,
    }));
  }

  async subIssues(epic: number): Promise<number[]> {
    const out = JSON.parse(
      await this.gh(["api", `repos/${this.cfg.repo}/issues/${epic}/sub_issues`, "--paginate"]),
    ) as Array<{ number: number }>;
    return out.map((i) => i.number);
  }

  async branchLastCommitAt(branch: string): Promise<string | null> {
    const r = await this.exec("gh", [
      "api",
      `repos/${this.cfg.repo}/branches/${branch}`,
      "--jq",
      ".commit.commit.committer.date",
    ]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async statusField(): Promise<{
    fieldId: string;
    projectId: string;
    options: Record<string, string>;
  }> {
    if (this.statusCache) return this.statusCache;
    const fields = JSON.parse(
      await this.gh([
        "project",
        "field-list",
        String(this.cfg.project),
        "--owner",
        this.cfg.owner,
        "--format",
        "json",
      ]),
    ) as {
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
    };
    const status = fields.fields.find((f) => f.name === "Status");
    if (!status?.options) throw new Error("project has no Status field");
    const view = JSON.parse(
      await this.gh([
        "project",
        "view",
        String(this.cfg.project),
        "--owner",
        this.cfg.owner,
        "--format",
        "json",
      ]),
    ) as { id: string };
    this.statusCache = {
      fieldId: status.id,
      projectId: view.id,
      options: Object.fromEntries(status.options.map((o) => [o.name, o.id])),
    };
    return this.statusCache;
  }

  async setStatus(itemId: string, status: Status): Promise<void> {
    const f = await this.statusField();
    const opt = f.options[status];
    if (!opt) throw new Error(`no option for status ${status}`);
    await this.write([
      "project",
      "item-edit",
      "--project-id",
      f.projectId,
      "--id",
      itemId,
      "--field-id",
      f.fieldId,
      "--single-select-option-id",
      opt,
    ]);
    this.invalidateBoard();
  }

  async addToProject(issue: number): Promise<string> {
    if (this.dryRun) {
      log("info", "dry-run: gh project item-add", { issue });
      return "dry-run";
    }
    const out = JSON.parse(
      await this.gh([
        "project",
        "item-add",
        String(this.cfg.project),
        "--owner",
        this.cfg.owner,
        "--url",
        `https://github.com/${this.cfg.repo}/issues/${issue}`,
        "--format",
        "json",
      ]),
    ) as { id: string };
    this.invalidateBoard();
    return out.id;
  }

  comment(kind: Kind, n: number, body: string): Promise<void> {
    return this.write([kind, "comment", String(n), "--repo", this.cfg.repo, "--body", body]);
  }

  addLabels(kind: Kind, n: number, labels: string[]): Promise<void> {
    return this.write([
      kind,
      "edit",
      String(n),
      "--repo",
      this.cfg.repo,
      "--add-label",
      labels.join(","),
    ]);
  }

  removeLabels(kind: Kind, n: number, labels: string[]): Promise<void> {
    return this.write([
      kind,
      "edit",
      String(n),
      "--repo",
      this.cfg.repo,
      "--remove-label",
      labels.join(","),
    ]);
  }

  assign(issue: number, login: string): Promise<void> {
    return this.write([
      "issue",
      "edit",
      String(issue),
      "--repo",
      this.cfg.repo,
      "--add-assignee",
      login,
    ]);
  }

  unassign(issue: number, login: string): Promise<void> {
    return this.write([
      "issue",
      "edit",
      String(issue),
      "--repo",
      this.cfg.repo,
      "--remove-assignee",
      login,
    ]);
  }

  editBody(issue: number, body: string): Promise<void> {
    return this.write(["issue", "edit", String(issue), "--repo", this.cfg.repo, "--body", body]);
  }

  closeIssue(n: number): Promise<void> {
    return this.write(["issue", "close", String(n), "--repo", this.cfg.repo]);
  }

  mergePR(n: number): Promise<void> {
    return this.write([
      "pr",
      "merge",
      String(n),
      "--repo",
      this.cfg.repo,
      "--squash",
      "--delete-branch",
    ]);
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<number> {
    if (this.dryRun) {
      log("info", "dry-run: gh issue create", { title: input.title });
      return 0;
    }
    const url = (
      await this.gh([
        "issue",
        "create",
        "--repo",
        this.cfg.repo,
        "--title",
        input.title,
        "--body",
        input.body,
        "--label",
        input.labels.join(","),
      ])
    ).trim();
    return Number(url.split("/").pop());
  }

  async addSubIssue(epic: number, issue: number): Promise<void> {
    if (this.dryRun) return;
    const id = (
      await this.gh(["api", `repos/${this.cfg.repo}/issues/${issue}`, "--jq", ".id"])
    ).trim();
    await this.gh([
      "api",
      "-X",
      "POST",
      `repos/${this.cfg.repo}/issues/${epic}/sub_issues`,
      "-F",
      `sub_issue_id=${id}`,
    ]);
  }
}

export type GitHubApi = Pick<
  GitHub,
  | "listIssues"
  | "getIssue"
  | "listOpenPRs"
  | "subIssues"
  | "branchLastCommitAt"
  | "setStatus"
  | "addToProject"
  | "comment"
  | "addLabels"
  | "removeLabels"
  | "assign"
  | "unassign"
  | "editBody"
  | "closeIssue"
  | "mergePR"
  | "createIssue"
  | "addSubIssue"
  | "viewerLogin"
  | "dryRun"
>;
