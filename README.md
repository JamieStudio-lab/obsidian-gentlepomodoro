# Gentle Pomodoro

A visually soothing, task-integrated Pomodoro timer for your daily focus work. Two ambient themes — Classic (day→night gradient) or Frosted Glass (drifting color orbs behind a frosted pane) — instead of a ticking clock, task linking with the Tasks plugin, and Dataview-friendly daily logs.

> **v0.5.6 (beta).** Available in the Obsidian [Community Plugins catalog](https://obsidian.md/plugins?id=gentle-pomo). See [Install](#install).

## Features

### 🍅 Gentle visual timer

- **Two themes**: **Classic** (the original day → dusk → night gradient) and **Frosted Glass** (three drifting color orbs behind a 3D frosted pane — pastel-twilight palette in light mode, fireplace warmth in dark mode). Switch in the main Obsidian Settings tab.
- Ambient shape that transitions through warm → cool colors as the timer runs.
- Configurable focus / short break / **long break** durations. Classic Pomodoro: long break every 4 focus sessions (configurable).
- Overtime tracking — the timer counts up with a subtle glow after the session ends.
- **Estimated end time** — while a session runs, the timer shows the wall-clock time you'll finish (e.g. `Ends 15:30`, with `(+1 day)` if it crosses midnight): a calm way to know when you're free without watching the countdown. Toggle in settings.
- Optional audio cues (war drum on start, bell/ding on finish) — bundled into the plugin, no extra downloads needed.
- Respects `prefers-reduced-motion`: timer animations soften when the OS requests it.

### ✅ Task integration

- Pick tasks straight from your vault. Compatible with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) format: `- [ ] Task ⏳ 2025-12-23 🆔 abc123` — on any list bullet (`-`, `*`, `+`, or numbered).
- Smart filtering: Overdue, Today, Tomorrow, and upcoming tasks. Choose the lookahead window (3 / 5 / 7 / 14 / 30 days) in settings; overdue tasks always show.
- One-click **Unlink current task**.
- **Opt-in (beta — edits your task files)**: adds a lifetime `🍅 N` count to the task line each time you finish a focus session for it, placed before the Tasks date fields so they keep parsing (e.g. `- [ ] Write docs 🍅 3 ⏳ 2025-12-23`).
- **Recovery actions** (settings buttons + commands): if an older version left markers after your task dates and broke their parsing — **Check** counts them without changing anything, **Repair** moves them back in place, **Remove** deletes the misplaced ones, and **Remove all** deletes every marker the counter ever wrote (back up your vault first). The writing actions ask for confirmation with exact counts and never touch a `🍅 N` you typed yourself.

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

### 🎵 Lofi study music

- Paste a YouTube link — a video, a 24/7 live stream (Lofi Girl!), or a playlist — in the plugin settings and a ▶️ play/pause/stop row appears in the timer panel. **Audio-only by design**: no video is ever shown.
- **Up to three links, switchable from the panel**: fill in a second or third link (each with an optional short name like _Lofi_ or _Rain_) and you can change the mood without opening settings. The controls open with a line naming what's playing — _Music | Lofi_ before you start, _Now playing | Lofi_ once it's going (plus the track name, on a playlist). That line is just a label; the list button at the left of the transport is what opens the picker, and it appears once you have two or more links. Picking one only selects it: the player reloads and lands silent, so press ▶️ to start. Renaming a link, or editing one you aren't listening to, never interrupts what's playing.
- **⏭ next link, and it keeps playing**: press it while music is going and the next link starts by itself once it has loaded; press it while paused or stopped and nothing makes a sound. It's the one control that carries the audio across a switch. Shown only when you have more than one link.
- **⏮ / ⏩ previous and next video** move through a playlist. They sit on their own row, which eases in and out and appears only when the link you're on is genuinely a playlist — a single video on loop doesn't count, even though YouTube treats it as a one-item playlist internally.
- **Links check themselves and name themselves**: paste a link and, if YouTube has no record of it — a typo, a deleted or private video, one that blocks embedding — a short message appears under the box in settings. The name box fills in on its own too, from the video or playlist title, tidied up: a SHOUTING title comes back to sentence case, a lowercase one gets its first letter capitalised, and an over-long one is cut at a word. (If a title turns out to be unusable — some are a single invisible character — the channel name is used instead.) Type over it any time; it never touches a name you've already written, or one you're in the middle of writing. The check is honest about its limits: it can't promise a link will play, only that YouTube can find it.
- **Fades in and out**: ▶️ eases the music up from silence, ⏸ and ⏹ ease it down before stopping, and ⏮/⏩ fade across a track change rather than cutting — no snapping in mid-bar. Change your mind mid-fade and it simply carries on; pressing ⏸ or ⏹ during a track skip cancels the skip.
- **Gentle ducking**: session cues (drum, bell, ding) briefly dip the music and ease it back up, so they stay audible without jolting the mix.
- **Loops by default** (turn off **Loop music** to play once), with a **Low / Mid / High** music volume next to the sound volume in the in-view settings.
- **Resumes where you left off, per link**: pause (or close the panel, or quit Obsidian) and the track is queued at that moment next time — press ▶️ to carry on. Each link keeps its own place, so switching away and back picks up where you were. Nothing auto-plays; ⏹ **Stop** — or changing that link — clears its position so it starts from the top instead. A link with its own timestamp (`?t=90`, or an older `#t=1m30s`) opens there. Live streams always start live.
- Fully manual — independent of your sessions; stops when you close the timer panel. If playback truly stops or stalls (stream offline, lost connection), a notice tells you.
- **Desktop only, for now.** On iPhone and iPad, YouTube refuses to load its player inside Obsidian at all (error 153): it requires the embedding page to identify itself with an HTTP `Referer`, and iOS doesn't send one for an app served from a custom scheme. Nothing the plugin can set changes this — it's the same wall other iOS webview apps hit — so the music player is a desktop feature until Obsidian or Apple changes that. Every other feature works on mobile as before.

