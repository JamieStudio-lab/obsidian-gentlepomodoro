import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CAPTION_NAME_FADE_MS, VIEW_TYPE_GENTLE_POMO } from "../constants";
import { THEME_IDS, themeClass } from "../themes";
import {
  bodyAt,
  namesClass,
  parseRules,
  selectorText,
  stripComments,
  themeSnapshot,
  type CssRule,
} from "./cssRules";

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

/** Comments removed, so prose naming a selector cannot be read as that rule. */
const stripped = stripComments(rules);

/** The selector text that owns the declaration at `pos`. */
const selectorOf = (text: string, pos: number): string => {
  const open = text.lastIndexOf("{", pos);
  const prev = Math.max(text.lastIndexOf("}", open), text.lastIndexOf("{", open - 1));
  return text.slice(prev + 1, open).trim();
};

/**
 * Every style rule in the comment-free stylesheet: selector list, body, and
 * the at-rule preludes around it.
 *
 * Whole rules, never lines. Prettier writes each selector of a list on its own
 * line and wraps a long descendant selector across several, so a line scan can
 * see neither a whole selector nor a whole selector list — which is how "never
 * names two different theme classes" came to pass for the one edit it existed
 * to stop. See tests/cssRules.ts.
 */
const styleRules: CssRule[] = parseRules(stripped);

/**
 * A committed fixture, with line endings normalised — the two theme freezes
 * are compared as text, and a checkout that converted the file to CRLF would
 * otherwise fail every line of the diff for a reason no one could act on.
 */
const fixture = (name: string): string =>
  readFileSync(resolve(root, "tests/fixtures", name), "utf8").replace(/\r\n/g, "\n");

/**
 * Compare against a committed fixture — or, run as
 *   GP_UPDATE_FIXTURES=1 npx vitest run tests/designTokens.test.ts
 * rewrite it from the tree. Opt-in and by hand only: a fixture that refreshed
 * itself would freeze nothing. Review the diff it leaves like any other change,
 * and say in the commit message why a frozen theme moved.
 */
