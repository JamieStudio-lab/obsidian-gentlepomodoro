import { App, PluginSettingTab, Setting } from "obsidian";
import type GentlePomoPlugin from "./main";
import { NO_TASK_LABEL, VIEW_TYPE_GENTLE_POMO } from "./constants";

export class GentlePomoSettingTab extends PluginSettingTab {
  plugin: GentlePomoPlugin;

  constructor(app: App, plugin: GentlePomoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const applySettingsToOpenViews = () => {
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
    };

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

    new Setting(containerEl).setName("Task integration").setHeading();

    new Setting(containerEl)
      .setName("Increment task pomodoro count on finish")
      .setDesc(
        "When a focus session linked to a task ends, append or update a 'pomodoro count' marker on the task line. Counts the lifetime total of focus sessions spent on each task."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.incrementPomodoroCountOnFinish)
          .onChange(async (value) => {
            this.plugin.settings.incrementPomodoroCountOnFinish = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
