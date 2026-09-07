export type Status = "Backlog" | "Ready" | "In Progress" | "In Review" | "Done";
export type Role = "builder" | "reviewer" | "validator" | "phase-closer" | "planner";
export type Size = "S" | "M" | "L";

export interface Comment {
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  comments: Comment[];
  updatedAt: string;
  status: Status | null; // from the project board; null when not on the board
  itemId: string | null; // project item id, needed for status writes
}

export type CheckState = "success" | "pending" | "failure" | "none";

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  labels: string[];
  isDraft: boolean;
  checks: CheckState;
  /** GitHub's own verdict on the branch; CONFLICTING gets a rebase job instead of a merge (#237). */
  mergeable: Mergeable;
  issue: number | null; // parsed from "Closes #N"
  updatedAt: string;
}

export interface BoardItem {
  itemId: string;
  issue: number;
  status: Status | null;
}

export interface Epic {
  number: number;
  phase: number;
  labels: string[];
  status: Status | null;
  state: "OPEN" | "CLOSED";
  taskNumbers: number[];
  directionCritical: boolean;
  specPath: string | null;
}

export interface Snapshot {
  host: string;
  now: string; // ISO
  issues: Issue[]; // all open issues + closed ones referenced by Depends on
  prs: PullRequest[]; // open, non-draft
  epics: Epic[];
  branchLastCommitAt: Record<number, string | null>; // issue → ISO of last commit on its branch
}

export type Action =
  | { type: "resume"; issue: number; role: Role; sessionId: string | null; pr: number | null }
  | { type: "merge"; pr: number; issue: number }
  | { type: "skip_validator"; pr: number; issue: number }
  | {
      type: "claim";
      issue: number;
      role: Role;
      pr: number | null;
      round: number;
      /** A builder round that only merges origin/main; does not count as a fix round (#237). */
      rebase?: boolean;
    }
  | { type: "release"; issue: number; reason: string }
  | { type: "reclaim"; issue: number; fromHost: string }
  | { type: "block"; issue: number; reason: string }
  | { type: "adopt"; issue: number }
  | { type: "phase_close"; epic: number }
  | { type: "plan"; epic: number }
  | { type: "apply_plan"; epic: number }
  | { type: "idle"; reason: string };
