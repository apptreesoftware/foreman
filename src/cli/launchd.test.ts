import { describe, expect, it } from "vitest";
import { launchdLabel, renderPlist } from "./launchd.ts";

describe("launchd", () => {
  it("label is per instance", () => {
    expect(launchdLabel("widgets")).toBe("com.apptreesoftware.foreman.widgets");
  });
  it("plist runs `foreman -p <name> run` with KeepAlive, logs under the state dir, and no billing vars", () => {
    const p = renderPlist({
      label: "com.apptreesoftware.foreman.widgets",
      node: "/usr/local/bin/node",
      foremanBin: "/opt/homebrew/bin/foreman",
      instance: "widgets",
      stateDir: "/Users/me/.foreman/widgets",
      home: "/Users/me",
      path: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    expect(p).toContain("<key>Label</key><string>com.apptreesoftware.foreman.widgets</string>");
    expect(p).toContain(
      "<string>/usr/local/bin/node</string><string>/opt/homebrew/bin/foreman</string><string>-p</string><string>widgets</string><string>run</string>",
    );
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>ThrottleInterval</key><integer>60</integer>");
    expect(p).toContain("/Users/me/.foreman/widgets/logs/foreman.out.log");
    expect(p).toContain("<key>HOME</key><string>/Users/me</string>");
    expect(p).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(p).not.toContain("ANTHROPIC_API_KEY");
  });
});
