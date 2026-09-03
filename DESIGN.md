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

The proof that the boundary is real: `.gp-total-time` is the one
on-artwork element coloured with a chrome token, and it pays for it with three colour overrides
(`.gp-theme-classic .gp-state-overtime.gp-mode-break .gp-total-time` and the `.theme-dark` /
`.theme-light` Frosted Glass rules on `.gp-total-time`) plus two orb desaturations (`.gp-state-overtime.gp-mode-break .gp-orb`, one per Obsidian theme) — and still leaves
classic + light Obsidian + focus overtime uncovered, where the grey lands on the night gradient at
about 2.34:1.

Also delete rules that merely restate an Obsidian default rather than adding one: `.gp-status-label`
re-states `--status-bar-font-size`, and two `line-height: 1.3` declarations re-state the inherited
`--line-height-tight`.

## Token layers

Declared on `:root`, **never on `.gp-root`.** Four plugin surfaces render outside the view
container and a `.gp-root`-scoped block misses all four — invisibly, because the timer panel, where
anyone would look to check, is fine:

- `.gp-status*` — built from `addStatusBarItem()` in [main.ts](main.ts)
- `.gp-confirm-modal` — [confirmModal.ts](confirmModal.ts)
- `.gp-setting-with-error` / `.gp-setting-error` — [GentlePomoSettingTab.ts](GentlePomoSettingTab.ts)
- `.workspace-leaf-content[data-type="gentle-pomo-view"]` — the resize-divider floor, the first rule in styles.css

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
theme declares for itself. All three shipped themes declare identical values — they are not sharing
a default, they independently chose the same one, which is what independence costs and is the point.
`--gp-scrim-alpha` drives `.gp-timer-shape::after`, a veil between artwork and text; it is the only
lever that makes an arbitrary supplied picture safe for white text, and it is a pseudo-element so
it needs no DOM node and no place in the artwork switch. Classic and Frosted Glass set it to 0;
Rooftop Skyline (0.6.2) is its first user, at 0.10 — a bitmap cannot be retuned per Obsidian theme
the way a gradient can, so the plates keep every pale band out of the clock zone and the veil
carries the rest.

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
- **Reveal caps stay `em`** (`2.5em` on `.gp-end-time.gp-visible` and `.gp-state-overtime .gp-total-time`,
  `7em` on the two caption words). `var()`
  substitutes token _text_, so an `em` cap still resolves against each element's own font-size —
  which is the point, since a type-scale change then cannot make the cap too small. In px it
  silently could.

## Do not break

### 1. Never move a rule. Substitute values in place.

Two behaviours are decided by source order alone, both between rules of equal specificity:

- `.gp-controls-row > *:not(:last-child)` must stay **before**
  `.gp-animated-wrapper.gp-hidden-animated` — `:not()` contributes class-level specificity,
  so only order decides. Reversed, a collapsed wrapper keeps its 12px margin and the row shows a gap
  where the buttons were.
- `.gp-task-list` must stay **before** `.gp-station-list`. If the task list wins,
  the station picker gets the filled background and the faster open animation, and its two
  deliberate differences vanish in a way that reads as a theme quirk.

Regrouping rules by component is the most natural design-system move available and is the most
dangerous one here.

### 2. Variant classes stay double-class.

`.gp-task-item.gp-task-selected .gp-task-check-icon` (specificity 0,3,0) is the only thing
beating `.gp-station-item .gp-task-check-icon { display: none }` (0,2,0). Flattened to a
single BEM-style class it drops to 0,2,0, ties, and the later rule wins — so **the tick on the
station you are listening to disappears**, which is the only indicator of which station is playing.
No test can see it.

`.gp-root .gp-hidden` is a descendant selector, not a compound one — do not "simplify" it
to `.gp-root.gp-hidden`, which would never match. It must out-specify `.gp-station-current`,
`.gp-station-list` and `.gp-task-item`, all `display: flex` at 0,1,0.

### 3. Anything hidden by animation must also be `inert`, seeded at construction.

