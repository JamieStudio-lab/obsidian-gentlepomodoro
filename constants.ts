import type { GentlePomoSettings } from "./types";

// Central home for shared, static values so they aren't duplicated as magic strings/numbers.
export const VIEW_TYPE_GENTLE_POMO = "gentle-pomo-view";
export const NO_TASK_LABEL = "No Task";
export const ONE_MINUTE_MS = 60_000;

// Cache TTL for "today's total focus seconds" — read by both the status bar
// refresh loop in main.ts and the public method on LogManager.
export const FOCUS_TOTAL_CACHE_TTL_MS = 30_000;

// Default settings used on first load or when a setting is missing.
export const DEFAULT_SETTINGS: GentlePomoSettings = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStartBreak: false,
  autoStartFocus: false,
  autoOpenOnStartup: true,
  showInStatusBar: true,
  showStatusBarTimeLeft: false,
  showDayNightIndicator: true,
  theme: "classic",
  soundEnabled: true,
  soundVolume: 0.7,
  tasksPath: "",
  logFolderPath: "",
  dailyFocusGoalMinutes: 120,
  goalNoticeEnabled: true,
  incrementPomodoroCountOnFinish: false,
  lastGoalHitDate: null,
  sessionsSinceLongBreak: 0,
  sessionCounterDate: null,
};
