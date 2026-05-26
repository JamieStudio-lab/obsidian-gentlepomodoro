// Two timer phases used throughout the plugin.
export type PomoMode = "focus" | "break";

// User-configurable settings stored by the plugin. The internal state fields
// at the bottom are persisted to data.json alongside settings but are not
// exposed in the settings UI — they track per-day counters.
export interface GentlePomoSettings {
  // Timer durations
  focusMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;

  // Behavior
  autoStartBreak: boolean;
  autoStartFocus: boolean;
  autoOpenOnStartup: boolean;

  // Status bar / display
  showInStatusBar: boolean;
  showStatusBarTimeLeft: boolean;
  showDayNightIndicator: boolean;

  // Appearance
  theme: "classic" | "frosted-glass";

  // Audio
  soundEnabled: boolean;
  soundVolume: number;

  // Paths
  tasksPath: string;
  logFolderPath: string;

  // Daily focus goal (set to 0 to disable)
  dailyFocusGoalMinutes: number;
  goalNoticeEnabled: boolean;

  // Pomodoro-per-task tracking (opt-in)
  incrementPomodoroCountOnFinish: boolean;

  // Internal state (not user-editable; persisted to data.json across reloads)
  lastGoalHitDate: string | null;
  sessionsSinceLongBreak: number;
  sessionCounterDate: string | null;
}

// Runtime snapshot of the timer used by the UI.
export interface TimerState {
  mode: PomoMode;
  isRunning: boolean;
  remainingMs: number;
  totalMs: number;
  taskName: string;
  // null when mode is "focus"; otherwise indicates short vs long break.
  breakType: "short" | "long" | null;
}

// Listener signature for timer state updates.
export type TimerListener = (state: TimerState) => void;

// Parsed task entry pulled from markdown files.
export interface TaskItem {
  text: string;
  cleanText: string;
  displayText: string;
  status: string;
  path: string;
  scheduled: string | null;
  due: string | null;
  effectiveDateStr: string; // Date string used for sorting/grouping (scheduled or due).
  taskId?: string; // optional Tasks plugin ID
}