const expectFixture = (name: string, actual: string): void => {
  if (process.env.GP_UPDATE_FIXTURES === "1") {
    writeFileSync(resolve(root, "tests/fixtures", name), actual);
    return;
  }
  expect(actual).toBe(fixture(name));
};

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

  it("gives every registered theme a block declaring every contract token", () => {
    for (const { id, cls } of themeBlocks) {
      // `\s*\{` after the class name is the token boundary here: it is what
      // stops the search for `.gp-theme-frosted-glass` landing on
      // `.gp-theme-frosted-glass-2 {`.
      const block = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
      expect(block, `no .${cls} token block in styles.css — see THEMES.md`).not.toBeNull();
      for (const token of CONTRACT_TOKENS) {
        expect(block?.[1], `theme "${id}" must declare ${token}`).toContain(token);
      }
    }
  });

  /**
   * Each theme's artwork nodes, and which themes SHARE a set of them.
   *
   * The two glass themes are built out of one set of nodes — .gp-glass-orbs,
   * .gp-orb-N, .gp-glass-pane, .gp-glass-highlight are created once by the
   * view and each theme styles them under its own class — so "reaching into
   * another theme" can no longer mean "names a node class another theme also
   * uses". It means naming a node class from another FAMILY. Themes inside one
   * family are exempt from each other here, and what keeps THEM apart is the
   * test below: no rule may name two different theme classes.
   */
  const ARTWORK = {
    classic: { family: "gradient layers", nodes: /gp-layer-/ },
    "frosted-glass": { family: "glass", nodes: /gp-(?:glass|orb)/ },
    "frosted-glass-2": { family: "glass", nodes: /gp-(?:glass|orb)/ },
    "pixel-city": { family: "pixel plates", nodes: /gp-pixel-city/ },
  } as const;

  it("never lets one theme's selector name another family's classes", () => {
    // Frosted Glass used to hide Classic's three layers by name, which is why
    // "classic" was not a theme at all — it was whatever was left over. That
    // shape needs N x (N-1) rules; catching it here keeps it at one block each.
    //
    // Per RULE, not per line: prettier wraps a long descendant selector across
    // several lines, so a theme class and the foreign node class it reaches
    // for can sit on different lines of one selector and a line scan sees
    // neither of them together.
    for (const { id, cls } of themeBlocks) {
      const mine = ARTWORK[id as keyof typeof ARTWORK];
      expect(mine, `theme "${id}" has no artwork family — add one`).toBeDefined();
      for (const other of themeBlocks) {
        const theirs = ARTWORK[other.id as keyof typeof ARTWORK];
        if (!theirs || other.id === id || theirs.family === mine.family) continue;
        // Whole-class match, not includes(): the fourth theme's class has the
        // second theme's class as a prefix.
        const offending = styleRules
          .filter((r) => namesClass(r.sel, cls) && theirs.nodes.test(r.sel))
          .map((r) => r.sel);
        expect(offending, `.${cls} reaches into theme "${other.id}"`).toEqual([]);
      }
    }
  });

  it("never names two different theme classes in one rule's selector list", () => {
    // With two themes sharing one set of artwork nodes this is the real
    // independence rule: a rule belongs to exactly one theme. It is also the
    // shape a careless fix for the prefix trap would take — grouping the old
    // and the new selector into one rule, after which neither theme can be
    // changed or deleted without touching the other.
    //
    // The whole SELECTOR LIST, not a line of it. This check used to scan
    // lines, and prettier puts every selector of a list on its own line, so
    // the merge it was written to catch is the one shape that passed it. A
    // rule is the unit here because a rule is what shares a body.
    const offending = styleRules
      .filter((r) => new Set([...r.sel.matchAll(/gp-theme-[a-z0-9-]+/g)].map((m) => m[0])).size > 1)
      .map((r) => r.sel);
    expect(offending, "one rule cannot belong to two themes").toEqual([]);
  });

  it("hides artwork by default so a theme only has to show its own", () => {
    expect(rules).toMatch(/\.gp-art\s*\{[^}]*display:\s*none/);
  });

  /**
   * The text between the Pixel City banner and the section's own end
   * banner. Empty when either is missing — the first test below says which,
   * so a renamed banner fails four tests rather than aborting the file.
   */
  const pixelCity = (() => {
    const title = rules.indexOf("Theme 3: Pixel City");
    if (title === -1) return "";
    // From the banner's own opening `/*`, so the comment stripper below sees
    // the banner as a comment rather than leaving its prose in the text; to
    // the end banner, because the chrome rules after the theme (the goal
    // progress line) are not the theme's and must not be policed as it.
    const start = rules.lastIndexOf("/* ====", title);
    const end = rules.indexOf("end of Theme 3", title);
    return end === -1 ? "" : rules.slice(start, end);
  })();

  it("has a Pixel City section closed by its own end banner", () => {
    expect(rules.indexOf("Theme 3: Pixel City"), "the section banner is gone").toBeGreaterThan(-1);
    const end = rules.indexOf("end of Theme 3");
    expect(end, "the section's end banner is gone").toBeGreaterThan(-1);
    expect(pixelCity.length).toBeGreaterThan(0);
    // The banner must sit between the theme's last rule and the first chrome
    // rule after it — or the slice above polices chrome again, or misses a
    // theme rule that drifted below the banner.
    expect(end, "the end banner sits after the goal-progress chrome").toBeLessThan(
      rules.indexOf(".gp-goal-progress {")
    );
    const after = rules.slice(end).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(after, "a Pixel City rule sits below the end banner").not.toContain(
      ".gp-theme-pixel-city"
    );
  });

  // THEMES.md, "pick exactly one smoothing route": --gp-progress is already
  // eased 0.8s on .gp-timer-visual. A theme that reads it AND transitions its
  // own plates doubles every skip and reset to ~1.6s — the reason Classic
  // still takes two pre-computed opacities from the view instead.
  it("moves the Pixel City plates on --gp-progress and on nothing else", () => {
    expect(pixelCity).toMatch(/var\(--gp-progress\)/);
    expect(pixelCity.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/transition/);
  });

  // A theme-scoped animation selector out-specifies the shared reduced-motion
  // `animation: none`, so an ungated one re-enables motion for exactly the
  // people who turned it off. This shipped once already (the mobile frosted
  // pulse); the gate is the fix, and this keeps it on the Pixel City opt-out.
  // Overtime is still running. The opt-out out-specifies the shared overtime
  // rule, so unless it excludes that state it replaces the blue / orange
  // breathing glow with the plain breath — which is what the first cut did.
  it("leaves the overtime glow alone on the Pixel City", () => {
    expect(pixelCity).toContain(".gp-state-running:not(.gp-state-overtime) .gp-timer-shape");
    expect(pixelCity).not.toMatch(/\.gp-state-running \.gp-timer-shape/);
  });

  it("gates the Pixel City pulse opt-out on prefers-reduced-motion", () => {
    const sel = ".gp-theme-pixel-city .gp-state-running:not(.gp-state-overtime) .gp-timer-shape";
    const at = pixelCity.indexOf(sel);
    expect(at, "the pulse opt-out is gone").toBeGreaterThan(-1);
    const gate = pixelCity.lastIndexOf("@media (prefers-reduced-motion: no-preference)", at);
    expect(gate, "the opt-out is not inside a no-preference media block").toBeGreaterThan(-1);
    // and no closing brace of that block sits between the gate and the rule
    const between = pixelCity.slice(gate, at);
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

  it("gives the panel's dropdown the plugin's ring, not Obsidian's halo", () => {
    // Obsidian styles a bare `select:focus` with a 3px
    // `--background-modifier-border-focus` halo and KEEPS it after a mouse
    // choice — `:focus-visible` matches a clicked <select> in Chromium, so
    // narrowing to keyboard focus does not remove it. On the panel's
    // full-width dropdown that halo is a light band across the whole 260px
    // column, which reads as a selection that got stuck rather than as focus.
    expect(rules).toContain(".gp-settings-select.dropdown:focus");
    const rule = rules.slice(rules.indexOf(".gp-settings-select.dropdown:focus"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("--gp-focus-ring-width");
    expect(body).toContain("--gp-focus-ring-color");
    // The halo has to be overwritten, not merely outlined over.
    expect(body).toContain("box-shadow:");
    expect(body).not.toContain("--background-modifier-border-focus");
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

describe("the panel's dropdown", () => {
  const view = readFileSync(resolve(root, "GentlePomoView.ts"), "utf8");

  it("carries Obsidian's own dropdown class", () => {
    // Not decoration. Obsidian's BARE `select` rule already sets
    // `appearance: none`, and only `.dropdown` carries the chevron
    // background-image — so dropping this class leaves a plain filled
    // rectangle with no arrow, which no local test could otherwise see.
    expect(view).toContain('cls: "gp-settings-select dropdown"');
  });

  it("names both classes in CSS rather than relying on stylesheet order", () => {
    // `.gp-settings-select` alone ties `.dropdown` on specificity, so which one
    // won would depend on load order — the source-order trap the register in
    // DESIGN.md exists for.
    const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of code.matchAll(/^\.gp-settings-select[^{]*\{/gm)) {
      expect(match[0], "must be qualified with .dropdown").toContain(".dropdown");
    }
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
            // Frosted glass 2's rim tokens, declared on .gp-timer-shape
            // because --gp-progress only resolves there. Permission to exist
            // outside :root, nothing more — where they may be declared is
            // held by the "Frosted glass 2's lit rim" describe below.
            "--gp-lg-1",
            "--gp-lg-2",
            "--gp-lg-3",
            "--gp-lg-deep",
            "--gp-lg-deepen",
            "--gp-lg-lift",
            "--gp-lg-pool",
            "--gp-lg-pool-lift",
            "--gp-lg-face-blur",
            "--gp-lg-orb-blur",
            "--gp-lg-rim-light",
            "--gp-lg-rim-dark",
            "--gp-lg-env",
            "--gp-lg-shade",
            "--gp-lg-deep-2",
            "--gp-lg-deep-3",
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

/** The two glass themes, as their CSS classes. */
const GLASS_1 = "gp-theme-frosted-glass";
const GLASS_2 = "gp-theme-frosted-glass-2";

describe("Frosted glass 2's lit rim", () => {
  // DESIGN.md register entry 12. Every check here is for a trap that the
  // 0.6.5 review proved was documented and unguarded: hoisting the rim's
  // tokens to the theme root, deleting one per mode, reversing the mask
  // order and deleting the no-mask fallback all passed the whole suite,
  // because the scoped-exception list above only PERMITS the names.
  //
  // The rim belongs to the FOURTH theme. 0.6.5 first replaced Frosted glass
  // with this artwork and then, on the maintainer's decision, shipped it
  // beside the original instead — so every selector below names
  // .gp-theme-frosted-glass-2, and the original theme having none of this is
  // itself a test ("the original Frosted glass is left as shipped").

  const RIM_TOKENS = [
    "--gp-lg-1",
    "--gp-lg-2",
    "--gp-lg-3",
    "--gp-lg-deep",
    "--gp-lg-deepen",
    "--gp-lg-lift",
    "--gp-lg-pool",
    "--gp-lg-pool-lift",
    "--gp-lg-face-blur",
    "--gp-lg-orb-blur",
    "--gp-lg-rim-light",
    "--gp-lg-rim-dark",
    "--gp-lg-env",
    "--gp-lg-shade",
    "--gp-lg-deep-2",
    "--gp-lg-deep-3",
  ];
  const DARK_RIM_TOKENS = [
    "--gp-lg-1",
    "--gp-lg-2",
    "--gp-lg-3",
    "--gp-lg-deep",
    "--gp-lg-deepen",
    "--gp-lg-lift",
    "--gp-lg-pool-lift",
    "--gp-lg-rim-light",
    "--gp-lg-rim-dark",
    "--gp-lg-env",
    "--gp-lg-shade",
    "--gp-lg-deep-2",
    "--gp-lg-deep-3",
  ];

  it("declares every rim token on .gp-timer-shape, in both modes", () => {
    // Three of the tokens are color-mix() expressions that read --gp-progress,
    // which is set inline on .gp-timer-visual. A custom property resolves its
    // var()s where it is DECLARED, so on the theme root every mix would
    // freeze at progress 0 with no error and the rim would never reach
    // twilight.
    const light = stripped.indexOf(`.${GLASS_2} .gp-timer-shape {`);
    const dark = stripped.indexOf(`.theme-dark .${GLASS_2} .gp-timer-shape {`);
    expect(light, "the light rim token block is gone").toBeGreaterThan(-1);
    expect(dark, "the dark rim token block is gone").toBeGreaterThan(-1);
    const lightBody = bodyAt(stripped, stripped.indexOf("{", light));
    const darkBody = bodyAt(stripped, stripped.indexOf("{", dark));
    for (const t of RIM_TOKENS) {
      expect(lightBody, `${t} is not declared in the light .gp-timer-shape block`).toMatch(
        new RegExp(`^\\s*${t}\\s*:`, "m")
      );
    }
    for (const t of DARK_RIM_TOKENS) {
      expect(darkBody, `${t} is not redeclared in the dark .gp-timer-shape block`).toMatch(
        new RegExp(`^\\s*${t}\\s*:`, "m")
      );
    }
  });

  it("declares no rim token outside Frosted glass 2's own .gp-timer-shape rules", () => {
    expect(tokenBlock, "a rim token has been hoisted to :root").not.toMatch(/--gp-lg-/);
    const owners = [...stripped.matchAll(/^\s*--gp-lg-[a-z0-9-]+\s*:/gm)].map((m) =>
      selectorOf(stripped, m.index ?? 0).replace(/\s+/g, " ")
    );
    expect(owners.length, "the rim tokens are gone").toBeGreaterThan(0);
    // Two conditions, and the second is the one the split added: a rim token
    // declared on the ORIGINAL theme's shape would land the whole redesign on
    // the theme this release promised to leave alone.
    const strays = owners.filter(
      (sel) => !/\.gp-timer-shape$/.test(sel) || !namesClass(sel, GLASS_2)
    );
    expect(strays, "a rim token is declared outside Frosted glass 2's timer shape").toEqual([]);
  });

  it("writes each mask shorthand before its composite, prefixed pair first, in every ring", () => {
    // Both `-webkit-mask` and `mask` are shorthands that reset mask-composite.
    // In an engine where the prefixed name aliases the standard one, a
    // shorthand written after the composite silently resets it and the ring
    // paints as a filled rounded rectangle over the clock.
    const bodies: string[] = [];
    for (const m of stripped.matchAll(/^\s*mask-composite\s*:/gm)) {
      const open = stripped.lastIndexOf("{", m.index ?? 0);
      const sel = selectorOf(stripped, m.index ?? 0).replace(/\s+/g, " ");
      expect(namesClass(sel, GLASS_2), `a masked ring outside Frosted glass 2: ${sel}`).toBe(true);
      bodies.push(bodyAt(stripped, open));
    }
    expect(bodies.length, "no masked ring left in the file").toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      const at = (re: RegExp): number => {
        const hit = re.exec(body);
        return hit ? hit.index : -1;
      };
      const wm = at(/^\s*-webkit-mask\s*:/m);
      const wmc = at(/^\s*-webkit-mask-composite\s*:/m);
      const sm = at(/^\s*mask\s*:/m);
      const smc = at(/^\s*mask-composite\s*:/m);
      expect(
        [wm, wmc, sm, smc].every((i) => i > -1),
        "a ring is missing one of its four mask lines"
      ).toBe(true);
      expect(wm < wmc && wmc < sm && sm < smc, "a ring's mask lines are out of order").toBe(true);
    }
  });

  it("restores a plain border when the engine cannot cut a ring", () => {
    const gate = stripped.indexOf(
      "@supports not ((mask-composite: exclude) or (-webkit-mask-composite: xor))"
    );
    expect(gate, "the no-mask fallback is gone").toBeGreaterThan(-1);
    const body = bodyAt(stripped, stripped.indexOf("{", gate));
    expect(body, "the fallback no longer restores the pane's border").toMatch(
      new RegExp(`\\.${GLASS_2} \\.gp-glass-pane\\s*\\{[^}]*border:\\s*1px solid`)
    );
  });

  it("reads the ground colour in exactly two places, both rim token blocks", () => {
    // DESIGN.md "artwork vs chrome": nothing inside .gp-timer-visual reads
    // --text-* or --background-*. The rim's SHADE is the one scoped
    // exception (0.6.5): a glass edge reflects the room it sits in, so its
    // dark side is the ground darkened rather than a fixed near-black — which
    // read as ink on every pale user theme. Two reads, one per mode, both
    // assigned to --gp-lg-env and nowhere else. A third read is the boundary
    // eroding; zero is the feature gone.
    // .gp-timer-visual paints the ground itself (chrome, shared by every
    // theme) and is the one legitimate read outside a theme block; every
    // other read in the file must be one of these two.
    const reads = [...stripped.matchAll(/var\(\s*--background-primary\b/g)]
      .map((m) => selectorOf(stripped, m.index ?? 0))
      .filter((sel) => sel !== ".gp-timer-visual");
    expect(reads, "the rim's ground read is gone, or has spread").toEqual([
      `.${GLASS_2} .gp-timer-shape`,
      `.theme-dark .${GLASS_2} .gp-timer-shape`,
    ]);
    const lines = stripped
      .split("\n")
      .filter((l) => /var\(\s*--background-primary\b/.test(l))
      .filter((l) => !/^\s*background:/.test(l));
    expect(
      lines.every((l) => /^\s*--gp-lg-env\s*:/.test(l)),
      "the ground must be read into --gp-lg-env only, never inline"
    ).toBe(true);
    // (--gp-ink-faint: var(--text-muted) in the theme root is the contract's
    // own ink slot, shared by every theme, and is not part of this rule.)
  });

  it("registers --gp-lg-env as a <color> so a non-colour ground cannot delete the rim", () => {
    // var() only covers a MISSING variable. A theme that sets
    // --background-primary to none, a gradient or an image substitutes that
    // text into the color-mix() and the whole conic-gradient becomes invalid
    // at computed-value time — no rim, no fallback. Registration makes the
    // bad value fall back to the initial colour instead. Probed: without it
    // the rim vanishes on a non-colour ground.
    expect(stripped).toMatch(/@property\s+--gp-lg-env\s*\{[^}]*syntax:\s*"<color>"/);
    expect(stripped).toMatch(/@property\s+--gp-lg-env\s*\{[^}]*inherits:\s*true/);
  });
});

describe("orb drift under reduced motion", () => {
  // DESIGN.md rule 4, third incident: a bare `.gp-orb` (0,1,0) in the reduce
  // block lost to `.gp-theme-frosted-glass .gp-orb-N` (0,2,0) from 0.2.0 to
  // 0.6.4, and the orbs kept drifting for exactly the users who had opted out.
  // Both glass themes now drift, each off its OWN keyframes, so each needs its
  // own opt-out and its own guard: a media query adds no specificity, so a
  // rule written for one theme cannot stop the other's orbs — and the class
  // names being prefixes of one another makes a text check that misses this
  // look like it passed.
  //
  // Class count stands in for specificity — nothing here uses ids, elements
  // or pseudo-classes.
  //
  // Counted PER COMMA-SEPARATED SELECTOR, because that is the unit the
  // cascade compares. A selector list has no specificity of its own: each of
  // its selectors is weighed separately against each of the other rule's. The
  // old count ran over the whole list, so a two-selector (0,2,0) stop rule
  // scored 4 and beat a (0,3,0) drift rule it in fact loses to.
  const classes = (sel: string): number => (sel.match(/\.[a-z0-9_-]+/gi) ?? []).length;
  const parts = (sel: string): number[] => sel.split(",").map((s) => classes(s));

  /** Every `animation: …drift…` rule whose selector names this theme. */
  const driftRules = (cls: string): { sel: string; name: string }[] => {
    const out: { sel: string; name: string }[] = [];
    for (const r of styleRules) {
      if (!namesClass(r.sel, cls)) continue;
      const m = /^\s*animation\s*:\s*(gp-[a-z0-9-]+)/m.exec(r.body);
      if (m && m[1].includes("drift")) out.push({ sel: r.sel, name: m[1] });
    }
    return out;
  };

  /** Every reduce-gated rule that stops this theme's orbs. */
  const stopRules = (cls: string): CssRule[] =>
    styleRules.filter(
      (r) =>
        r.context.includes("@media (prefers-reduced-motion: reduce)") &&
        namesClass(r.sel, cls) &&
        /\.gp-orb(?![\w-])/.test(r.sel) &&
        /animation\s*:\s*none/.test(r.body)
    );

  for (const [label, cls] of [
    ["Frosted glass", GLASS_1],
    ["Frosted glass 2", GLASS_2],
  ] as const) {
    it(`stops ${label}'s orbs with a selector that out-ranks every one of its drift rules`, () => {
      const drift = driftRules(cls);
      expect(drift.length, `${label}'s three orb drift rules are gone`).toBe(3);
      const stops = stopRules(cls);
      expect(stops.length, `no reduce-motion rule stops ${label}'s orb drift`).toBeGreaterThan(0);

      // The heaviest selector anywhere in a drift rule's list is what the stop
      // has to beat; the LIGHTEST selector in the stop's own list is what has
      // to beat it, since the whole list has to win, not its best member.
      const heaviestDrift = Math.max(...drift.flatMap((r) => parts(r.sel)));
      const bestStop = Math.max(...stops.map((r) => Math.min(...parts(r.sel))));
      // Strictly greater. A TIE is decided by source order, and both of these
      // live in blocks that get moved around — which is the whole reason the
      // reduce rule carries a third class instead of relying on where it sits.
      expect(
        bestStop,
        `${label}'s reduce-motion orb rule only ties its drift rules — source order would decide`
      ).toBeGreaterThan(heaviestDrift);
    });
  }

  it("gives each glass theme its own drift keyframes", () => {
    // The two sets are byte-identical copies on purpose: @keyframes are
    // document-global and have no theme scope, so a shared set would make
    // deleting either theme's block break the other one's orbs.
    const one = new Set(driftRules(GLASS_1).map((r) => r.name));
    const two = new Set(driftRules(GLASS_2).map((r) => r.name));
    const shared = [...one].filter((n) => two.has(n));
    expect(shared, "the two glass themes drift off the same keyframes").toEqual([]);
    for (const name of [...one, ...two]) {
      expect(stripped, `@keyframes ${name} is missing`).toMatch(
        new RegExp(`@keyframes\\s+${name}\\s*\\{`)
      );
    }
  });
});

describe("the original Frosted glass is left as shipped", () => {
  // 0.6.5 keeps the 0.6.4 theme exactly as users have it and ships the
  // redesign beside it. Nothing here describes a look — it is the boundary
  // that stops a future edit aimed at the new theme landing on the old one
  // through the prefix trap, which a text search without a token boundary
  // makes easy and silent.
  const owned = styleRules.filter((r) => namesClass(r.sel, GLASS_1));

  it("still has rules of its own", () => {
    // Without this the four checks below pass by describing nothing.
    expect(owned.length, "the original theme's rules are gone").toBeGreaterThan(10);
  });

  /**
   * The freeze itself, and the only check here that pins anything POSITIVE.
   *
   * The three "carries none of the rim machinery" checks below say what the
   * old theme must not have gained. They cannot see what it has LOST or what
   * has been changed inside it: retargeting one of the new theme's rules onto
   * the old class, or retuning one of the old theme's own values, leaves all
   * three green, and either would ship a visible change to a theme this
   * release promised would look identical.
   *
   * So: every rule whose selector names the old class, normalised to
   * `[at-rule context] selector { declarations }`, compared as one string
   * against a committed fixture. Text, so a failure prints a line diff naming
   * the rule and the declaration. Comments are stripped, so a rewritten
   * comment is not a failure and prose naming a selector is not a rule.
   *
   * The fixture was generated from this tree and then checked against
   * `git show main:styles.css`: the same extraction on 0.6.4's stylesheet
   * differs in exactly two rules, both of them the bug fixes recorded above —
   * the reduce-gated orb stop (bare `.gp-orb` there, so it did not name the
   * theme at all and is an ADDED rule here) and `:not(.gp-state-overtime)` on
   * both selectors of the mobile pulse swap. Nothing else moved.
   *
   * To change the old theme ON PURPOSE, regenerate the fixture in the same
   * commit (GP_UPDATE_FIXTURES=1 — see expectFixture) and say in the message
   * why a frozen theme moved.
   */
  it("matches the frozen snapshot of every rule that names it", () => {
    expectFixture("frosted-glass.rules.txt", `${themeSnapshot(css, GLASS_1)}\n`);
  });

  it("reads and declares no rim token", () => {
    const offending = owned.filter((r) => r.body.includes("--gp-lg-")).map((r) => r.sel);
    expect(offending, "a rim token reached the original theme").toEqual([]);
  });

  it("uses no mask", () => {
    const offending = owned
      .filter((r) => /(^|[\s;])(-webkit-)?mask[a-z-]*\s*:/m.test(r.body))
      .map((r) => r.sel);
    expect(offending, "the masked rings reached the original theme").toEqual([]);
  });

  it("styles no pseudo-element of the glass nodes", () => {
    // Its whole artwork is four real elements. Every ::before/::after in the
    // glass family — the fourth lobe, the rim, the torches, the inner wall,
    // the blooms — belongs to Frosted glass 2.
    const offending = owned.filter((r) => /::(before|after)/.test(r.sel)).map((r) => r.sel);
    expect(offending, "a pseudo-element rule reached the original theme").toEqual([]);
  });
});

describe("Frosted glass 2 is whole", () => {
  // The freeze above is one-sided: it stops the OLD theme gaining or losing a
  // rule, and says nothing about the new one. So a rule retargeted from the
  // new class onto the old fails over there, but a rule retargeted the other
  // way — or simply deleted — passed the entire suite. That matters most for
  // the three `display: block` opt-ins: the shared `.gp-art { display: none }`
  // hides every artwork node, each theme shows only its own, and moving that
  // one rule to the other theme's class leaves the new theme's square EMPTY
  // with nothing red anywhere.

  /**
   * Its selectors, with their at-rule context, sorted.
   *
   * Selectors only, and deliberately: this theme's numbers are still being
   * tuned — a rim stop, an orb blur, a saturation — and freezing declarations
   * here would make every tuning pass a test edit. What must not move without
   * being noticed is the SHAPE: which nodes and pseudo-elements it paints,
   * which of them are dark-mode or light-mode only, and which sit behind the
   * mask-composite @supports gate. Order-insensitive, because source order
   * inside the theme's own block decides nothing (the two places it does are
   * held by their own tests: the fallback's extra class, and the reduce rule's
   * third class).
   */
  it("paints exactly the nodes it was shipped with", () => {
    const actual = styleRules
      .filter((r) => namesClass(r.sel, GLASS_2))
      .map(selectorText)
      .sort();
    expectFixture("frosted-glass-2.selectors.txt", `${actual.join("\n")}\n`);
  });

  it("opts all three glass nodes into display: block, for each glass theme", () => {
    // Not "has a display: block rule" — WHICH nodes it turns on. The view
    // builds .gp-glass-orbs, .gp-glass-pane and .gp-glass-highlight once and
    // both themes style the same three; a theme that shows two of them is a
    // square missing its pane or its catch-light, which renders without error.
    const NODES = ["gp-glass-highlight", "gp-glass-orbs", "gp-glass-pane"];
    for (const cls of [GLASS_1, GLASS_2]) {
      const shown = new Set<string>();
      for (const r of styleRules) {
        // Unconditional only: an opt-in behind a media or supports gate is a
        // theme that renders blank on the engines outside it.
        if (r.context.length > 0) continue;
        if (!/(^|[\s;])display\s*:\s*block\b/.test(r.body)) continue;
        for (const one of r.sel.split(", ")) {
          if (!namesClass(one, cls)) continue;
          const node = NODES.find((n) => new RegExp(`\\.${n}$`).test(one));
          if (node) shown.add(node);
        }
      }
      expect([...shown].sort(), `.${cls} does not show all three glass nodes`).toEqual(NODES);
    }
  });
});

describe("the scattered glass rules exist for both themes", () => {
  // Most of each glass theme lives in one block, but two groups do not: the
  // overtime legibility rules sit with the other overtime rules, and the
  // mobile pulse swap sits beside the keyframes it names. Those are the rules
  // a split leaves behind, because they read as shared chrome. Each one is
  // per-theme and each theme needs its own copy.
  const MARKS = [
    /\.gp-total-time(?![\w-])/,
    /\.gp-overtime(?![\w-])/,
    /\.gp-state-overtime(?![\w-])/,
    /^body\.is-(?:mobile|tablet)(?![\w-])/,
  ];
  const scattered = styleRules.filter(
    (r) =>
      (namesClass(r.sel, GLASS_1) || namesClass(r.sel, GLASS_2)) && MARKS.some((m) => m.test(r.sel))
  );
  /** The selector with whichever glass class it names folded to one name. */
  const fold = (sel: string): string =>
    sel
      .replace(new RegExp(`(?<![\\w-])${GLASS_2}(?![\\w-])`, "g"), "GLASS")
      .replace(new RegExp(`(?<![\\w-])${GLASS_1}(?![\\w-])`, "g"), "GLASS");

  const forOne = scattered.filter((r) => namesClass(r.sel, GLASS_1)).map((r) => fold(r.sel));
  const forTwo = scattered.filter((r) => namesClass(r.sel, GLASS_2)).map((r) => fold(r.sel));

  /**
   * Frosted glass 2 has a fourth lobe, .gp-glass-orbs::before, that the
   * original theme does not, so its two break-overtime desaturation rules
   * have no twin and must not have one: there is nothing over there to
   * desaturate. Everything else is paired.
   */
  const ONLY_GLASS_2 = [
    ".theme-dark .GLASS .gp-state-overtime.gp-mode-break .gp-glass-orbs::before",
    ".theme-light .GLASS .gp-state-overtime.gp-mode-break .gp-glass-orbs::before",
  ];

  it("finds the scattered rules at all", () => {
    expect(forOne.length, "the original theme's scattered rules are gone").toBeGreaterThan(0);
    expect(forTwo.length, "Frosted glass 2's scattered rules are gone").toBeGreaterThan(0);
  });

  it("gives every scattered rule of one glass theme its twin on the other", () => {
    expect(
      forOne.filter((s) => !forTwo.includes(s)),
      "the original theme has a scattered rule Frosted glass 2 never got"
    ).toEqual([]);
    expect(
      forTwo.filter((s) => !forOne.includes(s) && !ONLY_GLASS_2.includes(s)),
      "Frosted glass 2 has a scattered rule the original theme never got"
    ).toEqual([]);
  });

  it("still has each rule the exemption list excuses", () => {
    // An exemption list that is never REQUIRED is a hole, not a guard: delete
    // the fourth lobe's two desaturation rules and the pairing test above goes
    // quieter, not redder, because it only ever asks whether an unpaired rule
    // is allowed — never whether the allowance is still being used. Those two
    // rules are the whole reason the lobe does not stay fully saturated behind
    // the clock through a break overtime.
    for (const sel of ONLY_GLASS_2) {
      expect(forTwo, `${sel} is gone — delete its exemption too`).toContain(sel);
    }
  });

  it("restates the orb blur through its token in every Frosted glass 2 overtime filter", () => {
    // These four rules restate the WHOLE orb filter, so a base blur retuned in
    // the theme block and not here silently reverts the moment a break runs
    // into overtime — which happened during the theme's design. The token is
    // what keeps the four in step, and a hard-coded px value here is the
    // regression coming back.
    const filters = styleRules.filter(
      (r) =>
        namesClass(r.sel, GLASS_2) &&
        /\.gp-state-overtime(?![\w-])/.test(r.sel) &&
        /(^|[\s;])filter\s*:/.test(r.body)
    );
    expect(filters.length, "Frosted glass 2's overtime desaturation rules are gone").toBe(4);
    for (const r of filters) {
      expect(r.body, `${r.sel} hard-codes a blur instead of reading the token`).toMatch(
        /filter:[^;]*var\(\s*--gp-lg-orb-blur\s*\)/
      );
    }
  });

  /**
   * Every rule that swaps the shadow-only breath in for a glass theme on
   * touch. Found by SHAPE rather than by a literal selector string: prettier
   * wraps the new theme's selectors over four lines each, so the string the
   * old version of this test searched for does not occur in the file at all.
   */
  const mobileSwapRules = (cls: string): CssRule[] =>
    styleRules.filter(
      (r) =>
        namesClass(r.sel, cls) &&
        r.sel.split(", ").some((s) => /^body\.is-(?:mobile|tablet)(?![\w-])/.test(s)) &&
        /animation\s*:\s*gp-[a-z0-9-]+/.test(r.body)
    );

  it("swaps in the shadow-only breath, not some other animation", () => {
    // The point of the swap is that gp-gentle-pulse-glow animates box-shadow
    // only. The drop shadow is outside the shape's rounded clip, so animating
    // it never re-rasterizes the backdrop-filter edge — which is the iOS
    // flicker this rule exists for. Any other animation name here is the
    // flicker back.
    for (const cls of [GLASS_1, GLASS_2]) {
      const swaps = mobileSwapRules(cls);
      expect(swaps.length, `.${cls} has no mobile pulse swap`).toBeGreaterThan(0);
      for (const r of swaps) {
        expect(r.body, `.${cls}'s pulse swap runs the wrong animation`).toMatch(
          /animation:\s*gp-gentle-pulse-glow(?![\w-])/
        );
      }
    }
  });

  // The same pair of guards Pixel City carries, for the same two reasons, now
  // for each glass theme's own copy of the swap. A media query adds no
  // specificity, so neither theme's rule can stand in for the other's — and
  // the second guard is the bug fix (a) landed: overtime is still "running",
  // and this selector out-specifies the shared `.gp-state-overtime
  // .gp-timer-shape` that swaps in the blue / orange breathing glow. Without
  // the exclusion that glow showed on a phone or tablet only while PAUSED,
  // which is what Frosted glass did from 0.3.2 to 0.6.4.
  for (const [label, cls] of [
    ["the original Frosted glass", GLASS_1],
    ["Frosted glass 2", GLASS_2],
  ] as const) {
    it(`leaves the overtime glow alone on ${label}`, () => {
      const swaps = mobileSwapRules(cls);
      expect(swaps.length, `.${cls} has no mobile pulse swap`).toBeGreaterThan(0);
      for (const r of swaps) {
        for (const one of r.sel.split(", ")) {
          // EVERY selector of the list: the swap is written as a
          // mobile/tablet pair, and one of the two losing its exclusion
          // reinstates the bug on that platform alone.
          expect(one, `${label}'s pulse swap covers overtime`).toContain(
            ".gp-state-running:not(.gp-state-overtime)"
          );
        }
      }
    });

    it(`gates ${label}'s pulse swap on prefers-reduced-motion`, () => {
      // Ungated, this selector out-specifies the shared reduced-motion
      // `animation: none` and re-enables the breath for exactly the people who
      // turned motion off.
      const swaps = mobileSwapRules(cls);
      expect(swaps.length, `.${cls} has no mobile pulse swap`).toBeGreaterThan(0);
      for (const r of swaps) {
        expect(r.context, `${label}'s pulse swap is not inside a no-preference block`).toContain(
          "@media (prefers-reduced-motion: no-preference)"
        );
      }
    });
  }
});
