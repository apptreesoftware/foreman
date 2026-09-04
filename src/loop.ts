import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describeBoard } from "./board.ts";
import { conflictOn } from "./claim.ts";
import type { ForemanConfig } from "./config.ts";
import {
  branchFor,
  type DispatchRequest,
  dispatchWithRetry,
  ensureWorktree as realEnsureWorktree,
  removeWorktree as realRemoveWorktree,
  realSpawn,
  type SessionResult,
  type Spawner,
  transcriptPath,
} from "./dispatch.ts";
import type { Exec } from "./exec.ts";
import { realExec } from "./exec.ts";
import { appendFeed, type FeedEntry } from "./feed.ts";
import { type GitHubApi, phaseOf } from "./github.ts";
import { fmt, openClaim } from "./ledger.ts";
import { log } from "./log.ts";
import {
  PlanIssuesSchema,
  parseDirectionCritical,
  parseSpecPath,
  planIssuesPath,
} from "./phase.ts";
import { preflight } from "./preflight.ts";
import { ledgerInterrupt } from "./release.ts";
import { appendSession, readSessions, todayStats } from "./sessions.ts";
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
  dryRun: boolean;
  stateDir: string;
  /** Where validator screenshots are archived: `<artifactsDir>/<pr>/`. */
  artifactsDir: string;
  copyDir: (src: string, dest: string) => Promise<void>;
  login: string;
  readFile: (absPath: string) => string | null;
  listPlanFiles?: () => string[]; // repo-relative *.issues.json paths
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
    dryRun,
    stateDir,
    artifactsDir: join(stateDir, "artifacts"),
    copyDir: async (src, dest) => {
      await cp(src, dest, { recursive: true, force: true });
    },
    login,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    listPlanFiles: () => {
      const dir = join(cfg.repoDir, "docs", "superpowers", "plans");
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".issues.json"))
            .map((f) => `docs/superpowers/plans/${f}`)
        : [];
    },
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
  const result = await dispatchWithRetry(req, cfg, {
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
  });
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
    await gh.addLabels("issue", n, ["blocked"]);
    await gh.comment(
      "issue",
      n,
      `blocked by foreman@${cfg.host}: ${res.timedOut ? "timed out" : res.subtype} after retries\n\n\`\`\`\n${excerpt}\n\`\`\``,
    );
    await gh.unassign(n, ctx.login);
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
      break;
    // The plan is drafted; hand the epic back to the owner. `needs-owner` and the dropped
    // `agent-ready` are both gates on the next planner session (#187) — either one alone stops
    // a re-plan, so a failed write here cannot restart a $5 planning session by itself.
    case "plan_drafted":
      await gh.addLabels("issue", n, ["needs-owner"]);
      await gh.removeLabels("issue", n, ["agent-ready"]);
      await setStatus(ctx, r.issue, "In Review");
      await gh.unassign(n, ctx.login);
      break;
  }
}

async function applyPlan(ctx: Ctx, epicNumber: number): Promise<void> {
  const { gh, cfg } = ctx;
  const epic = await gh.getIssue(epicNumber);
  const specPath = parseSpecPath(epic.body) ?? "";
  const nn =
    /phase-(\d\d)/.exec(specPath)?.[1] ?? /phase-(\d\d)/.exec(planIssuesPath(specPath, "x"))?.[1];
  const file = (ctx.listPlanFiles?.() ?? [])
    .filter((f) => nn && f.includes(`phase-${nn}-plan.issues.json`))
    .sort()
    .at(-1);
  const text = file ? ctx.readFile(join(cfg.repoDir, file)) : null;
  if (!text) {
    await gh.comment("issue", epicNumber, `${fmt.planApplied(cfg.host)} (no issues file)`);
    return;
  }
  const planFile = PlanIssuesSchema.parse(JSON.parse(text));
  for (const t of planFile.tasks) {
    let number = t.number;
    if (number) await gh.editBody(number, t.body);
    else {
      number = await gh.createIssue({ title: t.title, body: t.body, labels: t.labels });
      await gh.addSubIssue(epicNumber, number);
    }
    await gh.addLabels("issue", number, [...t.labels, "agent-ready"]);
    const existing = (await gh.listIssues("open")).find((i) => i.number === number);
    const itemId = existing?.itemId ?? (await gh.addToProject(number));
    await gh.setStatus(itemId, "Ready");
  }
  // The plan is applied, so the epic is no longer waiting on the owner: clear the gate that
  // holds the planner (#187) and put the epic back where the phase-closer can see it.
  await gh.removeLabels("issue", epicNumber, ["needs-owner"]);
  const item = epic.itemId ?? (await gh.addToProject(epicNumber));
  await gh.setStatus(item, "In Progress");
  await gh.comment("issue", epicNumber, fmt.planApplied(cfg.host));
}

