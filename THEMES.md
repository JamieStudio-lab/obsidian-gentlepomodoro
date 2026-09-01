# Theme Ideas

Visual themes for the Gentle Pomodoro timer view. Each theme should preserve the **gentle** aesthetic: slow transitions (≥0.8s), gradient blends, indirect time cues, no progress rings or hard countdown bars, and respect for `prefers-reduced-motion`.

## Shipped

- **Classic** — the original (formerly "Sunset / Aurora"). Three stacked gradient layers (day → dusk → night) whose opacities blend as progress advances. Squircle shape, gentle 8s scale pulse, day/night SVG badge.
- **Frosted Glass** — three soft color orbs drifting behind a frosted-glass pane. Orb hues interpolate through the sunrise→sunset palette via `--gp-progress` + `color-mix(in oklab, ...)`. Backdrop-filter blur gives the depth-of-field look.

## Planned

### Rooftop Skyline — pixel art

A pixel-art city silhouette along the bottom third, dithered sky above, and
**windows that light up as night falls**. The only concept considered where the
artwork itself reports progress: you can read roughly how far into a session you
are without looking at a number. Reverses cleanly — on a break the windows go
dark as dawn comes up.

Three plates (day / dusk / night) cross-faded on `--gp-progress`, shipped at
source resolution and scaled with `image-rendering: pixelated`. Four things it
needs that the two shipped themes did not: a bitmap face for the clock (so
font-family joins the token list above), opting out of the 8s scale pulse to the
shadow-only breath (resampling a bitmap at 1.03x shimmers), its own day/night
badge glyphs, and a much smaller `--gp-shape-radius` — a hard pixel grid meeting
a smooth 35px curve reads as a rendering fault.

## Future ideas

