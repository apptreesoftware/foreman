import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Controller, Mutex } from "./control.ts";

describe("Controller", () => {
  it("stop aborts the signal once and abort upgrades a pending stop", () => {
    const seen: string[] = [];
    const c = new Controller((m) => seen.push(m));
    expect(c.stopMode).toBeNull();
    expect(c.request("stop")).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(c.request("stop")).toBe(false);
    expect(c.request("abort")).toBe(true);
    expect(c.stopMode).toBe("abort");
    expect(c.request("stop")).toBe(false); // never downgrades
    expect(seen).toEqual(["stop", "abort"]);
  });
  it("sleep returns early on wake and on abort", async () => {
    const c = new Controller();
    const t0 = Date.now();
    const p = c.sleep(5_000);
    c.wake();
    await p;
    expect(Date.now() - t0).toBeLessThan(1_000);
    const p2 = c.sleep(5_000);
    c.request("stop");
    await p2;
    expect(Date.now() - t0).toBeLessThan(1_000);
    await c.sleep(5_000); // already aborted: resolves at once
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it("sleep removes its own waker on timeout, not just on wake", async () => {
    const c = new Controller();
    expect(c.pendingSleeps).toBe(0);
    await c.sleep(1);
    await c.sleep(1);
    await c.sleep(1);
    expect(c.pendingSleeps).toBe(0);
  });
  it("install maps signals to stop, abort and wake", () => {
    const c = new Controller();
    const fake = new EventEmitter();
    c.install(fake as unknown as NodeJS.Process);
    let woke = false;
    const p = c.sleep(5_000).then(() => {
      woke = true;
    });
    fake.emit("SIGUSR2");
    return p.then(() => {
      expect(woke).toBe(true);
      fake.emit("SIGTERM");
      expect(c.stopMode).toBe("stop");
      fake.emit("SIGUSR1");
      expect(c.stopMode).toBe("abort");
    });
  });
});

describe("Mutex", () => {
  it("serialises overlapping runs", async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
      return 1;
    });
    const b = m.run(async () => {
      order.push("b");
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
  it("releases after a rejection", async () => {
    const m = new Mutex();
    await expect(m.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await m.run(async () => 3)).toBe(3);
  });
});