`max-height: 0`, `max-width: 0` and `opacity: 0` remove nothing from the tab order, and
`pointer-events: none` does not gate Enter on a focused control. This shipped as a bug and was closed region by region:
`.gp-music-video-row` in 0.5.7, then in 0.6.1 the settings panel (populated unconditionally with
~12 controls including "Reset to defaults"), both `.gp-animated-wrapper` groups holding
Stop / Reset / −5 / +5, and the task list. Each pairs its class with `inert` through one setter —
`setSecondaryControlsHidden`, `setSettingsPanelVisible`, `closeTaskList` — so the two cannot drift.

Closing a list also has to **hand focus back**. The row that was just activated is inside the newly
inert container, so focus falls to the document and a keyboard user lands at the top of the panel.

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
`--gp-caption-delay`, and the mobile frosted pulse (`body.is-mobile .gp-theme-frosted-glass .gp-state-running .gp-timer-shape`) needs its
`@media (prefers-reduced-motion: no-preference)` wrapper because its selector is 0,4,1 against a
0,2,0 `animation: none`.

Zeroing a duration token is **not** a substitute for the explicit `transform: none` resets in the
reduced-motion blocks. A collapsed element's resting state _is_ a transform, so a zero duration makes
it jump there instantly rather than not move.

### 5. Every reveal cap is a magic number that must stay bigger than its content.

All have `overflow: hidden`, so raising a font-size, adding a settings row or localising a string
clips content with no error and no scrollbar: `.gp-end-time.gp-visible` 2.5em,
`.gp-state-overtime .gp-total-time` 2.5em, `.gp-task-list.gp-visible` 250px,
`.gp-settings-panel.gp-visible` 320px, `.gp-status-time` 64px, the caption words 7em.

Related: `.gp-settings-panel`'s collapsed `border-top/bottom: 1px solid transparent` must
stay. Border _colour_ is animatable while _adding_ a border is not, and those 2px of reserved border
box are what stop the panel jumping at the end of the reveal.

### 6. Five platform workarounds read as dead code and are load-bearing.

Each fails only on a device the maintainer does not develop on.

1. The WebKit SVG floor (`body.is-mobile .gp-icon-btn svg.svg-icon` and its tablet twin) must stay `min-width`/`min-height` + `flex-shrink: 0` on the
   two-class `svg.svg-icon` selector. WebKit collapses an SVG flex item's main axis to ~8px on iPad
   and a plain `width`, even `!important`, does not fix it. Any hand-built SVG inside a
   `.gp-icon-btn` must carry the `svg-icon` class.
2. `.gp-icon-btn svg` sizing stays absolute px. `em` resolves against a font-size Obsidian
   overrides per device; `%` collapses in iPad WebKit.
3. `body.is-mobile .gp-timer-time { transform: translateZ(0) }` is a GPU-layer workaround
   whose safety argument is literally "it has no other transform". Adding one invalidates it.
4. `.gp-music-player` stays **rendered** at 1×1 with `opacity: 0` — never `display: none`,
   never `visibility: hidden`, never `clip-path` (Obsidian review flags it as only partially
   supported). Removal is what stops playback.
5. `.gp-compact` uses `position: relative`, not `static`. `.gp-timer-shape` is
   `position: absolute; inset: 0`, and `static` would let it escape the 150px box.

### 7. Never set a static style value from TypeScript.

`eslint-plugin-obsidianmd`'s `no-static-styles-assignment` fires when the value passed to
`style.setProperty` is a **literal**, and forbids disabling the rule — so it fails `npm run lint`
and therefore CI. The three existing calls in [GentlePomoView.ts](GentlePomoView.ts) are legal only
because their values are `.toString()` results. This is also why the iPad SVG floor has to be CSS.

Custom properties are the sanctioned bridge: the rule exempts keys starting with `--`, and a
non-literal value passes.

### 8. Five values are duplicated across the CSS/TS boundary.

Three of the five are test-held (the fade and the leaf selector by `designTokens`, the plate
selectors by `rooftopArt`); the status-dot gradients and the mode classes are held by comments
only. Change them together:

