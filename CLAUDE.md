# CLAUDE.md

Project context for Claude Code sessions in this directory. Keep this file scannable in under 60 seconds.

## Project Summary

**Gentle Pomodoro** is an Obsidian plugin: a soothing, task-integrated Pomodoro timer that links sessions to Tasks-plugin markdown items and writes Dataview-compatible daily logs. Currently **v0.2.0 (beta)**.

**0.2.0 added:** new **Frosted Glass** theme — a 3D frosted pane in front of three drifting, hue-shifting color orbs (warm sunrise/fireplace → cool twilight, driven by the `--gp-progress` CSS variable). Theme picker (Classic / Frosted glass) in the main Obsidian Settings tab. Renamed the original theme internally from `"sunset"` to `"classic"` with one-time auto-migration in `loadSettings()`. Pastel-twilight palette in Obsidian light mode; fireplace-orange warmth in dark mode with mode-specific overrides. Overtime text contrast fixes for both modes (focus and break). Smooth color interpolation on skip/reset via `@property --gp-progress` registration. `THEMES.md` documents four future theme ideas.

**0.1.0 added:** long break after every Nth focus session (classic Pomodoro Technique), daily focus goal with status-bar progress + once-per-day "goal hit" notice, opt-in `🍅 N` counter written back to task lines (lifetime total per task; never resets), volume slider and auto-start toggles in the in-view settings panel.

**0.1.1 added:** audio cues now bundled into `main.js` so catalog/BRAT installs get sound out of the box (no mp3 assets needed on disk), `prefers-reduced-motion` respect on the timer-shape animations, sigstore artifact attestations on release assets, committed `package-lock.json` + CI uses `npm ci` for reproducible builds.

**0.1.2 added:** in-view settings panel redesigned with iOS-style toggle switches, Low/Mid/High segmented volume control, section headers (Timing / Audio / Auto-start), full-width Reset to defaults button, and apply-on-Enter for number inputs. Responsive pass: sticky timer visual at the top of the view, leaf-level horizontal scrolling on narrow sidebars (controls + settings + tasks lock at 260px and never shrink), day/night indicator auto-fades when the side panel drops below 200px, clock floors at 200×200, leaf min-height held at 320px so the divider stops shrinking past usable size.

**0.1.3 added:** docs-only release for the Obsidian Community Plugins catalog launch. README install path moved from BRAT to Community Plugins, and the feature list now reflects the 0.1.1 (bundled audio, `prefers-reduced-motion`) and 0.1.2 (redesigned in-view settings panel, narrow-sidebar responsive layout) changes that had not yet been written up.

Plugin ID: `gentle-pomo`. Mobile-compatible. Min Obsidian: 1.0.0.

## Build & Dev Commands

```bash
npm install            # bootstrap
npm run dev            # rollup --watch (rebuilds main.js into project root)
npm run build          # one-shot production build
npm run lint           # ESLint (Obsidian recommended + typed @typescript-eslint rules)
npm run lint:fix       # auto-fix what's safe
npm run format         # prettier --write .
npm run format:check   # prettier --check . (used by CI)
npm test               # vitest run
npm run test:watch     # vitest in watch mode
```

CI in [.github/workflows/ci.yml](.github/workflows/ci.yml) runs lint + format:check + test + build on every push and PR. Release in [.github/workflows/release.yml](.github/workflows/release.yml) attaches `main.js`, `manifest.json`, `styles.css` to GitHub Releases on tag push.

## Architecture

State flows through a listener pattern:

```
GentlePomoPlugin (main.ts)
    │
    ├── TimerEngine ──emit(TimerState)──▶ GentlePomoView   (renders the visual timer)
    │                                  └▶ status bar in main.ts
    │
    ├── LogManager       (appends daily-log markdown lines, TTL cache for today's totals)
    └── GentlePomoSettingTab  (Obsidian PluginSettingTab)
```

- `TimerEngine` is the single source of truth for timer state. Every subscriber gets a fresh snapshot via `onChange`.
- The view does **not** own state — it reads from `TimerEngine` and dispatches user actions back to it.
- Persistence is Obsidian's `loadData()`/`saveData()`; defaults are merged from `DEFAULT_SETTINGS` in [constants.ts](constants.ts).

## Source Map

