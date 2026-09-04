import type { GentlePomoSettings } from "./types";
import type { MusicResumeState } from "./youtubeMusic";
import { DEFAULT_THEME } from "./themes";

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

// The handshake is fire-and-forget: post it before the embed has installed its
// own message listener and it is simply lost, after which the player never
// streams an event and the panel reports "the music player hasn't loaded" for
// as long as it stays open. 100ms after `load` is ample on desktop and a guess
// everywhere else — a slower device, a cold cache or a heavy stream can boot
// well past it — so it is re-sent on this cadence until the player answers.
// Retries stop on the first message from the embed, so a healthy player costs
// exactly one extra timer that never fires.
export const MUSIC_HANDSHAKE_RETRY_MS = 600;
export const MUSIC_HANDSHAKE_MAX_ATTEMPTS = 8;

// Music ducking: while a sound cue plays, the lofi music dips to
// MUSIC_DUCK_FACTOR × the user's volume (multiplicative, so "Low" never jumps
// louder), then eases back. The embed's setVolume has no native fade, so both
// ramps are stepped — one post per MUSIC_DUCK_STEP_MS.
export const MUSIC_DUCK_FACTOR = 0.35;
export const MUSIC_DUCK_DOWN_MS = 240;
export const MUSIC_DUCK_UP_MS = 800;
export const MUSIC_DUCK_STEP_MS = 60;

// Music fades: ▶️ play eases the volume up from silence, ⏸ pause and ⏹ stop ease
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

// After a manual ⏩ advance, hold the "the music ended" notice for a moment. At
// the last item of a non-looping playlist the advance simply ends playback, and
// that notice blames a live stream going offline and asks for a new link —
// nonsense in answer to a button the user just pressed. Mid-playlist advances
// are already covered by the notice's own disarm on the next PLAYING/BUFFERING.
export const MUSIC_ADVANCE_NOTICE_GRACE_MS = 4000;

// How long the caption's station/track names dip out for before the new ones
// come back. Half the visible handover, since the rise mirrors the dip. Kept
// well under the "Music"/"Now playing" fade beside it: those two words are a
// mode you glance at, while a name is something you are reading, and holding it
// blank for a full second to be gentle just reads as a stall. The matching CSS
// duration is --gp-name-fade in styles.css; keep the two in step.
export const CAPTION_NAME_FADE_MS = 280;

// How long a BUFFERING player state must persist before the "music is
// buffering" Notice fires (normal track starts and brief rebuffers stay well
// under this), and the minimum gap between such notices — a flapping
// connection stalls repeatedly and must not turn the panel into a nag.
export const MUSIC_STALL_NOTICE_DELAY_MS = 10_000;
export const MUSIC_STALL_RENOTIFY_MS = 300_000;

// A failed settings write is reported at most this often. The pre-1.13 settings
// path commits on every keystroke, so a vault that cannot be written would
// otherwise queue one Notice per character typed into a text field.
export const SETTINGS_SAVE_RENOTIFY_MS = 60_000;

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
  theme: DEFAULT_THEME,
  soundEnabled: true,
  soundVolume: 0.7,
  // Both false here on purpose: DEFAULT_SETTINGS is the Object.assign merge
  // base in loadSettings(), so whatever sits here is what an UPGRADING user
  // silently inherits — and an upgrade must not start making a sound the
  // plugin has never made. loadSettings() flips breakEndSoundEnabled on for a
  // fresh install only (read.kind === "fresh") and persists it once.
  focusEndSoundEnabled: false,
  breakEndSoundEnabled: false,
  tasksPath: "",
  logFolderPath: "",
  showTaskSelector: true,
  taskSelectorDays: 3,
  dailyFocusGoalMinutes: 120,
  goalNoticeEnabled: true,
  incrementPomodoroCountOnFinish: false,
  musicUrl: "",
  musicUrl2: "",
  musicUrl3: "",
  musicName1: "",
  musicName2: "",
  musicName3: "",
  musicStationIndex: 0,
  showMusicPlayer: true,
  musicVolume: 0.7,
  musicLoop: true,
  musicResume: true,
  lastGoalHitDate: null,
  sessionsSinceLongBreak: 0,
  sessionCounterDate: null,
  // Frozen: the shallow Object.assign in loadSettings copies this REFERENCE, so
  // an in-place push here would corrupt the default for the life of the process
  // (and leak between vitest cases that spread DEFAULT_SETTINGS). Freezing turns
  // that silent corruption into an immediate TypeError. loadSettings always
  // replaces it with a fresh array.
  musicPositions: Object.freeze([]) as unknown as MusicResumeState[],
  lastMusicVideoId: null,
  lastMusicPlaylistId: null,
  lastMusicSeconds: 0,
  lastMusicUrl: null,
};
