import { Platform, TAbstractFile, TFile } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { PomoMode, TimerListener, TimerState } from "./types";
import type { MomentFactory } from "./momentTypes";
import type { SessionEnd } from "./logManager";
import { NO_TASK_LABEL, ONE_MINUTE_MS, SLEEP_GAP_MS } from "./constants";
import { logger } from "./logger";
import { logicalDate } from "./logLine";
import {
  isLongSession,
  plannedSessionEnd,
  type LongSessionAnswer,
  type LongSessionQuestion,
} from "./sessionGaps";
import {
  TASK_LINE_REGEX,
  findIdTaskLine,
  idTaskDone,
  incrementPomodoroCount,
  isPathGone,
  linkedLineIndex,
  pathAfterMove,
  taskCreatedDate,
  taskIdOf,
  taskNameAfterEdit,
  taskLineKey,
  taskMatchKey,
} from "./taskLoader";
import { AUDIO_URLS } from "./audioAssets";
import {
  CUE_SETTING_KEY,
  checkCueDuration,
  checkCueFileSize,
  resolveCue,
  type CueEdge,
  type CueProblem,
  type ResolvedCue,
} from "./timerCues";

declare const moment: MomentFactory;

/** The settings that hold a session's length — see durationSetting(). */
export type DurationSetting = "focusMinutes" | "breakMinutes" | "longBreakMinutes";

/** How loading one of the user's sound files ended. */
export type CueLoad = { ok: true; buffer: AudioBuffer } | { ok: false; problem: CueProblem };

/** One decoded (or failed) version of a user's sound file. */
interface CustomCueEntry {
  /** The file's mtime and size when it was read — an edit makes a new version. */
  version: string;
  /** When the read began, so a read that never finishes can be retried. */
  startedAt: number;
  result: Promise<CueLoad>;
  /** Filled in when `result` lands; a cue only ever plays a settled entry. */
  settled: CueLoad | null;
}

const fileVersion = (file: TFile): string => `${String(file.stat.mtime)}|${String(file.stat.size)}`;

const END_CUE_EDGES: readonly CueEdge[] = ["focus", "break"];

// How long a file read may stay unfinished before the next caller starts a
// fresh one instead of joining it. A read of a 2 MB file takes well under a
// second; one still going after this is an iCloud download that stalled, and
// joining it would leave a later pick of that file doing nothing at all.
const CUE_LOAD_STALE_MS = 15_000;

// How long a stopped preview takes to fall silent. Stopping a sound dead
// mid-waveform clicks; this is short enough to read as "stopped at once".
const PREVIEW_STOP_FADE_S = 0.08;

/** The settings tab's preview while it plays: the one sound that can be stopped. */
interface PlayingPreview {
  edge: CueEdge;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** A linked task, as one vault round trip saw it when it started. */
interface TaskLink {
  name: string;
  path: string | undefined;
  id: string | undefined;
  /** The line's raw text after the checkbox (TimerEngine.currentTaskLineText). */
  lineText: string;
}

export class TimerEngine {
  private state: TimerState;
  private intervalId: number | null = null;
  private listeners: Set<TimerListener> = new Set();
  private plugin: GentlePomoPlugin;

  // Single shared AudioContext, created lazily. Reusing one persistent context
  // avoids the per-call `new AudioContext()` footgun: a context created off a
  // user gesture (e.g. a timer-triggered completion sound) can start in the
  // `suspended` state, and an un-retained context/source can be GC'd before
  // playback finishes. A live shared context keeps its active sources alive.
  private audioCtx: AudioContext | null = null;

  // Decoded audio cache keyed by filename — decode each bundled asset once and
  // reuse its (immutable) AudioBuffer via a fresh BufferSource per play.
  private audioBuffers: Map<string, AudioBuffer> = new Map();

  // The user's own end-of-session sounds (0.6.7), keyed by vault path. Kept
  // apart from audioBuffers so a vault file can never share a slot with a
  // bundled one. Holds the two chosen files, plus any file still being
  // checked or one checked since the last pick — see evictCustomCues. A
  // failure that comes from the file itself (too large, too long, not
  // decodable) is cached too, under the same version, so a file that cannot
  // play is not read again on every cue; a failed READ is not (loadCustomCue).
  private customCues: Map<string, CustomCueEntry> = new Map();

  // The settings tab's preview (0.6.7) — the ONE sound the plugin can stop.
  // Real cues stay fire-and-forget on purpose (two may overlap, as they always
  // have); a preview is something the user starts, and a 30-second file they
  // cannot stop, or that plays on under the next one they try, is a bug.
  // `previewToken` is bumped by every stop and every new preview, so one still
  // loading its file never starts after it was stopped or replaced.
  private preview: PlayingPreview | null = null;
  private previewToken = 0;
  private previewListener: (() => void) | null = null;
  // When the last REAL cue still ringing ends, so a stopped preview can hand
  // the music back without cutting a real cue's dip short.
  private cueRingingUntil = 0;

  // Track the target end time (timestamp)
  private targetTime: number | null = null;

  // True once the opt-in overtime chime has AUDIBLY rung for the current
  // session, so Stop/Skip don't ring the same cue again seconds later. Cleared
  // wherever a session gets positive time back — switchMode, reset, addMinutes
  // — because after that the clock can cross zero a second time and a stale
  // flag would silence the cue for that second crossing's Stop.
  private endCueSounded = false;

  // A one-shot wake-up at the session's end time, beside the 50ms tick. The
  // tick alone can be up to a MINUTE late: a covered Obsidian window counts as
  // hidden (Electron maps macOS occlusion to a hidden page, and Obsidian sets
  // no backgroundThrottling), and five minutes after a page goes hidden
  // Chromium wakes a repeating timer at most once a minute unless audio is
  // playing — which, for someone who keeps the sound off, it is not. A single
  // setTimeout armed outside the tick is not "chained", so it is only ever
  // aligned to the second. It runs the same tick, whose `prev > 0` guard makes
  // a double fire a no-op. Re-armed wherever targetTime moves while running.
  private endWakeId: number | null = null;

  // When the tick last ran (or the loop started), for the sleep check in
  // tick(). Null while the loop is stopped.
  private lastTickAt: number | null = null;

  // True while Stop's long-session question is open. The end is NOT claimed
  // meanwhile (see finish), so this is what keeps a second Stop from asking
  // again on top of it.
  private askingLongSession = false;

  // Set by dispose() and never cleared: a disposed engine never arms a timer
  // again. Clearing the loop at dispose is not enough on its own, because an
  // async continuation can outlive it — a zero crossing with auto-start on
  // awaits four vault round trips in handleFinished() before switchMode()
  // restarts the loop, and a Skip does the same. Unload the plugin inside that
  // window and the continuation used to start a fresh interval nothing would
  // ever clear, logging sessions and ringing cues from a disabled plugin until
  // Obsidian restarted. Checked where timers are CREATED (startLoop,
  // armEndWake) rather than at each continuation, so a future async path
  // cannot reopen the hole by forgetting a check. Nothing restarts a disposed
  // engine on purpose: onload() constructs a new one every time.
  private disposed = false;

  // Counts sessions: bumped when the engine COMMITS to ending one (the
  // crossing with auto-start on, Stop, Skip — see beginEnding) and again when
  // switchMode() puts the next one on the clock. The status bar's menu (0.6.8)
  // records it when it opens, so a choice made after the timer has moved on
  // does nothing, rather than landing on a session the menu never showed. The
  // bump at the START of an end is what covers the crossing: the next session
  // only arrives after handleFinished's vault writes, and a menu clicked in
  // that window used to end the same session a second time. Two sessions of
  // one mode can follow each other (two quick skips), which is why this is a
  // counter and not the mode.
  private sessionSerial = 0;

  // True from the moment an end begins until switchMode() replaces the
  // session (or the end fails before it). finish(), skip() and the auto-start
  // crossing all await vault writes before the next session exists, and a
  // second end arriving in that window — the panel's Stop, a palette command,
  // the status bar menu — used to log the session twice, bump the task's 🍅
  // twice, move the long-break count twice and throw the new session away.
  private ending = false;

