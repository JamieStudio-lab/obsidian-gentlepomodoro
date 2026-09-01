# DESIGN.md

How the plugin's UI is put together, and the rules a change to [styles.css](styles.css) has to obey.
Contributor-facing theme documentation lives in [THEMES.md](THEMES.md); this file is for anyone
editing the stylesheet itself.

Read [Do not break](#do-not-break) before touching styles.css. Every entry there is something a
reasonable tidy-up would do, and each one breaks something quietly.

## The one rule: artwork vs chrome

The plugin draws two kinds of thing, and they get opposite treatment.

|                     | Chrome                                                         | Artwork                                     |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| What                | Task list, in-view settings panel, buttons, status bar, modals | `.gp-timer-visual` and everything inside it |
| Sits on             | The user's own theme background                                | A live gradient the timer drives            |
| Colour from         | Obsidian's variables (`--text-normal`, `--interactive-accent`) | Our own tokens                              |
| Follows user theme? | Always                                                         | No — that is what the theme picker is for   |

**Chrome inherits, artwork declares.** There are 54 `var()` references to 17 Obsidian variables in
the file today and they are all correct; do not re-mint them as `--gp-*`. Conversely, nothing inside
`.gp-timer-visual` may read `--text-*` or `--background-*`.

The proof that the boundary is real: `.gp-total-time` ([styles.css:1230](styles.css)) is the one
on-artwork element coloured with a chrome token, and it pays for it with three colour overrides
(`:1259`, `:1268`, `:1293`) plus two orb desaturations (`:1280`, `:1308`) — and still leaves
classic + light Obsidian + focus overtime uncovered, where the grey lands on the night gradient at
about 2.34:1.

Also delete rules that merely restate an Obsidian default rather than adding one: `:765`
(`.gp-status-label` re-states `--status-bar-font-size`), `:864` and `:1407` (`line-height: 1.3`
re-states the inherited `--line-height-tight`).

## Token layers

Declared on `:root`, **never on `.gp-root`.** Four plugin surfaces render outside the view
container and a `.gp-root`-scoped block misses all four — invisibly, because the timer panel, where
anyone would look to check, is fine:

- `.gp-status*` — built from `addStatusBarItem()` in [main.ts](main.ts)
- `.gp-confirm-modal` — [confirmModal.ts](confirmModal.ts)
- `.gp-setting-with-error` / `.gp-setting-error` — [GentlePomoSettingTab.ts](GentlePomoSettingTab.ts)
- `.workspace-leaf-content[data-type="gentle-pomo-view"]` — the resize-divider floor at styles.css:4

**Layer 0 — Obsidian's own variables.** Not ours. Listed above.

**Layer 1 — primitives.** Raw scale values with no meaning attached: `--gp-space-*`, `--gp-text-*`,
`--gp-radius-*`, `--gp-dur-*`, `--gp-ease-*`, `--gp-weight-*`, `--gp-opacity-*`.

**Layer 2 — semantic.** What components consume: the ink set, the focus ring, `--gp-rule`, the
elevations, the mode gradients.

**Layer 3 — component constants.** Values that must **not** be rounded onto a scale, because each
is a solved equation with a failure mode. `--gp-control-column` (260px) is a _budget_: five music
buttons come to 258px, `.gp-controls-row` is `justify-content: center` with non-shrinking children,
so an over-wide row loses content off **both** ends with no way to scroll back. Likewise
`--gp-row-slack`, the segmented-control insets, the clock's four sizes, and the `em`-based reveal
caps.

**Ink is a theme's business.** The four pieces of text on the artwork read `--gp-ink*` slots that each
theme declares for itself. Both shipped themes declare identical values — they are not sharing a
default, they independently chose the same one, which is what independence costs and is the point.
`--gp-scrim-alpha` (0 for both) drives `.gp-timer-shape::after`, a veil between artwork and text; it
is the only lever that makes an arbitrary supplied picture safe for white text, and it is a
pseudo-element so it needs no DOM node and no place in the artwork switch.

**Frosted Glass is the one theme whose legibility is not fully token-driven.** Its two
orb-desaturation rules fix a _text_ problem by mutating _artwork_ — dropping `saturate()` on
`.gp-orb` so overtime text stays readable. They were kept deliberately in 0.6.1 rather than retired,
to leave the shipped themes looking exactly as they look. A raster theme cannot copy that trick; it
has the scrim instead.

**Theme-contract tokens are the exception: they live only inside `.gp-theme-<id>` blocks, never on
`:root`.** Putting them on `:root` makes them shared defaults that themes override, which is exactly
the structure that made Classic the implicit default in the first place, moved down one layer.

### Units

- **Spacing is px.** The three interlocking constants — the 260px column, the 42/56px buttons, the
  44/50px tap floors — are all px. In `rem` the gaps grow with Obsidian's UI scale while the column
  does not, and the row-fits-in-260px arithmetic only holds in the axis that stopped scaling.
- **Type is rem**, because type genuinely should scale. Two sizes stay `clamp(… cqi …)`: they
  resolve against the timer square's container, which is 200–220px on desktop, `min(280px, 38vh)` on
  touch, and a hard 150px in compact mode. A fixed size re-breaks the exact layout compact mode
  exists to fix, and there is no media-query substitute — `@media (max-height)` and `(orientation)`
  were both tried and neither engages in Obsidian's mobile webview.
- **Reveal caps stay `em`** (`2.5em` at `:326` and `:1252`, `7em` at `:1446`/`:1466`). `var()`
  substitutes token _text_, so an `em` cap still resolves against each element's own font-size —
  which is the point, since a type-scale change then cannot make the cap too small. In px it
  silently could.

## Do not break

### 1. Never move a rule. Substitute values in place.

Two behaviours are decided by source order alone, both between rules of equal specificity:

- `.gp-controls-row > *:not(:last-child)` (`:369`) must stay **before**
  `.gp-animated-wrapper.gp-hidden-animated` (`:395`) — `:not()` contributes class-level specificity,
  so only order decides. Reversed, a collapsed wrapper keeps its 12px margin and the row shows a gap
  where the buttons were.
- `.gp-task-list` (`:817`) must stay **before** `.gp-station-list` (`:1546`). If the task list wins,
  the station picker gets the filled background and the faster open animation, and its two
  deliberate differences vanish in a way that reads as a theme quirk.

Regrouping rules by component is the most natural design-system move available and is the most
dangerous one here.

### 2. Variant classes stay double-class.

`.gp-task-item.gp-task-selected .gp-task-check-icon` (`:888`, specificity 0,3,0) is the only thing
beating `.gp-station-item .gp-task-check-icon { display: none }` (`:1538`, 0,2,0). Flattened to a
single BEM-style class it drops to 0,2,0, ties, and the later rule wins — so **the tick on the
station you are listening to disappears**, which is the only indicator of which station is playing.
No test can see it.

`.gp-root .gp-hidden` (`:812`) is a descendant selector, not a compound one — do not "simplify" it
to `.gp-root.gp-hidden`, which would never match. It must out-specify `.gp-station-current`
(`:1400`), `.gp-station-list` (`:1558`) and `.gp-task-item` (`:861`), all `display: flex` at 0,1,0.

### 3. Anything hidden by animation must also be `inert`, seeded at construction.

`max-height: 0`, `max-width: 0` and `opacity: 0` remove nothing from the tab order, and
`pointer-events: none` does not gate Enter on a focused control. This shipped as a bug and is fixed
only for the newest region — `.gp-music-video-row` toggles `inert` in
[GentlePomoView.ts](GentlePomoView.ts) with a comment naming the failure. Two older regions still
leak: the settings panel (`:523`, populated unconditionally with ~12 controls including "Reset to
defaults") and both `.gp-animated-wrapper` groups (`:395`) holding Stop / Reset / −5 / +5.

Seeding matters: the station list sets `inert` at construction precisely because the visibility
setter early-returns when unchanged, so delegating it would arm the attribute only after the first
open.

`display: none` is the only hiding mechanism that skips `inert` — and it may never be applied to
anything that animates, because `display` is not animatable.

### 4. Reduced motion is a specificity problem, not a coverage problem.

Media queries add no specificity, so any rule more specific than the `transition: none` block
silently re-enables motion for exactly the users who opted out — with no error and nothing visible
on the developer's machine. The file already records two incidents: the caption labels must keep
**exactly one** `transition` shorthand at 0,1,0 with the delay cascaded through
`--gp-caption-delay`, and the mobile frosted pulse (`:1929`) needs its
`@media (prefers-reduced-motion: no-preference)` wrapper because its selector is 0,4,1 against a
0,2,0 `animation: none`.

Zeroing a duration token is **not** a substitute for the explicit `transform: none` resets at
`:1332` and `:1604`. A collapsed element's resting state _is_ a transform, so a zero duration makes
it jump there instantly rather than not move.

### 5. Every reveal cap is a magic number that must stay bigger than its content.

All have `overflow: hidden`, so raising a font-size, adding a settings row or localising a string
clips content with no error and no scrollbar: `.gp-end-time.gp-visible` 2.5em (`:326`),
`.gp-state-overtime .gp-total-time` 2.5em (`:1252`), `.gp-task-list.gp-visible` 250px (`:831`),
`.gp-settings-panel.gp-visible` 320px (`:553`), `.gp-status-time` 64px (`:782`), the caption words
7em (`:1446`, `:1466`).

Related: `.gp-settings-panel`'s collapsed `border-top/bottom: 1px solid transparent` (`:537`) must
stay. Border _colour_ is animatable while _adding_ a border is not, and those 2px of reserved border
box are what stop the panel jumping at the end of the reveal.

### 6. Five platform workarounds read as dead code and are load-bearing.

Each fails only on a device the maintainer does not develop on.

1. The WebKit SVG floor (`:1686`) must stay `min-width`/`min-height` + `flex-shrink: 0` on the
   two-class `svg.svg-icon` selector. WebKit collapses an SVG flex item's main axis to ~8px on iPad
   and a plain `width`, even `!important`, does not fix it. Any hand-built SVG inside a
   `.gp-icon-btn` must carry the `svg-icon` class.
2. `.gp-icon-btn svg` sizing stays absolute px (`:461`). `em` resolves against a font-size Obsidian
   overrides per device; `%` collapses in iPad WebKit.
3. `body.is-mobile .gp-timer-time { transform: translateZ(0) }` (`:1900`) is a GPU-layer workaround
   whose safety argument is literally "it has no other transform". Adding one invalidates it.
4. `.gp-music-player` stays **rendered** at 1×1 with `opacity: 0` (`:1625`) — never `display: none`,
   never `visibility: hidden`, never `clip-path` (Obsidian review flags it as only partially
   supported). Removal is what stops playback.
5. `.gp-compact` uses `position: relative`, not `static` (`:1718`). `.gp-timer-shape` is
   `position: absolute; inset: 0`, and `static` would let it escape the 150px box.

### 7. Never set a static style value from TypeScript.

`eslint-plugin-obsidianmd`'s `no-static-styles-assignment` fires when the value passed to
`style.setProperty` is a **literal**, and forbids disabling the rule — so it fails `npm run lint`
and therefore CI. The three existing calls in [GentlePomoView.ts](GentlePomoView.ts) are legal only
because their values are `.toString()` results. This is also why the iPad SVG floor has to be CSS.

Custom properties are the sanctioned bridge: the rule exempts keys starting with `--`, and a
non-literal value passes.

### 8. Four values are duplicated across the CSS/TS boundary.

Only comments hold them in sync. Change them together:

| CSS                                           | TypeScript                                                   |
| --------------------------------------------- | ------------------------------------------------------------ |
| `--gp-name-fade: 0.28s` (`:1501`)             | `CAPTION_NAME_FADE_MS = 280` (constants.ts)                  |
| `[data-type="gentle-pomo-view"]` (`:4`)       | `VIEW_TYPE_GENTLE_POMO` (constants.ts)                       |
| `.gp-layer-day` / `.gp-layer-night` gradients | the same two on `.gp-status-dot` (`:750`, `:754`)            |
| `gp-mode-focus` / `gp-mode-break`             | applied in two unrelated DOM trees — view **and** status bar |

The last is why the mode gradients must reach `:root`: the status bar is created by
`addStatusBarItem()` and can never be reached by a `.gp-root`- or `.gp-theme-*`-scoped rule.

### 9. Product decisions that look like accessibility defects and are not.

- **The running countdown is hidden by design** (`:265`) — that is the "gentle" premise. Fix the
  white-on-gradient contrast with the scrim, never by revealing it.
- **Station rows use `title`, not `aria-label`.** `aria-label` _replaces_ the accessible name, so
  the obvious upgrade would have a screen reader announce a 60-character URL instead of the station
  name.
- **List rows are `<div>`, not `<button>`.** This was tried and reverted: Obsidian's own button
  styling out-specifies a plain class reset, so they kept a filled background in dark mode and the
  hover never showed. Fixing the task list means **copying** the div + `tabindex` + Enter/Space
  pattern, not improving on it.
- **`@media (hover: hover)` gates only the two timer reveals** (`:269`), because iOS sticky-hover
  pins the countdown open and defeats the auto-hide. It is deliberately not applied to the six
  ordinary hover-feedback rules.

### 10. No test can see any of this.

`grep -rn "gp-" tests/*.ts` returns zero across all suites. Verification is a computed-style diff
plus a human opening Obsidian — and about half the rules here engage on only one platform or in one
theme, so a desktop check proves very little. `styles.css` is not in `.prettierignore` and CI runs
`format:check`, so a hand-formatted token block fails the build on whitespace alone.

## Build

`rollup.config.mjs` is a function of the CLI args so `npm run dev` (`-w`) keeps an inline sourcemap
and `npm run build` does not. Before 0.6.0 both shared one config and the released `main.js` carried
it: 1,217,205 of 1,938,425 bytes, 63% of every download.

`main.js` is gitignored but Obsidian loads it directly — `npm run build` before reloading the
plugin. Verifying a mixed CSS/TS change without rebuilding produces new-CSS/old-TS state that looks
like a CSS bug.
