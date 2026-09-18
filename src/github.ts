import type { Exec } from "./exec.ts";
import { log } from "./log.ts";
import { MODEL_LABEL_PREFIX, ModelSchema } from "./state-file.ts";
import type { CheckState, Comment, Issue, Mergeable, PullRequest, Size, Status } from "./types.ts";

export interface GhConfig {
  repo: string;
  owner: string;
  /** Undefined until `foreman init` has created the board; nothing that reads it runs before then. */
  project: number | undefined;
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

/** The `Parent epic: #N` line the planner ends every task body with; null when absent. */
export function parentEpicOf(body: string): number | null {
  const m = /^Parent epic:\s*#(\d+)\s*$/m.exec(body);
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

/**
 * Everything the foreman knows about an issue, including where it sits on the board. The page
 * sizes are the ones `gh issue list --json` uses itself, so the ledger window is unchanged
 * (#387) — `planApplied` and `ciRerunCount` read comments an arbitrary distance back.
 */
const ISSUE_NODE = `
    number
    title
    body
    state
    updatedAt
    labels(first: 100) { nodes { name } }
    assignees(first: 100) { nodes { login } }
    comments(last: 100) { nodes { author { login } body createdAt } }
    projectItems(first: 5, includeArchived: false) {
      nodes {
        id
        project { number }
        fieldValueByName(name: "Status") {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
      }
    }`;

/**
 * The board Status and item id come from the issue's own `projectItems` rather than from a
 * separate `gh project item-list`, which cost 306 of the tick's 310 GraphQL points: it paged
 * every field value of every item on the board — closed issues included — to read three fields
 * off the handful the foreman had just fetched (#387). This query costs 5.
 *
 * `states` is baked into the string rather than passed as a variable because `gh api graphql`
 * has no way to send a list argument.
 */
const issuesQuery = (state: "open" | "all"): string => `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $cursor
      ${state === "open" ? "states: OPEN" : ""}
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {${ISSUE_NODE}
      }
    }
  }
}`;

const ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {${ISSUE_NODE}
    }
  }
}`;

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  comments: {
    nodes: Array<{ author: { login: string } | null; body: string; createdAt: string }>;
  };
  projectItems: {
    nodes: Array<{
      id: string;
      project: { number: number } | null;
      fieldValueByName: { name?: string } | null;
    }>;
  };
}

export class GitHub {
  private statusCache: {
    fieldId: string;
    projectId: string;
    options: Record<string, string>;
  } | null = null;

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

  async defaultBranch(): Promise<string> {
    const out = await this.gh([
      "repo",
      "view",
      this.cfg.repo,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    return out.trim() || "main";
  }

  /** `owner`/`name` for the repository query; `cfg.owner` owns the project, not necessarily the repo. */
  private repoArgs(): string[] {
    const [owner, name] = this.cfg.repo.split("/");
    return ["-f", `owner=${owner}`, "-f", `name=${name}`];
  }

  private graphql(query: string, args: string[]): Promise<string> {
    return this.gh(["api", "graphql", "-f", `query=${query}`, ...this.repoArgs(), ...args]);
  }

  private toIssue(i: RawIssue): Issue {
    // An issue can sit on several projects; only this foreman's board decides Status and item id.
    // No entry at all is the off-board case, which reads exactly as a board miss did before.
    const item = i.projectItems.nodes.find((p) => p.project?.number === this.cfg.project);
    const status = item?.fieldValueByName?.name;
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      labels: i.labels.nodes.map((l) => l.name),
      assignees: i.assignees.nodes.map((a) => a.login),
      comments: i.comments.nodes.map(
        (c): Comment => ({ author: c.author?.login ?? "", body: c.body, createdAt: c.createdAt }),
      ),
      updatedAt: i.updatedAt,
      status: STATUSES.includes(status as Status) ? (status as Status) : null,
      itemId: item?.id ?? null,
    };
  }

  /**
   * The tick's one full read: issues, their comments and their board Status, in a single query.
   * There is no board cache to go stale — every issue carries its own live Status, so a Status
   * edit made by hand is seen by the next tick (#249) without a second read (#387).
   */
  async listIssues(state: "open" | "all" = "open"): Promise<Issue[]> {
    const query = issuesQuery(state);
    const out: Issue[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: string[] = cursor ? ["-f", `cursor=${cursor}`] : [];
      const conn = (
        JSON.parse(await this.graphql(query, page)) as {
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: RawIssue[];
              };
            };
          };
        }
      ).data.repository.issues;
      for (const n of conn.nodes) out.push(this.toIssue(n));
      // `endCursor` is null on an empty page; without that guard the loop would re-read page one.
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
      cursor = conn.pageInfo.endCursor;
    }
  }

  /**
   * One issue, one query. This used to call `listIssues("all")` — every claim, merge, resume
   * and plan re-downloaded every issue in the repo with all of its comments, which is what
   * spent the hourly GraphQL budget (#192).
   */
  async getIssue(n: number): Promise<Issue> {
    const raw = (
      JSON.parse(await this.graphql(ISSUE_QUERY, ["-F", `number=${n}`])) as {
        data: { repository: { issue: RawIssue | null } };
      }
    ).data.repository.issue;
    if (!raw) throw new Error(`issue #${n} not found in ${this.cfg.repo}`);
    return this.toIssue(raw);
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
        "number,title,body,headRefName,headRefOid,labels,isDraft,mergeable,statusCheckRollup,updatedAt",
      ]),
    ) as Array<{
      number: number;
      title: string;
      body: string;
      headRefName: string;
      headRefOid?: string;
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
      headSha: p.headRefOid ?? "",
      labels: names(p.labels),
      isDraft: p.isDraft,
      checks: parseChecks(p.statusCheckRollup ?? []),
      mergeable: parseMergeable(p.mergeable),
      issue: parseClosesIssue(p.body ?? ""),
      updatedAt: p.updatedAt,
    }));
  }

  /**
   * Reruns the failed jobs of the newest workflow run for `sha`, and answers with its run id (or
   * null when GitHub has no run for that commit). REST rather than GraphQL on purpose: the
   * tick's GraphQL budget is for the board reads, and this only fires on a red PR (#362).
   */
  async rerunFailedChecks(sha: string): Promise<number | null> {
    const found = (
      await this.gh([
        "api",
        `repos/${this.cfg.repo}/actions/runs?head_sha=${sha}&per_page=1`,
        "--jq",
        ".workflow_runs[0].id // empty",
      ])
    ).trim();
    if (!found) return null;
    await this.write([
      "api",
      "--method",
      "POST",
      `repos/${this.cfg.repo}/actions/runs/${found}/rerun-failed-jobs`,
    ]);
    return Number(found);
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

  /** Scopes of the current token, from `gh auth status`'s "Token scopes:" line. */
  async tokenScopes(): Promise<string[]> {
    const r = await this.exec("gh", ["auth", "status"]);
    const m = /Token scopes: (.*)/.exec(`${r.stdout}\n${r.stderr}`);
    return m ? [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string) : [];
  }

  async listLabels(): Promise<string[]> {
    const out = await this.gh([
      "label",
      "list",
      "--repo",
      this.cfg.repo,
      "--limit",
      "200",
      "--json",
      "name",
      "--jq",
      ".[].name",
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  createLabel(l: { name: string; color: string; description: string }): Promise<void> {
    return this.write([
      "label",
      "create",
      l.name,
      "--repo",
      this.cfg.repo,
      "--color",
      l.color,
      "--description",
      l.description,
    ]);
  }

  async createProject(owner: string, title: string): Promise<number> {
    const out = JSON.parse(
      await this.gh(["project", "create", "--owner", owner, "--title", title, "--format", "json"]),
    ) as { number: number };
    return out.number;
  }

  linkProject(number: number, owner: string): Promise<void> {
    return this.write([
      "project",
      "link",
      String(number),
      "--owner",
      owner,
      "--repo",
      this.cfg.repo,
    ]);
  }

  async projectFields(
    number: number,
    owner: string,
  ): Promise<{
    projectId: string;
    status: { id: string; options: Array<{ id: string; name: string }> } | null;
  }> {
    const view = JSON.parse(
      await this.gh(["project", "view", String(number), "--owner", owner, "--format", "json"]),
    ) as { id: string };
    const fields = JSON.parse(
      await this.gh([
        "project",
        "field-list",
        String(number),
        "--owner",
        owner,
        "--format",
        "json",
      ]),
    ) as {
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
    };
    const status = fields.fields.find((f) => f.name === "Status");
    return {
      projectId: view.id,
      status: status?.options ? { id: status.id, options: status.options } : null,
    };
  }

  /** Replaces the single-select options wholesale; only ever called on a project `init` just created. */
  setStatusOptions(fieldId: string, names: string[]): Promise<void> {
    const options = names.map((n) => `{name: "${n}", color: GRAY, description: ""}`).join(", ");
    return this.write([
      "api",
      "graphql",
      "-f",
      `query=mutation { updateProjectV2Field(input: {fieldId: "${fieldId}", singleSelectOptions: [${options}]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
    ]);
  }

  async fileOnDefaultBranch(path: string): Promise<boolean> {
    const r = await this.exec("gh", [
      "api",
      `repos/${this.cfg.repo}/contents/${path}`,
      "--jq",
      ".sha",
    ]);
    return r.code === 0;
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
  | "rerunFailedChecks"
  | "createIssue"
  | "addSubIssue"
  | "viewerLogin"
  | "defaultBranch"
  | "tokenScopes"
  | "listLabels"
  | "createLabel"
  | "createProject"
  | "linkProject"
  | "projectFields"
  | "setStatusOptions"
  | "fileOnDefaultBranch"
  | "dryRun"
>;

/** What `foreman init` and `foreman epic new` need of `GitHub`, and nothing else. */
export type BootstrapApi = Pick<
  GitHub,
  | "tokenScopes"
  | "listLabels"
  | "createLabel"
  | "createProject"
  | "linkProject"
  | "projectFields"
  | "setStatusOptions"
  | "fileOnDefaultBranch"
  | "createIssue"
  | "addToProject"
  | "setStatus"
  | "addLabels"
>;
