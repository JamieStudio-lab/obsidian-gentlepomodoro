<p align="center"><img src=".github/banner.png" alt="Gentle Pomodoro — Focus gently. Work deeply." width="830"></p>

A calm Pomodoro timer for Obsidian. Instead of a ticking clock, a picture changes slowly from day to night as you focus. Link a session to a task from the Tasks plugin, and keep a daily log you can read with Dataview.

> **v0.7.0 (beta).** In the Obsidian [Community Plugins catalog](https://obsidian.md/plugins?id=gentle-pomo). See [Install](#install).

## Features

### 🍅 A gentle timer

- **Four themes**:
  - **Classic**: a day → dusk → night gradient.
  - **Frosted glass**: colour orbs drifting behind a frosted pane.
  - **Frosted glass 2**: the same, drawn as glass with a lit rim.
  - **Pixel city**: a pixel-art city whose windows light up as night falls.
- A focus session runs from day to night; a break runs back toward day.
- **No ticking countdown.** The time is hidden while a session runs. Hover the timer to see it, or tap it on a phone.
- **Estimated end time** while a session runs, like `Ends 15:30`.
- **Long breaks**: a long break after every 4 focus sessions, by default. The count starts again each day.
- **Overtime**: when time is up, the timer quietly counts up with a soft glow. The session goes on until you end it, and the extra time counts as focus.
- **Stop** (Finish & next) ends the session and leaves the next one paused. **Skip** moves on, and starts the next session if auto-start is on.
- **Sounds**: a drum when focus starts, and a sound when a session ends. Pick a built-in sound or your own mp3, m4a or wav file (up to 30 seconds).
- **Quiet when focus time is up**, by default, so the timer never breaks focus you want to keep going. A new install does play a sound when a break ends. Both can be turned on or off.
- **Notify when time is up** (computers, opt-in): a silent system notification, for when other windows cover Obsidian.
- Animations soften when your system asks for reduced motion.

### ✅ Tasks

- **Turn on Show task picker** (Settings → Tasks) to pick a task in the timer panel. It is off on a new install.
- It reads the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin's format, such as `- [ ] Write docs ⏳ 2025-12-23 🆔 abc123`, on any bullet (`-`, `*`, `+` or numbered).
- **Where tasks come from**: a tasks folder (empty means the whole vault), the note you are in, or all the notes you have open.
- From a folder, the picker shows tasks with a scheduled (⏳) or due (📅) date, grouped as Overdue, Today, Tomorrow and later, up to 3–30 days ahead. Overdue tasks always show. The two note options also show tasks with no date.
- A linked task stays linked when you change where tasks come from. Ticking it off unlinks it (at the end of the session, if one is under way).
- **🍅 count** (opt-in, beta — it edits your task files): each focus session you finish adds to a `🍅 N` count on the task's line, placed before the Tasks fields so its dates keep working: `- [ ] Write docs 🍅 3 ⏳ 2025-12-23`. A `🍅` you typed in the task's own text is left alone.
- **Count tools**: versions up to 0.5.0 wrote the count after a task's dates, which broke them. **Check**, **Repair** and **Remove** find and fix those lines across the whole vault. **Remove all** takes every count out — back up first. The tools that write ask first, with exact counts.

### 📊 Daily focus goal

- A daily target, 2 hours by default (0 turns it off), counted from the daily log. Skipped focus sessions don't count.
- On a computer, a ring in the status bar fills toward the goal. On a phone or tablet, the timer panel shows `Today 1h 12m / 2h 0m`.
- A notice once a day, when a session you log reaches the goal. You can turn it off.
- With no log folder set, only the session that is running counts.
- Each day's log file records that day's goal, so a review of an old day shows the goal it had.

### 📝 Daily log

- One Markdown file per day, `<folder>/YYYY-MM-DD-gentle-pomodoro-log.md`, with a line per session. Choose the folder under **Settings → Daily log**. With no folder set, nothing is logged.
- Each line is made of Dataview fields, so Dataview can read it. See [Log format](#log-format).
- **Copy a ready-made table** into any note from **Settings → Log tables**. See [Log tables](#log-tables).
- **Export sessions** to a CSV or JSON Lines file. See [Export sessions](#export-sessions).
- **Add a session** you did away from the timer, or **fix a logged session** (its task, kind, start, length or status, or delete it), without editing the line by hand.
- **Open today's log** from the command palette, the status bar's menu or the settings. On a phone, tap today's total in the timer panel.
- **Day starts at** (midnight to 6:00), for night owls: a session that starts before that hour goes into the day before's file.
- **Task switch**: if you change task during a focus, the whole session goes to the last task. Choose **Split at the switch** to log a line for each task instead.
- Sessions under a minute aren't logged. **Reset** throws the session away; **Stop** and **Skip** end it and keep it.
- **A sleeping computer isn't focus**: if a computer sleeps for over 10 minutes while the timer runs, the timer pauses and tells you how long it left out. Press Start to carry on. A locked phone keeps timing.
- **Long sessions**: when you stop a focus with 6 hours of active time that ran past its plan, such as a timer left on overnight, you're asked whether to keep it all or end it at the planned end. Change the hours, or turn it off, under **Ask about long sessions**.
- **Nothing is lost**: if Obsidian quits or crashes mid-session, it offers to log the session the next time it starts. A line that can't be written yet is kept on the device and written later.
- **Renamed tasks**: when a task has a `🆔`, its past lines take the new name. **Refresh log task names by ID** catches up on renames made while the task wasn't linked.
- **Logs from before 0.6.9** use an older line format that Dataview can't read. **Check log** reports them, and anything else that looks wrong, without changing anything. **Convert old log lines** rewrites them in the new format after asking.
- **Sync**: Obsidian Sync merges a day's file. Other sync tools (iCloud, Dropbox, Syncthing) can leave a conflict copy when two devices write the same day. Sessions in the copy don't count until you move them into the day's own file.

### 🧭 Status bar (computers)

- A small mark shows whether the timer is idle, running, paused or out of time, next to Focus, Break or Long break. A ring around it fills toward today's goal.
- Click it for a menu: Start / Pause / Resume, Finish & next, Skip to next, Open timer, Open today's log, and which time to show.
- The time is hidden by default, like the panel's countdown. You can show minutes left, a clock or the end time. Hover for the details.

### 🎵 Lofi music

- Paste a YouTube video, live stream or playlist link, and play it from the timer panel. Audio only; no video is shown.
- Up to three links, each with an optional name, filled in from the video's title when you paste. **⏭** moves to the next link and keeps playing. **⏪ / ⏩** step through a playlist.
- Fades in and out, and dips quietly under the timer's sounds.
- Loops by default, and each link resumes where you paused it. **⏹** starts it over next time.
- Its own mute and volume, separate from the timer's. It never starts by itself, and it stops when you close the panel.
- **It doesn't play on iPhone or iPad**: YouTube won't load its player inside Obsidian there (error 153), whatever the link.
- It uses YouTube over the network; see [Network use](#network-use).

### 📱 Phones and tablets

- Larger touch targets and one scrolling panel. On a short landscape screen, the timer shrinks out of the way.
- Tap the timer to see the countdown for a couple of seconds.
- Today's goal shows in the panel; tap it to open today's log.
- Sound: press **Start** once to allow audio. On iPhone, the silent switch mutes it.
- Not on phones and tablets: the status bar, system notifications and the sleep pause. Music doesn't play on iPhone or iPad.

## Install

Needs Obsidian 1.7.2 or later.

### Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Gentle Pomodoro** and click **Install**.
3. Enable it in **Community plugins**.

Or open the [catalog page](https://obsidian.md/plugins?id=gentle-pomo).

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/releases/latest). The sounds and images are inside `main.js`.
2. Put them in `<vault>/.obsidian/plugins/gentle-pomo/`.
3. Reload Obsidian and enable the plugin in **Community plugins**.

## Configure

### Settings (Settings → Gentle Pomodoro)

On Obsidian 1.13 and later, the settings open on a list of pages, each showing its current value. Obsidian's settings search finds any setting inside them. On older versions, the same settings are on one page, in the same order.

| Page                                                | What's on it                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timer**                                           | Auto-open on startup; theme, day/night indicator and estimated end time; long break length (15 min) and focus sessions before a long break (4); daily focus goal (120 min) and its notice.                                              |
| **Status bar** (computers)                          | Show in status bar, which time it shows, and today's total as text.                                                                                                                                                                     |
| **Sounds and notifications** (**Sounds** on phones) | **Timer sounds** and **Music sound**, to mute either. For the end of focus and of a break: which sound, whether it plays when time is up, whether the next session starts by itself, and a line saying what will happen. Notifications. |
| **Music**                                           | Three links and their names, show music player, loop, resume where you left off.                                                                                                                                                        |
| **Daily log**                                       | Log folder, day starts at, task switch, ask about long sessions, this device's name. Buttons: Open today's log, Check log, Convert old log lines, Refresh task names, Export sessions.                                                  |
| **Log tables**                                      | See [Log tables](#log-tables).                                                                                                                                                                                                          |
| **Tasks**                                           | Where to find tasks, tasks folder, show task picker, how many days ahead; the 🍅 count and its tools.                                                                                                                                   |

A warning sign on **Music** means a link that isn't a YouTube link. On **Daily log**, it means a folder the log's tools can't use, such as the vault's top level.

Good to know:

- **Timer sounds** covers every timer sound, the start drum and the end sound included, but not the music.
- **Your own sound**: first put the file in your vault, then pick it. On your other devices it plays once the file has synced (with Obsidian Sync, **Sync audio** is on by default); until then the built-in sound plays.
- **This device's name** is kept on this device only, never synced. Lines this device logs carry it as `Device`, to tell your devices apart. See [Privacy](#privacy).
- **Log folder**: changing it leaves your older logs where they are.

### Timer panel (gear icon on the timer)

Focus and break lengths (press Enter to apply; a session under way keeps its length), where to find tasks, **Timer sounds** and **Music sound** with their volumes, and for the end of focus and of a break a sound switch and auto-start. On computers, also notifications. **Reset to defaults** at the bottom resets these.

The volumes are only here. The switches are in the settings too, and the two stay in step.

## Log format

Each session adds a line to the day's log file (a line per task with **Split at the switch**; none for a session under a minute):

```md
- 🍅 Focus [Task:: [[Projects/Docs.md|Write docs]]] [ID:: abcd12] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0] [Session:: s7k2m9qx4w] [StartedBy:: start] [EndedBy:: time-up] [Planned:: 1500] [Cycle:: 2] [Offset:: -300]
- ☕ Rest [Start:: 2026-10-02 10:25:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break] [Session:: s3d9w6hq2e] [StartedBy:: auto] [EndedBy:: stop] [Planned:: 300] [Offset:: -300]
- ☕ Rest [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:15:00] [Scheduled:: 900] [Total:: 900] [Type:: long-break] [Session:: s5h2x8kv0b] [StartedBy:: auto] [EndedBy:: time-up] [Planned:: 900] [Offset:: -300]
```

| Field          | What it holds                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `Task`         | Focus only. A link to the task's note, shown with the task's name and tags; `No Task` when none was linked.   |
| `ID`           | Focus only, when the task has a `🆔`.                                                                         |
| `Start`, `End` | Local time, `YYYY-MM-DD HH:mm:ss`, always with the digits 0–9.                                                |
| `Scheduled`    | The session length in your settings when it started, in seconds.                                              |
| `Pauses`       | Focus only. A list of `"start - end"` pauses.                                                                 |
| `Total`        | Active seconds: `End` − `Start` − the pauses.                                                                 |
| `Status`       | Focus only. `finished` (Stop, or time up) or `cancelled` (Skip). Skipped focus doesn't count toward the goal. |
| `Type`         | `focus`, `short-break` or `long-break`.                                                                       |
| `Overtime`     | Focus only. Active seconds past the planned end; 0 when it ended on time or early.                            |

Rest lines have no `Pauses` or `Status`.

**Added in 0.7.0**, at the end of each line the timer writes. Some only when they apply:

| Field          | What it holds                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Session`      | An ID for the session, like `s7k2m9qx4w`. The lines of a session split at a task switch share it.                     |
| `StartedBy`    | `start` (you pressed Start), `auto` (it began by itself), `reset` (after Reset) or `added` (**Add a session**).       |
| `EndedBy`      | `time-up`, `stop`, `planned-end`, `skip`, `recovered`, `recovered-planned-end` (logged at the next start) or `added`. |
| `Planned`      | The timer's planned length when it ended, in seconds, including any +5 or −5.                                         |
| `Cycle`        | Focus only: 1 up to **Focus sessions before a long break**. Only on a focus that counted (time up or Stop).           |
| `Offset`       | Minutes east of UTC when it began: `-300` is UTC−5.                                                                   |
| `OffsetChange` | Minutes the clocks moved during the session. Only when a clock change happened.                                       |
| `Slept`        | Computers only. About how many seconds the computer slept while the timer ran (an estimate). Only when above 0.       |
| `Dropped`      | Seconds left out when a session was ended at its planned end. Only when above 0.                                      |
| `Device`       | This device's name, when you've set one.                                                                              |

- A line without `Session` is older: from before 0.7.0, converted, or written by a device still on 0.6.9. The new fields are unknown on it, not 0, and nothing adds them later.
- **Add a session** writes these too, with `added` for how it began and ended. It has no `Cycle`, `Slept`, `Dropped` or `Device`.
- **Fix a logged session** keeps them, but removes `Slept`, `Dropped` or `Cycle` when the change makes them untrue.

### Privacy

`Offset` shows your time zone, and `Device` names a machine. If you publish your log folder, they go with it. Leave **This device's name** empty to write no `Device`.

### The day's goal

Today's log file starts with the day's goal, in minutes:

```md
---
goal_minutes: 120
---
```

The timer keeps it up to date during the day. A past day keeps the goal it ended with. With the goal off, it's taken out. Your own properties in the file are kept.

### Queries

Field names and their order are stable, so queries can rely on them; new fields are only added at the end. Dataview reads `Start` and `End` as text; use `date(s.Start, "yyyy-MM-dd HH:mm:ss")` for a date. Two examples — put your log folder in place of `Your log folder`, or use the **Copy** buttons under **Log tables**, which fill it in:

````md
```dataview
TABLE WITHOUT ID s.Task AS Task, s.Start AS Start, round(s.Total / 60) AS Minutes, s.Status AS Status
FROM "Your log folder"
FLATTEN file.lists AS s
WHERE file.day AND endswith(file.name, "-gentle-pomodoro-log") AND (s.Type = "focus" OR (s.Type = null AND s.Start != null AND s.Total != null AND startswith(s.text, "🍅 Focus [")))
SORT s.Start DESC
LIMIT 20
```

```dataview
TABLE WITHOUT ID key AS Day, round(sum(rows.s.Total) / 60) AS "Focus minutes"
FROM "Your log folder"
FLATTEN file.lists AS s
WHERE file.day AND endswith(file.name, "-gentle-pomodoro-log") AND (s.Type = "focus" OR (s.Type = null AND s.Start != null AND s.Total != null AND startswith(s.text, "🍅 Focus ["))) AND s.Status != "cancelled"
GROUP BY file.day
SORT key DESC
```
````

The first lists your latest focus sessions. The second adds up each day's focus as the daily goal does, once old lines are converted. Tips for writing your own:

- Keep `file.day AND endswith(file.name, "-gentle-pomodoro-log")`, so other notes in the folder aren't counted.
- The `s.Type = null …` part takes in focus lines from logs older than the `Type` field.
- Field names are case-sensitive: `s.Total`, not `s.total`.
- Dataview silently drops a row when a cell fails. For a field older lines don't have, write `choice(s.Planned != null, round(default(s.Planned, 0) / 60), null)` rather than `round(s.Planned / 60)`.
- With **Day starts at** set, a session just after midnight is in the previous day's file.

### If you have your own queries or scripts

- **0.7.0** made lines longer, and `Overtime` is no longer the last field. A pattern anchored on the end, like `\[Overtime:: \d+\]$`, stops matching; read the field by name instead (`Overtime::\s*(\d+)`). Update every device that logs: a device still on 0.6.9 writes lines without the new fields.
- **0.6.9** put each field in brackets. Before, lines looked like `- 🍅 Focus | Task:: … | Total:: 1500 | …`, and Dataview couldn't read them. A pattern for a number or a word, like `Total::\s*(\d+)`, reads both. One that ends a value at `|` or the end of the line must now also stop at `]`. Old lines stay as they are until you run **Convert old log lines**.

## Log tables

**Settings → Log tables** gives you a table of your sessions to paste into any note. The **Copy** buttons copy ordinary [Dataview](https://github.com/blacksmithgu/obsidian-dataview) code with your log folder filled in. Dataview draws it, and you can change it as you like.

- **Columns**: the columns in the table, in order. **↑ / ↓** move a column, **✕** removes it, and the buttons under **Add a column** add one at the end. **Simple** (Date, Start, Task, Minutes, Status — the default) and **Detailed** (adds End, Planned, Overtime, Pauses and Ended by) are starting points.
- **Days**: this note's day (for a daily note), today, the last 7 days (default), the last 30 days, or all days.
- **Sessions**: focus only (default), or focus and breaks.
- **Include skipped focus**: on by default. Daily totals and time by task always leave it out, as the goal does.
- **Order**: newest or oldest first.
- **Show the code**: a preview of the sessions table.
- **Copy sessions table**, **Copy sessions table for DataviewJS** (needs Dataview's JavaScript queries setting), **Copy daily totals** and **Copy time by task**.

A copy is a snapshot: change the settings and copy again. Older lines show `-` for fields they don't have. With no log folder set there's nothing to copy, and a notice says so. If the clipboard is blocked, the code opens in a window to copy by hand.

## Export sessions

**Settings → Daily log → Export sessions**, or the command `Export sessions`, saves your sessions to a new file for a spreadsheet or a script. Choose:

- **Days**: the last 7 or 30 days, this or last month, this year, everything, or your own dates (`YYYY-MM-DD`).
- **Sessions**: focus and breaks, or focus only.
- **Format**: CSV (for spreadsheets) or JSON Lines (for scripts).
- **Folder**: `Pomodoro exports` by default. The dialog tells you if a folder can't be used, such as the vault's top level, a hidden folder, or a name some systems refuse.

Your last format and folder are remembered. The file is named like `gentle-pomodoro-sessions-2026-09-23-to-2026-10-22-091500.csv`. Each export makes a new file (adding ` 2`, ` 3`… if the name is taken), never overwrites one, and never changes your log. It reads the file back and warns you if a sync changed it.

- **CSV** has a header row and opens in Excel with accents intact. The columns, in order: `date`, `kind`, `type`, `start`, `end`, `startIso`, `endIso`, `task`, `taskPath`, `id`, `scheduled`, `planned`, `total`, `overtime`, `pauseCount`, `pausedSeconds`, `status`, `sessionId`, `startedBy`, `endedBy`, `cycle`, `offset`, `endOffset`, `slept`, `dropped`, `device`, `logFile`. New columns are only added at the end.
- **JSON Lines** has one object per line, with the same fields, except `task` is `{ name, path }` and `pauses` is a list of `{ start, end }`.
- `date` is the log's day, as **Day starts at** counts it. `startIso` and `endIso` add the time zone.
- An empty cell (`null` in JSON) means the line doesn't have that value, as on older lines.
- A text cell that starts like a formula (`=`, `+`, `-`, `@`) gets a `'` in front, so a spreadsheet doesn't run it.

To see the file in Obsidian, turn on **Show all file types** (Settings → Files and links). To sync it with Obsidian Sync, turn on **Sync all other types**.

## Reading your log from templates

For `dataviewjs` reviews, the plugin offers a small read-only API, so you don't need your own parser:

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

| Member               | What it gives                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | `1`.                                                                                                                                                                                                            |
| `dailyGoalMinutes()` | The daily goal setting in minutes; `0` when off.                                                                                                                                                                |
| `dayStartHour()`     | **Day starts at**, `0`–`6`.                                                                                                                                                                                     |
| `logPath(date)`      | The path of that day's log file, whether or not it exists; `null` with no log folder or a bad date.                                                                                                             |
| `getDay(date)`       | `{ date, path, goalMinutes, focusSeconds, sessions }`. `goalMinutes` is the setting for today and later, and for an earlier day the goal its file recorded (or `null`). `focusSeconds` counts as the goal does. |
| `getDays(from, to)`  | A `getDay` for each day from `from` to `to`, both included, up to 400 days.                                                                                                                                     |

- Dates are `YYYY-MM-DD` text. A bad date or range makes `getDay` and `getDays` reject.
- Each session has `kind` (`focus` or `rest`), `type`, `task` (`{ name, path }`), `id`, `start`, `end`, `scheduled`, `total`, `overtime`, `pauses` (a list of `{ start, end }`) and `status`. Times are the text as written; numbers are seconds. A field the line doesn't have is `null`.
- Lines from 0.7.0 on also have `sessionId`, `startedBy`, `endedBy`, `planned`, `cycle`, `offset`, `endOffset` (the offset when it ended), `slept`, `dropped` and `device`, from the fields under [Log format](#log-format). On older lines they're all `null`.
- The API only reads. It's there while the plugin is on (`?.api` is `undefined` when it's off), and its members keep their meaning while `version` stays the same.

## Commands

- `Open view`
- `Start` / `Pause` / `Finish & next` / `Skip to next`
- `Open today's log` — never creates an empty file.
- `Check log` / `Convert old log lines` — Check changes nothing; Convert asks first, with exact counts.
- `Add a session` / `Fix a logged session`
- `Export sessions`
- `Refresh log task names by ID`
- `Show in status bar` / `Hide from status bar`
- `Check for misplaced pomodoro count markers` / `Repair misplaced pomodoro count markers` / `Remove misplaced pomodoro count markers` / `Remove all pomodoro count markers`

## Compatible plugins

- **[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)**: the task picker reads its format.
- **[Dataview](https://github.com/blacksmithgu/obsidian-dataview)**: reads the daily log; the **Log tables** buttons give code for it.

## Files the plugin reads and writes

- **Task picker**: when you open it, reads the notes **Where to find tasks** points at, and the linked task's note.
- **Linked task**: reads its note to keep its name current and to see when you tick it off. With the 🍅 count on, it edits only that task's line.
- **Daily log**: writes one file a day in your log folder, with the day's goal at the top, and reads today's for the goal. When a task with a `🆔` is renamed, its past lines in that folder take the new name.
- **Log tools**: **Check log** only reads. **Convert old log lines** rewrites the files it changes; a day's file named in other digits (Obsidian in Arabic, Persian, Bengali or Nepali) is renamed, or merged into the 0–9 file and moved to the trash. **Add a session** and **Fix a logged session** write only the day they're about.
- **Old log lines notice**: once, after updating from 0.6.8 or earlier, reads the log files to see whether any old lines remain. It writes nothing.
- **Log tables**: read only the plugin's settings and your folder names, and write nothing; the code goes to the clipboard.
- **Export sessions**: reads the days you ask for and creates one new file (and its folder, if needed).
- **Kept on this device only**, never synced: the session in progress, log lines not yet written, a goal change not yet written, and this device's name.
- **Sounds**: the sound picker lists the vault's audio files. The file you choose is read at each start, and again when it changes.
- **🍅 count tools**: scan every note, only when you press them.

Nothing here leaves your device. The only network use is YouTube, below.

## Network use

Timers, logs and sounds are all local. The optional lofi music is the only part that uses the network, only to YouTube, and only after you paste a music link.

**Playing the audio.** With a music link set and **Show music player** on, the timer panel embeds YouTube's privacy-enhanced player from `www.youtube-nocookie.com`, which loads content from YouTube/Google servers. This happens only while the timer panel is open. Clearing the link or turning the player off stops it.

**Checking a link.** When you paste or edit a link in the settings, the plugin sends one small request to `www.youtube-nocookie.com/oembed`, shortly after you stop typing, with only the video or playlist ID. It tells you if YouTube can't find the link and suggests a name. This happens even with the timer panel closed and the player off. Nothing is sent for an empty slot, a link YouTube confirms isn't checked again in the same session, and a link it can't find is checked again at most once a minute.

YouTube's handling of both is covered by [Google's privacy policy](https://policies.google.com/privacy).

## Issues & feedback

Found a bug or have an idea? Please open an issue on the [GitHub issue tracker](https://github.com/JamieStudio-lab/obsidian-gentlepomodoro/issues).

## Development

```bash
npm install
npm run dev          # rollup --watch (rebuilds main.js)
npm run build        # one-shot production build
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run lint
npm run format       # prettier --write .
```

CI runs typecheck, lint, format check, tests and build on pushes and pull requests to `main`. A release tag publishes `main.js`, `manifest.json` and `styles.css` to GitHub Releases.

## Credits

- **Ding sound** — [Universfield](https://pixabay.com/users/universfield-28281460/) via [Pixabay](https://pixabay.com/sound-effects/).
- **Bell sounds** — [freesound_community](https://pixabay.com/users/freesound_community-46691455/) via [Pixabay](https://pixabay.com/sound-effects/).
- **War drum** — [freesound_community](https://pixabay.com/users/freesound_community-46691455/) via [Pixabay](https://pixabay.com/sound-effects/).
- **Pixel City artwork** — drawn by this repository's own script ([art/pixel-city/](art/pixel-city/)), MIT like the rest of the plugin. Palette: [Endesga 32](https://lospec.com/palette-list/endesga-32) by Endesga.

## AI disclaimer

Parts of this plugin were developed with AI assistance (Codex, Gemini, Claude). All code reviewed and tested by the maintainer before release.

## License

[MIT](LICENSE)
