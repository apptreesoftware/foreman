import type { Comment, Role } from "./types.ts";

export interface Claim {
  host: string;
  at: string;
  role: Role;
  round: number;
}

export const fmt = {
  claimed: (host: string, at: string, role: Role, round: number) =>
    `claimed by ${host} at ${at} role=${role} round=${round}`,
  session: (id: string, host: string, role: Role, attempt: number) =>
    `session ${id} on ${host} role=${role} attempt=${attempt}`,
  finished: (
    id: string,
    host: string,
    outcome: string,
    turns: number,
    cost: number,
    minutes: number,
  ) =>
    `session ${id} finished on ${host}: outcome=${outcome} turns=${turns} cost=$${cost.toFixed(2)} duration=${minutes}m`,
  released: (host: string, reason: string) => `released by ${host}: ${reason}`,
  reclaimed: (from: string, by: string, at: string) => `reclaimed from ${from} by ${by} at ${at}`,
  merged: (host: string) => `merged by foreman@${host}`,
  planApplied: (host: string) => `plan applied by foreman@${host}`,
  interrupted: (id: string, host: string, minutes: number) =>
    `session ${id} interrupted on ${host}: stopped by operator after ${minutes}m`,
  aborted: (host: string) => `released by ${host}: aborted by operator`,
  unblocked: (host: string) => `unblocked by owner via foreman@${host}`,
  adopted: (host: string) => `adopted onto board by ${host}`,
};

const CLAIM =
  /^claimed by (\S+) at (\S+) role=(builder|reviewer|validator|phase-closer|planner) round=(\d+)/;
const SESSION = /^session ([0-9a-f-]{36}) on (\S+) role=(\S+) attempt=(\d+)/;
const TERMINAL = /^(session \S+ finished|released by|reclaimed from|merged by foreman@)/;

export function parseClaim(body: string): Claim | null {
  const m = CLAIM.exec(body.trim());
  return m
    ? { host: m[1] as string, at: m[2] as string, role: m[3] as Role, round: Number(m[4]) }
    : null;
}

export function openClaim(comments: Comment[]): { claim: Claim; sessionId: string | null } | null {
  let open: { claim: Claim; sessionId: string | null } | null = null;
  for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const body = c.body.trim();
    const claim = parseClaim(body);
    if (claim) open = { claim, sessionId: null };
    else if (open && SESSION.test(body))
      open.sessionId = (SESSION.exec(body) as RegExpExecArray)[1] as string;
    else if (TERMINAL.test(body)) open = null;
  }
  return open;
}

export function activeClaims(comments: Comment[]): Claim[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let lastTerminal = -1;
  for (const [i, c] of sorted.entries()) {
    if (TERMINAL.test(c.body.trim())) lastTerminal = i;
  }
  return sorted
    .slice(lastTerminal + 1)
    .map((c) => parseClaim(c.body))
    .filter((c): c is Claim => c !== null);
}

export function fixRound(comments: Comment[]): number {
  return Math.max(
    1,
    ...comments
      .map((c) => parseClaim(c.body))
      .filter((c) => c?.role === "builder")
      .map((c) => (c as Claim).round),
  );
}

export function lastActivityAt(comments: Comment[]): string | null {
  return (
    comments
      .map((c) => c.createdAt)
      .sort()
      .at(-1) ?? null
  );
}

export function planApplied(comments: Comment[]): boolean {
  return comments.some((c) => c.body.trim().startsWith("plan applied by foreman@"));
}
