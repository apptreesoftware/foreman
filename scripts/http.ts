export interface WaitOptions {
  probe?: (url: string) => Promise<{ ok: boolean }>;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function waitForHttp(url: string, o: WaitOptions = {}): Promise<boolean> {
  const probe = o.probe ?? ((u: string) => fetch(u).then((r) => ({ ok: r.ok })));
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    try {
      if ((await probe(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 1000));
  }
  return false;
}
