import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { markDestructive } from "./confirmModal";
import type GentlePomoPlugin from "./main";
import { NO_TASK_LABEL, VIEW_TYPE_GENTLE_POMO } from "./constants";
import type { GentlePomoSettings } from "./types";
import { validateMusicUrl } from "./youtubeMusic";

type SettingsKey = keyof GentlePomoSettings;

// Shared between the declarative (1.13+) and imperative (pre-1.13) paths so
// the two can't drift.
const POMO_COUNT_TOGGLE_DESC =
  "Beta — edits your task files. Adds a lifetime '🍅 N' marker to the task line each time a linked focus session ends.";
const CHECK_MARKERS_NAME = "Check for misplaced pomodoro count markers";
const CHECK_MARKERS_DESC =
  "Counts markers misplaced by versions before 0.5.1, changing nothing. Affected files are listed in the developer console.";
const REPAIR_MARKERS_NAME = "Repair misplaced pomodoro count markers";
const REPAIR_MARKERS_DESC =
  "Moves misplaced markers back in front of the Tasks fields, keeping their counts. Asks for confirmation first.";
const REMOVE_MARKERS_NAME = "Remove misplaced pomodoro count markers";
const REMOVE_MARKERS_DESC =
  "Deletes misplaced markers instead, losing their counts. Asks for confirmation first.";
const REMOVE_ALL_MARKERS_NAME = "Remove all pomodoro count markers";
const REMOVE_ALL_MARKERS_DESC =
  "Risky — deletes every 🍅 marker the counter has written, losing all counts, and cannot be undone. Back up your vault first. Asks for confirmation.";

export class GentlePomoSettingTab extends PluginSettingTab {
  plugin: GentlePomoPlugin;

