<p align="center"><img src=".github/banner.png" alt="Gentle Pomodoro — Focus gently. Work deeply." width="830"></p>

A visually soothing, task-integrated Pomodoro timer for your daily focus work. Four ambient themes — Classic (day→night gradient), Frosted Glass (drifting colour orbs behind a frosted pane), Frosted Glass 2 (the same idea drawn as real glass, with a lit rim) or Pixel City (a pixel-art city whose windows light up as night falls) — instead of a ticking clock, task linking with the Tasks plugin, and Dataview-friendly daily logs.

> **v0.6.9 (beta).** Available in the Obsidian [Community Plugins catalog](https://obsidian.md/plugins?id=gentle-pomo). See [Install](#install).

## Features

### 🍅 Gentle visual timer

- **Four themes**: **Classic** (the original day → dusk → night gradient), **Frosted Glass** (three drifting colour orbs behind a 3D frosted pane — pastel-twilight palette in light mode, fireplace warmth in dark mode), **Frosted Glass 2** (the same idea drawn as real glass: a thin lit rim that picks up the session's colour, two highlights on the edge, sharper colour balls behind the pane, and an edge shade that follows your own theme's background colour so it sits well on light and coloured themes) and **Pixel City** (a pixel-art city under a dithered sky; the windows come on wave by wave as the session runs toward night, and go dark again over a break). Switch in the main Obsidian Settings tab.
- Ambient shape that transitions through warm → cool colors as the timer runs.
- Configurable focus / short break / **long break** durations. Classic Pomodoro: long break every 4 focus sessions (configurable).
- Overtime tracking — the timer counts up with a subtle glow after the session ends.
- **Estimated end time** — while a session runs, the timer shows the wall-clock time you'll finish (e.g. `Ends 15:30`, with `(+1 day)` if it crosses midnight): a calm way to know when you're free without watching the countdown. Toggle in settings.
- Optional audio cues (war drum on start, bell/ding on finish) — bundled into the plugin, no extra downloads needed. **Choose the end sounds yourself**: any of the three built-ins, or your own mp3, m4a or wav file from the vault (up to 30 seconds).
- **Notify when time is up** (computers, opt-in) — a silent system notification when focus or break time is up, so you notice even when other windows cover Obsidian. It works with the timer's sounds off. Turning it on shows a sample, which is when your computer may ask to allow notifications from Obsidian.
- Respects `prefers-reduced-motion`: timer animations soften when the OS requests it.

### ✅ Task integration

- Pick tasks straight from your vault. Compatible with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) format: `- [ ] Task ⏳ 2025-12-23 🆔 abc123` — on any list bullet (`-`, `*`, `+`, or numbered).
- **Choose where tasks come from**: a **tasks folder**, the **note you are in**, or **every note you have open**. The two note options also show tasks with no date, under a _No date_ heading — handy if you keep todos inline in your notes rather than in one folder.
- Smart filtering: Overdue, Today, Tomorrow, and upcoming tasks. Choose the lookahead window (3 / 5 / 7 / 14 / 30 days) in settings; overdue tasks always show.
- **Your linked task stays linked** when you change where tasks come from — if the new scope would not show it, it appears at the top under _Linked task_. Only ticking it off unlinks it.
- The **Current task** button shows the task's name without its tags, on up to two lines; on a computer, hover it to read a longer name in full.
- One-click **Unlink current task**.
- **Opt-in (beta — edits your task files)**: adds a lifetime `🍅 N` count to the task line each time you finish a focus session for it, placed before the Tasks date fields so they keep parsing (e.g. `- [ ] Write docs 🍅 3 ⏳ 2025-12-23`). A `🍅 N` you typed in the task's own text stays as it is, and the count goes beside it (`- [ ] Buy 🍅 2 kg 🍅 1 ⏳ 2025-12-23`). The same goes the other way: if you add words after the count (Edit Task puts them there), that `🍅 N` becomes text and the next session starts a new count beside it.
- **Recovery actions** (settings buttons + commands): if an older version left markers after your task dates and broke their parsing — **Check** counts them without changing anything, **Repair** moves them back in place, **Remove** deletes the misplaced ones, and **Remove all** deletes every marker the counter ever wrote (back up your vault first). The writing actions ask for confirmation with exact counts first. Repair and Remove only act on a marker sitting _after_ a task's date fields — the placement that breaks them, whoever typed it. None of the four touches a `🍅 N` you typed inside a task's own text, i.e. one with words after it. A `🍅 N` counts as a marker when nothing but tags, Tasks fields (dates, priority, recurrence, ID…), a block reference (`^id`) or the line's end follows it — or when it sits where the counter writes, just before the line's first Tasks emoji. Cancelled and in-progress tasks are included.