| File                                               | Purpose                                                                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [main.ts](main.ts)                                 | Plugin entry. Commands, ribbon, status bar, auto-open (via `onLayoutReady`), settings load/save.                                                                                                                  |
| [TimerEngine.ts](TimerEngine.ts)                   | Timer state machine: start/pause/finish/skip, mode switching, sound, task linking, vault-modify reactions.                                                                                                        |
| [GentlePomoView.ts](GentlePomoView.ts)             | Sidebar `ItemView` (~400 LOC). Builds DOM, subscribes to `TimerEngine`, renders task dropdown and day/night gradient.                                                                                             |
| [GentlePomoSettingTab.ts](GentlePomoSettingTab.ts) | Settings page (folder paths, auto-open, status bar, day/night toggle).                                                                                                                                            |
| [logManager.ts](logManager.ts)                     | Writes daily `*-gentle-pomodoro-log.md` files, tracks pauses, refreshes logged task names by ID, caches today's focus total.                                                                                      |
| [taskLoader.ts](taskLoader.ts)                     | Parses Tasks-plugin markdown (`⏳ 📅 🆔 🔺`), normalizes display text, groups by date. Per-task counter helpers: `parseTodayPomodoroCount` / `incrementTodayPomodoroCount`.                                       |
| [icons.ts](icons.ts)                               | Inline SVG day/night icons (`buildDayNightIcon`, `DAY_NIGHT_ICON_ORDER`).                                                                                                                                         |
| [logger.ts](logger.ts)                             | `logger.warn/error/debug` — auto-prefix `[GentlePomo]`. Use instead of `console.*`. (`console.log` is disallowed by the lint config.)                                                                             |
| [types.ts](types.ts)                               | `PomoMode`, `GentlePomoSettings`, `TimerState`, `TimerListener`, `TaskItem`.                                                                                                                                      |
| [constants.ts](constants.ts)                       | `VIEW_TYPE_GENTLE_POMO`, `NO_TASK_LABEL`, `ONE_MINUTE_MS`, `FOCUS_TOTAL_CACHE_TTL_MS`, `DEFAULT_SETTINGS`. New settings live here as defaults (long-break, daily-goal, per-task counter, transient state fields). |
| [momentTypes.ts](momentTypes.ts)                   | Type stubs for Obsidian's bundled `moment` global.                                                                                                                                                                |
| [styles.css](styles.css)                           | All visual styling. Class names are `gp-*` prefixed. Responsive via `clamp()` and container queries. Two themes scoped via `.gp-theme-classic` / `.gp-theme-frosted-glass` on `.gp-root`.                         |
| [THEMES.md](THEMES.md)                             | Documents the two shipped themes (Classic, Frosted Glass) and four future theme ideas (Moon Phases, Tide, Zen Ripple, Lantern) with the wiring pattern for adding a new theme.                                    |
| [CHANGELOG.md](CHANGELOG.md)                       | Per-version change log (Keep a Changelog format). Canonical version history — the "X.Y.Z added" snippets at the top of this file are for at-a-glance context.                                                     |
| [tests/](tests/)                                   | Vitest unit tests for taskLoader, logManager (formatLogLine + parseFocusTotalSeconds), TimerEngine state machine.                                                                                                 |
| [\_\_mocks\_\_/obsidian.ts](__mocks__/obsidian.ts) | Minimal Obsidian-API stubs so unit tests can `import` from project files without an Obsidian runtime.                                                                                                             |

## Conventions

- **State updates flow through `TimerEngine.emit()`** → listeners. Never mutate `TimerState` from the View or status bar.
- **Defaults live in [constants.ts](constants.ts)** `DEFAULT_SETTINGS`. New settings must be added there and merged via `Object.assign` in `loadSettings()` ([main.ts](main.ts) `loadSettings`).
- **Task IDs** are detected via the `🆔` emoji marker. Log entries use Obsidian wiki-link syntax: `[[path|display name]]`.
- **CSS classes are `gp-*` prefixed.** Stay consistent — search [styles.css](styles.css) before inventing new names.
- **Logging:** use `logger.warn/error/debug` from [logger.ts](logger.ts), not raw `console.*`. The prefix `[GentlePomo]` is added automatically.
- **Audio assets** (`ding-sound.mp3`, `singing_bell_short.mp3`, `war-drum_short.mp3`) live at the project root and are loaded by relative path from [TimerEngine.ts](TimerEngine.ts).
- **Task parsing** must go through [taskLoader.ts](taskLoader.ts) (`loadTasks`, `groupTasksByDate`, `normalizeTaskText`, etc.) — never re-implement regex inline.

