// Two timer phases used throughout the plugin.
export type PomoMode = "focus" | "break";

// User-configurable settings stored by the plugin.
export interface GentlePomoSettings {
  focusMinutes: number;
  breakMinutes: number;
  autoStartBreak: boolean;
  autoStartFocus: boolean;
  autoOpenOnStartup: boolean;
  showInStatusBar: boolean;
  showStatusBarTimeLeft: boolean;
  showDayNightIndicator: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  tasksPath: string;
  logFolderPath: string;
}

// Runtime snapshot of the timer used by the UI.
export interface TimerState {
  mode: PomoMode;
  isRunning: boolean;
  remainingMs: number;
  totalMs: number;
  taskName: string;
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