  /** Which session is on the clock. Moves when one starts ending and when the
   *  next begins; never while a session merely runs, pauses or resumes. */
  get session(): number {
    return this.sessionSerial;
  }

  /** Claim the end of the current session. False when an end is already in
   *  flight — the caller must then do nothing at all. */
  private beginEnding(): boolean {
    if (this.ending) return false;
    this.ending = true;
    this.sessionSerial += 1;
    return true;
  }

  // Track current task name for logging
  public currentTaskName: string = NO_TASK_LABEL;
  public currentTaskPath: string | undefined;

  public currentTaskId: string | undefined;

  /**
   * The linked line's raw text (after the checkbox) as the 🍅 counter last
   * left it: what a task with no 🆔 is found by, compared through
   * taskMatchKey. It starts as the line the picker linked and follows every
   * count this engine writes ("Write docs ⏳ …" → "Write docs 🍅 1 ⏳ …"),
   * because that write changes the very text the line is matched on —
   * matching on the linked name found the line once and never again. For a
   * task with a 🆔 it also follows
   * whatever `onFileModify` reads off the line, a count made elsewhere
   * included. A match key only, never logged or shown: the log, the status bar
   * and the "Current task" button keep `currentTaskName`, the name the task
   * was linked by, so counting can never rename a task in anyone's log.
   */
  public currentTaskLineText: string = NO_TASK_LABEL;

  // The linked task's note was deleted while a session was under way: the
  // task is held by name for that session and unlinked when it ends (F28).
  // Any new link — a pick, or the unlink itself — clears it.
  private unlinkAtSessionEnd = false;

  constructor(plugin: GentlePomoPlugin) {
    this.plugin = plugin;
    const total = plugin.settings.focusMinutes * ONE_MINUTE_MS;
    this.state = {
      mode: "focus",
      isRunning: false,
      remainingMs: total,
      totalMs: total,
      taskName: NO_TASK_LABEL,
      breakType: null,
    };
  }

  /**
   * Update the active task and notify LogManager so future log lines reflect
   * the change. `lineText` is the line's raw text after the checkbox, which a
   * task with no 🆔 is found by; it defaults to the name. It may be older than
   * the line — a picker list opened before a count still offers the old text —
   * which is why linkedLineIndex falls back to the count-free key.
   */
  setTask(name: string, path?: string, taskId?: string, lineText: string = name) {
    this.linkTask(name, path, taskId, lineText, false);
  }

  /** `renamed`: the same task under a new name, which is never a task switch
   *  (LogManager.updateTask) — the open segment keeps going. */
  private linkTask(
    name: string,
    path: string | undefined,
    taskId: string | undefined,
    lineText: string,
    renamed: boolean
  ) {
    this.currentTaskName = name;
    this.currentTaskLineText = lineText;
    this.currentTaskPath = path;
    this.currentTaskId = taskId;
    this.unlinkAtSessionEnd = false;
    this.state.taskName = name;
    this.state.taskPath = path;
    this.plugin.logManager.updateTask(name, path, taskId, renamed);
    this.emit();
  }

  /**
   * Reaction to vault file changes. If the modified file holds the active task,
   * refreshes the task name (when ID is known) and auto-unlinks if it's now
   * completed (only while no session is under way — see step 4).
   *
   * The refresh is how a rename reaches the log: the timer takes the new name
   * at once, and the past log lines with the ID follow once the typing has
   * stopped (LogManager.scheduleTaskRename). The 🍅 counter's count is not a
   * rename (`taskNameAfterEdit`) — taken as one, every count rewrote the
   * task's whole history (to 0.6.8) — and nor is a field or spacing change.
   * It only moves `currentTaskLineText`, kept current although a 🆔 task is
   * found by its ID everywhere (the counter, the unlink, the picker's tick and
   * pin). When several lines carry the 🆔, that text is also how the line is
   * told apart — and when it names none of them, or only ticked ones, the one
   * open copy is the task (F2, resolveIdLine): a task copied forward, its old
   * copy ticked, keeps the timer on the new one.
   */
  async onFileModify(file: TAbstractFile) {
    // A chosen sound file changed — edited, or updated by sync. Decode the new
    // version now, so the next cue plays it rather than the built-in while it
    // loads. Before the task checks, which return early when no task is linked.
    if (this.isEndCueFile(file.path)) void this.loadCustomCue(file.path);

    // 1. Basic checks. Linked is "has a note", never the name (F36).
    if (!this.currentTaskPath) return;

    // 2. Check if modified file matches current task file
    if (file.path !== this.currentTaskPath) return;

    // 3. Refresh task name by ID (if available) — or adopt a 🆔 the line has
    // gained since it was linked (C3). A read that fails skips this step
    // only: the unlink check below still runs (F41).
    try {
      if (this.currentTaskId) await this.followRename();
      else await this.adoptAddedId(file);
    } catch (e) {
      logger.warn("Could not read the linked task's note", e);
    }

    // 4. Not while a session is under way — running OR paused part-way (F6).
    // Unlinking renames the open session's task, so a task ticked while its
    // session was paused was logged as "No Task" and lost its 🍅. Every end
    // runs this check once the session is logged (Stop, Skip, the crossing,
    // a Reset of a paused session).
    if (this.sessionInProgress()) return;

    // 5. Check completion
    await this.checkTaskCompletionAndUnlink();
  }

  /** Step 3 for a task with a 🆔: take a rename off its line. */
  private async followRename() {
    const link = this.currentLink();
    if (!link.id || !link.path) return;
    const found = await findIdTaskLine(this.plugin.app, link.path, link.id, link.lineText);
    // The read awaited: a task linked meanwhile is not this line's.
    if (found === null || this.currentTaskId !== link.id || this.currentTaskPath !== link.path) {
      return;
    }
    const text = found.text;
    const latestName = taskNameAfterEdit(this.currentTaskName, text);
    if (latestName === this.currentTaskName) {
      this.currentTaskLineText = text;
      return;
    }
    this.linkTask(latestName, link.path, link.id, text, true);
    this.plugin.logManager.scheduleTaskRename({
      taskId: link.id,
      name: latestName,
      taskPath: link.path,
      createdDate: taskCreatedDate(text),
      line: found.line,
      copies: found.copies,
    });
  }

  /**
   * Step 3 for a task with no 🆔: if its line has one now, take it (C3). The
   * Tasks plugin gives a task an ID when it becomes another's dependency, and
   * until the task was picked again its sessions were logged with no ID — out
   * of the reviews' per-task table, and out of every later rename. The name is
   * kept, and the open session takes the ID.
   */
  private async adoptAddedId(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    const link = this.currentLink();
    const content = await this.plugin.app.vault.read(file);
    if (!this.isCurrentLink(link)) return;
    // Read only, so CRLF-safe.
    const lines = content.split(/\r?\n/);
    const index = linkedLineIndex(lines, undefined, link.lineText);
    const text = index === -1 ? undefined : lines[index].match(TASK_LINE_REGEX)?.[2];
    const taskId = text === undefined ? undefined : taskIdOf(text);
    if (text === undefined || taskId === undefined) return;
    this.linkTask(link.name, link.path, taskId, text, true);
  }

  /**
   * A note was renamed or moved — the linked task's, or a folder above it:
   * the link follows it, the open session too (C1). Every later session was
   * written as a link to the old path, which nothing repaired: Obsidian had
   * already updated its links, and the counter, the rename and the unlink all
   * looked for the note where it no longer was.
   */
  onFileRename(file: TAbstractFile, oldPath: string) {
    this.plugin.logManager.taskNoteMoved(oldPath, file.path);
    const moved = pathAfterMove(this.currentTaskPath, oldPath, file.path);
    if (moved === null) return;
    this.currentTaskPath = moved;
    this.state.taskPath = moved;
    this.emit();
  }

