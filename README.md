# Gentle Pomodoro for Obsidian

A visually soothing, task-integrated Pomodoro timer for Obsidian. 

This plugin is designed to help you maintain focus while keeping track of your work directly within your vault. It features a gentle, ambient visual timer that transitions from day to night, integrates with your daily tasks, and automatically logs your sessions for review.

## Features

### 🍅 Visual Timer
*   **Ambient Visuals:** Instead of a ticking clock, a soothing shape gently pulses and transitions colors (Day → Dusk → Night) as time progresses.
*   **Focus & Rest Modes:** Customizable durations for work and breaks.
*   **Overtime Tracking:** The timer counts up after the session ends, glowing gently to let you know you're in overtime without breaking your flow.

### ✅ Task Integration
*   **Seamless Workflow:** Select tasks directly from your Markdown files (compatible with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin format).
*   **Smart Filtering:** Automatically finds tasks scheduled for Today, Tomorrow, or Overdue.
*   **Context:** Links your focus session to the specific file where the task lives.

### 📊 Automated Logging
*   **Daily Logs:** Automatically generates a daily log file (e.g., `2025-12-23-gentle-pomodoro-log.md`).
*   **Dataview Compatible:** Logs are written in a format easily queried by the Dataview plugin.
*   **Detailed Metrics:** Tracks start/end times, pauses, actual duration vs. scheduled duration, and links back to the specific task file.

## Installation

1.  Clone this repository into your vault's plugin folder: `vault/.obsidian/plugins/obsidian-gentlepomodoro`.
2.  Run `npm i` or `yarn` to install dependencies.
3.  Run `npm run build` to compile the plugin.
4.  Reload Obsidian and enable "Gentle Pomodoro" in Community Plugins.

## Usage

### 1. The Timer View
Open the timer by clicking the **Clock Icon** in the ribbon or running the command `Gentle Pomodoro: Open view`.

### 2. Selecting a Task
Click the **"Select a task..."** button at the bottom of the timer view. The plugin scans your vault (or a specific folder you configure) for tasks formatted like this:

```markdown
- [ ] My important task ⏳ 2025-12-23
```

*Clicking a task links your current timer session to that specific item.*

### 3. Logging
Once a session finishes (or is cancelled), a log entry is appended to your daily log file.

**Example Log Output:** 

```md
- 🍅 Focus | Task:: [[Projects/MyProject.md|Write Documentation #docs]] | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | Scheduled:: 1500 | Total:: 1500 | Status:: finished
- ☕ Rest | Start:: 2025-12-23 10:25:00 | End:: 2025-12-23 10:30:00 | Scheduled:: 300 | Total:: 300
```

## Configuration

Go to Settings > Gentle Pomodoro to configure:

- Focus/Break Duration: Set your preferred minutes. 
- Tasks Folder Path: Limit task search to a specific folder (e.g., Daily Notes or Projects).
- Pomodoro Logs Folder: Choose where to save the daily log files (e.g., `Pomodoro_logs`).
- Sound: Toggle the notification chime. 

## Development

This project uses TypeScript.

1. `npm install` to install dependencies.
2. `npm run dev` to start compilation in watch mode.

## License

MIT
