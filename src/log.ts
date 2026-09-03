export type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}
