import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CAPTION_NAME_FADE_MS, VIEW_TYPE_GENTLE_POMO } from "../constants";
import { THEME_IDS, themeClass } from "../themes";

/**
 * The stylesheet's own test suite.
 *
 * Nothing else can see styles.css: no other suite references a `gp-` class,
 * and computed styles only exist inside a running Obsidian. So the rules that
 * hold this file together were, until 0.6.0, enforced by comments — which is
 * how `--gp-shadow-rgb` came to be read six times and declared nowhere for the
 * whole life of the theme feature, rendering a fallback nobody had chosen.
 *
 * These are text checks, deliberately. They cannot tell you a colour is ugly
 * or a layout is broken. They can tell you a token is a typo, a token is dead,
 * a theme has started reaching into another theme, or a value that must agree
 * with TypeScript has quietly stopped agreeing — which is every regression
 * this file has actually shipped.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "styles.css"), "utf8");

/** Everything before the first rule: the :root block and its comments. */
const TOKEN_BLOCK_END = css.indexOf("/* Enforce the minimum height");
const tokenBlock = css.slice(0, TOKEN_BLOCK_END);
const rules = css.slice(TOKEN_BLOCK_END);

const declared = new Set([...css.matchAll(/^\s*(--gp-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
const consumed = new Set([...css.matchAll(/var\(\s*(--gp-[a-z0-9-]+)/g)].map((m) => m[1]));

/**
 * Published from TypeScript onto `.gp-timer-visual`, so they are read in CSS
 * and never declared there. GentlePomoView sets all three; see the sky-phase
 * block in its timer listener.
 */
const PUBLISHED_FROM_TS = ["--gp-progress", "--gp-dusk-opacity", "--gp-night-opacity"];

describe("token hygiene", () => {
  it("declares every custom property it reads", () => {
    const missing = [...consumed].filter((t) => !declared.has(t) && !PUBLISHED_FROM_TS.includes(t));
    expect(missing, "read but never declared — a typo, or a promise never kept").toEqual([]);
  });

  it("reads every custom property it declares", () => {
    const dead = [...declared].filter((t) => !consumed.has(t));
    expect(dead, "declared but never read — delete it or wire it up").toEqual([]);
  });

  it("keeps the three TypeScript-published variables un-declared in CSS", () => {
    // If one of these ever gains a CSS declaration it would mask the value the
    // view is publishing, and the timer would stop tracking the session.
    for (const name of PUBLISHED_FROM_TS) {
      expect(declared.has(name), `${name} must come from GentlePomoView, not CSS`).toBe(false);
    }
  });
});

/**
 * What a theme must declare. Every one is read by a shared rule with today's
 * value as an inline fallback, so a theme that declares nothing still renders —
 * the list is what THEMES.md publishes as the theme API.
 */
const CONTRACT_TOKENS = [
  "--gp-font-display",
  "--gp-ink",
  "--gp-ink-dim",
  "--gp-ink-soft",
  "--gp-ink-faint",
  "--gp-ink-badge",
  "--gp-ink-shadow-lg",
  "--gp-ink-shadow",
  "--gp-ink-overtime",
  "--gp-ink-overtime-glow",
  "--gp-scrim-alpha",
  "--gp-shape-base",
  "--gp-shape-radius",
  "--gp-shadow-rgb",
];

describe("theme independence", () => {
  const themeBlocks = THEME_IDS.map((id) => ({ id, cls: themeClass(id) }));

  it("gives every registered theme a block declaring the three contract tokens", () => {
    for (const { id, cls } of themeBlocks) {
      const block = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
      expect(block, `no .${cls} token block in styles.css — see THEMES.md`).not.toBeNull();
      for (const token of CONTRACT_TOKENS) {
        expect(block?.[1], `theme "${id}" must declare ${token}`).toContain(token);
      }
    }
  });

  it("never lets one theme's selector name another theme's classes", () => {
    // Frosted Glass used to hide Classic's three layers by name, which is why
    // "classic" was not a theme at all — it was whatever was left over. That
    // shape needs N x (N-1) rules; catching it here keeps it at one block each.
    const OWN = {
      classic: /gp-layer-/,
      "frosted-glass": /gp-(?:glass|orb)/,
      "rooftop-skyline": /gp-rooftop/,
    } as const;
    for (const { id, cls } of themeBlocks) {
      for (const other of themeBlocks) {
        if (other.id === id) continue;
        const foreign = OWN[other.id as keyof typeof OWN];
        if (!foreign) continue;
        const offending = rules
          .split("\n")
          .filter((l) => l.includes(cls) && foreign.test(l) && !l.trimStart().startsWith("*"));
        expect(offending, `.${cls} reaches into theme "${other.id}"`).toEqual([]);
      }
    }
  });

  it("hides artwork by default so a theme only has to show its own", () => {
    expect(rules).toMatch(/\.gp-art\s*\{[^}]*display:\s*none/);
  });

  /** The text between the Rooftop Skyline banner and the next section banner. */
  const rooftop = (() => {
    const title = rules.indexOf("Theme 3: Rooftop Skyline");
    expect(title, "the Rooftop Skyline section is gone").toBeGreaterThan(-1);
    // From the banner's own opening `/*`, so the comment stripper below sees
    // the banner as a comment rather than leaving its prose in the text.
    const start = rules.lastIndexOf("/* ====", title);
    const next = rules.indexOf("/* ====", title);
    return rules.slice(start, next === -1 ? undefined : next);
  })();

  // THEMES.md, "pick exactly one smoothing route": --gp-progress is already
  // eased 0.8s on .gp-timer-visual. A theme that reads it AND transitions its
  // own plates doubles every skip and reset to ~1.6s — the reason Classic
  // still takes two pre-computed opacities from the view instead.
  it("moves the Rooftop Skyline plates on --gp-progress and on nothing else", () => {
    expect(rooftop).toMatch(/var\(--gp-progress\)/);
    expect(rooftop.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/transition/);
  });

  // A theme-scoped animation selector out-specifies the shared reduced-motion
  // `animation: none`, so an ungated one re-enables motion for exactly the
  // people who turned it off. This shipped once already (the mobile frosted
  // pulse); the gate is the fix, and this keeps it on the rooftop's opt-out.
  // Overtime is still running. The opt-out out-specifies the shared overtime
  // rule, so unless it excludes that state it replaces the blue / orange
  // breathing glow with the plain breath — which is what the first cut did.
  it("leaves the overtime glow alone on the Rooftop Skyline", () => {
    expect(rooftop).toContain(".gp-state-running:not(.gp-state-overtime) .gp-timer-shape");
    expect(rooftop).not.toMatch(/\.gp-state-running \.gp-timer-shape/);
  });

  it("gates the Rooftop Skyline pulse opt-out on prefers-reduced-motion", () => {
    const sel =
      ".gp-theme-rooftop-skyline .gp-state-running:not(.gp-state-overtime) .gp-timer-shape";
    const at = rooftop.indexOf(sel);
    expect(at, "the pulse opt-out is gone").toBeGreaterThan(-1);
    const gate = rooftop.lastIndexOf("@media (prefers-reduced-motion: no-preference)", at);
    expect(gate, "the opt-out is not inside a no-preference media block").toBeGreaterThan(-1);
    // and no closing brace of that block sits between the gate and the rule
    const between = rooftop.slice(gate, at);
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    expect(opens - closes, "the opt-out sits after the gated block closed").toBe(1);
  });
});

describe("focus rings", () => {
  // Both rules are (0,2,0), so ONLY source order decides. The station list is
  // overflow-y: auto with a max-height, so it needs the inset offset or the
  // ring is clipped at the first and last visible row — the two rows most
  // likely to have it. If the shared rule ever moves below, that clipping
  // comes back and only at the scroll edges.
  it("declares the shared row ring before the station list's inset one", () => {
    // Comments are stripped first: the prose above these rules names both
    // selectors, and matching that text finds the wrong order.
    const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
    const shared = code.indexOf(".gp-task-item:focus-visible");
    const station = code.indexOf(".gp-station-item:focus-visible");
    expect(shared, "the shared focus rule is gone").toBeGreaterThan(-1);
    expect(station, "the station focus rule is gone").toBeGreaterThan(-1);
    expect(shared).toBeLessThan(station);
  });

  it("gives every control class a ring", () => {
    for (const cls of [
      ".gp-btn",
      ".gp-btn-full",
      ".gp-icon-btn",
      ".gp-reset-button",
      ".gp-task-item",
      ".gp-segmented-btn",
      ".gp-station-item",
    ]) {
      expect(rules, `${cls} has no :focus-visible rule`).toContain(`${cls}:focus-visible`);
    }
  });

  // box-shadow has no `solid` keyword, so a shared `outline` shorthand is
  // invalid there at computed-value time and the property is dropped —
  // the toggle's ring disappears with nothing to show for it.
  it("keeps the ring's width and colour separate, never one shorthand", () => {
    expect(rules).toContain(
      "box-shadow: 0 0 0 var(--gp-focus-ring-width) var(--gp-focus-ring-color)"
    );
    expect(tokenBlock).not.toMatch(/--gp-focus-ring:\s/);
  });
});

describe("values that must agree with TypeScript", () => {
  // The view holds the two caption names invisible for CAPTION_NAME_FADE_MS and
  // repaints in the gap the CSS fade opens. Longer in CSS repaints mid-fade;
  // shorter stalls with the text already swapped.
  it("--gp-name-fade matches CAPTION_NAME_FADE_MS", () => {
    const m = /--gp-name-fade:\s*([\d.]+)(m?s)\s*;/.exec(css);
    expect(m, "--gp-name-fade is gone from styles.css").not.toBeNull();
    const ms = Number(m![1]) * (m![2] === "ms" ? 1 : 1000);
    expect(ms).toBe(CAPTION_NAME_FADE_MS);
  });

  // Renaming the view type without this selector leaves Obsidian's resize
  // divider matching nothing, so the leaf silently shrinks past 320px again.
  it("the leaf-content selector matches VIEW_TYPE_GENTLE_POMO", () => {
    expect(css).toContain(`[data-type="${VIEW_TYPE_GENTLE_POMO}"]`);
  });
});

describe("raw values outside the scale", () => {
  /**
   * A ratchet, not a ban. Each entry below is a value 0.6.0 deliberately left
   * literal, with the reason. Anything NEW fails, which is the point: the day
   * after this lands, the next rule someone writes cannot quietly reintroduce
   * a fourth near-identical duration.
   */
  const ALLOWED_DURATIONS = new Set([
    "0.15s", // segmented-control hover; snaps to the scale in 0.6.1
    "0.25s", // six sites; snapping to 200ms is a visible 50ms change
    "1s", // the overtime settle, paired with the 6s breath below
    "0s", // an explicit zero, not a tempo
    "4s",
    "6s",
    "8s", // ambient breaths
    "65s",
    "58s",
    "72s", // orb drifts; their non-divisibility is the feature
  ]);

  it("introduces no new literal duration", () => {
    const found = new Set<string>();
    for (const line of rules.split("\n")) {
      if (/^\s*(--gp-|\/\*|\*)/.test(line)) continue;
      if (!/transition|animation/.test(line) && !/^\s*[\d.]+m?s/.test(line)) {
        // durations only ever appear in these two shorthands or their longhands
        if (!/:\s*[^;]*\b[\d.]+m?s\b/.test(line)) continue;
      }
      for (const m of line.matchAll(/(?<![\w.-])(\d*\.?\d+m?s)(?![\w-])/g)) {
        if (!ALLOWED_DURATIONS.has(m[1])) found.add(m[1]);
      }
    }
    expect(
      [...found],
      "use a --gp-dur-* step, or add the value to ALLOWED_DURATIONS with a reason"
    ).toEqual([]);
  });

  it("keeps every declared token inside the :root block or a theme block", () => {
    // A token declared halfway down the file is how the old --gp-progress
    // registration ended up inside one theme's section while a shared rule
    // depended on it.
    const themeScoped = new Set(CONTRACT_TOKENS);
    const stray = [...rules.matchAll(/^\s*(--gp-[a-z0-9-]+)\s*:/gm)]
      .map((m) => m[1])
      .filter((t) => !themeScoped.has(t))
      .filter(
        // the touch tier, the orb palette and the caption's own timings are
        // deliberately declared at their point of use
        (t) =>
          ![
            "--gp-tap-min",
            "--gp-control-h",
            "--gp-segmented-inset",
            "--gp-control-gap",
            "--gp-icon-btn-size",
            "--gp-icon-svg-size",
            "--gp-orb-warm",
            "--gp-orb-cool",
            "--gp-glow-color",
            "--gp-caption-fade",
            "--gp-caption-delay",
            "--gp-name-fade",
          ].includes(t)
      );
    expect([...new Set(stray)], "declare it in :root, or list it as a scoped exception").toEqual(
      []
    );
  });

  it("has a :root token block at the top of the file", () => {
    expect(tokenBlock).toContain(":root {");
    expect(tokenBlock.indexOf(":root {")).toBeGreaterThan(-1);
  });
});
