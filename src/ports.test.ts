import { describe, expect, it } from "vitest";
import {
  DEV_API_PORT,
  DEV_SUPABASE_API_URL,
  DEV_WEB_PORT,
  portFromEnv,
  ROLE_API_PORT,
  ROLE_SUPABASE_API_URL,
  ROLE_WEB_PORT,
  roleSessionEnv,
  stackPorts,
} from "./ports.ts";

describe("portFromEnv", () => {
  it("takes a valid port and falls back on anything else", () => {
    expect(portFromEnv("8182", 8082)).toBe(8182);
    expect(portFromEnv(undefined, 8082)).toBe(8082);
    expect(portFromEnv("", 8082)).toBe(8082);
    expect(portFromEnv("nope", 8082)).toBe(8082);
    expect(portFromEnv("0", 8082)).toBe(8082);
    expect(portFromEnv("70000", 8082)).toBe(8082);
    expect(portFromEnv("81.5", 8082)).toBe(8082);
  });
});

describe("stackPorts", () => {
  it("defaults to the owner's dev stack", () => {
    expect(stackPorts({})).toMatchObject({
      web: DEV_WEB_PORT,
      api: DEV_API_PORT,
      webUrl: "http://localhost:8082",
      apiUrl: "http://localhost:3005",
      supabaseUrl: DEV_SUPABASE_API_URL,
    });
  });
  it("follows the role session's environment", () => {
    expect(stackPorts(roleSessionEnv())).toMatchObject({
      web: ROLE_WEB_PORT,
      api: ROLE_API_PORT,
      webUrl: "http://localhost:8182",
      apiUrl: "http://localhost:3105",
      supabaseUrl: ROLE_SUPABASE_API_URL,
    });
  });
});

describe("roleSessionEnv", () => {
  it("names the isolated stack the foreman starts", () => {
    expect(roleSessionEnv()).toEqual({
      TONE_WEB_PORT: "8182",
      TONE_API_PORT: "3105",
      SUPABASE_API_URL: "http://127.0.0.1:55621",
    });
  });
});
