# Gentle Pomodoro Plugin -- Pomodoro Logs

## Plugin overview

This project is about creating a gentle pomodoro plugin for the Obsidian. Read the main.ts, manifest.json, and the styles.css for more information. 

## Data storage

In Obsidian plugin settings, you can add a folder path (e.g., "/Pomodoro_logs") in your obsidian vault for storing pomodoro logs of the gentle pomodoro plugin. Ensure the code checks if the folder exists first. If the user sets a path `/Pomodoro_logs` but hasn't created the folder, the plugin should create it recursively before trying to write the file. 

The plugin automatically generates daily log markdown files in this folder path titled "YYYY-MM-DD-gentle-pomodoro-log" to keep track of all focus and rest sessions started today (00:00:00-23:59:59). Log the sessions in the file corresponding to the Start Time. 

## Data type 

The gentle pomodoro logs are recorded using a format compatible with Dataview (inline fields) for each type of data in the markdown file that generated under the selected folder path for logs. For example: 

```md
- 🍅 Focus | Task:: [[Path/To/File.md|Task Name #tag]] | Start:: 2025-12-21 14:00:00 | End:: 2025-12-21 14:25:00 | Scheduled:: 1500 | Pauses:: ["2025-12-21 14:10:00 - 2025-12-21 14:12:00"] | Total:: 1500 | Status:: finished
- ☕ Rest | Start:: 2025-12-21 14:25:00 | End:: 2025-12-21 14:30:00 | Scheduled:: 300 | Total:: 300
```

The log entry should be generated and appended to the file only after the session concludes (via Stop or Reset).

### Focus session data

Focus session data starts to be recorded when users click the start button in stop status for focus mode. 

- TTask name: WikiLink `[[File Path|Task Name]]`; linked to the "Tasks" plugin source file.   
    - Task names follow the selected task from the "current task list" on the plugin UI. If no task is selected, log as `Task:: No Task`.
    - Task names will be updated when the timer is running or paused. 
- Scheduled focus time: int; seconds. 
- Focus start time: str; YYYY-MM-DD HH:mm:ss; record when users click the start button in stop status for focus mode.
- Focus end time: str; YYYY-MM-DD HH:mm:ss; record when users click the stop, reset, or skip button in start status for focus mode.
- Pause session: use inline JSON fields like `pauses:: ["2025-12-21 14:10:00 - 2025-12-21 14:12:00", "..."]`, lists. 
    - Pauses start time: str; YYYY-MM-DD HH:mm:ss; record when users click the pause button in start status; for focus mode only.
    - Pause end time: str; YYYY-MM-DD HH:mm:ss; record when users click the start button in pause status; for focus mode only.
- Task total focus time: int; seconds; calculation by "focus end time - focus start time - sum(pause end time - pauses start time)" 
- Focus status: str; "finished" (timer completed or running overtime after clicking the stop button) or "cancelled" (stopped early, resetted, or skipped).

### Rest session data

- Scheduled rest time: int; seconds. 
- Rest start time: str; YYYY-MM-DD HH:mm:ss; record when users click the start button in stop status for rest mode.
- Rest end time: str; YYYY-MM-DD HH:mm:ss; record when users click the stop or skip button in start status for rest mode. 
- Total rest time: int; seconds; calculation by "rest end time - rest start time". 