  /**
   * A note was deleted — the linked task's, or a folder above it. A session
   * under way keeps the task's name and loses its note, so its line logs the
   * name with no dead link (C1); the task is unlinked once that session ends
   * (checkTaskCompletionAndUnlink, which every end runs). With none under
   * way — or one already ending, whose line has its task — it goes at once.
   * Kept on, it was given every later session while the panel and the status
   * bar showed no task, and with the picker hidden nothing could clear it
   * (F28).
   */
  onFileDelete(file: TAbstractFile) {
    this.plugin.logManager.taskNoteDeleted(file.path);
    if (!isPathGone(this.currentTaskPath, file.path)) return;
    if (!this.sessionInProgress() || this.ending) {
      this.setTask(NO_TASK_LABEL);
      return;
    }
    this.currentTaskPath = undefined;
    this.state.taskPath = undefined;
    this.unlinkAtSessionEnd = true;
    this.emit();
  }

  /**
   * A task is on the timer: linked to its note, or held by name for the
   * session its note was deleted during (F28). What hiding the picker unlinks.
   */
  holdsTask(): boolean {
    return this.currentTaskPath !== undefined || this.unlinkAtSessionEnd;
  }

  /**
   * A session is under way: running, or paused part-way through. A timer that
   * was never started — or was reset — shows its full length.
   */
  private sessionInProgress(): boolean {
    return this.state.isRunning || this.state.remainingMs !== this.state.totalMs;
  }

  /** The linked task as it stands now, for a vault round trip to hold on to. */
  private currentLink(): TaskLink {
    return {
      name: this.currentTaskName,
      path: this.currentTaskPath,
      id: this.currentTaskId,
      lineText: this.currentTaskLineText,
    };
  }

  /** Is `link` still the linked task, with the line text it was taken with? */
  private isCurrentLink(link: TaskLink): boolean {
    return (
      this.currentTaskName === link.name &&
      this.currentTaskPath === link.path &&
      this.currentTaskId === link.id &&
      this.currentTaskLineText === link.lineText
    );
  }

  getState(): TimerState {
    return { ...this.state };
  }

  onChange(listener: TimerListener) {
    this.listeners.add(listener);
    listener(this.getState());
  }

  offChange(listener: TimerListener) {
    this.listeners.delete(listener);
  }

  private emit() {
    const snapshot = this.getState();
    this.listeners.forEach((l) => l(snapshot));
  }

  private clearLoop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.lastTickAt = null;
    this.clearEndWake();
  }

  private clearEndWake() {
    if (this.endWakeId !== null) {
      window.clearTimeout(this.endWakeId);
      this.endWakeId = null;
    }
  }

  /**
   * Arm (or re-arm) the one-shot wake-up for the current end time. Nothing to
   * arm while paused or once the session is already in overtime. The extra
   * millisecond keeps a timer that fires exactly on time from reading a
   * remaining time of +0.x and finding nothing to do.
   */
  private armEndWake() {
    this.clearEndWake();
    if (this.disposed || !this.state.isRunning || this.targetTime === null) return;
    const delay = this.targetTime - Date.now();
    if (delay <= 0) return;
    this.endWakeId = window.setTimeout(() => {
      this.endWakeId = null;
      this.tick();
    }, delay + 1);
  }

  private startLoop() {
    this.clearLoop();
    if (this.disposed) return; // see `disposed`

    // Safety: Ensure targetTime is set if running
    if (this.state.isRunning && this.targetTime === null) {
      this.targetTime = Date.now() + this.state.remainingMs;
    }

    this.lastTickAt = Date.now();
    this.intervalId = window.setInterval(() => this.tick(), 50);
    this.armEndWake();
  }

  private tick() {
    if (!this.state.isRunning || this.targetTime === null) return;

    // Calculate remaining time based on system clock
    const now = Date.now();
    // Before the crossing below: a laptop that slept through its session's
    // end must not wake to end it (F48) — unless the next session starts by
    // itself, which ends it at its planned end (F11).
    if (this.pausedForSleep(now)) return;
    this.lastTickAt = now;
    const prev = this.state.remainingMs;
    this.state.remainingMs = this.targetTime - now;

    // The tick is a writer of remainingMs like reset() and addMinutes(), so it
    // needs their clear too. `targetTime - now` rises whenever the system clock
    // steps BACKWARD (an NTP correction, a manual change, a VM or laptop resume
    // that re-syncs), which is arithmetically identical to adding time — and a
    // stale flag would then silence the next crossing's Stop.
    if (this.state.remainingMs > 0) this.endCueSounded = false;

    // Natural completion: fire once on the tick that crosses zero. The
    // `prev > 0` guard guarantees this fires a single time (later ticks have
    // prev <= 0; a new session restores a positive remainingMs). Only act
    // when the next mode's auto-start toggle is on — otherwise fall through
    // and let the timer count up into overtime (unchanged behavior).
    if (prev > 0 && this.state.remainingMs <= 0) {
      // The instant the clock reached zero. The tick that sees it can be late
      // — a covered window, a sleep, a phone holding the app — and the
      // session that auto-starts the next one ends HERE, not then (F3). A
      // desktop that slept through it gets here only with auto-start on
      // (F11); with it off, pausedForSleep above paused the session.
      const crossedAt = this.targetTime;
      const autoStart = this.autoStartsNext();
      // The opt-in system notification (0.6.6). Placed ABOVE the branch so
      // both paths post it, and read here because state.mode is still the
      // mode that ENDED — completeNaturally() switches it. It is silent and
      // changes nothing about the timer, so the overtime guarantee below
      // still holds. The plugin owns it: the engine does no UI.
      this.plugin.notifySessionEnd(this.state.mode, autoStart);
      if (autoStart) {
        this.state.remainingMs = 0; // freeze display at 00:00
        this.clearLoop(); // stop ticking; completeNaturally restarts the loop
        // A Stop or Skip already ending this session got here first; the
        // tick cannot normally run then (both clear the loop), but the end is
        // theirs either way.
        if (!this.beginEnding()) return;
        this.emit();
        void this.completeNaturally(crossedAt);
        return;
      }
      // Auto-start is off, so the session deliberately slides into overtime
      // to protect flow (see CLAUDE.md — this silence is a product value,
      // not a defect). The optional chime ANNOUNCES the end and changes
      // nothing else: no logging, no mode switch, no clearLoop. Everything
      // below this line must stay identical to the pre-0.6.3 fall-through.
      this.maybeChimeAtCrossing();
    }

    this.emit();
  }

  /**
   * On the desktop app, a tick more than SLEEP_GAP_MS after the last one means
   * the computer was asleep: nothing runs while it is, and on waking the tick
   * and the end wake-up fire at once. Until 0.6.9 the sleep counted as focus,
   * and Stop the next morning logged the whole night as finished (F48). Now
   * the timer pauses as it stood at the last tick, the log records the pause
   * from then, and the user is told how long was not counted.
   *
   * Desktop only: a phone suspends a backgrounded or locked app as a matter of
   * course, and the wall-clock timer is built to run through that — a locked
   * phone's 25 minutes would otherwise log as nothing. The gap is far above
   * Chromium's once-a-minute tick for a covered window, which must not count.
   *
   * Two sleeps are not paused:
   * - One before the session's first tick (F15) — an auto-started session the
   *   lid closed on at once. Paused from its own start, it looked never
   *   started: the next Start played the drum as for a fresh session and
   *   resumed this one, its old Start and a night's pause included, filed
   *   under the day before. It had no time to keep, so it is thrown away and
   *   the timer waits at full length. `remainingMs` is written by the tick
   *   alone, so while it still equals the total no tick has run since the
   *   session began at full length (a Start, an auto-start, a running Reset).
   * - One through the planned end with the next session's auto-start on
   *   (F11): that session ends at its planned end, as on a phone (F3), and
   *   the next one starts now — the tick's crossing does both, so this
   *   returns false. Paused instead, it woke with time left and no break.
   */
  private pausedForSleep(now: number): boolean {
    const last = this.lastTickAt;
    if (!Platform.isDesktopApp || last === null || this.targetTime === null) return false;
    if (now - last <= SLEEP_GAP_MS) return false;
    if (this.state.remainingMs === this.state.totalMs) {
      this.discardUnstarted();
      this.plugin.notifySleepPause(now - last);
      return true;
    }
    if (last < this.targetTime && this.targetTime <= now && this.autoStartsNext()) return false;
    this.state.remainingMs = this.targetTime - last;
    this.halt(last);
    this.plugin.notifySleepPause(now - last);
    return true;
  }