export async function execute(action: Action, ctx: Ctx): Promise<"continue" | "stop"> {
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
      const issue = await gh.getIssue(action.issue);
      await gh.mergePR(action.pr);
      await gh.comment("issue", action.issue, fmt.merged(cfg.host));
      await gh.closeIssue(action.issue);
      await setStatus(ctx, issue, "Done");
      await ctx.removeWorktree(cfg, action.issue, ctx.exec);
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
    case "block":
      await gh.addLabels("issue", action.issue, ["blocked"]);
      await gh.comment("issue", action.issue, `blocked by foreman@${cfg.host}: ${action.reason}`);
      await gh.unassign(action.issue, ctx.login);
      return "continue";
    case "reclaim": {
      await gh.comment("issue", action.issue, fmt.reclaimed(action.fromHost, cfg.host, ctx.now()));
      const issue = await gh.getIssue(action.issue);
      const prs = await gh.listOpenPRs();
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
      if (action.role === "builder" && action.round === 1 && issue.status !== "In Progress")
        await setStatus(ctx, issue, "In Progress");
      await runRole(ctx, {
        issue,
        role: action.role,
        pr: action.pr,
        round: action.round,
        resumeSessionId: null,
        notes:
          action.round > 1
            ? "Read the PR review and the latest validator comment; address every item."
            : "",
      });
      return "stop";
    }
    case "resume": {
      const issue = await gh.getIssue(action.issue);
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
      await applyPlan(ctx, action.epic);
      return "continue";
  }
}

export async function runOnce(ctx: Ctx): Promise<void> {
  const pre = await preflight(ctx.cfg, {
    env: process.env,
    exec: ctx.exec,
    stateDir: ctx.stateDir,
    now: new Date(),
  });
  ctx.state?.patch({ lastPreflight: { ok: pre.ok, reason: pre.ok ? null : pre.reason } });
  if (!pre.ok) {
    log("warn", "preflight failed; sleeping", { reason: pre.reason });
    return;
  }
  const snapshot = await buildSnapshot(ctx);
  const actions = plan(snapshot);
  const names = actions.map((a) =>
    // Every non-idle Action variant carries either "issue" or "epic" — never neither — so a
    // third fallback branch is unreachable (and TS correctly types it as `never`).
    a.type === "idle" ? `idle(${a.reason})` : `${a.type}#${"issue" in a ? a.issue : a.epic}`,
  );
  log("info", "plan", { actions: names });
  const today = todayStats(readSessions(ctx.stateDir), new Date(snapshot.now));
  const board = describeBoard(snapshot, {
    host: ctx.cfg.host,
    preflight: { ok: true, reason: null },
    stopPresent: false,
    todayCount: today.count,
    cap: ctx.cfg.maxSessionsPerDay,
  });
  ctx.state?.patch({ lastPlan: names, board });
  for (const a of actions) {
    if (ctx.signal.aborted) {
      log("info", "stopping before next action", { next: a.type });
      break;
    }
    if ((await execute(a, ctx)) === "stop") break;
  }
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
  iterate?: (ctx: Ctx) => Promise<void>;
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
    try {
      await lock(() => iterate(ctx));
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      log("error", "loop iteration failed", {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures,
        nextAttemptSeconds: backoffSeconds(ctx.cfg.pollSeconds, consecutiveFailures),
      });
    }
    const delayMs = backoffSeconds(ctx.cfg.pollSeconds, consecutiveFailures) * 1000;
    ctx.state?.patch({
      lastTickAt: ctx.now(),
      nextTickAt: new Date(Date.now() + delayMs).toISOString(),
      consecutiveFailures,
    });
    if (ctx.signal.aborted) return;
    await sleep(delayMs);
  }
}
