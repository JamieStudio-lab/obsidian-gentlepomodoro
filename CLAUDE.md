# CLAUDE.md

Project context for Claude Code sessions in this directory. Keep this file scannable in under 60 seconds.

## Project Summary

**Gentle Pomodoro** is an Obsidian plugin: a soothing, task-integrated Pomodoro timer that links sessions to Tasks-plugin markdown items and writes Dataview-compatible daily logs. Currently **v0.0.6 (beta)**, ~2,000 LOC of TypeScript, no tests yet.

Plugin ID: `gentle-pomo`. Mobile-compatible. Min Obsidian: 1.0.0.

## Build & Dev Commands

```bash
npm install            # bootstrap (obsidian is pulled from master tarball — see Quirks)
npm run dev            # rollup --watch (rebuilds main.js into project root)
npm run build          # one-shot production build
npm run lint           # ESLint check (Obsidian's recommended rules)
npm run lint:fix       # auto-fix what's safe
```

There is **no test script** and **no CI**. Verify behavior by loading the plugin in Obsidian (the working directory *is* a real `.obsidian/plugins/...` folder, so a reload picks up the build).

## Architecture

State flows through a listener pattern:

```
GentlePomoPlugin (main.ts)
    │
    ├── TimerEngine ──emit(TimerState)──▶ GentlePomoView   (renders the visual timer)
    │                                  └▶ status bar in main.ts
    │
    ├── LogManager       (appends daily-log markdown lines, 30s TTL cache for today's totals)
    └── GentlePomoSettingTab  (Obsidian PluginSettingTab)
```

- `TimerEngine` is the single source of truth for timer state. Every subscriber gets a fresh snapshot via `onChange`.
- The view does **not** own state — it reads from `TimerEngine` and dispatches user actions back to it.
- Persistence is Obsidian's `loadData()`/`saveData()`; defaults are merged from `DEFAULT_SETTINGS` in [constants.ts](constants.ts).

## Source Map

| File | Purpose |
|------|---------|
| [main.ts](main.ts) | Plugin entry. Commands, ribbon, status bar, auto-open observer, settings load/save. |
| [TimerEngine.ts](TimerEngine.ts) | Timer state machine: start/pause/finish/skip, mode switching, sound, task linking, vault-modify reactions. |
| [GentlePomoView.ts](GentlePomoView.ts) | Sidebar `ItemView` — 549 LOC. Builds DOM, subscribes to `TimerEngine`, renders task dropdown and day/night gradient. |
| [GentlePomoSettingTab.ts](GentlePomoSettingTab.ts) | Settings page (folder paths, auto-open, status bar, day/night toggle). |
| [logManager.ts](logManager.ts) | Writes daily `*-gentle-pomodoro-log.md` files, tracks pauses, refreshes logged task names by ID, caches today's focus total. |
| [taskLoader.ts](taskLoader.ts) | Parses Tasks-plugin markdown (`⏳ 📅 🆔 🔺`), normalizes display text, groups by Overdue/Today/Tomorrow/Upcoming. |
| [types.ts](types.ts) | `PomoMode`, `GentlePomoSettings`, `TimerState`, `TimerListener`, `TaskItem`. |
| [constants.ts](constants.ts) | `VIEW_TYPE_GENTLE_POMO`, `NO_TASK_LABEL`, `ONE_MINUTE_MS`, `DEFAULT_SETTINGS`. |
| [momentTypes.ts](momentTypes.ts) | Type stubs for Obsidian's bundled `moment` global. |
| [styles.css](styles.css) | All visual styling. Class names are `gp-*` prefixed. Responsive via `clamp()` and container queries. |

## Conventions

- **State updates flow through `TimerEngine.emit()`** → listeners. Never mutate `TimerState` from the View or status bar.
- **Defaults live in [constants.ts](constants.ts)** `DEFAULT_SETTINGS`. New settings must be added there and merged via `Object.assign` in `loadSettings()` ([main.ts:155-158](main.ts)).
- **Task IDs** are detected via the `🆔` emoji marker (`TASK_ID_REGEX` in [TimerEngine.ts](TimerEngine.ts)). Log entries use Obsidian wiki-link syntax: `[[path|display name]]`.
- **CSS classes are `gp-*` prefixed.** Stay consistent — search [styles.css](styles.css) before inventing new names.
- **Error logs prefix `[GentlePomo]`** for grep-ability (e.g., `console.error("[GentlePomo] ...")`).
- **Audio assets** (`ding-sound.mp3`, `singing_bell_short.mp3`, `war-drum_short.mp3`) live at the project root and are loaded by relative path from [TimerEngine.ts](TimerEngine.ts).

## Settings & Persistence

`GentlePomoSettings` in [types.ts](types.ts) is the schema. Stored by Obsidian in `data.json` at the project root. Modify via `plugin.settings.foo = ...` then `await plugin.saveSettings()`.

## Log Format

Daily file: `<folder>/YYYY-MM-DD-gentle-pomodoro-log.md`. One line per session, inline-field format so Dataview can query it:

```markdown
- 🍅 Focus | Task:: [[Projects/MyProject.md|Write Docs]] | ID:: abcd12 | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished
- ☕ Rest  | Start:: 2025-12-23 10:25:00 | End:: 2025-12-23 10:30:00 | Scheduled:: 300 | Total:: 300
```

Field order is load-bearing for users' Dataview queries — do not reorder or rename without a version bump and changelog note.

## Important Quirks

- **`obsidian` dependency is `https://github.com/obsidianmd/obsidian-api/tarball/master`** — `npm install` can pull in surprise API changes. Don't assume the lockfile is reproducible.
- **Version of record is [manifest.json](manifest.json)** (currently 0.0.6). [package.json](package.json) is stale at 0.0.1 — ignore it for version checks.
- **`main.js` is the built artifact.** It's gitignored, but Obsidian loads it directly — you must `npm run build` (or have `npm run dev` running) before reloading the plugin.
- **Auto-open uses a `MutationObserver`** ([main.ts:174](main.ts)) to wait for the settings modal to close on startup. If you change startup flow, test the "Obsidian launched with settings open" case.
- **No tests.** Do not claim behavior works without verifying in Obsidian — type-check passing is not enough.

## Don't Do This

- Don't add `setInterval` calls in the view — subscribe to `TimerEngine.onChange` instead.
- Don't touch the DOM from `TimerEngine` or `LogManager` — UI rendering belongs in the View.
- Don't bypass the `[GentlePomo]` log prefix — it's how the maintainer filters console output.
- Don't reorder or rename inline fields in log lines — users have Dataview queries pinned to the current schema.
- Don't reach into `this.app.metadataCache` for task parsing — use [taskLoader.ts](taskLoader.ts) (handles emoji markers, normalization, grouping).

## Reusable Patterns

- **Listener pattern:** `onChange/offChange/emit` in [TimerEngine.ts](TimerEngine.ts) — copy this shape for any new subscribable state.
- **Settings merge:** `Object.assign({}, DEFAULT_SETTINGS, loaded ?? {})` in `loadSettings` ([main.ts:155-158](main.ts)).
- **TTL cache:** `statusFocusLastFetchMs` / `statusFocusFetchInFlight` pattern in [main.ts:309-323](main.ts) — reuse for any expensive periodic fetch.
