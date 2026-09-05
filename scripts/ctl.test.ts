import { describe, expect, it } from "vitest";
import { parseCtlArgs } from "./ctl-args.ts";

describe("parseCtlArgs", () => {
  it("parses command and flags", () => {
    expect(parseCtlArgs(["status", "--watch"])).toEqual({
      cmd: "status",
      watch: true,
      json: false,
      config: undefined,
      value: null,
    });
    expect(parseCtlArgs(["status", "--json", "--config", "/c"])).toMatchObject({
      cmd: "status",
      json: true,
      config: "/c",
    });
    expect(parseCtlArgs(["abort"])).toMatchObject({ cmd: "abort" });
  });
  it("parses model, with and without a name", () => {
    expect(parseCtlArgs(["model"])).toMatchObject({ cmd: "model", value: null });
    expect(parseCtlArgs(["model", "sonnet"])).toMatchObject({ cmd: "model", value: "sonnet" });
  });
  it("parses cap, with and without a value", () => {
    expect(parseCtlArgs(["cap"])).toMatchObject({ cmd: "cap", value: null });
    expect(parseCtlArgs(["cap", "50"])).toMatchObject({ cmd: "cap", value: "50" });
    expect(parseCtlArgs(["cap", "default"])).toMatchObject({ cmd: "cap", value: "default" });
  });
  it("rejects unknown commands", () => {
    expect(() => parseCtlArgs(["dance"])).toThrow(/usage/);
    expect(() => parseCtlArgs([])).toThrow(/usage/);
  });
});