  constructor(app: App, plugin: GentlePomoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private applySettingsToOpenViews(): void {
    const hasApplySettings = (view: unknown): view is { applySettings: () => void } => {
      if (!view || typeof view !== "object") return false;
      return (
        "applySettings" in view &&
        typeof (view as { applySettings?: unknown }).applySettings === "function"
      );
    };

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO);
    for (const leaf of leaves) {
      const view: unknown = leaf.view;
      if (hasApplySettings(view)) view.applySettings();
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
    return [
      {
        type: "group",
        heading: "Display & behavior",
        items: [
          {
            name: "Pomodoro logs folder",
            desc: "Folder to store daily log files (e.g., 'pomodoro_logs').",
            control: { type: "text", key: "logFolderPath", placeholder: "Example: pomodoro_logs" },
          },
          {
            name: "Auto-open on startup",
            desc: "Open the view in the right panel when Obsidian starts.",
            control: { type: "toggle", key: "autoOpenOnStartup" },
          },
          {
            name: "Show status bar",
            desc: "Show the status bar indicator.",
            control: { type: "toggle", key: "showInStatusBar" },
          },
        ],
      },
      {
        type: "group",
        heading: "Timer appearance",
        items: [
          {
            name: "Theme",
            desc: "Visual style for the timer.",
            control: {
              type: "dropdown",
              key: "theme",
              options: { classic: "Classic", "frosted-glass": "Frosted glass" },
            },
          },
          {
            name: "Day/night indicator",
            desc: "Show a subtle sun/moon indicator above the timer.",
            control: { type: "toggle", key: "showDayNightIndicator" },
          },
          {
            name: "Show estimated end time",
            desc: "Show the projected finish time on the timer while a session is running.",
            control: { type: "toggle", key: "showEndTime" },
          },
        ],
      },
      {
        type: "group",
        heading: "Music",
        items: [
          {
            name: "YouTube music URL",
            desc: "Paste a YouTube video, live stream, or playlist link. Audio plays in the timer panel — the video is never shown.",
            control: {
              type: "text",
              key: "musicUrl",
              placeholder: "Paste a YouTube link",
              validate: (value) => validateMusicUrl(String(value ?? "")),
            },
          },
          {
            name: "Show music player",
            desc: "Show the music controls in the timer panel. Turning this off also stops playback.",
            control: { type: "toggle", key: "showMusicPlayer" },
          },
          {
            name: "Loop music",
            desc: "Replay the video or playlist from the start when it ends. Live streams aren't affected. Changing this reloads the player.",
            control: { type: "toggle", key: "musicLoop" },
          },
        ],
      },
      {
        type: "group",
        heading: "Long break",
        items: [
          {
            name: "Long break duration (minutes)",
            desc: "Length of the long break that replaces a regular break.",
            control: { type: "number", key: "longBreakMinutes", min: 1 },
          },
          {
            name: "Long break frequency",
            desc: "Number of focus sessions before each long break (classic technique uses 4).",
            control: { type: "number", key: "longBreakEvery", min: 1 },
          },
        ],
      },
      {
        type: "group",
        heading: "Daily focus goal",
        items: [
          {
            name: "Daily focus goal (minutes)",
            desc: "Set to 0 to disable. The status bar shows today's progress against this goal.",
            control: { type: "number", key: "dailyFocusGoalMinutes", min: 0 },
          },
          {
            name: "Goal-hit notice",
            desc: "Show a one-time notice when today's focus first crosses the daily goal.",
            control: { type: "toggle", key: "goalNoticeEnabled" },
          },
        ],
      },
      {
        type: "group",
        heading: "Task selector",
        items: [
          {
            name: "Tasks folder path",
            desc: "Folder to search for tasks (e.g., 'daily notes'). Leave empty to search the entire vault.",
            control: { type: "text", key: "tasksPath", placeholder: "Example: projects/active" },
          },
          {
            name: "Show task selector",
            desc: "Show the task picker in the timer panel. Turning this off unlinks the current task.",
            control: { type: "toggle", key: "showTaskSelector" },
          },
          {
            name: "Task lookahead window",
            desc: "How many days ahead the task selector shows scheduled/due tasks. Overdue tasks always appear.",
            control: {
              type: "dropdown",
              key: "taskSelectorDays",
              options: {
                "3": "3 Days",
                "5": "5 Days",
                "7": "7 Days",
                "14": "14 Days",
                "30": "30 Days",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Task integration",
        items: [
          {
            name: "Increment task pomodoro count on finish",
            desc: POMO_COUNT_TOGGLE_DESC,
            control: { type: "toggle", key: "incrementPomodoroCountOnFinish" },
          },
          {
            name: CHECK_MARKERS_NAME,
            desc: CHECK_MARKERS_DESC,
            action: () => {
              void this.plugin.checkPomodoroMarkers();
            },
          },
          {
            name: REPAIR_MARKERS_NAME,
            desc: REPAIR_MARKERS_DESC,
            action: () => {
              void this.plugin.repairPomodoroMarkers();
            },
          },
          {
            name: REMOVE_MARKERS_NAME,
            desc: REMOVE_MARKERS_DESC,
            action: () => {
              void this.plugin.removeMisplacedPomodoroMarkers();
            },
          },
          {
            name: REMOVE_ALL_MARKERS_NAME,
            desc: REMOVE_ALL_MARKERS_DESC,
            action: () => {
              void this.plugin.removeAllPomodoroMarkers();
            },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    // The lookahead dropdown persists a number but renders string option keys.
    if (key === "taskSelectorDays") return this.plugin.settings.taskSelectorDays.toString();
    return this.plugin.settings[key as SettingsKey];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key as SettingsKey) {
      case "tasksPath":
        settings.tasksPath = String(value);
        break;
      case "showTaskSelector": {
        const show = Boolean(value);
        settings.showTaskSelector = show;
        await this.plugin.saveSettings();
        if (!show && this.plugin.timer.currentTaskName !== NO_TASK_LABEL) {
          this.plugin.timer.setTask(NO_TASK_LABEL);
        }
        this.applySettingsToOpenViews();
        return;
      }
      case "taskSelectorDays": {
        const n = parseInt(String(value), 10);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.taskSelectorDays = n;
        break;
      }
      case "logFolderPath":
        settings.logFolderPath = String(value);
        break;
      case "autoOpenOnStartup":
        settings.autoOpenOnStartup = Boolean(value);
        break;
      case "showInStatusBar":
        await this.plugin.setStatusBarVisibility(Boolean(value));
        return;
      case "showDayNightIndicator":
        settings.showDayNightIndicator = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "showEndTime":
        settings.showEndTime = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "musicUrl":
        // Invalid URLs never reach here on 1.13+ — the control's validate hook
        // rejects them inline. The view rebuilds its iframe via applySettings.
        settings.musicUrl = String(value).trim();
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "showMusicPlayer":
        // The view-side reconciliation removes the iframe when this goes off —
        // that removal is what stops playback (no timer/engine side effect).
        settings.showMusicPlayer = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "musicLoop":
        // Loop is baked into the embed URL, so the view rebuilds the iframe
        // (stopping any current playback) when this flips.
        settings.musicLoop = Boolean(value);
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "theme":
        settings.theme = value === "frosted-glass" ? "frosted-glass" : "classic";
        await this.plugin.saveSettings();
        this.applySettingsToOpenViews();
        return;
      case "longBreakMinutes": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.longBreakMinutes = Math.floor(n);
        break;
      }
      case "longBreakEvery": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) return;
        settings.longBreakEvery = Math.floor(n);
        break;
      }
      case "dailyFocusGoalMinutes": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return;
        settings.dailyFocusGoalMinutes = Math.floor(n);
        break;
      }
      case "goalNoticeEnabled":
        settings.goalNoticeEnabled = Boolean(value);
        break;
      case "incrementPomodoroCountOnFinish":
        settings.incrementPomodoroCountOnFinish = Boolean(value);
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
  }

  // Fallback for Obsidian < 1.13.0 (minAppVersion is below that). Never called
  // on 1.13+, where the tab renders declaratively from getSettingDefinitions()
  // — keep both paths in sync when adding or changing a setting.
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const applySettingsToOpenViews = () => this.applySettingsToOpenViews();

    new Setting(containerEl).setName("Display & behavior").setHeading();

    new Setting(containerEl)
      .setName("Pomodoro logs folder")
      .setDesc("Folder to store daily log files (e.g., 'pomodoro_logs').")
      .addText((text) =>
        text
          .setPlaceholder("Example: pomodoro_logs")
          .setValue(this.plugin.settings.logFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.logFolderPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open on startup")
      .setDesc("Open the view in the right panel when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpenOnStartup).onChange(async (value) => {
          this.plugin.settings.autoOpenOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Show the status bar indicator.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showInStatusBar).onChange(async (value) => {
          await this.plugin.setStatusBarVisibility(value);
        })
      );

    new Setting(containerEl).setName("Timer appearance").setHeading();

    new Setting(containerEl)
      .setName("Theme")
      .setDesc("Visual style for the timer.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("classic", "Classic")
          .addOption("frosted-glass", "Frosted glass")
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as "classic" | "frosted-glass";
            await this.plugin.saveSettings();
            applySettingsToOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Day/night indicator")
      .setDesc("Show a subtle sun/moon indicator above the timer.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showDayNightIndicator).onChange(async (value) => {
          this.plugin.settings.showDayNightIndicator = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Show estimated end time")
      .setDesc("Show the projected finish time on the timer while a session is running.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEndTime).onChange(async (value) => {
          this.plugin.settings.showEndTime = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl).setName("Music").setHeading();

    new Setting(containerEl)
      .setName("YouTube music URL")
      .setDesc(
        "Paste a YouTube video, live stream, or playlist link. Audio plays in the timer panel — the video is never shown."
      )
      .addText((text) =>
        text
          .setPlaceholder("Paste a YouTube link")
          .setValue(this.plugin.settings.musicUrl)
          .onChange(async (value) => {
            // No validate hook pre-1.13 — an unparsable URL simply hides the
            // music section view-side (parseYouTubeUrl returns null).
            this.plugin.settings.musicUrl = value.trim();
            await this.plugin.saveSettings();
            applySettingsToOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("Show music player")
      .setDesc("Show the music controls in the timer panel. Turning this off also stops playback.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showMusicPlayer).onChange(async (value) => {
          this.plugin.settings.showMusicPlayer = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Loop music")
      .setDesc(
        "Replay the video or playlist from the start when it ends. Live streams aren't affected. Changing this reloads the player."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.musicLoop).onChange(async (value) => {
          this.plugin.settings.musicLoop = value;
          await this.plugin.saveSettings();
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl).setName("Long break").setHeading();

    new Setting(containerEl)
      .setName("Long break duration (minutes)")
      .setDesc("Length of the long break that replaces a regular break.")
      .addText((text) =>
        text.setValue(this.plugin.settings.longBreakMinutes.toString()).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.longBreakMinutes = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Long break frequency")
      .setDesc("Number of focus sessions before each long break (classic technique uses 4).")
      .addText((text) =>
        text.setValue(this.plugin.settings.longBreakEvery.toString()).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n) && n >= 1) {
            this.plugin.settings.longBreakEvery = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl).setName("Daily focus goal").setHeading();

    new Setting(containerEl)
      .setName("Daily focus goal (minutes)")
      .setDesc("Set to 0 to disable. The status bar shows today's progress against this goal.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.dailyFocusGoalMinutes.toString())
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n >= 0) {
              this.plugin.settings.dailyFocusGoalMinutes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Goal-hit notice")
      .setDesc("Show a one-time notice when today's focus first crosses the daily goal.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.goalNoticeEnabled).onChange(async (value) => {
          this.plugin.settings.goalNoticeEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Task selector").setHeading();

    new Setting(containerEl)
      .setName("Tasks folder path")
      .setDesc(
        "Folder to search for tasks (e.g., 'daily notes'). Leave empty to search the entire vault."
      )
      .addText((text) =>
        text
          .setPlaceholder("Example: projects/active")
          .setValue(this.plugin.settings.tasksPath)
          .onChange(async (value) => {
            this.plugin.settings.tasksPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show task selector")
      .setDesc(
        "Show the task picker in the timer panel. Turning this off unlinks the current task."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showTaskSelector).onChange(async (value) => {
          this.plugin.settings.showTaskSelector = value;
          await this.plugin.saveSettings();
          if (!value && this.plugin.timer.currentTaskName !== NO_TASK_LABEL) {
            this.plugin.timer.setTask(NO_TASK_LABEL);
          }
          applySettingsToOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Task lookahead window")
      .setDesc(
        "How many days ahead the task selector shows scheduled/due tasks. Overdue tasks always appear."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("3", "3 Days")
          .addOption("5", "5 Days")
          .addOption("7", "7 Days")
          .addOption("14", "14 Days")
          .addOption("30", "30 Days")
          .setValue(this.plugin.settings.taskSelectorDays.toString())
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.taskSelectorDays = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl).setName("Task integration").setHeading();

    new Setting(containerEl)
      .setName("Increment task pomodoro count on finish")
      .setDesc(POMO_COUNT_TOGGLE_DESC)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.incrementPomodoroCountOnFinish)
          .onChange(async (value) => {
            this.plugin.settings.incrementPomodoroCountOnFinish = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(CHECK_MARKERS_NAME)
      .setDesc(CHECK_MARKERS_DESC)
      .addButton((btn) =>
        btn.setButtonText("Check").onClick(() => {
          void this.plugin.checkPomodoroMarkers();
        })
      );

    new Setting(containerEl)
      .setName(REPAIR_MARKERS_NAME)
      .setDesc(REPAIR_MARKERS_DESC)
      .addButton((btn) =>
        btn.setButtonText("Repair").onClick(() => {
          void this.plugin.repairPomodoroMarkers();
        })
      );

    new Setting(containerEl)
      .setName(REMOVE_MARKERS_NAME)
      .setDesc(REMOVE_MARKERS_DESC)
      .addButton((btn) => {
        btn.setButtonText("Remove").onClick(() => {
          void this.plugin.removeMisplacedPomodoroMarkers();
        });
        markDestructive(btn);
      });

    new Setting(containerEl)
      .setName(REMOVE_ALL_MARKERS_NAME)
      .setDesc(REMOVE_ALL_MARKERS_DESC)
      .addButton((btn) => {
        btn.setButtonText("Remove all").onClick(() => {
          void this.plugin.removeAllPomodoroMarkers();
        });
        markDestructive(btn);
      });
  }
}
