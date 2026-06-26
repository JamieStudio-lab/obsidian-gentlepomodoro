# Gentle Pomodoro

A visually soothing, task-integrated Pomodoro timer for your daily focus work. Two ambient themes — Classic (day→night gradient) or Frosted Glass (drifting color orbs behind a frosted pane) — instead of a ticking clock, task linking with the Tasks plugin, and Dataview-friendly daily logs.

> **v0.3.0 (beta).** Available in the Obsidian [Community Plugins catalog](https://obsidian.md/plugins?id=gentle-pomo). See [Install](#install).

## Features

### 🍅 Gentle visual timer

- **Two themes**: **Classic** (the original day → dusk → night gradient) and **Frosted Glass** (three drifting color orbs behind a 3D frosted pane — pastel-twilight palette in light mode, fireplace warmth in dark mode). Switch in the main Obsidian Settings tab.
- Ambient shape that transitions through warm → cool colors as the timer runs.
- Configurable focus / short break / **long break** durations. Classic Pomodoro: long break every 4 focus sessions (configurable).
- Overtime tracking — the timer counts up with a subtle glow after the session ends.
- Optional audio cues (war drum on start, bell/ding on finish) — bundled into the plugin, no extra downloads needed.
- Respects `prefers-reduced-motion`: timer animations soften when the OS requests it.

### ✅ Task integration

- Pick tasks straight from your vault. Compatible with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) format: `- [ ] Task ⏳ 2025-12-23 🆔 abc123`.
- Smart filtering: Overdue, Today, Tomorrow, upcoming (next 3 days).
- One-click **Unlink current task**.
- **Opt-in**: increment `🍅 N` on the task line each time you finish a focus session for it. Lifetime count per task; legacy `🍅 N (date)` markers from earlier builds are read correctly and migrate on next write.

### 📊 Daily focus goal

- Set a daily focus target (default 2h, set to 0 to disable).
- Status bar shows progress: `Today 1h 12m / 2h`. Turns green when the goal is met.
- One-time "goal hit" notice each day. Resets automatically at local midnight.

### 📝 Dataview-friendly daily logs

- One markdown file per day: `<folder>/YYYY-MM-DD-gentle-pomodoro-log.md`.
- One inline-field line per session (start, end, pauses, duration, status, type).
- **Rename-safe** when tasks carry `🆔` — past log lines update on rename, or via the `Refresh log task names by ID` command.

### 🧭 Status bar

- Compact mode/time indicator with today's total focus.
- Click the dot to open the timer; click the label to toggle the time-left display.

### 📱 Mobile (iPad & phone)

- Touch-friendly layout: larger buttons and tap targets, and the controls reflow to fit the screen instead of scrolling sideways.
- **Tap the timer shape to peek** at the running countdown (the touch equivalent of hovering on desktop — the countdown stays hidden by default so you don't fixate on the clock).
- The daily-goal progress appears in the timer view, since Obsidian hides the status bar on mobile.
- **Sound note:** completion cues need a prior tap (pressing **Start** unlocks audio), and iOS's hardware **silent/ring switch** mutes them when it's on — both are platform constraints, not plugin bugs.

## Install

### Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Gentle Pomodoro** and click **Install**.
3. Enable it in **Community plugins**.

Or grab it directly from the [Obsidian catalog page](https://obsidian.md/plugins?id=gentle-pomo).

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/releases/latest). Audio is bundled into `main.js` — no extra files needed.
2. Drop them into `<vault>/.obsidian/plugins/gentle-pomo/`.
3. Reload and enable in Community Plugins.

## Configure

**Settings tab** (Settings → Gentle Pomodoro):

- Tasks folder path, log folder path.
- Auto-open on startup, show status bar, day/night indicator.
- **Theme**: `Classic` (default) or `Frosted glass`.
- **Long break**: duration (default 15m) and frequency (every N focus sessions, default 4).
- **Daily focus goal**: minutes (default 120, 0 disables) and goal-hit notice toggle.
- **Task integration**: increment-task-pomodoro-count-on-finish (opt-in).

**In-view panel** (gear icon on the timer) — grouped into sections:

- **Timing**: focus / short break / long break durations (press Enter to apply).
- **Audio**: sound toggle and **Low / Mid / High** volume.
- **Auto-start**: auto-start break, auto-start focus. When on, a session that runs out automatically plays the end cue and starts the next one. The buttons stay explicit: **Stop** (finish & next) always switches to the next session **paused**, while **Skip** starts it (when auto-start is on).
- Full-width **Reset to defaults** button at the bottom.

Layout adapts to narrow sidebars: the timer visual stays sticky at the top, controls keep a comfortable minimum width and the panel scrolls horizontally if needed.

## Log format

Each session appends one line to the day's log file:

```md
- 🍅 Focus | Task:: [[Projects/Docs.md|Write docs]] | ID:: abcd12 | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus
- ☕ Rest | Start:: 2025-12-23 10:25:00 | End:: 2025-12-23 10:30:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break
- ☕ Rest | Start:: 2025-12-23 11:00:00 | End:: 2025-12-23 11:15:00 | Scheduled:: 900 | Total:: 900 | Type:: long-break
```

`Type::` is `focus | short-break | long-break`. Field order is stable — safe to pin Dataview queries against it.

## Commands

- `Open view`
- `Start` / `Pause` / `Finish & next` / `Skip to next`
- `Refresh log task names by ID`
- `Show status bar` / `Hide status bar`

## Compatible plugins

- **[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)** — the task picker reads its emoji-marker format.
- **[Dataview](https://github.com/blacksmithgu/obsidian-dataview)** — daily log lines use inline fields, ready to query.

## Development

```bash
npm install
npm run dev          # rollup --watch (rebuilds main.js)
npm run build        # one-shot production build
npm test             # vitest
npm run lint
npm run format       # prettier --write .
```

CI on every push runs lint, format-check, tests, and build. Release tags push a GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached.

## Credits

- **Ding sound** — [Universfield](https://pixabay.com/users/universfield-28281460/) via [Pixabay](https://pixabay.com/sound-effects/).
- **Bell sounds** — [freesound_community](https://pixabay.com/users/freesound_community-46691455/) via [Pixabay](https://pixabay.com/sound-effects/).

## AI disclaimer

Parts of this plugin were developed with AI assistance (Codex, Gemini, Claude). All code reviewed and tested by the maintainer before release.

## License

[MIT](LICENSE)