## Settings & Persistence

`GentlePomoSettings` in [types.ts](types.ts) is the schema. Stored by Obsidian in `data.json` at the project root. Modify via `plugin.settings.foo = ...` then `await plugin.saveSettings()`.

## Log Format

Daily file: `<folder>/YYYY-MM-DD-gentle-pomodoro-log.md`. One line per session, inline-field format so Dataview can query it:

```markdown
- 🍅 Focus | Task:: [[Projects/MyProject.md|Write Docs]] | ID:: abcd12 | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus
- ☕ Rest | Start:: 2025-12-23 10:25:00 | End:: 2025-12-23 10:30:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break
- ☕ Rest | Start:: 2025-12-23 11:00:00 | End:: 2025-12-23 11:15:00 | Scheduled:: 900 | Total:: 900 | Type:: long-break
```

`Type::` was added in 0.1.0 — values are `focus | short-break | long-break`. Additive; existing Dataview queries still match.

Field order is **load-bearing** for users' Dataview queries — do not reorder or rename without a version bump and changelog note. The schema is locked in by [tests/logManager.test.ts](tests/logManager.test.ts).

## Important Quirks

- **`obsidian` dep is pinned to `^1.4.16`** (types-only npm package). [package.json](package.json) and [manifest.json](manifest.json) track 0.1.3; [versions.json](versions.json) maps each plugin version to its `minAppVersion`.
- **`main.js` is the built artifact.** It's gitignored, but Obsidian loads it directly — you must `npm run build` (or have `npm run dev` running) before reloading the plugin.
- **Auto-open** runs inside `this.app.workspace.onLayoutReady()`. A `MutationObserver` fallback waits for any settings/community-plugin modal to close before activating the view (handles freshly-installed-plugin UX).
- **`noImplicitOverride: true`** is enabled in [tsconfig.json](tsconfig.json). Always mark methods that override Obsidian base classes (`Plugin.onload`, `ItemView.onClose`, etc.) with `override`.
- **`package-lock.json` is tracked** — CI uses `npm ci` for reproducible builds (since 0.1.1). Regenerate with `npm install` whenever `package.json` changes.
- **Local-timezone date string** used for daily reset logic is `moment().format("YYYY-MM-DD")` (defined as `todayLocalStr()` in both [main.ts](main.ts) and [TimerEngine.ts](TimerEngine.ts)). Same format as the daily log file naming, so all "today" logic agrees.
- **Per-task counter is opt-in** (`incrementPomodoroCountOnFinish`, default off). When enabled, finishing a focus session linked to a task increments a lifetime `🍅 N` marker on the task line. Legacy `🍅 N (YYYY-MM-DD)` markers from an earlier 0.1.0 build are still readable; on the next increment the parens are stripped and the marker becomes `🍅 N+1`.
- **Internal state fields** in `GentlePomoSettings` (`lastGoalHitDate`, `sessionsSinceLongBreak`, `sessionCounterDate`) are persisted to `data.json` alongside user settings but are not surfaced in any settings UI — they implement the once-per-day notice and long-break counter.

## Don't Do This

- Don't add `setInterval` calls in the view — subscribe to `TimerEngine.onChange` instead.
- Don't touch the DOM from `TimerEngine` or `LogManager` — UI rendering belongs in the View.
- Don't reach into `this.app.metadataCache` for task parsing — use [taskLoader.ts](taskLoader.ts).
- Don't use `console.*` directly — go through [logger.ts](logger.ts) (and `console.log` is lint-blocked anyway).
- Don't reorder or rename inline fields in log lines — tests in [tests/logManager.test.ts](tests/logManager.test.ts) will fail, and users have Dataview queries pinned to the current schema.

## Reusable Patterns

- **Listener pattern:** `onChange/offChange/emit` in [TimerEngine.ts](TimerEngine.ts) — copy this shape for any new subscribable state.
- **Settings merge:** `Object.assign({}, DEFAULT_SETTINGS, loaded ?? {})` in [main.ts](main.ts) `loadSettings`.
- **TTL cache:** `FOCUS_TOTAL_CACHE_TTL_MS` + `lastFetchMs` + `fetchInFlight` pattern in [main.ts](main.ts) `maybeRefreshFocusTotal` and [logManager.ts](logManager.ts) `getTodayFocusSeconds` — reuse for any expensive periodic fetch.
