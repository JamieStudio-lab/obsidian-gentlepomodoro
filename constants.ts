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

// Idle heartbeat for the focus-total display. The engine only emits while
// running or on user actions, so without this an app left open across local
// midnight keeps yesterday's "Today X / Y" on screen until the first
// interaction of the new day. Quiet beats are two compares (TTL + date stamp).
export const FOCUS_TOTAL_HEARTBEAT_MS = 60_000;

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

// Music fades: ♪ play eases the volume up from silence, ⏸ pause and ⏹ stop ease
// it down to silence *before* the pause/stop command is posted (posting it
// first would cut the audio dead, which is the jolt the fade exists to remove).
// The out-fade therefore delays the actual pause, so it is the shorter of the
// two — long enough to smooth the edge, short enough that the button still
// feels immediate. (The duck's ramps are asymmetric too, but for its own
// reason: its down-ramp is a race to get under the cue's attack, and it delays
// nothing.) The curve is eased rather than linear — see buildFadeRamp in
// youtubeMusic.ts. The step interval is shorter than the duck's, which is what
// keeps a fade covering the whole volume range from stepping much more coarsely
// than the duck's short dip does.
export const MUSIC_FADE_IN_MS = 800;
export const MUSIC_FADE_OUT_MS = 450;
export const MUSIC_FADE_STEP_MS = 50;

// A fade-in waits for playback to actually start before it runs, which means it
// waits on the embed. If the embed never starts — iOS refusing a first play
// without an in-iframe tap, a dropped command, a dead video — the wait must not
// be forever: the player would sit silently at volume 0. After this long the
// fade stands down and the user's volume goes back on (inaudible while nothing
// is playing, and it puts the volume control back in charge).
export const MUSIC_FADE_ARM_TIMEOUT_MS = 5000;

// A fade-in only advances while audio is actually flowing, so a mid-fade
// rebuffer stretches it rather than being spent on silence — the resume seek
// from 0.5.3 rebuffers on exactly this boundary. Bounded so a player that never
// comes back can't leave the ramp parked half-way up.
export const MUSIC_FADE_HOLD_MAX_MS = 3000;

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

// How often a changed music position is written to data.json while playback
// runs. The embed reports its clock ~4Hz, so the position is tracked in memory
// and only *persisted* on boundaries (pause, stop, track end, panel close,
// plugin unload) — this interval is the crash/force-quit safety net, and it
// writes nothing when the position hasn't moved since the last save. Keeping it
// slow matters: data.json lives in the vault, so every write is sync traffic.
export const MUSIC_POSITION_SAVE_MS = 60_000;

// How far below a posted resume seek the reported clock may be and still count
// as "the seek landed". The embed keeps reporting the pre-seek position for a
// beat after the command, and those readings must not overwrite the position
// being resumed to.
export const RESUME_SEEK_LANDING_TOLERANCE_S = 5;

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
  musicResume: true,
  lastGoalHitDate: null,
  sessionsSinceLongBreak: 0,
  sessionCounterDate: null,
  lastMusicVideoId: null,
  lastMusicPlaylistId: null,
  lastMusicSeconds: 0,
  lastMusicUrl: null,
};
