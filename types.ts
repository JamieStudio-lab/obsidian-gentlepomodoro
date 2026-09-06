import type { MusicResumeState } from "./youtubeMusic";
import type { PomoTheme } from "./themes";
import type { TaskSource } from "./taskScope";

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
  theme: PomoTheme;

  // Audio
  soundEnabled: boolean;
  soundVolume: number;
  // Opt-in end-of-session chimes for the overtime path (the matching auto-start
  // toggle off). Both default to false in DEFAULT_SETTINGS because that object
  // is also the merge base for an UPGRADING user, who must stay exactly as
  // quiet as they were; loadSettings() turns breakEndSoundEnabled on for a
  // fresh install only. Focus→break stays off even for new users — that is the
  // edge where a chime would interrupt a session someone wants to keep going.
  focusEndSoundEnabled: boolean;
  breakEndSoundEnabled: boolean;

  // Paths
  tasksPath: string;
  logFolderPath: string;

  // Show the task picker (button + dropdown) in the timer panel.
  showTaskSelector: boolean;

  // Which notes the picker reads: the tasks folder above, the note you are in,
  // or every note open in the main area. Defaults to "folder" in
  // DEFAULT_SETTINGS because that object is the merge base for an UPGRADING
  // user, whose picker must not change under them (GitHub issue #4).
  taskSource: TaskSource;

  // How many days ahead the task selector shows scheduled/due tasks.
  // Overdue tasks always appear regardless of this window.
  taskSelectorDays: number;

  // Daily focus goal (set to 0 to disable)
  dailyFocusGoalMinutes: number;
  goalNoticeEnabled: boolean;

  // Pomodoro-per-task tracking (opt-in)
  incrementPomodoroCountOnFinish: boolean;

  // Music (audio-only lofi playback via a hidden YouTube embed in the timer panel)
  //
  // Three fixed station slots. `musicUrl` is slot 1 and keeps its exact
  // pre-0.5.7 meaning, so an upgrade needs no URL migration and a rollback to
  // 0.5.6 still finds a usable link. "" = that slot is unused; pasting into an
  // empty slot adds a station, clearing one removes it. Fixed arity rather than
  // an array on purpose: DEFAULT_SETTINGS is merged shallowly (main.ts
  // loadSettings), so a mutable array default would be shared by reference, and
  // positional slots have no index-shift-on-delete to get wrong.
  musicUrl: string; // station 1 — user-pasted YouTube URL; "" = empty slot
  musicUrl2: string; // station 2
  musicUrl3: string; // station 3
  // Display names for the panel's station buttons. Blank falls back to the slot
  // number, so a name is never required. Display-only: a name must never reach
  // the embed key or a stored position, or renaming would restart the music.
  musicName1: string;
  musicName2: string;
  musicName3: string;
  // Which slot plays. Persisted like any user preference, but mutated from the
  // panel rather than the settings tab. Never trusted as read: resolveStationIndex
  // maps it to a slot that actually holds a URL.
  musicStationIndex: number;
  showMusicPlayer: boolean; // feature switch: off hides the controls and stops playback
  /**
   * The music's mute, kept separate from `musicVolume` so the level survives it.
   * Storing a mute as `musicVolume: 0` cannot work: the panel's segmented row
   * picks the NEAREST option, so 0 paints "Low" as active while the player is
   * silent, and the next click on any segment destroys the mute.
   */
  musicSoundEnabled: boolean;
  musicVolume: number; // 0-1, mapped ×100 for the embed's setVolume
  musicLoop: boolean; // replay the video/playlist when it ends (no effect on live streams)
  musicResume: boolean; // reopen the music where it was paused/left off

  // Internal state (not user-editable; persisted to data.json across reloads)
  lastGoalHitDate: string | null;
  sessionsSinceLongBreak: number;
  sessionCounterDate: string | null;
  // Remembered music positions (see musicResume), one per station URL. Keyed by
  // the `url` stamp each entry carries — the music-URL setting string it was
  // recorded under — so a position follows its link across slots and is dropped
  // when no slot holds that link any more. At most one entry per slot.
  //
  // Always REPLACED, never mutated in place at the array level: the shallow
  // DEFAULT_SETTINGS merge would otherwise let a push corrupt the module default.
  musicPositions: MusicResumeState[];
  // Legacy single-slot position written by <= 0.5.6. Migrated once into
  // musicPositions on first load and never read again; kept in data.json so a
  // rollback to 0.5.6 still resumes. Not marked @deprecated on purpose — that
  // rule is error-level here and would flag the migration that must read them.
  lastMusicVideoId: string | null;
  lastMusicPlaylistId: string | null;
  lastMusicSeconds: number;
  lastMusicUrl: string | null;
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
  // Date used for sorting and grouping (scheduled, else due). NULL for a task
  // carrying neither, which only the note scopes admit — the folder scope
  // still requires a date, so this is never null for an upgrading user's list.
  // Every reader must branch on it BEFORE building a moment: `moment(null)` is
  // invalid but `moment(undefined)` is *now*, so one careless read files every
  // undated task under "Today".
  effectiveDateStr: string | null;
  taskId?: string; // optional Tasks plugin ID
  // True only for the linked task when the current scope would NOT have shown
  // it — the picker lifts those into their own group so changing the scope can
  // never look as though the link was dropped.
  pinned?: boolean;
}
