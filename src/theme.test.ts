import { describe, expect, it } from "vitest";
import { pickTheme, THEMES, type ThemeName } from "./theme.ts";

describe("pickTheme", () => {
  it("is stable for a name", () => {
    expect(pickTheme("litart", [])).toBe(pickTheme("litart", []));
    expect(THEMES).toContain(pickTheme("litart", []));
  });

  it("takes the only unused theme", () => {
    expect(pickTheme("anything", ["indigo", "violet", "teal"])).toBe("mono");
    expect(pickTheme("else", ["mono", "violet", "teal", "violet"])).toBe("indigo");
  });

  it("four instances in turn get four different themes", () => {
    const taken: ThemeName[] = [];
    for (const name of ["apptrade", "fishcity", "litart", "tone_tonic"])
      taken.push(pickTheme(name, taken));
    expect(new Set(taken).size).toBe(4);
  });

  it("a fifth instance repeats one", () => {
    expect(THEMES).toContain(pickTheme("fifth", ["indigo", "violet", "teal", "mono"]));
  });
});