  /** F15: the session on the clock never ticked. Throw it away and wait at
   *  full length, as a Reset of a paused session does. */
  private discardUnstarted() {
    this.plugin.logManager.discardSession();
    // The session on the clock is gone; a menu opened for it must not act on
    // whatever comes next (as in reset()).
    this.sessionSerial += 1;
    this.state.isRunning = false;
    this.targetTime = null;
    this.clearLoop();
    this.emit();
    // The session that held an unlink back is gone (see onFileModify).
    void this.checkTaskCompletionAndUnlink();
  }

  /** Whether the session that follows this one starts by itself. */
  private autoStartsNext(): boolean {
    return this.state.mode === "focus"
      ? this.plugin.settings.autoStartBreak
      : this.plugin.settings.autoStartFocus;
  }

  /**
   * The end-of-session cue for the mode that is ENDING — the user's choice for
   * that edge (0.6.7), by default the singing bell after focus and the ding
   * after a break. The choice was written out three times before 0.6.3; it
   * lives here so the crossing, Stop and Skip cannot drift. Resolved before
   * anything is awaited: every caller is about to switch the mode.
   */
  private playEndCue() {
    const cue = this.endCue(this.state.mode === "focus" ? "focus" : "break");
    void this.playSound(cue.file, cue.path);
  }

  /** The sound an edge plays, read from the live settings. */
  private endCue(edge: CueEdge): ResolvedCue {
    return resolveCue(this.plugin.settings[CUE_SETTING_KEY[edge]], edge);
  }

  private isEndCueFile(path: string): boolean {
    return END_CUE_EDGES.some((edge) => this.endCue(edge).path === path);
  }

  /**
   * Whether the user asked to be told that the session now ENDING has ended.
   *
   * This is deliberately independent of the auto-start toggles. Until 0.6.3 the
   * auto-start path chimed unconditionally, which meant the two settings encoded
   * only THREE states — there was no way to say "start the next session, but
   * quietly" — and the chime setting was silently overruled rather than merely
   * irrelevant. Reading it on both paths makes all four states real and removes
   * the dependency, which is what let the settings UI stop hiding rows.
   */
  private endChimeWanted(): boolean {
    return this.state.mode === "focus"
      ? this.plugin.settings.focusEndSoundEnabled
      : this.plugin.settings.breakEndSoundEnabled;
  }

  /**
   * The opt-in chime when the clock runs out and nothing starts on its own.
   *
   * `endCueSounded` stops Stop/Skip ringing the SAME cue again moments later.
   * It is stamped only when the cue could actually be HEARD: `soundEnabled` is
   * the master gate inside playSound(), and the user can flip it between this
   * crossing and the Stop — at which point "it already rang" is a lie that
   * silences a Stop which has rung since 0.2.1. Stamping an intent rather than
   * an audible event is the bug this ordering exists to prevent.
   */
  private maybeChimeAtCrossing() {
    if (!this.endChimeWanted()) return;
    if (this.cueIsAudible()) this.endCueSounded = true;
    this.playEndCue();
  }

  /**
   * The settings-level conditions playSound() checks before it does anything.
   * Kept in step with its two early returns ON PURPOSE — this is what makes
   * `endCueSounded` record an audible EVENT rather than an intent, and both can
   * be flipped between a crossing and the Stop that follows it.
   *
   * It does not, and cannot cheaply, cover the failures further inside
   * playSound (no AudioContext, a resume that never lands, a decode that
   * throws). Those would need the stamp to wait on the decode, which opens a
   * window where a fast Stop double-cues — a worse trade for a rarer fault. The
   * realistic one of them, an iOS context parked in "interrupted", is fixed at
   * the resume instead.
   */
  private cueIsAudible(): boolean {
    return this.plugin.settings.soundEnabled && this.plugin.settings.soundVolume > 0;
  }

  /**
   * Whether a manual Stop/Skip should ring the end cue. False only in overtime
   * where the opt-in chime already rang for this same session.
   *
   * BOTH arms are load-bearing; an earlier version of this comment called the
   * first one decoration and was wrong. `remainingMs > 0` is what keeps the
   * ordinary case (Stop before the clock runs out) correct, and it is the only
   * guard on the tick path if the clock ever steps backward far enough to
   * outrun the clear added there. Swapping `> 0` for `>= 0` still kills no test
   * — the flag is only set once remainingMs has gone negative — but that is a
   * statement about the boundary, not a licence to drop the arm.
   */
  private shouldPlayManualEndCue(): boolean {
    return this.state.remainingMs > 0 || !this.endCueSounded;
  }

  /**
   * Natural end-of-session handler (timer reached zero with auto-start on).
   * Chimes if asked to, then reuses handleFinished() to log the session, advance
   * the long-break counter, and auto-start the next session. handleFinished()
   * itself plays no sound (finish() plays it first) — we mirror that here.
   *
   * The cue is gated on the SAME setting as the overtime path (see
   * endChimeWanted). Before 0.6.3 it rang unconditionally, so auto-advancing
   * always made a noise whatever the user wanted; the upgrade derivation seeds
   * each chime from the matching auto-start value so nobody's sounds change.
   *
   * No `endCueSounded` stamp is needed: handleFinished() runs switchMode(),
   * which clears the flag and starts a fresh session with positive time, so a
   * later Stop is stopping something else entirely.
   *
   * The session ends at `crossedAt`, its planned end, with no overtime: the
   * app ended it, not the user, so however late the tick ran the line is the
   * session's planned length. Before 0.6.9 a crossing seen on waking a laptop
   * logged the whole night as finished focus (F3). The next session starts now.
   */
  private async completeNaturally(crossedAt: number) {
    try {
      if (this.endChimeWanted()) this.playEndCue();
      // Natural completion only fires when the toggle is on → auto-start the next.
      await this.handleFinished(true, { endAt: crossedAt, overtimeSeconds: 0 });
    } finally {
      this.ending = false;
    }
  }

  private async handleFinished(autoStartNext: boolean, end: SessionEnd) {
    // The task this session was for, taken before the first await: logging it
    // reads and writes the vault, and a task picked meanwhile — at the zero
    // crossing, when people choose what comes next — is not the one that
    // earned this 🍅. The log line is the session's; so is its count.
    const link = this.currentLink();
    // The day the session is filed under — its START (F24). Read now: ending
    // it closes the log's session, and the day of the end put a focus from
    // 23:50 to 00:15 on the next day's count while its line went in today's.
    const sessionDay =
      this.plugin.logManager.openSessionDay() ??
      logicalDate(moment(), this.plugin.settings.dayStartHour);

    // Log the finished session. False when it was under a minute (F59): no
    // line, and below, no 🍅 and no step of the long-break count.
    const counted = await this.plugin.logManager.endSession("finished", end);

    // For focus sessions: optionally increment the task's pomodoro count
    // BEFORE the unlink check so we don't skip on a just-completed task.
    if (counted && this.state.mode === "focus") {
      await this.maybeIncrementTaskPomodoroCount(link);
    }

    // Check if task is completed and unlink if so
    await this.checkTaskCompletionAndUnlink();

    if (this.state.mode === "focus") {
      // A session that did not count earns no break of its own: short, since
      // the count it would have moved may already sit on a long one.
      let isLongBreak = false;
      if (counted) {
        // Advance the long-break counter, resetting when the day turns — the
        // day the log files this session under, so "Day starts at" moves this
        // rollover with the file's.
        const counter =
          this.plugin.settings.sessionCounterDate === sessionDay
            ? this.plugin.settings.sessionsSinceLongBreak + 1
            : 1;
        this.plugin.settings.sessionsSinceLongBreak = counter;
        this.plugin.settings.sessionCounterDate = sessionDay;
        await this.plugin.saveSettings();

        const longBreakEvery = Math.max(1, this.plugin.settings.longBreakEvery);
        isLongBreak = counter % longBreakEvery === 0;
      }
      this.switchMode("break", autoStartNext, isLongBreak);
    } else {
      this.switchMode("focus", autoStartNext);
    }
  }