### 📊 Daily focus goal

- Set a daily focus target (default 2h, set to 0 to disable).
- The status bar shows progress as a thin ring that fills toward the goal and changes when the goal is met. Hover for `Today: 1h 12m of 2h 0m`, or turn on the text in settings.
- One-time "goal hit" notice each day — once across all your devices, too. A new day starts at midnight, or at the hour you set under **Day starts at**.
- The total is counted from the daily log. With no log folder set, nothing is logged, so the goal counts only the session that is running — the timer panel says so on phones and tablets, and the status bar's hover text on computers (`no log folder set`).
- Each day's log file keeps that day's goal as a property, `goal_minutes`, so a review of an old day still shows the goal it had after you change the setting. The timer writes it into today's file when it logs a session; older days are never changed.

### 📝 Dataview-friendly daily logs

- One markdown file per day in your log folder, `<folder>/YYYY-MM-DD-gentle-pomodoro-log.md`, with one line per session. Set the folder under **Settings → Daily log**; with none set, no log is kept.
- Every line is made of Dataview fields — `[Start:: …]`, `[Total:: …]`, `[Status:: …]` and the rest — so Dataview reads them directly. See [Log format](#log-format) for the fields and example queries.
- **Logs from before 0.6.9** have lines Dataview can't read. The plugin still reads them (today's total, renames), and **Convert old log lines** rewrites them in the new form, keeping every start, end and total — it shows exact counts, lists the few tidy-ups it makes to task names and dates, and asks first. A day logged under two file names — one written with other digits by Obsidian in Arabic, Persian, Bengali or Nepali — is merged into the 0-9 file, each session at its start time, and the old file goes to the trash. **Check log** reports what it would convert or merge, and anything in the log that looks wrong, without changing a thing.
- **Open today's log** from the command palette, the status bar's menu, the settings, or — on phones and tablets — by tapping today's total in the timer panel.
- **Add a session** you did away from the timer, or **fix a logged session** — its task, start, length or status, or delete it — without editing the line by hand.
- **Day starts at** (midnight to 6:00), for night owls: a session that starts before this hour counts for the day before — its log file, today's total, the goal and the long-break count all agree. A session is always filed under the day it _starts_.
- **Task switch**: if you pick another task during a focus, the whole session goes to the last task, as before. Choose **Split at the switch** to log a line for each task instead. A part under a minute joins the next part, or the one before it if it is the last; the 🍅 count, if you use it, goes to the task linked at the end, even when its part was too short for a line.
- **Under a minute is not a session**: a focus or break with less than a minute of active time — usually a mis-click — writes no line, adds no 🍅 and doesn't move the long-break count.
- **Reset throws the session away**: no line, no 🍅. A task you ticked off during the session (or whose note you deleted) is unlinked, as at any end. To end a session and keep what you did, use Stop or Skip.
- **A sleeping computer isn't focus** (computers only): if the computer sleeps for more than 10 minutes with the timer running, the timer pauses where it stood and tells you how long was not counted. Press Start to carry on. If the session's planned end passed during the sleep and the next session starts on its own, the session ends at its planned time and the next one starts when the computer wakes.
- **Long sessions**: when you stop a focus that ran 6 hours or more _and_ past its planned end — a timer left running overnight — you're asked whether to keep all of it or end it at the planned end. Choose 2, 4, 6 or 8 hours, or off, under **Ask about long sessions**.
- **An unfinished session is offered back**: if Obsidian quits, crashes or updates mid-session, the next start offers to log it — up to where the timer was last seen running — or discard it. A focus long enough for **Ask about long sessions** that ran past its planned end can also be logged up to its planned end. On a computer that loses at most a minute. A phone that closes Obsidian in the background ends the session at about when it was locked or left, however long it stayed away. A line that can't be written is kept on that device and written later; the notice says so.
- **Rename-safe** when tasks carry a `🆔`: past lines take the task's new name a few seconds after you stop typing, only on lines that link to that task's note, and each line keeps its own tags. **Refresh log task names by ID** catches up on renames made while the task wasn't linked; it shows examples and asks first. A change to the 🍅 count is not a rename. If you copy a task forward and tick the old copy, the timer stays with the copy still open, and the ticked copy's past lines keep their name.
- **Moving or renaming the task's note** keeps the link; deleting the note keeps the task's name in the log for the session under way, without a dead link, and then unlinks the task.
- **Sync conflicts**: Obsidian Sync merges the day's file. Other sync tools (iCloud, Dropbox, Syncthing) can leave a conflict copy when two devices write the same day; sessions in the copy don't count toward the day until you move them into the day's own file.

