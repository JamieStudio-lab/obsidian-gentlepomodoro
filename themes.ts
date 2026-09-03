/**
 * The theme registry — the single place a timer theme is declared.
 *
 * A theme used to be registered at FOUR sites: the union in types.ts, the
 * dropdown options and the write-path ternary in GentlePomoSettingTab, and a
 * pair of toggleClass calls in GentlePomoView. The ternary was the dangerous
 * one. Written as `value === "frosted-glass" ? "frosted-glass" : "classic"`,
 * it still type-checks after the union widens — so adding a third theme and
 * forgetting that line would store "classic" whenever the new theme was
 * picked, with no compile error and nothing at runtime to say so.
 *
 * Everything now derives from THEMES: the id type, the default, the dropdown,
 * the CSS class, and the resolver. A missing entry is a type error, and the
 * view needs no change at all to gain a theme.
 *
 * Adding one is two steps — an entry here, and a `.gp-theme-<id>` block in
 * styles.css. See THEMES.md for what that block is required to declare.
 */

/** id -> the label shown in the settings dropdown. */
export const THEMES = {
  classic: "Classic",
  "frosted-glass": "Frosted glass",
  "rooftop-skyline": "Rooftop skyline",
} as const;

export type PomoTheme = keyof typeof THEMES;

/**
 * The theme a plugin starts on, and the landing spot for an unreadable one.
 * Also the value DEFAULT_SETTINGS carries, so the two cannot drift.
 */
export const DEFAULT_THEME: PomoTheme = "classic";

export const THEME_IDS = Object.keys(THEMES) as PomoTheme[];

/** The class the view puts on its container. Themes scope their CSS to it. */
export function themeClass(id: PomoTheme): string {
  return `gp-theme-${id}`;
}

/**
 * Narrow an arbitrary stored value to a real theme.
 *
 * data.json is hand-editable and sync-mergeable, and `coerceToDefaults` cannot
 * help here: a bogus theme id is still a string, so it has the same type as
 * the default and passes every check. Since 0.6.0 each theme's artwork is
 * opt-in — shown only by its own block — an id matching no theme would leave
 * the timer square empty rather than falling through to classic's rules, as it
 * silently did before.
 */
export function resolveTheme(value: unknown): PomoTheme {
  // Membership is tested against the id LIST, not with `in`. `in` walks the
  // prototype chain, so `"toString" in THEMES` is true — which would have
  // resolved to a `gp-theme-toString` class matching no block, i.e. the empty
  // square this function exists to prevent. Caught by its own test.
  return THEME_IDS.includes(value as PomoTheme) ? (value as PomoTheme) : DEFAULT_THEME;
}