  /**
   * If the user has opted in (`incrementPomodoroCountOnFinish`), increment the
   * lifetime `🍅 N` marker on the linked task line. Best-effort: failures are
   * logged but never throw.
   */
  private async maybeIncrementTaskPomodoroCount(link: TaskLink) {
    if (!this.plugin.settings.incrementPomodoroCountOnFinish) return;
    if (!link.path) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(link.path);
    if (!(file instanceof TFile)) return;

    // Count the session's task, as it was linked when the session ended —
    // never whatever is linked once the vault answers. A task linked
    // meanwhile must get neither this 🍅 nor this line's text.
    let counted = "";

    try {
      // Atomic read-modify-write: `process` locks the file, so a concurrent
      // sync/plugin write can't be clobbered between our read and write.
      await this.plugin.app.vault.process(file, (content) => {
        const lines = content.split("\n");
        const index = linkedLineIndex(lines, link.id, link.lineText);
        if (index === -1) return content;

        lines[index] = incrementPomodoroCount(lines[index]);
        counted = lines[index].match(TASK_LINE_REGEX)?.[2] ?? "";
        return lines.join("\n");
      });
    } catch (e) {
      logger.warn("Failed to increment task pomodoro count", e);
      return;
    }

    // Follow the line: the count just changed the text a task with no 🆔 is
    // found by. Only after the write landed, and only for the same link.
    if (counted && this.isCurrentLink(link)) this.currentTaskLineText = counted;
  }

  private async checkTaskCompletionAndUnlink() {
    // A task whose note was deleted mid-session: that session has ended, and
    // the task goes with it (F28; see onFileDelete). Every end runs this.
    if (this.unlinkAtSessionEnd) {
      this.setTask(NO_TASK_LABEL);
      return;
    }
    if (!this.currentTaskPath) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(this.currentTaskPath);
    if (!(file instanceof TFile)) return;

    // The link this check is about. A task linked while the note is being read
    // is another task, perhaps in another note: checking it against this note
    // could find a done line with its text and unlink it.
    const link = this.currentLink();

    try {
      const content = await this.plugin.app.vault.read(file);
      if (!this.isCurrentLink(link)) return;
      // CRLF-safe split: this path only reads, and the $-anchored
      // TASK_LINE_REGEX can't match a line with a trailing \r. Write paths
      // (marker increment/repair) must keep split("\n") — they rejoin on "\n".
      const lines = content.split(/\r?\n/);

      // A task with a 🆔: done exactly when the line the 🍅 counter counts is
      // ticked (idTaskDone) — one rule for which copy is the task (F2).
      if (link.id) {
        if (idTaskDone(lines, link.id, link.lineText) === true) this.setTask(NO_TASK_LABEL);
        return;
      }

      // A task with no 🆔: as linkedLineIndex finds it, by the exact text or
      // without the count — and any open line on either keeps it linked: a
      // done copy of a recurring task can match the exact text while the
      // task itself, a count ahead, matches only without the count.
      const exactKey = taskMatchKey(link.lineText);
      const looseKey = taskLineKey(link.lineText);
      const exact = { open: false, done: false };
      const loose = { open: false, done: false };

      for (const line of lines) {
        const taskMatch = line.match(TASK_LINE_REGEX);
        if (!taskMatch) continue;
        const tier =
          taskMatchKey(taskMatch[2]) === exactKey
            ? exact
            : taskLineKey(taskMatch[2]) === looseKey
              ? loose
              : null;
        if (tier && taskMatch[1] === " ") tier.open = true;
        else if (tier) tier.done = true;
      }

      const foundIncomplete = exact.open || loose.open;
      const foundComplete = exact.done || loose.done;
      if (!foundIncomplete && foundComplete) {
        this.setTask(NO_TASK_LABEL);
      }
    } catch (e) {
      logger.error("Failed to check task completion", e);
    }
  }

  /** Lazily create (once) and return the shared AudioContext, or null if unsupported. */
  private getAudioContext(): AudioContext | null {
    // A disposed engine has closed its context; a late file decode or preview
    // must not open a new one that nothing would ever close.
    if (this.disposed) return null;
    if (this.audioCtx) return this.audioCtx;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;

    this.audioCtx = new AudioContextCtor();
    return this.audioCtx;
  }

  /**
   * Release engine resources on plugin unload: stop the tick loop, close the
   * shared AudioContext (Chromium caps live contexts, so leaking one per
   * disable/enable cycle would eventually silence all sound), and drop the
   * decoded-buffer cache. Terminal: see `disposed`.
   */
  dispose() {
    this.disposed = true;
    this.clearLoop();
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.audioBuffers.clear();
    this.customCues.clear();
    // Closing the context above silences a preview too; drop the bookkeeping.
    this.preview = null;
    this.previewToken++;
    this.previewListener = null;
  }

  /**
   * Play one cue. `filename` is a bundled sound; `customPath`, when given, is
   * the user's own file (0.6.7), which plays INSTEAD — but only when it is
   * already decoded and still the same version of the file. Otherwise the
   * bundled sound plays, and the file is loaded for next time.
   *
   * Two rules hold this together:
   * - A cue never waits on the vault. A file on iCloud or a syncing phone can
   *   take seconds to read, and a late cue lands on top of whatever the user
   *   did next.
   * - A choice of sound adds no early return. cueIsAudible() mirrors the two
   *   gates below so that `endCueSounded` records an audible EVENT; a missing
   *   or unplayable file that returned here instead of falling back would turn
   *   a stamped crossing into silence, and the Stop after it would be silent
   *   too.
   *
   * Returns what played — the vault path or the bundled filename — or null.
   */
  private async playSound(
    filename: string,
    customPath: string | null = null,
    preview: { edge: CueEdge; token: number } | null = null
  ) {
    if (!this.plugin.settings.soundEnabled) return null;
    // Volume 0 is not reachable from the segmented control (0.3 / 0.7 / 1.0) but
    // is from a hand-edited data.json. Returning here rather than playing silence
    // keeps two things honest: the cue does not dip the lofi music for four
    // seconds for nothing, and `endCueSounded` is not stamped for a cue nobody
    // heard — which would silence the following Stop.
    if (this.plugin.settings.soundVolume <= 0) return null;

    const dataUrl = AUDIO_URLS[filename];
    if (!dataUrl) {
      logger.debug(`Sound file not bundled: ${filename}`);
      return null;
    }

    try {
      const ctx = this.getAudioContext();
      if (!ctx) return null;

      // A context created off a user gesture starts suspended; resume so a
      // timer-triggered completion sound is actually audible. "interrupted" is
      // WebKit's own state — iOS parks the context there on a phone call, Siri,
      // or a screen lock, which is precisely the walked-away case the chime
      // exists for. It IS in lib.dom.d.ts's AudioContextState. Listing both
      // rather than `!== "running"` keeps a closed context on the clean skip
      // path instead of a rejected resume.
      if (ctx.state === "suspended" || ctx.state === "interrupted") await ctx.resume();

      let played = filename;
      let audioBuffer: AudioBuffer | null = null;
      if (customPath !== null) {
        audioBuffer = this.readyCustomCue(customPath);
        if (audioBuffer === null) void this.loadCustomCue(customPath);
        else played = customPath;
      }
      audioBuffer ??= await this.bundledBuffer(ctx, filename, dataUrl);
      // An unload can land during the resume or the decode above, and a
      // disabled plugin must not ring or dip the music.
      if (this.disposed) return null;
      // A preview stopped or replaced while it loaded. Previews only: a real
      // cue has no such return, or cueIsAudible would stop being honest.
      if (preview !== null && preview.token !== this.previewToken) return null;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const gain = ctx.createGain();
      gain.gain.value = this.plugin.settings.soundVolume;

      source.connect(gain);
      gain.connect(ctx.destination);
      // Dip any playing lofi music under the cue for exactly the clip's length
      // (view-side; no-op when nothing is playing).
      this.plugin.duckMusicInOpenViews(audioBuffer.duration);
      source.start(0);
      if (preview !== null) {
        this.holdPreview(preview.edge, source, gain);
      } else {
        this.cueRingingUntil = Math.max(
          this.cueRingingUntil,
          Date.now() + audioBuffer.duration * 1000
        );
      }
      return played;
    } catch (e) {
      logger.error(`Failed to play sound ${filename}:`, e);
      return null;
    }
  }

