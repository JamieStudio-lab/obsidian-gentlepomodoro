# Changelog

All notable changes to **Gentle Pomodoro** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-06-25

### Added

- **Systematic mobile (iPad / phone) support.** All mobile/touch styling now lives in one consolidated section in `styles.css`, driven by sizing tokens (`--gp-tap-min`, `--gp-icon-*-size`) so future tweaks live in one place. Two query strategies are used deliberately: `body.is-mobile` / `body.is-tablet` for layout/sizing, and `@media (hover: none) and (pointer: coarse)` for input-capability fixes.
- **Tap-to-peek countdown on touch.** The running countdown is hidden by design ("gentle, don't fixate on the clock"); on desktop you hover the shape to peek. Touch devices have no hover, so tapping the timer shape now toggles the countdown visible/hidden.
- **Daily-goal progress in the view on mobile.** Obsidian hides the status bar on mobile, which is where the `Today 2h / 4h` goal meter lived — it's now mirrored into the timer view and shown on mobile/tablet (hidden on desktop, where the status bar still carries it).

### Changed

- Bigger touch targets on mobile (≥44px): icon buttons, volume segments, the reset button, task-list rows, and number inputs.
- Mobile control layout reflows (full-width column, wrapping button rows) instead of forcing the whole leaf to scroll sideways, and the timer visual is allowed a little more width.
- **Minimum Obsidian version raised to 1.7.2** (the plugin uses `Workspace.revealLeaf` and `Vault.createFolder`).

### Fixed

- Icon-button glyphs were thin slivers on iPad. Root cause (found via Web Inspector): a WebKit/Safari flexbox bug collapses an SVG flex item's main-axis width to ~min-content (8px) while honoring its height, so the control glyphs rendered ~8px wide × 32px tall. Fixed with a `min-width`/`min-height` floor (plus `flex-shrink: 0`) in CSS, which the flex algorithm can't cross. Glyphs are now a full 32px in a 48px button on mobile; iPhone and desktop unchanged.
- **Daily-log writes are now robust on mobile.** A session could be silently dropped when the Vault file index lagged the filesystem (common on mobile right after the log file is created, or when Obsidian Sync brings it in): the old write path checked the raw filesystem but then looked the file up in the index, and when the two disagreed it appended nowhere. The write path now resolves the file through the Vault index and falls back to an adapter-level append, so a session is never lost to an index lag. Write failures (sync conflicts, locked files) are caught — the user gets a notice and the timer still advances, instead of an unhandled error — and the folder-create step tolerates a sync race.
- Task-rename log rewrites now match the log folder by path boundary, so a log folder named e.g. `Log` no longer also scans/rewrites files under a sibling folder like `Logs`.

### Internal

- Task-picker click handlers converted from direct `.onclick` to `registerDomEvent` so listeners are cleaned up on view close.

### Known limitations

- On iOS, the hardware silent/ring switch mutes WebAudio, so completion sounds won't play with the switch on. Completion sounds otherwise rely on a prior tap (Start) to unlock audio. These are platform constraints, not plugin bugs.

## [0.2.1] — 2026-05-31

### Fixed

- Auto-start break / focus now actually starts the next session when the timer reaches zero — previously the timer slid into overtime and never advanced even with the toggles on.
- The end-of-session sound (bell on focus, ding on break) now plays at natural completion when auto-start is on.
- Audio reliability: a single shared `AudioContext` is created once and resumed when suspended (a fresh per-call context could start suspended or be garbage-collected before playback), decoded clips are cached, and the context + timer tick-loop are released on plugin unload so they don't leak across disable/enable cycles.

### Changed

- **Stop** (Finish & next) now always switches to the next mode **paused**, even when auto-start is on. **Skip** respects the auto-start toggle — it starts the next session when auto-start is on, otherwise switches paused. The auto-start toggles now govern only automatic (timer-reaches-zero) transitions.

## [0.2.0] — 2026-05-26

### Added

- New **Frosted Glass** theme: a 3D backdrop-blurred pane in front of three drifting, hue-shifting color orbs. Warm sunrise (light mode) / fireplace (dark mode) at the start of focus, easing to cool twilight by the end, driven by the `--gp-progress` CSS variable.
- Theme picker — `Classic` (default) or `Frosted glass` — in the main Obsidian Settings tab.
- Pastel-twilight palette in Obsidian light mode; fireplace-orange warmth in Obsidian dark mode (mode-specific overrides scoped via `body.theme-dark` / `body.theme-light`).
- Smooth color interpolation on skip / reset via `@property --gp-progress` registration — color transitions feel cadenced like the Classic theme's opacity transitions.
- `THEMES.md` — documents the two shipped themes plus four future theme ideas (Moon Phases, Tide, Zen Ripple, Lantern) and the wiring pattern for adding a new theme.

### Changed

- Original theme renamed internally from `"sunset"` to `"classic"`. One-time auto-migration runs in `loadSettings()` so existing users carry over silently.
- Overtime text contrast improved across both light and dark Obsidian, both focus and break modes (overtime timer + "Total: M:SS" line both readable on the new pastel/orange backdrops).

## [0.1.3] — 2026-05-20

### Changed

- Docs-only release for the Obsidian Community Plugins catalog launch.
- README install path moved from BRAT to Community Plugins.
- Feature list refreshed to reflect 0.1.1 and 0.1.2 changes that hadn't been written up yet.

## [0.1.2] — 2026-05-20

### Changed

- In-view settings panel redesigned: iOS-style toggle switches, Low / Mid / High segmented volume control, section headers (Timing / Audio / Auto-start), full-width Reset to defaults button.
- Apply-on-Enter for number inputs in the settings panel.
- Responsive pass: sticky timer visual at the top of the view, leaf-level horizontal scrolling on narrow sidebars (controls + settings + tasks lock at 260px), day/night indicator auto-fades when the side panel drops below 200px, clock floors at 200×200, leaf min-height held at 320px.

## [0.1.1] — 2026-05-19

### Added

- Audio cues bundled into `main.js` — no extra mp3 files needed on disk; catalog/BRAT installs get sound out of the box.
- `prefers-reduced-motion` respect on the timer-shape animations.
- Sigstore artifact attestations on release assets.

### Changed

- `package-lock.json` committed; CI uses `npm ci` for reproducible builds.

## [0.1.0] — 2026-05-18

### Added

- Long break after every Nth focus session (classic Pomodoro Technique).
- Daily focus goal with status-bar progress + once-per-day "goal hit" notice.
- Opt-in `🍅 N` counter written back to task lines (lifetime total per task; never resets).
- Volume slider and auto-start toggles in the in-view settings panel.

## [0.0.5] — 2026-02-03

Initial public-facing release. See git log for details.

## [0.0.4-Beta] — 2025-12-29

Pre-release beta. See git log for details.

## [0.0.3] — 2025-12-23

First tagged build. See git log for details.
