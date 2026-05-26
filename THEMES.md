# Theme Ideas

Visual themes for the Gentle Pomodoro timer view. Each theme should preserve the **gentle** aesthetic: slow transitions (≥0.8s), gradient blends, indirect time cues, no progress rings or hard countdown bars, and respect for `prefers-reduced-motion`.

## Shipped

- **Classic** — the original (formerly "Sunset / Aurora"). Three stacked gradient layers (day → dusk → night) whose opacities blend as progress advances. Squircle shape, gentle 8s scale pulse, day/night SVG badge.
- **Frosted Glass** — three soft color orbs drifting behind a frosted-glass pane. Orb hues interpolate through the sunrise→sunset palette via `--gp-progress` + `color-mix(in oklab, ...)`. Backdrop-filter blur gives the depth-of-field look.

## Future ideas

Saved during the Frosted Glass implementation (2026-05-25). Not yet implemented — see [the Frosted Glass plan](#shipped) for the wiring pattern (settings flag, theme class on `.gp-root`, DOM nodes always built and CSS-toggled).

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

## Wiring pattern (for whoever picks one up next)

1. Add the new value to the `theme` union in [types.ts](types.ts) and update the default in [constants.ts](constants.ts) if needed.
2. In `GentlePomoView.onOpen()` ([GentlePomoView.ts:60](GentlePomoView.ts#L60)), build any theme-specific DOM nodes — they live alongside the existing ones and are CSS-toggled.
3. In `applySettings()` ([GentlePomoView.ts:306](GentlePomoView.ts#L306)), toggle `gp-theme-<name>` on `containerEl`.
4. Add an option to the segmented control in `renderSettingsPanel()` ([GentlePomoView.ts:458](GentlePomoView.ts#L458)).
5. Scope the new CSS rules to `.gp-theme-<name>` and hide the inactive theme's DOM nodes via `display: none`.

The `--gp-progress` CSS variable is already published on `.gp-timer-visual` each tick (in the listener) — use it with `color-mix(in oklab, A, B calc(var(--gp-progress) * 100%))` for any color interpolation.
