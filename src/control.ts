import type { StopMode } from "./state-file.ts";

/** Owns the daemon's abort signal. Signals and the web page both call `request`. */
export class Controller {
  private readonly ac = new AbortController();
  private mode: StopMode | null = null;
  private wakers = new Set<() => void>();

  constructor(private readonly onChange: (mode: StopMode) => void = () => {}) {}

  get signal(): AbortSignal {
    return this.ac.signal;
  }
  get stopMode(): StopMode | null {
    return this.mode;
  }
  /** Number of `sleep()` calls still pending. Test/diagnostic use only. */
  get pendingSleeps(): number {
    return this.wakers.size;
  }

  /** stop → abort upgrades; anything else after the first request is ignored. */
  request(mode: StopMode): boolean {
    if (this.mode === mode || this.mode === "abort") return false;
    this.mode = mode;
    if (!this.ac.signal.aborted) this.ac.abort();
    this.onChange(mode);
    this.wake();
    return true;
  }

  wake(): void {
    const ws = this.wakers;
    this.wakers = new Set();
    for (const w of ws) w();
  }

  sleep(ms: number): Promise<void> {
    if (this.ac.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  install(p: NodeJS.Process = process): void {
    p.on("SIGTERM", () => this.request("stop"));
    p.on("SIGINT", () => this.request("stop"));
    p.on("SIGUSR1", () => this.request("abort"));
    p.on("SIGUSR2", () => this.wake());
  }
}

/** Serialises the poll tick and the web page's on-demand `next` computation. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