  /** Decode each bundled asset once, then reuse its AudioBuffer. */
  private async bundledBuffer(
    ctx: AudioContext,
    filename: string,
    dataUrl: string
  ): Promise<AudioBuffer> {
    const cached = this.audioBuffers.get(filename);
    if (cached) return cached;
    // Strip the `data:audio/...;base64,` prefix and decode to bytes.
    // Avoids fetch() (restricted by obsidianmd lint config) and the network round-trip.
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // decodeAudioData detaches `bytes.buffer`; harmless since we cache the
    // resulting AudioBuffer and never touch the raw bytes again.
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
    this.audioBuffers.set(filename, audioBuffer);
    return audioBuffer;
  }

  /**
   * The decoded sound for a user's file, if it is ready AND still the version
   * on disk. Synchronous on purpose — see playSound: a cue never waits.
   */
  private readyCustomCue(path: string): AudioBuffer | null {
    const entry = this.customCues.get(path);
    if (!entry || !entry.settled || !entry.settled.ok) return null;
    const file = this.plugin.app.vault.getFileByPath(path);
    if (file === null || fileVersion(file) !== entry.version) return null;
    return entry.settled.buffer;
  }

  /**
   * Read and decode one of the user's sound files, once per version of it.
   * Public for the settings tab, which checks a file with this as it is
   * picked and asks it why a saved one plays the built-in instead.
   *
   * Two callers asking for the same version share one read (the entry holds
   * the promise), unless it has been going for CUE_LOAD_STALE_MS. A MISSING
   * file is not cached: finding that out is a lookup, and a file still
   * syncing should be found by the next cue rather than remembered as gone.
   * Nor is a failed READ — see below. `forPick` is the settings tab checking
   * a file before saving it: that file is not named by any setting yet.
   */
  loadCustomCue(path: string, forPick = false): Promise<CueLoad> {
    const file = this.plugin.app.vault.getFileByPath(path);
    if (file === null) return Promise.resolve({ ok: false, problem: "missing" });
    const version = fileVersion(file);
    const cached = this.customCues.get(path);
    if (
      cached !== undefined &&
      cached.version === version &&
      (cached.settled !== null || Date.now() - cached.startedAt < CUE_LOAD_STALE_MS)
    ) {
      return cached.result;
    }

    const entry: CustomCueEntry = {
      version,
      startedAt: Date.now(),
      result: this.decodeCustomCue(file),
      settled: null,
    };
    void entry.result.then((load) => {
      entry.settled = load;
      // Replaced meanwhile — by an edit, or by a retry of a stalled read.
      if (this.customCues.get(path) !== entry) return;
      // A read that failed says nothing about the file — iCloud still
      // downloading an offloaded one, OneDrive or an antivirus holding it —
      // and its mtime and size do not change when it becomes readable. Cached,
      // it would be refused, and every cue would play the built-in, until the
      // file was edited or Obsidian restarted. Forget it, as for a missing file.
      if (!load.ok && load.problem === "unreadable") {
        this.customCues.delete(path);
        return;
      }
      // Nobody names this file any more — the row moved to another sound
      // while it decoded (at startup, after an edit). Nothing else would
      // sweep it once the rows are on built-ins, so let go of it now. A
      // PICK's file is not named until the pick saves it, so a pick keeps
      // it and releases it itself on every other way out.
      if (!forPick && !this.isEndCueFile(path)) this.customCues.delete(path);
    });
    this.customCues.set(path, entry);
    this.evictCustomCues(path);
    return entry.result;
  }

  private async decodeCustomCue(file: TFile): Promise<CueLoad> {
    // Checked BEFORE the read. The whole file is decoded before its length is
    // known, so its size is the only guard on memory — a long file at a low
    // bitrate decodes to far more than its size suggests.
    const sizeProblem = checkCueFileSize(file.path, file.stat.size);
    if (sizeProblem !== null) return { ok: false, problem: sizeProblem };
    let bytes: ArrayBuffer;
    try {
      bytes = await this.plugin.app.vault.readBinary(file);
    } catch (e) {
      logger.warn(`Could not read sound file ${file.path}`, e);
      return { ok: false, problem: "unreadable" };
    }
    const ctx = this.getAudioContext();
    if (!ctx) return { ok: false, problem: "undecodable" };
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (e) {
      logger.warn(`Could not decode sound file ${file.path}`, e);
      return { ok: false, problem: "undecodable" };
    }
    const lengthProblem = checkCueDuration(buffer.duration);
    if (lengthProblem !== null) return { ok: false, problem: lengthProblem };
    return { ok: true, buffer };
  }

  /**
   * Drop every file no setting names any more, keeping `keep` — the file being
   * checked right now, which is not saved until the check passes — and any
   * file still loading, which is a pick in progress on one row or the other.
   * Evicting that one made each of two quick picks on the two rows read and
   * decode its file twice. A decoded 30-second sound is about 11 MB.
   */
  private evictCustomCues(keep: string | null) {
    const wanted = new Set<string>();
    if (keep !== null) wanted.add(keep);
    for (const edge of END_CUE_EDGES) {
      const path = this.endCue(edge).path;
      if (path !== null) wanted.add(path);
    }
    for (const [path, entry] of this.customCues) {
      if (!wanted.has(path) && entry.settled !== null) this.customCues.delete(path);
    }
  }

  /**
   * Let go of every decoded file no setting names — called by the settings tab
   * once a pick is saved. Loading a file is the only other time the cache is
   * swept, so switching a row back to a built-in would otherwise keep the old
   * file decoded in memory for the rest of the session.
   */
  releaseUnchosenCues() {
    this.evictCustomCues(null);
  }

  /**
   * Decode the chosen files ahead of time, so the first cue after startup
   * plays the user's own sound. With the default sounds this does nothing at
   * all — no file is read and no audio context is created.
   */
  prepareEndCues() {
    for (const edge of END_CUE_EDGES) {
      const path = this.endCue(edge).path;
      if (path !== null) void this.loadCustomCue(path);
    }
  }