| CSS                                           | TypeScript                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `--gp-name-fade: 0.28s`                       | `CAPTION_NAME_FADE_MS = 280` (constants.ts)                            |
| `[data-type="gentle-pomo-view"]`              | `VIEW_TYPE_GENTLE_POMO` (constants.ts)                                 |
| `.gp-layer-day` / `.gp-layer-night` gradients | the same two on `.gp-status-dot`                                       |
| `gp-mode-focus` / `gp-mode-break`             | applied in two unrelated DOM trees — view **and** status bar           |
| `.gp-rooftop-*` selectors                     | `ROOFTOP_LAYERS` in rooftopArt.ts (held by `tests/rooftopArt.test.ts`) |

The mode-class row is why the mode gradients must reach `:root`: the status bar is created by
`addStatusBarItem()` and can never be reached by a `.gp-root`- or `.gp-theme-*`-scoped rule.

### 9. Product decisions that look like accessibility defects and are not.

- **The running countdown is hidden by design** (`.gp-state-running .gp-timer-time { opacity: 0 }`) — that is the "gentle" premise. Fix the
  white-on-gradient contrast with the scrim, never by revealing it.
- **Station rows use `title`, not `aria-label`.** `aria-label` _replaces_ the accessible name, so
  the obvious upgrade would have a screen reader announce a 60-character URL instead of the station
  name.
- **List rows are `<div>`, not `<button>`.** This was tried and reverted: Obsidian's own button
  styling out-specifies a plain class reset, so they kept a filled background in dark mode and the
  hover never showed. Fixing the task list means **copying** the div + `tabindex` + Enter/Space
  pattern, not improving on it.
- **`@media (hover: hover)` gates only the two timer reveals**, because iOS sticky-hover
  pins the countdown open and defeats the auto-hide. It is deliberately not applied to the six
  ordinary hover-feedback rules.

### 10. No test can see any of this render.

Two suites read `styles.css` as text — `designTokens` (tokens, theme independence, focus rings,
the CSS/TS pairs) and `rooftopArt` (the plates, their selectors, the build config) — and they can
tell you a name is wrong, a token is dead, or a rule is missing. None can tell you a colour is
unreadable or a layout is broken. That verification is a computed-style diff plus a human opening
Obsidian — and about half the rules here engage on only one platform or in one theme, so a desktop
check proves very little. `styles.css` is not in `.prettierignore` and CI runs `format:check`, so a
hand-formatted token block fails the build on whitespace alone.

### 11. Bitmap plates move on `--gp-progress` alone, and the pulse opt-out excludes overtime.

Rooftop Skyline's sixteen plates are `<img>` nodes whose opacity is a `clamp()` of
`--gp-progress` and **nothing else**: no `transition` on any plate, because the scalar is already
eased 0.8s on `.gp-timer-visual` and a second ease doubles every skip and reset. A window "switch"
is a ramp steep enough to be one (`* 100`, i.e. over 1% of the session), since a computed value has
no step function. The theme replaces the 1.03× size pulse — which resamples a bitmap every frame
and shimmers on a pixel grid — with the shadow-only breath by `animation-name` alone, scoped
`.gp-state-running:not(.gp-state-overtime)` inside `prefers-reduced-motion: no-preference`.
Both guards are for bugs that shipped in-branch: overtime is still "running", and a theme-scoped
selector out-ranks both the shared overtime glow and the reduced-motion `animation: none`. The
plates themselves reach users only because they are **inside `main.js`** — Obsidian installs
three files, and a loose image is missing for everyone but the machine that put it there.
`tests/designTokens.test.ts` holds the first three; `tests/rooftopArt.test.ts` the delivery.

## Build

`rollup.config.mjs` is a function of the CLI args so `npm run dev` (`-w`) keeps an inline sourcemap
and `npm run build` does not. Before 0.6.0 both shared one config and the released `main.js` carried
it: 1,217,205 of 1,938,425 bytes, 63% of every download.

`@rollup/plugin-url` inlines `**/*.mp3` and, since 0.6.2, `**/*.png` as data URLs with no size
limit: the audio cues and the Rooftop Skyline plates ship inside `main.js` because nothing else
does. Keep raster art indexed and at source resolution; the plate test budgets it.

`main.js` is gitignored but Obsidian loads it directly — `npm run build` before reloading the
plugin. Verifying a mixed CSS/TS change without rebuilding produces new-CSS/old-TS state that looks
like a CSS bug.
