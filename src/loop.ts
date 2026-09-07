import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describeBoard } from "./board.ts";
import { budgetUpdate } from "./budget.ts";
import { conflictOn } from "./claim.ts";
import type { ForemanConfig } from "./config.ts";
import {
  applyRoleConfig,
  branchFor,
  type DispatchRequest,
  dispatchWithRetry,
  needsIsolatedStack,
  ensureWorktree as realEnsureWorktree,
  removeWorktree as realRemoveWorktree,
  realSpawn,
  restoreRoleConfig,
  type SessionResult,
  type Spawner,
  transcriptPath,
} from "./dispatch.ts";
import type { Exec } from "./exec.ts";
import { realExec } from "./exec.ts";
import { appendFeed, type FeedEntry } from "./feed.ts";
import { type GitHubApi, modelOf, phaseOf } from "./github.ts";
import { fmt, openClaim, parseClaim } from "./ledger.ts";
import { log } from "./log.ts";
import { createNotifier, type NotifyPort, noopNotify } from "./notify.ts";
import {
  PlanIssuesSchema,
  parseDirectionCritical,
  parseSpecPath,
  planIssuesPath,
} from "./phase.ts";
import { fetchOrigin, listPlanFilesOnMain, readPlanFileOnMain } from "./plans.ts";
import { graphqlBudget, preflight } from "./preflight.ts";
import { ledgerInterrupt } from "./release.ts";
import {
  appendMerge,
  appendSession,
  readMerges,
  readSessions,
  type SessionLogEntry,
  todayStats,
} from "./sessions.ts";
import { plan } from "./state.ts";
import type { CurrentSession, StateStore, StopMode } from "./state-file.ts";
import type { Activity } from "./stream.ts";
import type { Action, Epic, Issue, Role, Snapshot } from "./types.ts";

/** Activity lands in state.json at most this often; the feed file is appended per event. */
export const ACTIVITY_FLUSH_MS = 2000;

export interface Ctx {
  cfg: ForemanConfig;
  gh: GitHubApi;
  exec: Exec;
  spawn: Spawner;
  /** Push notifications; `noopNotify` when `notify` is absent from foreman.json (#225). */
  notify: NotifyPort;
  dryRun: boolean;
  stateDir: string;
  /** Where validator screenshots are archived: `<artifactsDir>/<pr>/`. */
  artifactsDir: string;
  copyDir: (src: string, dest: string) => Promise<void>;
  login: string;
  readFile: (absPath: string) => string | null;
  /** Repo-relative `*.issues.json` paths on `origin/main`. */
  planFiles: () => Promise<string[]>;
  /** Content of a repo-relative path on `origin/main`, or null when it is not there. */
  readPlanFile: (repoRelPath: string) => Promise<string | null>;
  ensureWorktree: (
    cfg: ForemanConfig,
    issue: number,
    branch: string,
    exec: Exec,
  ) => Promise<string>;
  removeWorktree: (cfg: ForemanConfig, issue: number, exec: Exec) => Promise<void>;
  transcriptExists: (worktree: string, sessionId: string) => boolean;
  now: () => string;
  /** Aborted when the operator requests stop or abort. */
  signal: AbortSignal;
  stopMode: () => StopMode | null;
  /** The daemon's state.json writer; null for --once runs and tests. */
  state: Pick<StateStore, "patch" | "get"> | null;
}

export function realCtx(
  cfg: ForemanConfig,
  gh: GitHubApi,
  login: string,
  dryRun: boolean,
  stateDir: string,
  control: { signal: AbortSignal; stopMode: () => StopMode | null; state: Ctx["state"] },
): Ctx {
  return {
    cfg,
    gh,
    ...control,
    exec: realExec,
    spawn: realSpawn,
    // A dry run must stay silent: it reports what it would do without doing it, so it has no
    // business waking the owner's phone.
    notify: dryRun
      ? noopNotify
      : createNotifier(cfg.notify, {
          fetch: globalThis.fetch,
          exec: realExec,
          stateDir,
          repo: cfg.repo,
          host: cfg.host,
        }),
    dryRun,
    stateDir,
    artifactsDir: join(stateDir, "artifacts"),
    copyDir: async (src, dest) => {
      await cp(src, dest, { recursive: true, force: true });
    },
    login,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    planFiles: () => listPlanFilesOnMain(realExec, cfg.repoDir),
    readPlanFile: (p) => readPlanFileOnMain(realExec, cfg.repoDir, p),
    ensureWorktree: realEnsureWorktree,
    removeWorktree: realRemoveWorktree,
    transcriptExists: (w, s) => existsSync(transcriptPath(w, s)),
    now: () => new Date().toISOString(),
  };
}

/**
 * Refetches the viewer login for a daemon that started before `gh` was authenticated. No-op
 * once `ctx.login` is set, so a healthy daemon never re-fetches it. Preflight's `gh auth status`
 * check inside `runOnce` keeps any write from reaching GitHub while the login is still empty, so
 * a repeated failure here is harmless — the next tick just tries again.
 */