  /**
   * Wake the audio context from inside a click. iOS lets only a user gesture
   * start WebAudio, and every caller is about to await a file read, after
   * which the gesture no longer counts. Harmless everywhere else.
   */
  wakeAudio() {
    const ctx = this.getAudioContext();
    if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) {
      void ctx.resume().catch(() => {});
    }
  }

  /**
   * Play an edge's sound now: the settings tab's ▶, and a sound just picked.
   *
   * Obeys "Timer sounds" — that switch promises every sound the timer makes —
   * and says so, so the tab can tell the user why nothing played. Unlike a
   * real cue it WAITS for the user's file to load: hearing the built-in right
   * after picking a file would read as the pick having failed. It never
   * touches `endCueSounded`; a preview is not the end of a session.
   *
   * "stale" when the choice changed while the file loaded: a pick made in the
   * meantime plays its own sound, and playing the old one after it would say
   * the pick had not been saved.
   */
  async previewEndCue(edge: CueEdge): Promise<"muted" | "played" | "stale"> {
    // One preview at a time, and the old one stops NOW — not once the new
    // file has loaded, which could be a noticeable wait.
    this.stopPreview();
    if (!this.plugin.settings.soundEnabled) return "muted";
    const token = this.previewToken;
    this.wakeAudio();
    const cue = this.endCue(edge);
    if (cue.path !== null) {
      await this.loadCustomCue(cue.path);
      const now = this.endCue(edge);
      if (token !== this.previewToken || now.file !== cue.file || now.path !== cue.path) {
        return "stale";
      }
    }
    await this.playSound(cue.file, cue.path, { edge, token });
    return token === this.previewToken ? "played" : "stale";
  }

  /** Which row's preview is playing, for the settings tab's ▶ / ■. */
  previewingEdge(): CueEdge | null {
    return this.preview?.edge ?? null;
  }

  /** The settings tab's hook for repainting ▶ / ■. One listener; null to clear. */
  setPreviewListener(listener: (() => void) | null) {
    this.previewListener = listener;
  }

  /**
   * Stop the preview — ■, a new pick, the other row's ▶, closing the settings.
   * Also cancels one still loading its file. It fades out rather than cutting
   * off, and hands the music back once the real cues still ringing are done
   * instead of when the stopped sound would have ended.
   */
  stopPreview() {
    this.previewToken++;
    const playing = this.preview;
    if (playing === null) return;
    this.preview = null;
    const ctx = this.audioCtx;
    try {
      if (ctx) {
        const t = ctx.currentTime;
        playing.gain.gain.setValueAtTime(playing.gain.gain.value, t);
        playing.gain.gain.linearRampToValueAtTime(0, t + PREVIEW_STOP_FADE_S);
        playing.source.stop(t + PREVIEW_STOP_FADE_S);
      } else {
        playing.source.stop();
      }
    } catch (e) {
      // stop() on a source that has already ended is a no-op by the spec, so
      // this is only for the unexpected — a context closed under us.
      logger.debug("Could not stop the preview", e);
    }
    this.plugin.shortenMusicDuckInOpenViews(Math.max(0, this.cueRingingUntil - Date.now()) / 1000);
    this.previewListener?.();
  }

  private holdPreview(edge: CueEdge, source: AudioBufferSourceNode, gain: GainNode) {
    this.preview = { edge, source, gain };
    source.onended = () => {
      // A stopped preview's own `ended` arrives after it was replaced.
      if (this.preview?.source !== source) return;
      this.preview = null;
      this.previewListener?.();
    };
    this.previewListener?.();
  }

  /**
   * Which setting holds a session's length: a long break reads
   * `longBreakMinutes`, any other break `breakMinutes`. The one place this
   * rule lives. reset(), start() and updateDuration() each used to decide it
   * from the mode alone, so a long break was handled as a short one: reset
   * put the short length on the clock (still labelled "Long break"), a paused
   * long break once started logged the short length as `Scheduled::`, and the
   * panel's "Break (m)" row resized a long break on the clock.
   */
  private durationSetting(mode: PomoMode, breakType: TimerState["breakType"]): DurationSetting {
    if (mode === "focus") return "focusMinutes";
    return breakType === "long" ? "longBreakMinutes" : "breakMinutes";
  }

  /** The configured length of a session, in minutes. */
  private sessionMinutes(mode: PomoMode, breakType: TimerState["breakType"]): number {
    return this.plugin.settings[this.durationSetting(mode, breakType)];
  }

  /**
   * Transition to the given mode. When entering break, `isLongBreak` selects
   * `longBreakMinutes` over `breakMinutes` and records the type on the state
   * so the log line can include it.
   */
  switchMode(mode: PomoMode, autoStart = false, isLongBreak = false) {
    const breakType: TimerState["breakType"] =
      mode === "focus" ? null : isLongBreak ? "long" : "short";
    const minutes = this.sessionMinutes(mode, breakType);

    const total = minutes * ONE_MINUTE_MS;

    // A new session has its own end to announce.
    this.endCueSounded = false;
    this.sessionSerial += 1;
    this.ending = false;
    // Whatever the log still holds open is not the session beginning here: a
    // Start that slipped in while the last end was writing opened one in the
    // OLD mode, and the next start resumed it (F21). Every end has closed its
    // own session by now, so this drops only a stray.
    this.plugin.logManager.discardSession();

    this.state = {
      mode,
      isRunning: autoStart,
      remainingMs: total,
      totalMs: total,
      taskName: this.currentTaskName,
      taskPath: this.currentTaskPath,
      breakType,
    };
    this.emit();

    if (autoStart) {
      this.plugin.logManager.startSession(
        mode,
        this.currentTaskName,
        minutes,
        this.currentTaskPath,
        this.currentTaskId,
        breakType
      );
      this.targetTime = Date.now() + total;
      this.startLoop();
    } else {
      this.targetTime = null;
      this.clearLoop();
    }
  }

  /** Start or resume the timer. Opens a session in LogManager and begins the 50ms tick loop. */
  start() {
    // Not while a session is ending (F21, and the same for pause, reset and
    // the two length changes below): the end awaits vault writes before the
    // next session exists, and a Start in that window opened a session in the
    // old mode that the next break then resumed — logged as a 🍅 Focus line.
    if (this.state.isRunning || this.ending) return;

    // Check if this is a fresh start (not a resume)
    const isFreshStart = this.state.remainingMs === this.state.totalMs;

    this.state.isRunning = true;

    // A fresh start is a new session, so nothing the log still holds open is
    // resumed into it. A Start and a Pause inside one tick leave the clock at
    // full length with a session open in the log; resumed, the next Start
    // logged that old Start and the pause since (F15).
    if (isFreshStart) this.plugin.logManager.discardSession();

    // Start or Resume Logging
    const minutes = this.sessionMinutes(this.state.mode, this.state.breakType);
    this.plugin.logManager.startSession(
      this.state.mode,
      this.currentTaskName,
      minutes,
      this.currentTaskPath,
      this.currentTaskId,
      this.state.breakType
    );

    // Set target based on current remaining time
    this.targetTime = Date.now() + this.state.remainingMs;

    // Play War Drum only on fresh Focus start
    if (isFreshStart && this.state.mode === "focus") {
      void this.playSound("war-drum_short.mp3");
    }

    this.emit();
    this.startLoop();
  }

  /** Pause the timer without ending the session — pause is logged for accounting. */
  pause() {
    if (!this.state.isRunning || this.ending) return;
    this.halt();
  }

  /** Stop the clock and open a pause in the log, from `pausedAt` (ms) or now.
   *  Pause, and the sleep check, which pauses from the last tick. */
  private halt(pausedAt?: number) {
    this.plugin.logManager.pauseSession(pausedAt);
    this.state.isRunning = false;
    this.targetTime = null;
    this.clearLoop();
    this.emit();
  }

  /**
   * Finish the current session (Stop button): log it as finished and switch to
   * the next mode **paused**. Stop never auto-starts the next session, even when
   * the auto-start toggle is on — that's what Skip / natural completion are for.
   */
  async finish() {
    if (this.ending || this.askingLongSession) return;
    let end = this.endedByHand();
    const question = this.longSessionQuestion(end);
    if (question !== null) {
      // The end is claimed only once the answer lands, never while the
      // question is open: a claim held across it would leave every other
      // gesture — Pause, Skip, Reset, from the panel, a hotkey or the menu —
      // dead behind a dialog. (A second Stop asks nothing: the open question
      // answers it.) So the timer may have moved on meanwhile, and the answer
      // counts only for the session it was asked about.
      const askedFor = this.sessionSerial;
      const answer = await this.askLongSession(question);
      // Unloaded meanwhile (F19): the reloaded plugin offers the session.
      if (this.disposed || answer === "cancel" || this.sessionSerial !== askedFor) return;
      if (answer === "planned") end = plannedSessionEnd(question);
    }
    if (!this.beginEnding()) return;
    try {
      await this.finishClaimed(end);
    } finally {
      this.ending = false;
    }
  }

  /**
   * Stop asks before logging a focus that ran `longSessionPromptHours` or
   * more of active time AND past its planned end — a timer left running
   * overnight on a machine that never slept, which the sleep check cannot
   * see (F48). Null for anything else: a break, a session within its plan,
   * the question turned off. The rule is isLongSession, which the startup
   * question about a session an earlier run left asks by too (F18).
   */
  private longSessionQuestion(end: Required<SessionEnd>): LongSessionQuestion | null {
    const logManager = this.plugin.logManager;
    const active = logManager.openSessionActiveSeconds(end.endAt);
    const hours = this.plugin.settings.longSessionPromptHours;
    if (active === null || !isLongSession(this.state.mode, active, end.overtimeSeconds, hours)) {
      return null;
    }
    // The planned length off the clock, which allows for every ±5 (F20).
    // Not `active - overtime`: active counts whole-second stamps and overtime
    // the milliseconds past the end time, so about half of all answers ended
    // a second past the plan — End 09:25:01, Total 1501 beside Scheduled 1500.
    const planned = Math.floor(this.state.totalMs / 1000);
    const plannedEndAt = logManager.openSessionReachedAt(planned, end.endAt);
    if (plannedEndAt === null) return null;
    return { activeSeconds: active, overtimeSeconds: end.overtimeSeconds, plannedEndAt };
  }

  /** Ask through the plugin, one question at a time. A dialog that cannot be
   *  shown keeps the whole session, as every earlier version did — answering
   *  "cancel" instead would leave a Stop that could never stop. */
  private async askLongSession(question: LongSessionQuestion): Promise<LongSessionAnswer> {
    this.askingLongSession = true;
    try {
      return await this.plugin.askAboutLongSession(question);
    } catch (e) {
      logger.error("Could not ask about a long session; keeping all of it", e);
      return "keep";
    } finally {
      this.askingLongSession = false;
    }
  }

  private async finishClaimed(end: SessionEnd) {
    // Stop the tick FIRST. handleFinished() below awaits four vault round trips
    // before switchMode() replaces the state, and the 50ms loop keeps running
    // through all of them — so a Stop pressed a few hundred ms before zero used
    // to cue here, cross zero mid-await, and cue AGAIN from the crossing.
    // Harmless before 0.6.3, when the crossing made no sound; a measured double
    // cue now. switchMode() restarts the loop when it auto-starts.
    this.clearLoop();
    // Play specific sounds based on mode when manually finishing — unless the
    // opt-in chime already rang for this session in overtime.
    if (this.shouldPlayManualEndCue()) {
      this.playEndCue();
    }
    await this.handleFinished(false, end);
  }

  /**
   * Where a session the user ends — Stop, Skip — ends: now, with its active
   * time past the planned end (0 before zero). While running that is read off
   * the end time, which already allows for every pause and every ±5; while
   * paused, off the time the pause froze.
   */
  private endedByHand(): Required<SessionEnd> {
    const endAt = Date.now();
    const remaining =
      this.state.isRunning && this.targetTime !== null
        ? this.targetTime - endAt
        : this.state.remainingMs;
    return { endAt, overtimeSeconds: remaining < 0 ? Math.floor(-remaining / 1000) : 0 };
  }

  /** Skip the current session; logs focus skips as "cancelled" and rest skips as "finished". */
  async skip() {
    if (!this.beginEnding()) return;
    try {
      await this.skipClaimed();
    } finally {
      this.ending = false;
    }
  }

  private async skipClaimed() {
    // Stop the tick first — same reason as finish(): the awaits below outlast
    // the crossing, and a second cue would fire from the tick mid-skip.
    this.clearLoop();
    // Check if we are in a "stopped" state (fresh start, not running, not paused)
    const isStopped = !this.state.isRunning && this.state.remainingMs === this.state.totalMs;

    // Play specific sounds based on mode when skipping, unless stopped — or
    // unless the opt-in chime already rang for this session in overtime.
    if (!isStopped && this.shouldPlayManualEndCue()) {
      this.playEndCue();
    }

    const status = this.state.mode === "focus" ? "cancelled" : "finished";
    await this.plugin.logManager.endSession(status, this.endedByHand());

    await this.checkTaskCompletionAndUnlink();

    // Skip respects the auto-start toggle: with it on, the next session starts
    // running; with it off, it switches paused (same as Stop).
    const autoStart = this.autoStartsNext();
    const nextMode: PomoMode = this.state.mode === "focus" ? "break" : "focus";
    this.switchMode(nextMode, autoStart);
  }

  /**
   * Put the full length back on the clock and throw the session away (F7): no
   * line, no 🍅, no long-break step. Running, a fresh session begins at this
   * instant — new Start, no pauses, the war drum as for any fresh focus.
   * Paused part-way, the timer stops at full length with no session open.
   * Until 0.6.9 Reset touched only the clock: the log kept the old session,
   * and the next Start resumed it, old Start and hours-long pause included.
   * Skip is the other gesture: it logs what was done.
   */
  reset() {
    if (this.ending) return;
    const minutes = this.sessionMinutes(this.state.mode, this.state.breakType);
    const total = minutes * ONE_MINUTE_MS;
    const discarded = this.sessionInProgress();

    this.plugin.logManager.discardSession();
    // The session on the clock is gone; a status bar menu opened for it must
    // not act on the one that follows.
    if (discarded) this.sessionSerial += 1;

    this.state.remainingMs = total;
    this.state.totalMs = total;
    // Time is back on the clock, so it can cross zero again — a stale "already
    // chimed" flag would silence the cue for that second crossing's Stop.
    this.endCueSounded = false;

    // The session that held the unlink back is gone (see onFileModify) — on
    // every Reset that throws one away, running too (F12): a task ticked done
    // during a running session stayed linked, and the fresh session below was
    // logged to it and 🍅'd its done line. Called before that session opens;
    // the note is read first, so a done task still leaves it a moment later.
    if (discarded) void this.checkTaskCompletionAndUnlink();

    if (this.state.isRunning) {
      this.plugin.logManager.startSession(
        this.state.mode,
        this.currentTaskName,
        minutes,
        this.currentTaskPath,
        this.currentTaskId,
        this.state.breakType
      );
      this.targetTime = Date.now() + total;
      if (this.state.mode === "focus") void this.playSound("war-drum_short.mp3");
      this.armEndWake();
    } else {
      this.targetTime = null;
      this.clearLoop();
    }

    this.emit();
  }

  /** Adjust total and remaining by `delta` minutes (clamped to a 1-minute minimum total). */
  addMinutes(delta: number) {
    if (this.ending) return;
    const deltaMs = delta * ONE_MINUTE_MS;

    // 1. Update the Total Duration
    let newTotal = this.state.totalMs + deltaMs;
    const minTotal = ONE_MINUTE_MS;
    if (newTotal < minTotal) newTotal = minTotal;

    // 2. Update Remaining Time with Clamp
    const oldRemaining = this.state.remainingMs;
    let newRemaining = oldRemaining + deltaMs;

    if (newRemaining > newTotal) newRemaining = newTotal;

    this.state.totalMs = newTotal;
    this.state.remainingMs = newRemaining;
    // A recovered focus counts its Overtime past this length (F16).
    this.plugin.logManager.plannedLengthChanged();

    // Same rule as reset(): once the clock is positive again it can cross zero
    // a second time, and a stale flag would silence that crossing's Stop. The
    // +5 button is reachable in overtime, so this is a real path, not a guard
    // against a hypothetical.
    if (newRemaining > 0) this.endCueSounded = false;

    // 3. Shift the Wall-Clock Target
    if (this.state.isRunning && this.targetTime !== null) {
      const effectiveChange = newRemaining - oldRemaining;
      this.targetTime += effectiveChange;
      this.armEndWake();
    }
    this.emit();
  }

  /**
   * A length setting changed (write it first). Only the session that reads
   * that setting follows it — so "Break (m)" leaves a long break alone — and
   * only while it has not begun. A session under way keeps its length and the
   * next one takes the new one (F17): moving the total alone made the meter,
   * the ring and the sky jump by the difference, while the session still ran
   * out at its old time and logged its old Scheduled.
   */
  updateDuration(setting: DurationSetting) {
    if (this.ending) return;
    if (this.durationSetting(this.state.mode, this.state.breakType) !== setting) return;
    if (this.sessionInProgress()) return;
    const newTotal = this.plugin.settings[setting] * ONE_MINUTE_MS;
    this.state.remainingMs = newTotal;
    this.state.totalMs = newTotal;
    this.emit();
  }
}
