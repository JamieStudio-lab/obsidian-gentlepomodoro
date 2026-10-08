import type { GentlePomoSettings } from "./types";
import type { MusicResumeState } from "./youtubeMusic";
import { DEFAULT_THEME } from "./themes";

// Central home for shared, static values so they aren't duplicated as magic strings/numbers.
export const VIEW_TYPE_GENTLE_POMO = "gentle-pomo-view";
export const NO_TASK_LABEL = "No Task";
export const ONE_MINUTE_MS = 60_000;

// A session shorter than this — active time, as its line's Total would say —
// is not a session (0.6.9, F59): no line, no 🍅, no step of the long-break
// count. Stop, Skip and the zero crossing alike; almost always a mis-click or
// a test, and the reviews counted every one of them.
export const MIN_SESSION_SECONDS = 60;

// A gap this long between two ticks of a running timer means the computer was
// asleep (0.6.9, F48): the timer pauses as it stood at the last tick and the
// gap is logged as a pause. Desktop only — a phone suspends a backgrounded app
// as a matter of course, and its sessions must survive that. Far above the
// once-a-minute tick Chromium allows a covered window, which must never count.
export const SLEEP_GAP_MS = 10 * ONE_MINUTE_MS;

// How long after the last rename of a linked task its past log lines are
// rewritten (0.6.9, F26). Obsidian saves a note every 2 s while it is typed
// in; each save renamed the whole history, half-typed names included.
export const TASK_RENAME_DELAY_MS = 3000;

// How long after the last change of the daily goal setting today's log file
// is given the new goal (0.6.9). Settings on Obsidian before 1.13 commit every
// keystroke, so typing 120 sets 1, then 12, then 120: one write, of 120.
export const LOG_GOAL_WRITE_DELAY_MS = 1500;

// How long the one-time notice about old log lines stays up (0.6.9,
// logFormatNotice.ts). Longer than Obsidian's default: it names a setting and
// two buttons to find, and it never comes back.
export const LOG_FORMAT_NOTICE_MS = 15_000;

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

// How long a read of today's log may take before it counts as failed (0.6.9,
// C4). A read that never settles — an iCloud placeholder, a stuck read on a
// phone — otherwise held the tracker's in-flight guard for good, and the
// meter and the goal notice stopped until Obsidian restarted.
export const FOCUS_TOTAL_READ_TIMEOUT_MS = 10_000;

// How often a running session is saved on this device, so a quit, a crash or
// an iOS background kill can offer it back (0.6.9, F23). A recovered session
// ends where it was last seen, so a quit or a crash on a computer loses at
// most this. A phone that suspends Obsidian in the background runs no timer,
// so its saves stop when the app is left and the session ends at about then,
// however long the phone stayed away.
export const OPEN_SESSION_SAVE_MS = 60_000;

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
  statusBarTime: "hidden",
  statusBarShowTotal: false,
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
  // Today's sounds, so the Object.assign merge gives an upgrading user exactly
  // what they heard before. Kept in step with DEFAULT_END_CUE in timerCues.ts.
  focusEndSound: "bell",
  breakEndSound: "ding",
  // Off for everyone, new installs included: an interruption at the end of a
  // session is something to ask for, never something to find turned on.
  sessionEndNotification: false,
  tasksPath: "",
  logFolderPath: "",
  // Midnight, so an upgrading user's days and file names do not move.
  dayStartHour: 0,
  // What every earlier version did, so no upgrader's lines change.
  taskSwitchLogging: "last-task",
  longSessionPromptHours: 6,
  showTaskSelector: true,
  // "folder" reproduces every pre-0.6.4 picker exactly, which is what this
  // object owes an upgrading user (see GentlePomoSettings.taskSource).
  taskSource: "folder",
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
  musicSoundEnabled: true,
  musicVolume: 0.7,
  musicLoop: true,
  musicResume: true,
  lastGoalHitDate: null,
  sessionsSinceLongBreak: 0,
  sessionCounterDate: null,
  // Never looked at as it stands: loadSettings derives it once when data.json
  // has none (deriveLogFormatNotice) — true, an upgrade, a damaged data.json,
  // a first install or a reinstall over old logs alike. false here so that
  // nothing that falls back to this object ever starts a scan.
  logFormatNoticePending: false,
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
