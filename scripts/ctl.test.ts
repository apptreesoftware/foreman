import { describe, expect, it } from "vitest";
import { parseCtlArgs } from "./ctl-args.ts";

describe("parseCtlArgs", () => {
  it("parses command and flags", () => {
    expect(parseCtlArgs(["status", "--watch"])).toEqual({
      cmd: "status",
      watch: true,
      json: false,
      config: undefined,
      model: null,
    });
    expect(parseCtlArgs(["status", "--json", "--config", "/c"])).toMatchObject({
      cmd: "status",
      json: true,
      config: "/c",
    });
    expect(parseCtlArgs(["abort"])).toMatchObject({ cmd: "abort" });
  });
  it("parses model, with and without a name", () => {
    expect(parseCtlArgs(["model"])).toMatchObject({ cmd: "model", model: null });
    expect(parseCtlArgs(["model", "sonnet"])).toMatchObject({ cmd: "model", model: "sonnet" });
  });
  it("rejects unknown commands", () => {
    expect(() => parseCtlArgs(["dance"])).toThrow(/usage/);
    expect(() => parseCtlArgs([])).toThrow(/usage/);
  });
});