Not yet implemented. See [The theme API](#the-theme-api) for what a theme is required to provide and the two steps to register one.

### 1. Moon Phases — Night Sky

A single calm mood: pure night. A central moon waxes from new → full over the focus session, and wanes back during break. Subtle CSS-dot starfield with very slow opacity twinkle.

```
      ╭───────────────╮
      │  ·     ·    · │
      │     ·    ·    │     ← starfield (slow twinkle)
      │ ·     🌒      │
      │      MOON     │     ← waxes new→full as focus
      │ ·    grows    ·│       progresses (reverse on break)
      │      ·       · │
      │  ·     · ·    │
      ╰───────────────╯
```

- **Palette:** midnight indigo `#0f1b3d` → deep blue `#1e3a5f` → moon-cream `#fffaf0`.
- **Motion:** moon mask interpolates on `--gp-progress`; starfield twinkle via `@keyframes` with 4-6s opacity loop (disabled under reduced motion).
- **Shape:** perfect circle (border-radius 50%), not the current squircle.
- **Vibe:** meditative, single mood, very still.
- **Implementation notes:** moon is two overlapping circles — a "lit" disc and a moving "shadow" disc that slides across it horizontally as progress advances. SVG mask or two stacked divs both work.

### 2. Tide — Rising Water

A water level rises smoothly from bottom to top over the focus session, falls during break. Two slow sine-wave silhouettes overlap and cross-fade. Color deepens as it fills.

```
      ╭───────────────╮
      │               │
      │               │
      │   ～～～～～    │     ← waterline rises slowly
      │  ░░░░░░░░░░░   │       (sine wave undulates)
      │  ▒▒▒▒▒▒▒▒▒▒▒   │
      │  ▓▓▓▓▓▓▓▓▓▓▓   │     ← gradient deepens
      │  ███████████   │       seafoam → ocean
      ╰───────────────╯
```

- **Palette:** pale seafoam `#a8e6cf` → soft teal `#6fb1a3` → deep ocean `#1a3a52`.
- **Motion:** waterline height tied to `--gp-progress` via `clip-path: polygon(...)` or `height: calc(var(--gp-progress) * 100%)`. Sine-wave silhouette undulates over 12s (translateX of an SVG path).
- **Shape:** keep current rounded-square (35px border-radius).
- **Vibe:** tactile fill cue, gentle horizon — the only theme with a literal "fill" mechanic, but slow enough to stay gentle.
- **Implementation notes:** two `<svg>` wave paths stacked with slight horizontal offset, each animated with different durations so they never line up.

### 3. Zen Ripple — Pond

A perfect circle with a soft solid center color and 2-3 concentric rings that pulse outward very slowly — like a stone dropped in a still pond. Lots of negative space, minimal motion.

```
           ╭───╮
         ╭┄┄┄┄┄╮             ← outermost ring (fades out)
        ┌─────────┐
       │ ╭───────╮ │
       │ │  ◯◯◯  │ │         ← rings emanate from center
       │ │ ◯ ● ◯ │ │            every ~10s, very softly
       │ │  ◯◯◯  │ │
       │ ╰───────╯ │
        └─────────┘
         ╰┄┄┄┄┄╯
           ╰───╯
```

- **Palette:** sand `#f4e4c1` → moss-green `#7a9b76` → twilight-purple `#5c4f7c`.
- **Motion:** ripple every ~10s via `@keyframes` (scale 0.6 → 1.4, opacity 0.6 → 0). Center color shifts on `--gp-progress`.
- **Shape:** perfect circle.
- **Vibe:** meditative, lots of breathing room — least visually busy of all themes.
- **Implementation notes:** three pseudo-elements (`::before`, `::after`, plus one extra div) with staggered animation-delay produce the ripple cascade. Could also work as three real div children for cleaner control.

### 4. Lantern — Soft Globe

A perfect circle with a glowing "ember" core built from layered radial gradients. As time progresses, the core hue shifts warm → cool. Soft halo breathes very slowly. Paper-lantern feel.

```
           ╭───────╮
          ╱ ░░░░░░░ ╲
         │ ░ ▒▒▒▒▒ ░ │       ← halo (soft outer glow)
         │ ░ ▓▓●▓▓ ░ │
         │ ░ ▒▒▒▒▒ ░ │       ← ember core (hue shifts)
          ╲ ░░░░░░░ ╱
           ╰───────╯

     amber → gold → rose → indigo
```

- **Palette:** warm amber `#ffb347` → white-gold `#fce8b2` → rose-gold `#e89c8e` → indigo `#2e3a59`.
- **Motion:** halo breathes (6s box-shadow loop, similar to overtime); core hue shifts on `--gp-progress` via `color-mix()`. The current overtime breathing-glow already proves this pattern works.
- **Shape:** perfect circle with radial-gradient depth.
- **Vibe:** warm, cozy, candle-like — the warmest theme of the set.
- **Implementation notes:** single div with three stacked `background-image: radial-gradient(...)` (core, mid, halo) using progress-driven `color-mix()` for each stop. No extra DOM needed beyond the existing `.gp-timer-shape`.

## The theme API

These names are a **public contract**: they will not change without a changelog
entry. Everything else in [styles.css](styles.css) — the layout, component and
spacing classes, and the `--gp-space-*` / `--gp-text-*` / `--gp-dur-*` scales —
is internal and may change in any release.

### What the plugin gives you

| Name                                      | What it is                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--gp-progress`                           | **The contract.** A number, 0 → 1. 0 is the start of the arc, 1 is the end. Already mode-flipped, so it counts up during focus and back down during a break — a theme never needs to know which it is in. Registered with `@property`, so it interpolates rather than snapping. |
| `--gp-dusk-opacity`, `--gp-night-opacity` | The same journey pre-split for a three-layer cross-fade: `dusk = 2p` capped at 1, `night = 2p − 1` clamped. Use these if you stack layers; use `--gp-progress` if you interpolate colour.                                                                                       |
| `.gp-theme-<id>`                          | Your class, put on the view container. Scope everything you write to it.                                                                                                                                                                                                        |
| `.gp-timer-shape`                         | The clipped square your artwork lives in. Structure is shared; paint is yours.                                                                                                                                                                                                  |
| `.gp-art`                                 | Put this on every artwork node you add. It is hidden by default; your block shows your own.                                                                                                                                                                                     |

### What you declare

Each is read by a shared rule with today's value as a fallback, so a theme that
declares nothing still renders.

| Token               | Meaning                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--gp-shape-base`   | The flat colour behind your artwork.                                                                                                                                                                          |
| `--gp-shape-radius` | The square's corner rounding. You may change it. You may **not** remove `overflow: hidden` — the frosted pane's `backdrop-filter` and its iOS pulse workaround are both written against that clipped surface. |
| `--gp-shadow-rgb`   | Three comma-separated RGB **channels** for the drop shadow — `0, 0, 0`, not a hex. A colour here makes all six shadow declarations invalid at computed-value time and the timer's depth silently disappears.  |

### The one appearance rule

**At `--gp-progress: 0` it must look like day. At `1` it must look like night.**
That is the whole shared metaphor, and it is deliberately a sentence rather than
a mechanism — Classic fades gradients, Frosted Glass mixes colours in `oklab`, a
pixel theme cross-fades bitmaps. How you get there is yours.

### Adding a theme

Two steps.

1. An entry in `THEMES` in [themes.ts](themes.ts) — `id: "Label"`. The id type,
   the default, the settings dropdown, the CSS class and the resolver all derive
   from it, so a missing entry is a compile error and the view needs no change.
2. A `.gp-theme-<id>` block in [styles.css](styles.css): declare the three
   tokens above, and show your own `.gp-art` nodes. If your artwork needs new
   DOM, build it in `GentlePomoView.onOpen` beside the existing nodes and give
   it `gp-art`.

**Never name another theme's classes.** Before 0.6.0, Frosted Glass hid
Classic's three layers by name, which is why "classic" was not really a theme at
all — it was whatever was left over. That pattern needs N × (N−1) rules; this
one needs one block per theme.

### Two rules that are easy to get wrong

- **Pick exactly one smoothing route.** Either read the eased `--gp-progress`,
  or put your own `transition` on the thing you animate. `--gp-progress` is
  already transitioned 0.8s on `.gp-timer-visual`, so doing both doubles every
  skip and reset to roughly 1.6s.
- **Gate any animation you add on `prefers-reduced-motion`.** A theme-scoped
  selector out-specifies the shared `animation: none` block, so an ungated
  animation re-enables motion for exactly the people who turned it off — with no
  error and nothing visible on your own machine. This has already shipped here
  once; see the wrapper on the mobile frosted pulse.

See [DESIGN.md](DESIGN.md) for the rules governing the rest of the stylesheet.
