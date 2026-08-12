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
  // Show the projected wall-clock end time on the timer while a session runs.
  showEndTime: boolean;

  // Appearance
  theme: "classic" | "frosted-glass";

  // Audio
  soundEnabled: boolean;
  soundVolume: number;

  // Paths
  tasksPath: string;
  logFolderPath: string;

  // Show the task picker (button + dropdown) in the timer panel.
  showTaskSelector: boolean;

  // How many days ahead the task selector shows scheduled/due tasks.
  // Overdue tasks always appear regardless of this window.
  taskSelectorDays: number;

  // Daily focus goal (set to 0 to disable)
  dailyFocusGoalMinutes: number;
  goalNoticeEnabled: boolean;

  // Pomodoro-per-task tracking (opt-in)
  incrementPomodoroCountOnFinish: boolean;

  // Music (audio-only lofi playback via a hidden YouTube embed in the timer panel)
  musicUrl: string; // user-pasted YouTube URL; "" = feature unset
  showMusicPlayer: boolean; // feature switch: off hides the controls and stops playback
  musicVolume: number; // 0-1, mapped ×100 for the embed's setVolume
  musicLoop: boolean; // replay the video/playlist when it ends (no effect on live streams)
  musicResume: boolean; // reopen the music where it was paused/left off

  // Internal state (not user-editable; persisted to data.json across reloads)
  lastGoalHitDate: string | null;
  sessionsSinceLongBreak: number;
  sessionCounterDate: string | null;
  // Remembered music position (see musicResume). Cleared by ⏹ Stop and when a
  // track finishes; keyed by video so a new URL never inherits an old offset.
  lastMusicVideoId: string | null;
  lastMusicPlaylistId: string | null;
  lastMusicSeconds: number;
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
