import type { GentlePomoSettings } from "./types";

// Central home for shared, static values so they aren't duplicated as magic strings/numbers.
export const VIEW_TYPE_GENTLE_POMO = "gentle-pomo-view";
export const NO_TASK_LABEL = "No Task";
export const ONE_MINUTE_MS = 60_000;

// How long the tapped-to-peek countdown stays revealed on touch before auto-hiding.
export const PEEK_REVEAL_MS = 2000;

// Cache TTL for "today's total focus seconds" — read by both the status bar
// refresh loop in main.ts and the public method on LogManager.
export const FOCUS_TOTAL_CACHE_TTL_MS = 30_000;

// Delay between the music iframe's load event and the "listening" handshake.
// The embed isn't ready to register listeners the instant it loads (Vidstack
// ships the same ~100ms wait).
export const MUSIC_LISTENING_DELAY_MS = 100;

// Music ducking: while a sound cue plays, the lofi music dips to
// MUSIC_DUCK_FACTOR × the user's volume (multiplicative, so "Low" never jumps
// louder), then eases back. The embed's setVolume has no native fade, so both
// ramps are stepped — one post per MUSIC_DUCK_STEP_MS.
export const MUSIC_DUCK_FACTOR = 0.35;
export const MUSIC_DUCK_DOWN_MS = 240;
export const MUSIC_DUCK_UP_MS = 800;
export const MUSIC_DUCK_STEP_MS = 60;

// How long an ENDED player state must persist before the "music ended" Notice
// fires. Playlist auto-advance and loop restarts pass through ENDED and resume
// within ~a second — only a lone, lasting ENDED (finished video with loop off,
// or a live stream going offline) should surface to the user.
export const MUSIC_ENDED_NOTICE_DELAY_MS = 3000;

// How long a BUFFERING player state must persist before the "music is
// buffering" Notice fires (normal track starts and brief rebuffers stay well
// under this), and the minimum gap between such notices — a flapping
// connection stalls repeatedly and must not turn the panel into a nag.
export const MUSIC_STALL_NOTICE_DELAY_MS = 10_000;
export const MUSIC_STALL_RENOTIFY_MS = 300_000;

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
  showEndTime: true,
  theme: "classic",
  soundEnabled: true,
  soundVolume: 0.7,
  tasksPath: "",
  logFolderPath: "",
  showTaskSelector: true,
  taskSelectorDays: 3,
  dailyFocusGoalMinutes: 120,
  goalNoticeEnabled: true,
  incrementPomodoroCountOnFinish: false,
  musicUrl: "",
  showMusicPlayer: true,
  musicVolume: 0.7,
  musicLoop: true,
  lastGoalHitDate: null,
  sessionsSinceLongBreak: 0,
  sessionCounterDate: null,
};
