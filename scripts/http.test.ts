import { describe, expect, it } from "vitest";
import { waitForHttp } from "./http.ts";

describe("waitForHttp", () => {
  it("resolves once the probe returns ok", async () => {
    let n = 0;
    const probe = async () => ({ ok: ++n >= 3 });
    await expect(waitForHttp("http://x", { probe, timeoutMs: 1000, intervalMs: 1 })).resolves.toBe(
      true,
    );
    expect(n).toBe(3);
  });
  it("gives up after the timeout", async () => {
    const probe = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(waitForHttp("http://x", { probe, timeoutMs: 20, intervalMs: 5 })).resolves.toBe(
      false,
    );
  });
});