export async function ensureLogin(ctx: Ctx): Promise<void> {
  if (ctx.login) return;
  try {
    ctx.login = await ctx.gh.viewerLogin();
  } catch {
    // still unauthenticated; try again next tick
  }
}

export async function buildSnapshot(ctx: Ctx): Promise<Snapshot> {
  const issues = await ctx.gh.listIssues("open");
  const prs = (await ctx.gh.listOpenPRs()).filter((p) => !p.isDraft);
  const epics: Epic[] = [];
  for (const e of issues.filter((i) => i.labels.includes("epic"))) {
    const specPath = parseSpecPath(e.body);
    const specText = specPath ? ctx.readFile(join(ctx.cfg.repoDir, specPath)) : null;
    epics.push({
      number: e.number,
      phase: phaseOf(e.labels) ?? 99,
      labels: e.labels,
      status: e.status,
      state: e.state,
      taskNumbers: await ctx.gh.subIssues(e.number),
      directionCritical: specText ? parseDirectionCritical(specText) : false,
      specPath,
    });
  }
  const branchLastCommitAt: Record<number, string | null> = {};
  for (const i of issues) {
    const open = openClaim(i.comments);
    if (open && open.claim.host !== ctx.cfg.host)
      branchLastCommitAt[i.number] = await ctx.gh.branchLastCommitAt(branchFor(i.number, i.title));
  }
  return { host: ctx.cfg.host, now: ctx.now(), issues, prs, epics, branchLastCommitAt };
}

async function setStatus(ctx: Ctx, issue: Issue, status: Issue["status"] & string): Promise<void> {
  if (issue.itemId) await ctx.gh.setStatus(issue.itemId, status);
  else log("warn", "issue not on board; status not set", { issue: issue.number, status });
}

// conflictOn only sees claims already present in the fetched issue's comments. A real GitHub
// re-fetch after gh.comment() picks up the comment we just posted, but that isn't guaranteed
// (eventual consistency, or a stub in tests), so merge our own pending claim in locally before
// checking for a race with another host's claim.
function withOwnClaim(issue: Issue, body: string, at: string, login: string): Issue {
  return { ...issue, comments: [...issue.comments, { author: login, body, createdAt: at }] };
}

interface RunRole {
  issue: Issue;
  role: Role;
  pr: number | null;
  round: number;
  resumeSessionId: string | null;
  notes: string;
  rebase?: boolean;
}

/**
 * The model a session on this issue runs as: the issue's `model:<name>` label (#259), else the
 * owner's live override, else `model` from foreman.json.
 */
export function modelFor(ctx: Ctx, labels: string[]): string {
  return modelOf(labels) ?? ctx.state?.get().model ?? ctx.cfg.model;
}

/** The daily session cap this tick enforces: the owner's live override, else foreman.json's. */
export function capFor(ctx: Ctx): number {
  return ctx.state?.get().maxSessionsPerDay ?? ctx.cfg.maxSessionsPerDay;
}

/**
 * The comparable half of a `sessions.log` line: what the session ran as and what it spent getting
 * there. `activity.model` is the id the CLI reported at init (`claude-opus-5`), which is what
 * makes opus-vs-sonnet comparable; the dispatched name is the fallback for a session that never
 * emitted an init event (#226).
 */
function sessionMetrics(
  result: SessionResult,
  current: CurrentSession,
  model: string,
): Pick<SessionLogEntry, "model" | "turns" | "durationMinutes" | "denials" | "subtype"> {
  return {
    model: current.activity?.model ?? model,
    turns: result.numTurns,
    durationMinutes: Math.round(result.durationMs / 6_000) / 10,
    denials: result.denials,
    subtype: result.subtype,
  };
}

