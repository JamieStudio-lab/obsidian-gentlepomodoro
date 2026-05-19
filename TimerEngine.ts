import { TAbstractFile, TFile } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { PomoMode, TimerListener, TimerState } from "./types";
import type { MomentFactory } from "./momentTypes";
import { NO_TASK_LABEL, ONE_MINUTE_MS } from "./constants";
import { logger } from "./logger";
import { findTaskNameById, incrementPomodoroCount, normalizeTaskText } from "./taskLoader";

declare const moment: MomentFactory;

const TASK_ID_REGEX = /🆔\s*([A-Za-z0-9_-]+)/;

// Local-timezone YYYY-MM-DD; matches the format LogManager uses for daily log filenames.
const todayLocalStr = (): string => moment().format("YYYY-MM-DD");

export class TimerEngine {
  private state: TimerState;
  private intervalId: number | null = null;
  private listeners: Set<TimerListener> = new Set();
  private plugin: GentlePomoPlugin;

  // Track the target end time (timestamp)
  private targetTime: number | null = null;

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
  }

  private startLoop() {
    this.clearLoop();

    // Safety: Ensure targetTime is set if running
    if (this.state.isRunning && this.targetTime === null) {
      this.targetTime = Date.now() + this.state.remainingMs;
    }

    this.intervalId = window.setInterval(() => {
      if (!this.state.isRunning || this.targetTime === null) return;

      // Calculate remaining time based on system clock
      const now = Date.now();
      this.state.remainingMs = this.targetTime - now;

      this.emit();
    }, 50);
  }

  private async handleFinished() {
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
      this.switchMode("break", this.plugin.settings.autoStartBreak, isLongBreak);
    } else {
      this.switchMode("focus", this.plugin.settings.autoStartFocus);
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
      const content = await this.plugin.app.vault.read(file);
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
        const taskMatch = line.match(/^\s*-\s*\[( |x)\]\s+(.*)$/i);
        if (taskMatch && normalizeTaskText(taskMatch[2]) === this.currentTaskName) {
          updatedIndex = i;
          break;
        }
      }

      if (updatedIndex === -1) return;

      lines[updatedIndex] = incrementPomodoroCount(lines[updatedIndex]);
      await this.plugin.app.vault.modify(file, lines.join("\n"));
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
      const lines = content.split("\n");

      let foundIncomplete = false;
      let foundComplete = false;

      for (const line of lines) {
        // If current task has ID, match by ID
        if (this.currentTaskId) {
          const idMatch = line.match(TASK_ID_REGEX);
          if (idMatch && idMatch[1] === this.currentTaskId) {
            if (/^\s*-\s*\[ \]\s+/.test(line)) {
              foundIncomplete = true;
              break;
            }
            if (/^\s*-\s*\[x\]\s+/i.test(line)) {
              foundComplete = true;
            }
          }
          continue;
        }

        // Fallback: match by normalized text
        const incompleteMatch = line.match(/^\s*-\s*\[ \]\s+(.*)$/);
        if (incompleteMatch) {
          const clean = normalizeTaskText(incompleteMatch[1]);
          if (clean === this.currentTaskName) {
            foundIncomplete = true;
            break;
          }
        }

        const completeMatch = line.match(/^\s*-\s*\[x\]\s+(.*)$/i);
        if (completeMatch) {
          const clean = normalizeTaskText(completeMatch[1]);
          if (clean === this.currentTaskName) {
            foundComplete = true;
          }
        }
      }

      if (!foundIncomplete && foundComplete) {
        this.setTask(NO_TASK_LABEL);
      }
    } catch (e) {
      logger.error("Failed to check task completion", e);
    }
  }

  private async playSound(filename: string) {
    if (!this.plugin.settings.soundEnabled) return;

    try {
      const pluginDir = this.plugin.manifest.dir;
      if (pluginDir) {
        const soundFile = `${pluginDir}/${filename}`;
        const exists = await this.plugin.app.vault.adapter.exists(soundFile);

        if (exists) {
          const arrayBuffer = await this.plugin.app.vault.adapter.readBinary(soundFile);
          const AudioContextCtor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

          if (!AudioContextCtor) return;
          const ctx = new AudioContextCtor();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;

          const gain = ctx.createGain();
          gain.gain.value = this.plugin.settings.soundVolume;

          source.connect(gain);
          gain.connect(ctx.destination);
          source.start(0);
        } else {
          logger.debug(`Sound file not found: ${soundFile}`);
        }
      }
    } catch (e) {
      logger.error(`Failed to play sound ${filename}:`, e);
    }
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

  /** Finish the current session, log it as finished, and switch to the next mode. */
  async finish() {
    // Play specific sounds based on mode when manually finishing
    if (this.state.mode === "focus") {
      void this.playSound("singing_bell_short.mp3");
    } else {
      void this.playSound("ding-sound.mp3");
    }
    await this.handleFinished();
  }

  /** Skip the current session; logs focus skips as "cancelled" and rest skips as "finished". */
  async skip() {
    // Check if we are in a "stopped" state (fresh start, not running, not paused)
    const isStopped = !this.state.isRunning && this.state.remainingMs === this.state.totalMs;

    // Play specific sounds based on mode when skipping, unless stopped
    if (!isStopped) {
      if (this.state.mode === "focus") {
        void this.playSound("singing_bell_short.mp3");
      } else {
        void this.playSound("ding-sound.mp3");
      }
    }

    const status = this.state.mode === "focus" ? "cancelled" : "finished";
    await this.plugin.logManager.endSession(status);

    await this.checkTaskCompletionAndUnlink();

    const nextMode: PomoMode = this.state.mode === "focus" ? "break" : "focus";
    this.switchMode(nextMode, false);
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

    if (this.state.isRunning) {
      this.targetTime = Date.now() + total;
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

    // 3. Shift the Wall-Clock Target
    if (this.state.isRunning && this.targetTime !== null) {
      const effectiveChange = newRemaining - oldRemaining;
      this.targetTime += effectiveChange;
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