### 🧭 Status bar

- A small mark shows at a glance whether the timer is **idle, running, paused, or its time is up** — the end of a session is silent by design, so a glance at the corner is the gentle way to know. Beside it: Focus, Break or Long break.
- A thin **ring** around the mark fills toward today's focus goal.
- **Click it** (or right-click) for a menu: Start / Pause / Resume, Finish & next, Skip to next, Open timer, Open today's log, and which time to show.
- **Time**: hidden by default, like the timer panel's countdown. Or show minutes left (`12m`), a clock (`12:34`), or the end time (`Ends 15:30`).
- **Hover** for everything else: time left and end time, the linked task, and today's focus against your goal — with `no log folder set` beside it when nothing is being logged.
- Computers only — Obsidian has no status bar on phones and tablets.

### 🎵 Lofi study music

- Paste a YouTube link — video, 24/7 live stream (Lofi Girl!), or playlist — and a ▶️ play/pause/stop row appears in the panel. **Audio-only by design**: no video is ever shown.
- **Up to three links**, each with an optional short name. A line above the controls says what's playing; the list button opens the picker.
- **⏭ next link** carries the audio across the switch. Picking one from the list doesn't — press ▶️ to start it.
- **⏪ / ⏩** move through a playlist, on their own row that appears only when the link is genuinely a playlist.
- **Links check and name themselves**: paste one and a bad link says so, while the name box fills in from the title. Type over it any time.
- **Fades in and out** on every control — ▶️, ⏸, ⏹ and track skips all ease rather than cut. Change your mind mid-fade and it carries on.
- **Gentle ducking**: session cues briefly dip the music and ease it back up, so they stay audible without jolting the mix.
- **Loops by default** (turn off **Loop music** to play once), with a **Music sound** mute and a **Low / Mid / High** music volume in the in-view settings. The mute silences without stopping, so a live stream stays live.
- **Resumes where you left off, per link.** ⏹ **Stop** — or changing that link — makes it start from the top instead. Live streams always start live.
- Fully manual — independent of your sessions; stops when you close the panel. A notice tells you if playback stalls.
- **Desktop only.** YouTube won't load its player inside Obsidian on iOS at all (error 153) — no link works there, and nothing the plugin can set changes it. Every other feature works on mobile.

### 📱 Mobile (iPad & phone)

