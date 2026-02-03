import { App, PluginSettingTab, Setting } from "obsidian";
import type GentlePomoPlugin from "./main";
import { VIEW_TYPE_GENTLE_POMO } from "./constants";

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

    new Setting(containerEl)
      .setName("Tasks folder path")
      .setDesc("Folder to search for tasks (e.g., 'daily notes'). Leave empty to search the entire vault.")
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
  }
}
