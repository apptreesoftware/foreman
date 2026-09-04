import type { GitHubApi } from "./github.ts";
import { fmt } from "./ledger.ts";
import type { StopMode } from "./state-file.ts";

export const GH_TIMEOUT_MS = 20_000;

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface InterruptInput {
  mode: StopMode;
  host: string;
  login: string;
  issue: number;
  role: string;
  round: number;
  sessionId: string;
  minutes: number;
}

export type InterruptGh = Pick<GitHubApi, "comment" | "unassign" | "setStatus" | "getIssue">;

/**
 * The ledger writes for an operator interrupt. `stop` keeps the claim open (the next start
 * resumes); `abort` closes it. Returns a description of each write for logging.
 */
export async function ledgerInterrupt(
  gh: InterruptGh,
  i: InterruptInput,
  timeoutMs = GH_TIMEOUT_MS,
): Promise<string[]> {
  const done: string[] = [];
  const call = async (label: string, p: Promise<unknown>) => {
    await withTimeout(p, timeoutMs, label);
    done.push(label);
  };
  if (i.mode === "stop") {
    await call(
      `comment interrupted #${i.issue}`,
      gh.comment("issue", i.issue, fmt.interrupted(i.sessionId, i.host, i.minutes)),
    );
    return done;
  }
  await call(`comment released #${i.issue}`, gh.comment("issue", i.issue, fmt.aborted(i.host)));
  await call(`unassign #${i.issue}`, gh.unassign(i.issue, i.login));
  if (i.role === "builder" && i.round === 1) {
    const issue = await withTimeout(gh.getIssue(i.issue), timeoutMs, `getIssue #${i.issue}`);
    if (issue.status === "In Progress" && issue.itemId)
      await call(`status Ready #${i.issue}`, gh.setStatus(issue.itemId, "Ready"));
  }
  return done;
}