- Touch-friendly: bigger tap targets, one smooth-scrolling panel, and a layout that adapts to the screen — on a short/landscape phone the timer shrinks and gets out of the way.
- **Tap the timer shape** to peek at the hidden countdown — it fades back on its own after a couple of seconds. The daily-goal progress shows in the view (Obsidian hides the status bar on mobile); tap it to open today's log.
- **A locked or backgrounded phone keeps timing**: the [sleep pause](#-dataview-friendly-daily-logs) is for computers only, so a session runs on while the phone is in your pocket.
- **Sound:** press **Start** once to unlock audio, and note iOS's hardware silent switch mutes it — platform constraints, not bugs.
- **Notify when time is up** is for computers only — the mobile apps can't show system notifications, so the switch isn't shown there.
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

- **Display & behavior**: auto-open on startup.
- **Status bar** (computers only): **show in status bar**, **time in status bar** (hidden, minutes left, clock or end time — also in the status bar's own menu), and **show today's total as text** beside the goal ring.
- **Timer appearance**: **theme** (`Classic` default, `Frosted glass`, `Frosted glass 2` or `Pixel city`), **show day/night indicator**, and **estimated end time** (shown while a session runs).
- **Audio**: **timer sounds** (the master switch — it also covers the start drum and the Stop sound, and never touches the music) and the **music sound** mute. Both also live in the timer panel, and the two surfaces follow each other; the **volumes** are in the timer panel only, since a level is something you move while listening.
- **When focus ends** and **When a break ends** — the same headings as the timer panel. Each group has:
  - **Focus-end sound** / **Break-end sound** — the singing bell and the ding by default. Pick another built-in sound or your own **mp3, m4a or wav** file from the vault (up to 30 seconds); picking plays it once, and **▶** plays it again — while a sound plays, ▶ turns into **■** to stop it. Only one plays at a time: picking another sound, pressing the other row's ▶, switching **Timer sounds** off or closing the settings stops it. A file that can't be used is refused when you pick it, with the reason. If a chosen file goes missing on a device (not synced yet, deleted, renamed), the built-in sound plays and the row says why. The sound always plays when you stop or skip that session. Settings tab only.
  - **Play it when focus time is up** / **Play it when break time is up** — rings the sound once when that session's time is up, whether the timer runs into overtime or starts the next session.
  - **Auto-start the break** / **Auto-start focus**.
  - A line saying what will actually happen with the settings you have.
  - **Using your own sound:** first put the file in your vault — drag it into Obsidian's file list, or on a phone attach it to any note — then pick it from the list. Files in hidden folders such as `.obsidian` aren't listed. On your other devices it plays once the file has synced there (with Obsidian Sync, only while its **Sync audio** option is on — it is by default); until then the built-in sound plays.
- **Notifications** (computers only): **notify when time is up** — a silent system notification when focus or break time is up. Also in the timer panel.
- **Music**: **music link 1–3** (video, live stream, or playlist — audio-only playback in the timer panel), each with an optional **name** shown in the panel and filled in for you when you paste a link, **show music player** (turning it off also stops playback), **loop music** (replay from the start when it ends; on by default), and **resume where you left off** (reopen each link at the moment you paused; on by default).
- **Long break**: duration (default 15m) and **focus sessions before a long break** (default 4).
- **Daily log**:
  - **Pomodoro logs folder** — where the daily log files go. Empty (the default) keeps no log. Spaces around the name are dropped, the vault's top level (`/`) isn't accepted, and if you type an existing folder's name in other capitals, that folder is used and the row says so. Changing it leaves older logs where they are, and the row reminds you.
  - **Day starts at** — midnight (the default) to 6:00.
  - **Task switch** — **Last task gets the whole session** (the default) or **Split at the switch**.
  - **Ask about long sessions** — off, 2, 4, 6 (the default) or 8 hours.
  - Buttons: **Open today's log**, **Check log**, **Convert old log lines** and **Refresh task names** — the same as the commands (the last is `Refresh log task names by ID`).
- **Daily focus goal**: minutes (default 120, 0 turns it off) and **show a notice when you reach the goal**.
- **Task picker**: **where to find tasks** (tasks folder / current note / open notes); tasks folder path; **show task picker** (defaults to hidden until you set a tasks folder path; turning it off unlinks the current task); **task lookahead window** — how many days ahead the picker reaches (3 / 5 / 7 / 14 / 30 days; default 3), with overdue tasks always shown.
- **Task integration**: **count pomodoros on the task** (opt-in, beta — edits your task files), plus the marker recovery actions: check / repair / remove misplaced / remove all.

**In-view panel** (gear icon on the timer) — grouped into sections:

- **Timing**: focus and break durations (press Enter to apply). A session already under way keeps its length; the next one takes the new one. The long break is set in the settings tab.
- **Tasks**: **Where to find tasks** — tasks folder / current note / open notes. Hidden while **Show task picker** is off.
- **Audio**: **Timer sounds** with **Timer volume**, and **Music sound** with **Music volume** — two matched pairs. The two switches also appear in the settings tab's **Audio** group; the volumes live here only. The music pair is hidden while **Show music player** is off.
- **When focus ends** / **When a break ends**: each holds that moment's **Play a sound** and its **Auto-start** toggle, plus a line saying what will actually happen. The buttons stay explicit: **Stop** (finish & next) always switches to the next session **paused**, while **Skip** starts it (when auto-start is on).
- **Notifications** (computers only): **Notify when time is up** — the same switch as in the settings tab.
- **End-of-session sounds**: by default a session that runs out stays silent and the timer counts up — deliberately, so a chime never interrupts focus you want to keep going with. Turn on **Play a sound** under **When a break ends** or **When focus ends** to be told anyway (in the settings tab: **Play it when break time is up** / **Play it when focus time is up**). A new install starts with the break sound on and the focus one off; upgrading keeps whatever you hear today. Each applies whether the timer runs into overtime or auto-starts the next session, so auto-start can be silent too. Both sit in the timer panel and in the settings tab, and follow the master **Timer sounds** switch. Which sound plays is chosen in the settings tab, at the top of the same group.
- Full-width **Reset to defaults** button at the bottom.

Layout adapts to narrow sidebars: the timer visual stays sticky at the top, controls keep a comfortable minimum width and the panel scrolls horizontally if needed.

## Log format

Each session adds one line to the day's log file, made of Dataview fields:

```md
- 🍅 Focus [Task:: [[Projects/Docs.md|Write docs]]] [ID:: abcd12] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]
- ☕ Rest [Start:: 2026-10-02 10:25:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]
- ☕ Rest [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:15:00] [Scheduled:: 900] [Total:: 900] [Type:: long-break]
```

| Field          | What it holds                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task`         | Focus only. A link to the task's note, shown as the task's name with its tags; just the name when the task has no note; `No Task` when no task was linked. |
| `ID`           | Focus only, when the task has a `🆔`.                                                                                                                      |
| `Start`, `End` | Local time, `YYYY-MM-DD HH:mm:ss`, always with the digits 0–9 whatever language Obsidian is in.                                                            |
| `Scheduled`    | The session's length in your settings when it started, in seconds.                                                                                         |
| `Pauses`       | Focus only. The pauses, as a list of `"start - end"` text.                                                                                                 |
| `Total`        | Active seconds: `End` − `Start` − the pauses, exactly.                                                                                                     |
| `Status`       | Focus only. `finished` (Stop, or time up) or `cancelled` (Skip). Skipped focus doesn't count toward the daily goal.                                        |
| `Type`         | `focus`, `short-break` or `long-break`.                                                                                                                    |
| `Overtime`     | Focus only. Active seconds past the planned end, after any +5 or −5; 0 when the session ended on time or early.                                            |

Rest lines have no `Pauses` or `Status`: a break's pauses are taken out of its `Total`, and a skipped break is logged like a finished one.

Today's file also starts with one property, the day's goal in minutes. The timer writes it each time it logs a session, so the file holds the goal as it was at the day's last session — a change made after that is not recorded. With the goal off it adds nothing, and an earlier day's file is never changed. Properties of your own there are kept, and the goal goes in among them:

```md
---
goal_minutes: 120
---
```

The field names and their order are stable — safe to pin queries against. Dataview reads `Start` and `End` as text; use `date(Start, "yyyy-MM-dd HH:mm:ss")` when you need a date. Two examples (put your own log folder in place of `Pomodoro logs`):

````md
```dataview
TABLE WITHOUT ID L.Task AS Task, date(L.Start, "yyyy-MM-dd HH:mm:ss") AS Start, round(L.Total / 60) AS Minutes, L.Status AS Status
FROM "Pomodoro logs"
FLATTEN file.lists AS L
WHERE L.Type = "focus"
SORT L.Start DESC
LIMIT 20
```

```dataview
TABLE WITHOUT ID key AS Day, round(sum(rows.L.Total) / 60) AS "Focus minutes"
FROM "Pomodoro logs"
FLATTEN file.lists AS L
WHERE L.Type = "focus" AND L.Status != "cancelled"
GROUP BY file.day
SORT key DESC
```
````

The first lists your latest focus sessions; the second adds up each day's focus the way the daily goal does, leaving skipped sessions out.

With **Day starts at** set to a later hour, a session that starts after midnight but before that hour goes into the previous day's file. Queries and templates that look a day's file up by its calendar date will find it there.

**Changed in 0.6.9 — check your own queries.** Earlier versions wrote `- 🍅 Focus | Task:: … | Start:: … | Total:: 1500 | …`, from which Dataview reads no field at all. The field names, their order and the values are unchanged; only the brackets are new, plus `Overtime` at the end of focus lines. A pattern for a number or a fixed word, such as `Total::\s*(\d+)` or `Status::\s*cancelled`, reads both kinds of line. A pattern that ends a text value at a `|` or at the end of the line (`[^|]+`, `.*`) must also stop at `]` on the new lines: `Task::\s*(?:…|([^|]+))`, on a task with no note, takes `No Task] [Start:: …` and the rest of the line. And one that splits a line on `|`, or looks for `| Key::`, reads only the old lines. Old logs stay as they are until you run **Convert old log lines**, which rewrites them in the new form, keeping every start, end and total (it also tidies task names, tells you what before it writes, and adds no `Overtime`: only the timer knows that). Run **Check log** first to see what it would change.

## Reading your log from templates

If you write `dataviewjs` reviews, you don't need your own parser for the log. The plugin offers a small API that reads it the way the plugin does — both line formats, skipped sessions left out of the total, each day with the goal its own file recorded:

````md
```dataviewjs
const pomo = app.plugins.plugins["gentle-pomo"]?.api;
const date = dv.current().file.day?.toFormat("yyyy-MM-dd");
if (pomo && date) {
  const day = await pomo.getDay(date);
  // Days logged before 0.6.9 have no goal of their own: fall back to this note's.
  const goal = day.goalMinutes ?? (dv.current().focusgoalhours ?? 2) * 60;
  dv.paragraph(`Focus: ${Math.round(day.focusSeconds / 60)} of ${goal} minutes`);
  dv.table(
    ["Start", "Task", "Minutes", "Status"],
    day.sessions
      .filter((s) => s.kind === "focus")
      .map((s) => [s.start, s.task?.name ?? "", Math.round((s.total ?? 0) / 60), s.status])
  );
}
```
````

| Member               | What it gives                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | `1`.                                                                                                                                                                                                                                                                                                                                                |
| `dailyGoalMinutes()` | The daily focus goal setting, in minutes; `0` when it is off.                                                                                                                                                                                                                                                                                       |
| `dayStartHour()`     | **Day starts at**, `0`–`6`.                                                                                                                                                                                                                                                                                                                         |
| `logPath(date)`      | The path of that day's log file, whether or not it exists; `null` with no log folder, and for a date that isn't `YYYY-MM-DD` (it doesn't reject).                                                                                                                                                                                                   |
| `getDay(date)`       | `{ date, path, goalMinutes, focusSeconds, sessions }`. `path` is `null` when the day has no file. `goalMinutes`: the setting for today and later days; for an earlier day, the goal its file recorded, or `null` when it has none. `focusSeconds` counts as the daily goal does — skipped sessions left out, a session still running not yet in it. |
| `getDays(from, to)`  | A `getDay` for each day from `from` to `to`, both included — at most 400 days.                                                                                                                                                                                                                                                                      |

Dates are text, `YYYY-MM-DD` (from a Dataview date: `.toFormat("yyyy-MM-dd")`); anything else makes `getDay` and `getDays` reject with a message saying so. Each session is `{ kind, type, task, id, start, end, scheduled, total, overtime, pauses, status }`: `kind` is `focus` or `rest`, `task` is `{ name, path }` (focus only; `path` is the task's note, the link as written when that note is gone, `null` with no link), `start` and `end` are the text as written, the numbers are seconds, `pauses` is a list of `{ start, end }` (empty when there were none, and on Rest lines; `null` when the line's `Pauses` can't be read, such as one edited by hand — check before you use it), and any other field the line doesn't have is `null` — lines from before 0.6.9 have no `overtime`. Rest lines have no `task` or `status`.

The API only reads: it never changes a file, and what it returns is yours to change. It is versioned — `version` changes only if a member's meaning does — so a template can rely on it. It is there while the plugin is on; `?.api` gives `undefined` when it's off.

## Commands

- `Open view`
- `Start` / `Pause` / `Finish & next` / `Skip to next`
- `Open today's log` — opens it if there is one; it never creates an empty file.
- `Check log` / `Convert old log lines` — Check changes nothing; Convert asks first, with exact counts.
- `Add a session` / `Fix a logged session`
- `Refresh log task names by ID`
- `Show in status bar` / `Hide from status bar`
- `Check for misplaced pomodoro count markers` / `Repair misplaced pomodoro count markers` / `Remove misplaced pomodoro count markers` / `Remove all pomodoro count markers`

## Compatible plugins

- **[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)** — the task picker reads its emoji-marker format.
- **[Dataview](https://github.com/blacksmithgu/obsidian-dataview)** — daily log lines are made of inline fields, ready to query (see [Log format](#log-format)).

## Files the plugin reads

What the plugin reads and writes in your vault, and when:

- **Task picker** — when you open it, reads the notes that **Where to find tasks** points at: the tasks folder and its subfolders (or the whole vault if that field is empty), the current note, or your open notes; plus the note that holds your linked task.
- **Linked task** — reads that task's note to keep its name up to date and to unlink it when you tick it off; with the opt-in 🍅 counter on, edits only that task's line.
- **Daily logs** — writes one log file a day in your log folder (today's with the day's goal as a property at the top) and reads today's for the daily goal; renaming a linked task, or the `Refresh log task names by ID` command, rewrites task names inside the logs in that folder. **Check log** and **Convert old log lines** read the daily log files in that folder (Check also reads the notes their 🆔 lines link to; Convert rewrites the files that change, and moves a log file whose lines it merged into another to the trash, as your trash setting says). **Add a session** / **Fix a logged session** write only the day they are about, and their task button reads the same notes as the task picker. Before the daily-goal notice, the plugin reads its own settings file again, in case another device has shown it today. The template API reads the log files of the days a template asks for, and nothing else.
- **Kept on this device only** — the session in progress (so it can be offered back after a quit or a crash) and any log line that couldn't be written yet, in Obsidian's local storage for this vault. Not in the plugin's settings file, so none of it syncs.
- **Sound picker** — lists the vault's mp3, m4a and wav files when you open it, and reads only the file you pick.
- **🍅 Check / Repair / Remove** — scan every note, only when you press them.

Nothing here leaves your device. The only network use is YouTube, described below.

## Network use

Timers, logs, and sounds are all local (audio cues are bundled into `main.js`, or read from your own vault if you choose a file). The optional lofi-music feature is the only part that reaches the network, in two places — both only ever to YouTube, and neither happens until you paste a music link.

**Playing the audio.** With a music link set and **Show music player** on, the timer panel embeds YouTube's privacy-enhanced player from `www.youtube-nocookie.com` to stream the audio, which loads content from YouTube/Google servers. This happens only while the timer panel is open; clearing the link or turning the toggle off stops it entirely.

**Checking a link.** When you paste or edit a link in the settings, the plugin makes one small request to `www.youtube-nocookie.com/oembed` about that link, to tell you if YouTube can't find it and to offer a name for it. It is sent shortly after you stop typing, and it carries only the video or playlist ID you pasted. Unlike the player above, this happens even with the timer panel closed and **Show music player** off — those control playback, not the settings page. No request is made for an empty slot, and a link YouTube confirms is remembered for the session, so editing the same working link twice doesn't ask twice. A link it can't find is re-checked at most once a minute, in case it was only just published.

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
- **War drum** — [freesound_community](https://pixabay.com/users/freesound_community-46691455/) via [Pixabay](https://pixabay.com/sound-effects/).
- **Pixel City artwork** — drawn by this repository's own script ([art/pixel-city/](art/pixel-city/)), MIT like the rest of the plugin. Palette: [Endesga 32](https://lospec.com/palette-list/endesga-32) by Endesga.

## AI disclaimer

Parts of this plugin were developed with AI assistance (Codex, Gemini, Claude). All code reviewed and tested by the maintainer before release.

## License

[MIT](LICENSE)
