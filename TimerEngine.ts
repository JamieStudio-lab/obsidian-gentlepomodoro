import { TAbstractFile, TFile } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { PomoMode, TimerListener, TimerState } from "./types";
import type { MomentFactory } from "./momentTypes";
import { NO_TASK_LABEL, ONE_MINUTE_MS } from "./constants";
import { logger } from "./logger";
import {
  TASK_LINE_REGEX,
  findTaskNameById,
  incrementPomodoroCount,
  normalizeTaskText,
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

const TASK_ID_REGEX = /🆔\s*([A-Za-z0-9_-]+)/;

// Local-timezone YYYY-MM-DD; matches the format LogManager uses for daily log filenames.
const todayLocalStr = (): string => moment().format("YYYY-MM-DD");

/** How loading one of the user's sound files ended. */
export type CueLoad = { ok: true; buffer: AudioBuffer } | { ok: false; problem: CueProblem };

/** One decoded (or failed) version of a user's sound file. */
interface CustomCueEntry {
  /** The file's mtime and size when it was read — an edit makes a new version. */
  version: string;
  result: Promise<CueLoad>;
  /** Filled in when `result` lands; a cue only ever plays a settled entry. */
  settled: CueLoad | null;
}

const fileVersion = (file: TFile): string => `${String(file.stat.mtime)}|${String(file.stat.size)}`;

const END_CUE_EDGES: readonly CueEdge[] = ["focus", "break"];

// How long a stopped preview takes to fall silent. Stopping a sound dead
// mid-waveform clicks; this is short enough to read as "stopped at once".
const PREVIEW_STOP_FADE_S = 0.08;

/** The settings tab's preview while it plays: the one sound that can be stopped. */
interface PlayingPreview {
  edge: CueEdge;
  source: AudioBufferSourceNode;
  gain: GainNode;
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

  // Track current task name for logging
  public currentTaskName: string = NO_TASK_LABEL;
  public currentTaskPath: string | undefined;

  public currentTaskId: string | undefined;

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

  /** Update the active task and notify LogManager so future log lines reflect the change. */
  setTask(name: string, path?: string, taskId?: string) {
    this.currentTaskName = name;
    this.currentTaskPath = path;
    this.currentTaskId = taskId;
    this.state.taskName = name;
    this.plugin.logManager.updateTask(name, path, taskId);
    this.emit();
  }

  /**
   * Reaction to vault file changes. If the modified file holds the active task,
   * refreshes the task name (when ID is known) and auto-unlinks if it's now
   * completed (only while not currently running).
   */
  async onFileModify(file: TAbstractFile) {
    // A chosen sound file changed — edited, or updated by sync. Decode the new
    // version now, so the next cue plays it rather than the built-in while it
    // loads. Before the task checks, which return early when no task is linked.
    if (this.isEndCueFile(file.path)) void this.loadCustomCue(file.path);

    // 1. Basic checks
    if (this.currentTaskName === NO_TASK_LABEL || !this.currentTaskPath) return;

    // 2. Check if modified file matches current task file
    if (file.path !== this.currentTaskPath) return;

    // 3. Refresh task name by ID (if available)
    if (this.currentTaskId) {
      const latestName = await findTaskNameById(
        this.plugin.app,
        this.currentTaskPath,
        this.currentTaskId
      );
      if (latestName && latestName !== this.currentTaskName) {
        this.setTask(latestName, this.currentTaskPath, this.currentTaskId);
        await this.plugin.logManager.updateLoggedTaskName(
          this.currentTaskId,
          latestName,
          this.currentTaskPath
        );
      }
    }

    // 4. If timer is running, do NOT unlink automatically (per requirements)
    if (this.state.isRunning) return;

    // 5. Check completion
    await this.checkTaskCompletionAndUnlink();
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

    this.intervalId = window.setInterval(() => this.tick(), 50);
    this.armEndWake();
  }

  private tick() {
    if (!this.state.isRunning || this.targetTime === null) return;

    // Calculate remaining time based on system clock
    const now = Date.now();
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
      const autoStart =
        this.state.mode === "focus"
          ? this.plugin.settings.autoStartBreak
          : this.plugin.settings.autoStartFocus;
      // The opt-in system notification (0.6.6). Placed ABOVE the branch so
      // both paths post it, and read here because state.mode is still the
      // mode that ENDED — completeNaturally() switches it. It is silent and
      // changes nothing about the timer, so the overtime guarantee below
      // still holds. The plugin owns it: the engine does no UI.
      this.plugin.notifySessionEnd(this.state.mode, autoStart);
      if (autoStart) {
        this.state.remainingMs = 0; // freeze display at 00:00
        this.clearLoop(); // stop ticking; completeNaturally restarts the loop
        this.emit();
        void this.completeNaturally();
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
   */
  private async completeNaturally() {
    if (this.endChimeWanted()) this.playEndCue();
    // Natural completion only fires when the toggle is on → auto-start the next.
    await this.handleFinished(true);
  }

  private async handleFinished(autoStartNext: boolean) {
    // Log the finished session
    await this.plugin.logManager.endSession("finished");

    // For focus sessions: optionally increment the task's pomodoro count
    // BEFORE the unlink check so we don't skip on a just-completed task.
    if (this.state.mode === "focus") {
      await this.maybeIncrementTaskPomodoroCount();
    }

    // Check if task is completed and unlink if so
    await this.checkTaskCompletionAndUnlink();

    if (this.state.mode === "focus") {
      // Advance the long-break counter, resetting at local-midnight rollover.
      const today = todayLocalStr();
      const counter =
        this.plugin.settings.sessionCounterDate === today
          ? this.plugin.settings.sessionsSinceLongBreak + 1
          : 1;
      this.plugin.settings.sessionsSinceLongBreak = counter;
      this.plugin.settings.sessionCounterDate = today;
      await this.plugin.saveSettings();

      const longBreakEvery = Math.max(1, this.plugin.settings.longBreakEvery);
      const isLongBreak = counter % longBreakEvery === 0;
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
  private async maybeIncrementTaskPomodoroCount() {
    if (!this.plugin.settings.incrementPomodoroCountOnFinish) return;
    if (!this.currentTaskPath || this.currentTaskName === NO_TASK_LABEL) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(this.currentTaskPath);
    if (!(file instanceof TFile)) return;

    try {
      // Atomic read-modify-write: `process` locks the file, so a concurrent
      // sync/plugin write can't be clobbered between our read and write.
      await this.plugin.app.vault.process(file, (content) => {
        const lines = content.split("\n");
        let updatedIndex = -1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Prefer ID match when available.
          if (this.currentTaskId) {
            const idMatch = line.match(TASK_ID_REGEX);
            if (idMatch && idMatch[1] === this.currentTaskId) {
              updatedIndex = i;
              break;
            }
            continue;
          }
          // Fallback: match by normalized text on a task line (open or completed).
          const taskMatch = line.match(TASK_LINE_REGEX);
          if (taskMatch && normalizeTaskText(taskMatch[2]) === this.currentTaskName) {
            updatedIndex = i;
            break;
          }
        }

        if (updatedIndex === -1) return content;

        lines[updatedIndex] = incrementPomodoroCount(lines[updatedIndex]);
        return lines.join("\n");
      });
    } catch (e) {
      logger.warn("Failed to increment task pomodoro count", e);
    }
  }

  private async checkTaskCompletionAndUnlink() {
    if (!this.currentTaskPath || this.currentTaskName === NO_TASK_LABEL) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(this.currentTaskPath);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.plugin.app.vault.read(file);
      // CRLF-safe split: this path only reads, and the $-anchored
      // TASK_LINE_REGEX can't match a line with a trailing \r. Write paths
      // (marker increment/repair) must keep split("\n") — they rejoin on "\n".
      const lines = content.split(/\r?\n/);

      let foundIncomplete = false;
      let foundComplete = false;

      for (const line of lines) {
        // If current task has ID, match by ID
        if (this.currentTaskId) {
          const idMatch = line.match(TASK_ID_REGEX);
          if (idMatch && idMatch[1] === this.currentTaskId) {
            const taskMatch = line.match(TASK_LINE_REGEX);
            if (taskMatch?.[1] === " ") {
              foundIncomplete = true;
              break;
            }
            if (taskMatch) {
              foundComplete = true;
            }
          }
          continue;
        }

        // Fallback: match by normalized text
        const taskMatch = line.match(TASK_LINE_REGEX);
        if (taskMatch && normalizeTaskText(taskMatch[2]) === this.currentTaskName) {
          if (taskMatch[1] === " ") {
            foundIncomplete = true;
            break;
          }
          foundComplete = true;
        }
      }

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
   * the promise). A MISSING file is not cached: finding that out is a lookup,
   * and a file still syncing should be found by the next cue rather than
   * remembered as gone. Nor is a failed READ — see below.
   */
  loadCustomCue(path: string): Promise<CueLoad> {
    const file = this.plugin.app.vault.getFileByPath(path);
    if (file === null) return Promise.resolve({ ok: false, problem: "missing" });
    const version = fileVersion(file);
    const cached = this.customCues.get(path);
    if (cached !== undefined && cached.version === version) return cached.result;

    const entry: CustomCueEntry = { version, result: this.decodeCustomCue(file), settled: null };
    void entry.result.then((load) => {
      entry.settled = load;
      // A read that failed says nothing about the file — iCloud still
      // downloading an offloaded one, OneDrive or an antivirus holding it —
      // and its mtime and size do not change when it becomes readable. Cached,
      // it would be refused, and every cue would play the built-in, until the
      // file was edited or Obsidian restarted. Forget it, as for a missing file.
      if (!load.ok && load.problem === "unreadable" && this.customCues.get(path) === entry) {
        this.customCues.delete(path);
      }
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
      // Already ended between the check and the stop: nothing to silence.
      logger.debug("Preview had already stopped", e);
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
   * Transition to the given mode. When entering break, `isLongBreak` selects
   * `longBreakMinutes` over `breakMinutes` and records the type on the state
   * so the log line can include it.
   */
  switchMode(mode: PomoMode, autoStart = false, isLongBreak = false) {
    let minutes: number;
    let breakType: "short" | "long" | null;
    if (mode === "focus") {
      minutes = this.plugin.settings.focusMinutes;
      breakType = null;
    } else if (isLongBreak) {
      minutes = this.plugin.settings.longBreakMinutes;
      breakType = "long";
    } else {
      minutes = this.plugin.settings.breakMinutes;
      breakType = "short";
    }

    const total = minutes * ONE_MINUTE_MS;

    // A new session has its own end to announce.
    this.endCueSounded = false;

    this.state = {
      mode,
      isRunning: autoStart,
      remainingMs: total,
      totalMs: total,
      taskName: this.currentTaskName,
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
    if (this.state.isRunning) return;

    // Check if this is a fresh start (not a resume)
    const isFreshStart = this.state.remainingMs === this.state.totalMs;

    this.state.isRunning = true;

    // Start or Resume Logging
    const minutes =
      this.state.mode === "focus"
        ? this.plugin.settings.focusMinutes
        : this.plugin.settings.breakMinutes;
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
    if (!this.state.isRunning) return;

    // Log Pause
    this.plugin.logManager.pauseSession();

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
    await this.handleFinished(false);
  }

  /** Skip the current session; logs focus skips as "cancelled" and rest skips as "finished". */
  async skip() {
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
    await this.plugin.logManager.endSession(status);

    await this.checkTaskCompletionAndUnlink();

    // Skip respects the auto-start toggle: with it on, the next session starts
    // running; with it off, it switches paused (same as Stop).
    const autoStart =
      this.state.mode === "focus"
        ? this.plugin.settings.autoStartBreak
        : this.plugin.settings.autoStartFocus;
    const nextMode: PomoMode = this.state.mode === "focus" ? "break" : "focus";
    this.switchMode(nextMode, autoStart);
  }

  // Cancel current session without switching modes; not in use currently
  async cancel() {
    await this.plugin.logManager.endSession("cancelled");
    await this.checkTaskCompletionAndUnlink();
    this.switchMode(this.state.mode, false);
  }

  reset() {
    const minutes =
      this.state.mode === "focus"
        ? this.plugin.settings.focusMinutes
        : this.plugin.settings.breakMinutes;
    const total = minutes * ONE_MINUTE_MS;

    this.state.remainingMs = total;
    this.state.totalMs = total;
    // Time is back on the clock, so it can cross zero again — a stale "already
    // chimed" flag would silence the cue for that second crossing's Stop.
    this.endCueSounded = false;

    if (this.state.isRunning) {
      this.targetTime = Date.now() + total;
      this.armEndWake();
    } else {
      this.targetTime = null;
      this.clearLoop();
    }

    this.emit();
  }

  /** Adjust total and remaining by `delta` minutes (clamped to a 1-minute minimum total). */
  addMinutes(delta: number) {
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

  /** Change a mode's configured duration; takes effect immediately only if that mode is fresh-stopped. */
  updateDuration(mode: PomoMode, minutes: number) {
    if (this.state.mode === mode) {
      const newTotal = minutes * ONE_MINUTE_MS;
      if (!this.state.isRunning && this.state.remainingMs === this.state.totalMs) {
        this.state.remainingMs = newTotal;
      }
      this.state.totalMs = newTotal;
      this.emit();
    }
  }
}