### 📱 Mobile (iPad & phone)

- Touch-friendly: bigger tap targets, one smooth-scrolling panel, and a layout that adapts to the screen — on a short/landscape phone the timer shrinks and gets out of the way.
- **Tap the timer shape** to peek at the hidden countdown — it fades back on its own after a couple of seconds. The daily-goal progress shows in the view (Obsidian hides the status bar on mobile).
- **Sound:** press **Start** once to unlock audio, and note iOS's hardware silent switch mutes it — platform constraints, not bugs.
- **Lofi music doesn't play on iPhone or iPad** — YouTube won't load its player inside Obsidian there (error 153). See [Lofi study music](#-lofi-study-music) for why; it isn't the link, and no other link works.

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

**Settings tab** (Settings → Gentle Pomodoro), grouped into sections (findable via Obsidian's settings search on Obsidian 1.13+):

- **Display & behavior**: log folder path, auto-open on startup, and show status bar.
- **Timer appearance**: **theme** (`Classic` default or `Frosted glass`), day/night indicator, and **estimated end time** (shown while a session runs).
- **Music**: **music link 1–3** (video, live stream, or playlist — audio-only playback in the timer panel), each with an optional **name** shown in the panel and filled in for you when you paste a link, **show music player** (turning it off also stops playback), **loop music** (replay from the start when it ends; on by default), and **resume where you left off** (reopen each link at the moment you paused; on by default).
- **Long break**: duration (default 15m) and frequency (every N focus sessions, default 4).
- **Daily focus goal**: minutes (default 120, 0 disables) and goal-hit notice toggle.
- **Task selector**: tasks folder path; **show task selector** (defaults to hidden until you set a tasks folder path; turning it off unlinks the current task); **task lookahead window** — how many days ahead the selector reaches (3 / 5 / 7 / 14 / 30 days; default 3), with overdue tasks always shown.
- **Task integration**: increment task pomodoro count on finish (opt-in, beta — edits your task files), plus the marker recovery actions: check / repair / remove misplaced / remove all.

**In-view panel** (gear icon on the timer) — grouped into sections:

- **Timing**: focus / short break / long break durations (press Enter to apply).
- **Audio**: sound toggle, **Low / Mid / High** volume, and **Low / Mid / High** music volume.
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
- `Check for misplaced pomodoro count markers` / `Repair misplaced pomodoro count markers` / `Remove misplaced pomodoro count markers` / `Remove all pomodoro count markers`

## Compatible plugins

- **[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)** — the task picker reads its emoji-marker format.
- **[Dataview](https://github.com/blacksmithgu/obsidian-dataview)** — daily log lines use inline fields, ready to query.

## Network use

Timers, logs, and sounds are all local (audio cues are bundled into `main.js`). The optional lofi-music feature is the only part that reaches the network, in two places — both only ever to YouTube, and neither happens until you paste a music link.

**Playing the audio.** With a music link set and **Show music player** on, the timer panel embeds YouTube's privacy-enhanced player from `www.youtube-nocookie.com` to stream the audio, which loads content from YouTube/Google servers. This happens only while the timer panel is open; clearing the link or turning the toggle off stops it entirely.

**Checking a link.** When you paste or edit a link in the settings, the plugin makes one small request to `www.youtube-nocookie.com/oembed` about that link, to tell you if YouTube can't find it and to offer a name for it. It is sent shortly after you stop typing, and it carries only the video or playlist ID you pasted. Unlike the player above, this happens even with the timer panel closed and **Show music player** off — those control playback, not the settings page. No request is made for an empty slot, and answers are remembered for the session so editing the same link twice doesn't ask twice.

YouTube's handling of both is covered by [Google's privacy policy](https://policies.google.com/privacy).

## Issues & feedback

Found a bug or have an idea? Please open an issue on the [GitHub issue tracker](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/issues) — bug reports and feature requests are welcome.

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