async function runRole(ctx: Ctx, r: RunRole): Promise<void> {
  const { cfg, gh } = ctx;
  if (ctx.dryRun) {
    log("info", "dry-run: would dispatch", {
      issue: r.issue.number,
      role: r.role,
      pr: r.pr,
      round: r.round,
      resume: r.resumeSessionId,
    });
    return;
  }
  const prs = await gh.listOpenPRs();
  const branch =
    prs.find((p) => p.number === r.pr)?.headRefName ?? branchFor(r.issue.number, r.issue.title);
  const worktree = await ctx.ensureWorktree(cfg, r.issue.number, branch, ctx.exec);
  let sessionId = r.resumeSessionId ?? randomUUID();
  let resume = r.resumeSessionId !== null;
  let notes = r.notes;
  if (resume && !ctx.transcriptExists(worktree, sessionId)) {
    notes = `Previous session ${sessionId} on ${cfg.host} has no local transcript. Read the Progress comments and the branch diff, then continue.\n${notes}`;
    sessionId = randomUUID();
    resume = false;
  }
  if (r.round > 1 && r.pr)
    await gh.removeLabels("pr", r.pr, ["reviewer:changes", "validator:failed"]);
  // Sessions that may `pnpm db:reset` or serve the app run against the isolated `tone_tonic_val`
  // stack, not the owner's (#228). The rewrite lives only in the worktree and is undone below, so
  // it never reaches a commit. The restore is unconditional and runs first, so a rewrite left
  // behind by a crashed isolated session cannot be committed by a later non-isolated one.
  const isolated = needsIsolatedStack(r.role);
  await restoreRoleConfig(worktree, ctx.exec);
  if (isolated) await applyRoleConfig(worktree, cfg.repoDir, ctx.exec);
  // Controller ruling (Task 6 review): always dispatch with attempt: 1 — dispatchWithRetry owns
  // retry counting internally, and no attempt count carries across loop iterations.
  const req: DispatchRequest = {
    role: r.role,
    issue: r.issue.number,
    pr: r.pr,
    title: r.issue.title,
    specPath: parseSpecPath(r.issue.body),
    worktree,
    branch,
    sessionId,
    resume,
    attempt: 1,
    round: r.round,
    notes,
    isolated,
    rebase: r.rebase === true,
  };
  const started = Date.now();
  let current: CurrentSession = {
    issue: r.issue.number,
    title: r.issue.title,
    role: r.role,
    pr: r.pr,
    round: r.round,
    attempt: 1,
    sessionId,
    resume,
    worktree,
    branch,
    childPid: null,
    startedAt: ctx.now(),
    deadlineAt: new Date(started + cfg.wallClockMinutes * 60_000).toISOString(),
    activity: null,
  };
  const setCurrent = (p: Partial<CurrentSession>) => {
    current = { ...current, ...p };
    ctx.state?.patch({ current });
  };
  setCurrent({});
  let flushTimer: NodeJS.Timeout | null = null;
  let dirty = false;
  const flush = () => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    ctx.state?.patch({ current });
  };
  let feedWarned = false;
  const onActivity = (activity: Activity, entries: FeedEntry[]) => {
    current = { ...current, activity };
    dirty = true;
    if (!flushTimer) {
      flushTimer = setTimeout(flush, ACTIVITY_FLUSH_MS);
      flushTimer.unref();
    }
    for (const e of entries) {
      try {
        appendFeed(ctx.stateDir, current.sessionId, e);
      } catch (err) {
        if (!feedWarned) {
          feedWarned = true;
          log("warn", "feed append failed; continuing without the feed", {
            sessionId: current.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };
  // The owner can change the model from the page or `ctl model` mid-run; it lands in state.json
  // and is read here, per dispatch, so it takes effect without restarting the daemon (#210). A
  // `model:<name>` label on the issue outranks both, for every role that runs on it (#259).
  const model = modelFor(ctx, r.issue.labels);
  let result: SessionResult;
  try {
    result = await dispatchWithRetry(
      req,
      { ...cfg, model },
      {
        spawn: ctx.spawn,
        signal: ctx.signal,
        onSpawn: (pid) => setCurrent({ childPid: pid }),
        onActivity,
        onAttempt: async (a) => {
          setCurrent({
            attempt: a.attempt,
            sessionId: a.sessionId,
            resume: a.resume,
            childPid: null,
            activity: null,
          });
          await gh.comment("issue", a.issue, fmt.session(a.sessionId, cfg.host, a.role, a.attempt));
        },
      },
    );
  } finally {
    // Unconditional, even on a throw or an operator abort, and even for a session that was never
    // isolated: a rewrite an earlier crashed session left behind would otherwise be committed by
    // this one, or block `ensureWorktree`'s `git pull --ff-only`.
    await restoreRoleConfig(worktree, ctx.exec);
  }
  if (flushTimer) clearTimeout(flushTimer);
  flush();
  const minutes = Math.round((Date.now() - started) / 60_000);
  // Outcome wins over interrupted: a child that printed its structured result JSON just before
  // the kill landed did finish its work, so it takes the normal completion path below (comment +
  // applyOutcome) rather than the interrupt bookkeeping — on `abort` that means the interrupt
  // path's unassign/Ready reset is deliberately skipped, because the work is done.
  if (!result.outcome && result.interrupted) {
    const mode = ctx.stopMode() ?? "stop";
    appendSession(ctx.stateDir, {
      t: ctx.now(),
      host: cfg.host,
      role: r.role,
      issue: r.issue.number,
      sessionId: result.sessionId,
      attempt: current.attempt,
      costUsd: result.costUsd,
      outcome: mode === "abort" ? "aborted" : "interrupted",
      ...sessionMetrics(result, current, model),
    });
    try {
      const writes = await ledgerInterrupt(gh, {
        mode,
        host: cfg.host,
        login: ctx.login,
        issue: r.issue.number,
        role: r.role,
        round: r.round,
        sessionId: result.sessionId,
        minutes,
      });
      log("info", "session interrupted by operator", { issue: r.issue.number, mode, writes });
      ctx.state?.patch({ current: null, unfinished: null });
    } catch (err) {
      log("error", "interrupt bookkeeping failed; recorded as unfinished", {
        issue: r.issue.number,
        mode,
        error: err instanceof Error ? err.message : String(err),
      });
      ctx.state?.patch({ current: null, unfinished: { ...current, mode } });
    }
    return;
  }
  if (result.interrupted && result.outcome) {
    const mode = ctx.stopMode() ?? "stop";
    log("info", "session finished despite interrupt; applying its outcome", {
      issue: r.issue.number,
      mode,
    });
  }
  appendSession(ctx.stateDir, {
    t: ctx.now(),
    host: cfg.host,
    role: r.role,
    issue: r.issue.number,
    sessionId: result.sessionId,
    attempt: req.attempt,
    costUsd: result.costUsd,
    outcome: result.outcome?.outcome ?? result.subtype,
    ...sessionMetrics(result, current, model),
  });
  await gh.comment(
    "issue",
    r.issue.number,
    fmt.finished(
      result.sessionId,
      cfg.host,
      result.outcome?.outcome ?? result.subtype,
      result.numTurns,
      result.costUsd,
      minutes,
    ),
  );
  ctx.state?.patch({ current: null });
  await applyOutcome(ctx, r, result, worktree);
}

// Role sessions cannot write outside their worktree (`--permission-mode dontAsk` denies it even
// for allowlisted mkdir/mv), so the validator leaves screenshots in
// `<worktree>/.validation-artifacts/<pr>/` and the foreman archives them here before the worktree
// is removed on merge.
async function archiveArtifacts(ctx: Ctx, worktree: string, pr: number | null): Promise<void> {
  if (!pr) return;
  const src = join(worktree, ".validation-artifacts", String(pr));
  if (!existsSync(src)) return;
  const dest = join(ctx.artifactsDir, String(pr));
  await ctx.copyDir(src, dest);
  log("info", "archived validation artifacts", { pr, dest });
}

async function applyOutcome(
  ctx: Ctx,
  r: RunRole,
  res: SessionResult,
  worktree: string,
): Promise<void> {
  const { gh, cfg } = ctx;
  const n = r.issue.number;
  const pr = res.outcome?.pr ?? r.pr;
  if (!res.outcome) {
    const excerpt = [res.resultText ?? "", res.stderr].join("\n").trim().slice(-1500);
    const reason = `${res.timedOut ? "timed out" : res.subtype} after retries`;
    await gh.addLabels("issue", n, ["blocked"]);
    await gh.comment(
      "issue",
      n,
      `blocked by foreman@${cfg.host}: ${reason}\n\n\`\`\`\n${excerpt}\n\`\`\``,
    );
    await gh.unassign(n, ctx.login);
    // The excerpt is session output — stderr, the model's last words — so it stays on GitHub.
    // Only the foreman's own one-line reason is pushed.
    await ctx.notify.send({ kind: "blocked", issue: n, title: r.issue.title, reason });
    return;
  }
  switch (res.outcome.outcome) {
    case "pr_opened":
      await setStatus(ctx, r.issue, "In Review");
      break;
    case "blocked":
      await gh.addLabels("issue", n, ["blocked"]);
      await gh.comment("issue", n, `blocked by ${r.role}: ${res.outcome.notes}`);
      await gh.unassign(n, ctx.login);
      await ctx.notify.send({
        kind: "blocked",
        issue: n,
        title: r.issue.title,
        reason: res.outcome.notes,
      });
      break;
    case "approved":
      if (pr) {
        await gh.addLabels("pr", pr, ["reviewer:approved"]);
        await gh.removeLabels("pr", pr, ["reviewer:changes"]);
      }
      break;
    case "changes_requested":
      if (pr) await gh.addLabels("pr", pr, ["reviewer:changes"]);
      break;
    case "passed":
      await archiveArtifacts(ctx, worktree, pr);
      if (pr) {
        await gh.addLabels("pr", pr, ["validator:passed"]);
        await gh.removeLabels("pr", pr, ["validator:failed"]);
      }
      break;
    case "failed":
      await archiveArtifacts(ctx, worktree, pr);
      if (pr) await gh.addLabels("pr", pr, ["validator:failed"]);
      break;
    case "phase_closed":
      await setStatus(ctx, r.issue, "In Review");
      await gh.addLabels("issue", n, ["needs-owner"]);
      await ctx.notify.send({
        kind: "phase_closed",
        epic: n,
        title: r.issue.title,
        review: firstIssueRef(res.outcome.notes),
      });
      break;
    // The plan is drafted; hand the epic back to the owner. `needs-owner` and the dropped
    // `agent-ready` are both gates on the next planner session (#187) — either one alone stops
    // a re-plan, so a failed write here cannot restart a $5 planning session by itself.
    case "plan_drafted":
      await gh.addLabels("issue", n, ["needs-owner"]);
      await gh.removeLabels("issue", n, ["agent-ready"]);
      await setStatus(ctx, r.issue, "In Review");
      await gh.unassign(n, ctx.login);
      await ctx.notify.send({
        kind: "plan_drafted",
        epic: n,
        title: r.issue.title,
        pr: res.outcome.pr,
      });
      break;
  }
}

/**
 * The phase-closer returns the review issue it opened in its notes ("review issue #55; DM sent");
 * the number is what the owner actually wants to open. Null when the notes name none, and the
 * notification falls back to linking the epic.
 */
export function firstIssueRef(notes: string): number | null {
  const m = /#(\d+)/.exec(notes);
  return m ? Number(m[1]) : null;
}

/** True when the plan's tasks were written to GitHub; false when it was left for a later tick. */
async function applyPlan(ctx: Ctx, epicNumber: number, snapshot?: Snapshot): Promise<boolean> {
  const { gh, cfg } = ctx;
  const epic = await issueFor(ctx, epicNumber, snapshot);
  const specPath = parseSpecPath(epic.body) ?? "";
  const nn =
    /phase-(\d\d)/.exec(specPath)?.[1] ?? /phase-(\d\d)/.exec(planIssuesPath(specPath, "x"))?.[1];
  // Nothing else in the daemon refreshes repoDir, so a plan PR merged minutes ago is only
  // visible after this fetch; a failed fetch falls back to the last known origin/main (#189).
  if (!(await fetchOrigin(ctx.exec, cfg.repoDir)))
    log("warn", "fetch failed; reading the plan from the last known origin/main", {
      epic: epicNumber,
    });
  const file = (await ctx.planFiles())
    .filter((f) => nn && f.includes(`phase-${nn}-plan.issues.json`))
    .sort()
    .at(-1);
  const text = file ? await ctx.readPlanFile(file) : null;
  if (!text) {
    // Deliberately no `plan applied` comment: planApplied() reads that as done and the epic
    // would never get its tasks. Leave the epic untouched so the next tick retries.
    log("warn", "approved plan file not on origin/main; retrying next tick", {
      epic: epicNumber,
      phase: nn ?? null,
    });
    return false;
  }
  const planFile = PlanIssuesSchema.parse(JSON.parse(text));
  // One board read for the whole plan. This used to be one `listIssues` per task, which is a
  // `gh project item-list` each time; a twenty-task plan tripped GitHub's rate limiter, the
  // tick failed, and the retry started the same storm again.
  const issues = snapshot?.issues ?? (await gh.listIssues("open"));
  const itemIds = new Map(issues.map((i) => [i.number, i.itemId]));
  // The epic's sub-issues, read at most once and only when a task is actually being reused: a
  // reused issue may be unlinked, because the attempt that created it can have died between
  // createIssue and addSubIssue. phaseComplete() only walks Epic.taskNumbers, so an unlinked task
  // is invisible to it and the phase closes with the task still open and `agent-ready` (#223).
  let cache: Set<number> | null = null;
  const linkedTasks = async () => {
    cache ??= new Set(
      snapshot?.epics.find((e) => e.number === epicNumber)?.taskNumbers ??
        (await gh.subIssues(epicNumber)),
    );
    return cache;
  };
  for (const t of planFile.tasks) {
    // A task without a number is created — unless an earlier attempt already did. The Phase 1
    // apply created #190, failed later in the tick, and the retry created #216, an exact
    // duplicate. The title plus the "Parent epic" line the planner puts in every body is the key.
    const reused = t.number
      ? undefined
      : issues.find(
          (i) =>
            i.state === "OPEN" &&
            i.title === t.title &&
            i.body.includes(`Parent epic: #${epicNumber}`),
        )?.number;
    let number = t.number ?? reused;
    if (number) {
      await gh.editBody(number, t.body);
      // Only for a reused issue: on the t.number path the planner is naming an issue it already
      // linked, and addSubIssue on an existing link is a 422 that would fail the whole tick.
      if (reused) {
        const linked = await linkedTasks();
        if (!linked.has(reused)) {
          await gh.addSubIssue(epicNumber, reused);
          // Two plan tasks with the same title resolve to the same issue; don't link it twice.
          linked.add(reused);
        }
      }
    } else {
      number = await gh.createIssue({ title: t.title, body: t.body, labels: t.labels });
      await gh.addSubIssue(epicNumber, number);
    }
    // A reused task the board has already moved on (In Progress / In Review / Done) must not be
    // re-armed: setStatus("Ready") makes mergeDecision reject its approved PR forever, and
    // buildCandidates would dispatch a second builder round on finished work. The retry that
    // gets here is slow (apply_plan only re-runs on a tick with nothing claimable), so this is
    // the common case for a reused issue, not a corner.
    const existing = reused ? issues.find((i) => i.number === reused) : undefined;
    const inFlight =
      existing !== undefined &&
      existing.status !== null &&
      existing.status !== "Backlog" &&
      existing.status !== "Ready";
    if (inFlight) {
      log("warn", "reused plan task already in flight; leaving its labels and status alone", {
        issue: number,
        status: existing.status,
      });
    } else {
      await gh.addLabels("issue", number, [...t.labels, "agent-ready"]);
      const itemId = itemIds.get(number) ?? (await gh.addToProject(number));
      await gh.setStatus(itemId, "Ready");
    }
  }
  // The plan is applied, so the epic is no longer waiting on the owner: clear the gate that
  // holds the planner (#187) and put the epic back where the phase-closer can see it.
  await gh.removeLabels("issue", epicNumber, ["needs-owner"]);
  const item = epic.itemId ?? (await gh.addToProject(epicNumber));
  await gh.setStatus(item, "In Progress");
  await gh.comment("issue", epicNumber, fmt.planApplied(cfg.host));
  return true;
}

/** When this issue was first claimed, from its ledger; null when nothing ever claimed it. */
function firstClaimAt(issue: Issue): string | null {
  return (
    [...issue.comments]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .find((c) => parseClaim(c.body) !== null)?.createdAt ?? null
  );
}

/**
 * The issue as this tick's snapshot already saw it, falling back to a single-issue read. Only
 * the claim paths below re-read from GitHub on purpose, to spot a competing host's claim (#192).
 */
async function issueFor(ctx: Ctx, n: number, snapshot?: Snapshot): Promise<Issue> {
  return snapshot?.issues.find((i) => i.number === n) ?? (await ctx.gh.getIssue(n));
}

export async function execute(
  action: Action,
  ctx: Ctx,
  snapshot?: Snapshot,
): Promise<"continue" | "stop" | "noop"> {
  const { gh, cfg } = ctx;
  log("info", "action", { ...action, dryRun: ctx.dryRun });
  // Dry-run must not call any gh method: return before the switch dispatches to a case that would.
  if (ctx.dryRun)
    return action.type === "claim" ||
      action.type === "resume" ||
      action.type === "phase_close" ||
      action.type === "plan"
      ? "stop"
      : "continue";
  switch (action.type) {
    case "idle":
      return "stop";
    // Deviation from the brief: types.ts declares a "release" Action variant but no producer
    // (claim.ts/merge.ts/phase.ts/pick.ts) ever constructs one; the brief's execute() switch
    // omitted it, which fails tsc's exhaustiveness check. Handled the same way "block" releases
    // a claim without blocking, since that is the plain reading of the action's shape.
    case "release":
      await gh.comment("issue", action.issue, fmt.released(cfg.host, action.reason));
      await gh.unassign(action.issue, ctx.login);
      return "continue";
    case "merge": {
      const issue = await issueFor(ctx, action.issue, snapshot);
      await gh.mergePR(action.pr);
      await gh.comment("issue", action.issue, fmt.merged(cfg.host));
      await gh.closeIssue(action.issue);
      // The issue closes here and drops out of every later snapshot (`gh issue list --state
      // open`), so its claim→merge span is recorded now, while the ledger is still in hand.
      appendMerge(ctx.stateDir, {
        issue: action.issue,
        pr: action.pr,
        host: cfg.host,
        claimedAt: firstClaimAt(issue),
        mergedAt: ctx.now(),
      });
      await setStatus(ctx, issue, "Done");
      await ctx.removeWorktree(cfg, action.issue, ctx.exec);
      await ctx.notify.send({
        kind: "merged",
        pr: action.pr,
        issue: action.issue,
        title: issue.title,
      });
      return "continue";
    }
    case "skip_validator":
      await gh.addLabels("pr", action.pr, ["validator:skipped"]);
      await gh.comment(
        "pr",
        action.pr,
        `validator skipped by foreman@${cfg.host}: issue areas are infra/db/shared only`,
      );
      return "continue";
    case "adopt": {
      // The picker only reads Status Ready, so an agent-ready issue that nobody added to the
      // board is invisible to it. Put it on the board, set it Ready, and say so on the issue so
      // the change is not silent (#249).
      const itemId = await gh.addToProject(action.issue);
      await gh.setStatus(itemId, "Ready");
      await gh.comment("issue", action.issue, fmt.adopted(`foreman@${cfg.host}`));
      log("info", "adopted onto board", { issue: action.issue, status: "Ready" });
      return "continue";
    }
    case "block":
      await gh.addLabels("issue", action.issue, ["blocked"]);
      await gh.comment("issue", action.issue, `blocked by foreman@${cfg.host}: ${action.reason}`);
      await gh.unassign(action.issue, ctx.login);
      // The title is a nicety here: take it from the tick's snapshot rather than spending a read.
      await ctx.notify.send({
        kind: "blocked",
        issue: action.issue,
        title: snapshot?.issues.find((i) => i.number === action.issue)?.title ?? "",
        reason: action.reason,
      });
      return "continue";
    case "reclaim": {
      await gh.comment("issue", action.issue, fmt.reclaimed(action.fromHost, cfg.host, ctx.now()));
      const issue = await issueFor(ctx, action.issue, snapshot);
      const prs = snapshot?.prs ?? (await gh.listOpenPRs());
      const pr = prs.find((p) => p.issue === action.issue)?.number ?? null;
      await gh.comment("issue", action.issue, fmt.claimed(cfg.host, ctx.now(), "builder", 1));
      await gh.assign(action.issue, ctx.login);
      await runRole(ctx, {
        issue,
        role: "builder",
        pr,
        round: 1,
        resumeSessionId: null,
        notes: `Reclaimed from ${action.fromHost} after two idle hours. Read Progress comments and the branch diff, then continue.`,
      });
      return "stop";
    }
    case "claim": {
      const claimBody = fmt.claimed(cfg.host, ctx.now(), action.role, action.round);
      await gh.comment("issue", action.issue, claimBody);
      await gh.assign(action.issue, ctx.login);
      const fetched = await gh.getIssue(action.issue);
      const withClaim = withOwnClaim(fetched, claimBody, ctx.now(), ctx.login);
      if (conflictOn(withClaim, cfg.host) === "release") {
        await gh.comment("issue", action.issue, fmt.released(cfg.host, "conflict"));
        await gh.unassign(action.issue, ctx.login);
        return "continue";
      }
      const issue = fetched;
      const rebase = action.rebase === true;
      // A rebase round is builder work on an In Review issue; the board stays where it is.
      if (
        action.role === "builder" &&
        action.round === 1 &&
        !rebase &&
        issue.status !== "In Progress"
      )
        await setStatus(ctx, issue, "In Progress");
      await runRole(ctx, {
        issue,
        role: action.role,
        pr: action.pr,
        round: action.round,
        resumeSessionId: null,
        rebase,
        notes:
          !rebase && action.round > 1
            ? "Read the PR review and the latest validator comment; address every item."
            : "",
      });
      return "stop";
    }
    case "resume": {
      const issue = await issueFor(ctx, action.issue, snapshot);
      await runRole(ctx, {
        issue,
        role: action.role,
        pr: action.pr,
        round: 1,
        resumeSessionId: action.sessionId,
        notes: "",
      });
      return "stop";
    }
    case "phase_close":
    case "plan": {
      const role: Role = action.type === "phase_close" ? "phase-closer" : "planner";
      const claimBody = fmt.claimed(cfg.host, ctx.now(), role, 1);
      await gh.comment("issue", action.epic, claimBody);
      const issue = await gh.getIssue(action.epic);
      const withClaim = withOwnClaim(issue, claimBody, ctx.now(), ctx.login);
      if (conflictOn(withClaim, cfg.host) === "release") {
        await gh.comment("issue", action.epic, fmt.released(cfg.host, "conflict"));
        return "continue";
      }
      // A planner session runs for an hour or more with nothing else to show for it on GitHub,
      // so mark the epic the way a builder marks a task: assigned and In Progress (#187).
      if (action.type === "plan") {
        await gh.assign(action.epic, ctx.login);
        if (issue.status !== "In Progress") await setStatus(ctx, issue, "In Progress");
      }
      await runRole(ctx, { issue, role, pr: null, round: 1, resumeSessionId: null, notes: "" });
      return "stop";
    }
    case "apply_plan":
      // A plan whose file is not on origin/main yet is left for the next tick, and that is not
      // work: counting it would make the loop hot until the plan PR merges.
      return (await applyPlan(ctx, action.epic, snapshot)) ? "continue" : "noop";
  }
}

export interface TickOutcome {
  /**
   * True when this tick changed the board — started a session, merged, applied a plan, released
   * or blocked — so the next tick need not wait out `pollSeconds` (#207, #223).
   */
  didWork: boolean;
  /** The last action that counted as work, for the log line; null when none did. */
  action: Action["type"] | null;
}

export async function runOnce(ctx: Ctx): Promise<TickOutcome> {
  // Read per tick, so raising the cap from the page un-parks the daemon on the next tick rather
  // than needing a restart to reload foreman.json (#213).
  const pre = await preflight(
    { ...ctx.cfg, maxSessionsPerDay: capFor(ctx) },
    {
      env: process.env,
      exec: ctx.exec,
      stateDir: ctx.stateDir,
      now: new Date(),
    },
  );
  ctx.state?.patch({ lastPreflight: { ok: pre.ok, reason: pre.ok ? null : pre.reason } });
  // Preflight fails on every tick of a parked spell, so the notifier — not the loop — decides
  // whether this transition is worth a push (#225).
  await ctx.notify.syncParked(pre.ok ? null : pre.reason);
  if (!pre.ok) {
    log("warn", "preflight failed; sleeping", { reason: pre.reason });
    return { didWork: false, action: null };
  }
  // Free `rateLimit` reads around the tick's two phases, so the page can say whether the hourly
  // GraphQL budget went on the loop's own reads, the session it dispatched, or something else.
  const before = await graphqlBudget(ctx.exec);
  const snapshot = await buildSnapshot(ctx);
  // A decision issue is opened by a role session, not by the foreman, so the snapshot is the only
  // place it shows up; the notifier announces each one once.
  await ctx.notify.syncDecisions(snapshot.issues);
  const actions = plan(snapshot);
  const names = actions.map((a) =>
    // Every non-idle Action variant carries either "issue" or "epic" — never neither — so a
    // third fallback branch is unreachable (and TS correctly types it as `never`).
    a.type === "idle" ? `idle(${a.reason})` : `${a.type}#${"issue" in a ? a.issue : a.epic}`,
  );
  log("info", "plan", { actions: names });
  const sessions = readSessions(ctx.stateDir);
  const today = todayStats(sessions, new Date(snapshot.now));
  const board = describeBoard(
    snapshot,
    {
      host: ctx.cfg.host,
      preflight: { ok: true, reason: null },
      stopPresent: false,
      todayCount: today.count,
      cap: capFor(ctx),
    },
    { sessions, merges: readMerges(ctx.stateDir) },
  );
  ctx.state?.patch({ lastPlan: names, board });
  const afterReads = await graphqlBudget(ctx.exec);
  let didWork = false;
  let worked: Action["type"] | null = null;
  for (const a of actions) {
    if (ctx.signal.aborted) {
      log("info", "stopping before next action", { next: a.type });
      break;
    }
    const r = await execute(a, ctx, snapshot);
    // A dry run performs nothing, so it must not shorten the next wait — otherwise
    // `runForever --dry-run` becomes a hot loop. "noop" is an action that chose to wait.
    // The *last* action that counted, not the first: a tick that merges and then dispatches a
    // session should name the session, which is always executed last because dispatching returns
    // "stop". Naming the first would log "merge" and hide the more interesting event.
    if (!ctx.dryRun && a.type !== "idle" && r !== "noop") {
      didWork = true;
      worked = a.type;
    }
    if (r === "stop") break;
  }
  const budget = budgetUpdate(
    ctx.state?.get().budget ?? null,
    { before, afterReads, afterActions: await graphqlBudget(ctx.exec) },
    ctx.now(),
  );
  if (budget) {
    ctx.state?.patch({ budget });
    log("info", "graphql budget", {
      remaining: budget.remaining,
      tickReads: budget.tickReads,
      actionSpend: budget.actionSpend,
      betweenTicks: budget.betweenTicks,
    });
  }
  return { didWork, action: worked };
}

/**
 * Longest gap between attempts. A GitHub rate-limit lockout clears within the hour, so the
 * cap keeps a locked-out foreman retrying often enough to pick the work back up on its own.
 */
export const MAX_BACKOFF_SECONDS = 900;

/** Poll interval while healthy; doubles per consecutive failure, capped. */
export function backoffSeconds(pollSeconds: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return pollSeconds;
  return Math.min(pollSeconds * 2 ** consecutiveFailures, MAX_BACKOFF_SECONDS);
}

export interface LoopDeps {
  sleep?: (ms: number) => Promise<void>;
  iterate?: (ctx: Ctx) => Promise<TickOutcome>;
  /** Serialises ticks with the web page's on-demand `next`; identity when absent. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export async function runForever(ctx: Ctx, deps: LoopDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const iterate = deps.iterate ?? runOnce;
  const lock = deps.lock ?? (<T>(fn: () => Promise<T>) => fn());
  let consecutiveFailures = 0;
  for (;;) {
    if (ctx.signal.aborted) return;
    let outcome: TickOutcome = { didWork: false, action: null };
    try {
      outcome = await lock(() => iterate(ctx));
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      log("error", "loop iteration failed", {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures,
        nextAttemptSeconds: backoffSeconds(ctx.cfg.pollSeconds, consecutiveFailures),
      });
    }
    // A tick that did work has changed the board — a merge unblocks dependents, a session has
    // already spent its minutes — so waiting out another `pollSeconds` is dead time (#207, #223).
    // A tick that found nothing eligible still sleeps the interval, and a failure still backs off.
    const delaySeconds =
      outcome.didWork && consecutiveFailures === 0
        ? 0
        : backoffSeconds(ctx.cfg.pollSeconds, consecutiveFailures);
    if (delaySeconds === 0) log("info", "ticking again immediately", { action: outcome.action });
    const at = ctx.now();
    ctx.state?.patch({
      lastTickAt: at,
      nextTickAt: new Date(Date.parse(at) + delaySeconds * 1000).toISOString(),
      consecutiveFailures,
    });
    if (ctx.signal.aborted) return;
    await sleep(delaySeconds * 1000);
  }
}
