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
    containerEl.createEl("h2", { text: "Gentle Pomodoro Settings" });

    const applySettingsToOpenViews = () => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO);
      for (const leaf of leaves) {
        (leaf.view as any)?.applySettings?.();
      }
    };

    new Setting(containerEl)
      .setName("Tasks Folder Path")
      .setDesc("Folder to search for tasks (e.g., 'Daily Notes'). Leave empty to search entire vault.")
      .addText((text) =>
        text
          .setPlaceholder("Example: Projects/Active")
          .setValue(this.plugin.settings.tasksPath)
          .onChange(async (value) => {
            this.plugin.settings.tasksPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pomodoro Logs Folder")
      .setDesc("Folder to store daily log files (e.g., 'Pomodoro_logs').")
      .addText((text) =>
        text
          .setPlaceholder("Example: Pomodoro_logs")
          .setValue(this.plugin.settings.logFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.logFolderPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open on startup")
      .setDesc("Open the Gentle Pomodoro view in the right panel when Obsidian starts.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpenOnStartup).onChange(async (value) => {
          this.plugin.settings.autoOpenOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Show the Gentle Pomodoro status bar indicator.")
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
