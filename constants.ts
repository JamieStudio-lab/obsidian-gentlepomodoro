import type { GentlePomoSettings } from "./types";

// Central home for shared, static values so they aren't duplicated as magic strings/numbers.
export const VIEW_TYPE_GENTLE_POMO = "gentle-pomo-view";
export const NO_TASK_LABEL = "No Task";
export const ONE_MINUTE_MS = 60_000;

// Default settings used on first load or when a setting is missing.
export const DEFAULT_SETTINGS: GentlePomoSettings = {
  focusMinutes: 25,
  breakMinutes: 5,
  autoStartBreak: false,
  autoStartFocus: false,
  autoOpenOnStartup: true,
  showInStatusBar: true,
  showStatusBarTimeLeft: false,
  showDayNightIndicator: true,
  soundEnabled: true,
  soundVolume: 0.7,
  tasksPath: "",
  logFolderPath: "",
};
