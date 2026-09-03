import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../launchd");
describe("launchd files", () => {
  it("plist keeps the agent alive and logs under ~/.tone_tonic/logs", () => {
    const plist = readFileSync(join(dir, "com.tonetonic.foreman.plist"), "utf8");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("com.tonetonic.foreman");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("__HOME__/.tone_tonic/logs/foreman.out.log");
    expect(plist).toContain("__REPO__/tools/foreman/launchd/foreman.sh");
    expect(plist).not.toContain("ANTHROPIC_API_KEY");
  });
  it("wrapper unsets billing vars, cds to the repo and execs pnpm start", () => {
    const sh = readFileSync(join(dir, "foreman.sh"), "utf8");
    expect(sh).toContain("unset ANTHROPIC_API_KEY");
    expect(sh).toContain("exec pnpm --filter @tone/foreman start");
    expect(sh).toContain("__REPO__");
  });
});
