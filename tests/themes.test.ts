import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, THEME_IDS, resolveTheme, themeClass } from "../themes";

describe("theme registry", () => {
  it("keeps the id list and the label map in step", () => {
    expect(THEME_IDS).toEqual(Object.keys(THEMES));
    expect(THEME_IDS.length).toBeGreaterThan(0);
  });

  it("ships a default that is a real theme", () => {
    expect(THEME_IDS).toContain(DEFAULT_THEME);
  });

  it("derives the CSS class from the id", () => {
    for (const id of THEME_IDS) expect(themeClass(id)).toBe(`gp-theme-${id}`);
  });
});

describe("resolveTheme", () => {
  it("passes every registered id through unchanged", () => {
    for (const id of THEME_IDS) expect(resolveTheme(id)).toBe(id);
  });

  // data.json is hand-editable and sync-mergeable, and coerceToDefaults cannot
  // help: a bogus theme id is still a string, so it has the same type as the
  // default and passes every check it makes. Since artwork became opt-in per
  // theme, an unresolved id would leave the timer square empty rather than
  // falling through to classic's rules the way it silently did before.
  it.each([
    ["an unknown id", "moon-phases"],
    ["the pre-2026-05 legacy id", "sunset"],
    ["an empty string", ""],
    ["a number", 3],
    ["null", null],
    ["undefined", undefined],
    ["an object", { theme: "classic" }],
    ["a prototype key, which `in` alone would accept", "toString"],
  ])("falls back to the default for %s", (_label, value) => {
    expect(resolveTheme(value)).toBe(DEFAULT_THEME);
  });
});
