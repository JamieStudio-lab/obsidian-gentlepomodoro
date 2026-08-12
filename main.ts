import { Notice, Plugin, WorkspaceLeaf } from "obsidian";

import { confirmAction } from "./confirmModal";
import { GentlePomoSettingTab } from "./GentlePomoSettingTab";
import { GentlePomoView } from "./GentlePomoView";
import { LogManager, effectiveFocusBaseSeconds, shouldFireGoalNotice } from "./logManager";
import { logger } from "./logger";
import {
  removeAllPomodoroMarkersInVault,
  removeMisplacedPomodoroMarkersInVault,
  repairPomodoroMarkersInVault,
  scanAllPomodoroMarkersInVault,
  scanMisplacedPomodoroMarkersInVault,
} from "./taskLoader";
import { TimerEngine } from "./TimerEngine";
import {
  DEFAULT_SETTINGS,
  FOCUS_TOTAL_CACHE_TTL_MS,
  FOCUS_TOTAL_HEARTBEAT_MS,
  MUSIC_POSITION_SAVE_MS,
  VIEW_TYPE_GENTLE_POMO,
} from "./constants";
import type { GentlePomoSettings, PomoMode, TimerListener, TimerState } from "./types";
import type { MusicResumeState } from "./youtubeMusic";
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

// Local-timezone YYYY-MM-DD; matches LogManager's daily-log file naming.
const todayLocalStr = (): string => moment().format("YYYY-MM-DD");

export default class GentlePomoPlugin extends Plugin {
  override settings!: GentlePomoSettings;
  timer!: TimerEngine;
  logManager!: LogManager;
  private statusBarEl: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private statusLabel: HTMLElement | null = null;
  private statusModeEl: HTMLElement | null = null;
  private statusTimeEl: HTMLElement | null = null;
  private statusFocusTotal: HTMLElement | null = null;
  private lastStatusRender: { second: number; mode: PomoMode; running: boolean } | null = null;
  private statusFocusBaseSeconds = 0;
  /** Local date (YYYY-MM-DD) the cached base was fetched for; other days count as 0. */
  private statusFocusBaseDate: string | null = null;
  private statusFocusLastFetchMs = 0;
  private statusFocusFetchInFlight = false;
  private statusTimerListener: TimerListener | null = null;
  private goalTimerListener: TimerListener | null = null;
  private autoOpenObserver: MutationObserver | null = null;
  private repairInFlight = false;
  /** Set when the remembered music position has moved since the last save. */
  private musicPositionDirty = false;

  override async onload() {
    await this.loadSettings();
    this.logManager = new LogManager(this);
    this.timer = new TimerEngine(this);

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        await this.timer.onFileModify(file);
      })
    );

    this.registerView(VIEW_TYPE_GENTLE_POMO, (leaf) => new GentlePomoView(leaf, this));

    this.addRibbonIcon("clock", "Gentle pomodoro", () => {
      void this.activateView();
    });

    this.addSettingTab(new GentlePomoSettingTab(this.app, this));

    this.addCommand({
      id: "refresh-logs-by-task-id",
      name: "Refresh log task names by ID",
      callback: async () => {
        await this.logManager.refreshLoggedTaskNamesById();
      },
    });

    this.addCommand({
      id: "open-view",
      name: "Open view",
      callback: async () => {
        await this.activateView();
      },
    });

    this.addCommand({
      id: "start",
      name: "Start",
      checkCallback: (checking: boolean) => {
        const state = this.timer.getState();
        if (checking) return !state.isRunning;
        this.timer.start();
        return true;
      },
    });

    this.addCommand({
      id: "pause",
      name: "Pause",
      checkCallback: (checking: boolean) => {
        const state = this.timer.getState();
        if (checking) return state.isRunning;
        this.timer.pause();
        return true;
      },
    });

    this.addCommand({
      id: "finish",
      name: "Finish & next",
      checkCallback: (checking: boolean) => {
        const state = this.timer.getState();
        const canShow = state.isRunning || state.remainingMs !== state.totalMs;
        if (checking) return canShow;
        void this.timer.finish();
        return true;
      },
    });

    this.addCommand({
      id: "skip",
      name: "Skip to next",
      callback: () => {
        void this.timer.skip();
      },
    });

    this.addCommand({
      id: "show-status-bar",
      name: "Show status bar",
      checkCallback: (checking: boolean) => {
        if (checking) return !this.settings.showInStatusBar;
        void this.setStatusBarVisibility(true);
        return true;
      },
    });

    this.addCommand({
      id: "hide-status-bar",
      name: "Hide status bar",
      checkCallback: (checking: boolean) => {
        if (checking) return this.settings.showInStatusBar;
        void this.setStatusBarVisibility(false);
        return true;
      },
    });

    this.addCommand({
      id: "check-task-pomodoro-markers",
      name: "Check for misplaced pomodoro count markers",
      callback: () => {
        void this.checkPomodoroMarkers();
      },
    });

    this.addCommand({
      id: "repair-task-pomodoro-markers",
      name: "Repair misplaced pomodoro count markers",
      callback: () => {
        void this.repairPomodoroMarkers();
      },
    });

    this.addCommand({
      id: "remove-task-pomodoro-markers",
      name: "Remove misplaced pomodoro count markers",
      callback: () => {
        void this.removeMisplacedPomodoroMarkers();
      },
    });

    this.addCommand({
      id: "remove-all-task-pomodoro-markers",
      name: "Remove all pomodoro count markers",
      callback: () => {
        void this.removeAllPomodoroMarkers();
      },
    });

    // Goal bookkeeping subscribes to the engine directly, independent of the
    // status bar — it must keep working with "Show in status bar" off, where
    // the status-bar listener is unregistered. Emits only kick the guarded
    // refetch; the once-per-day goal notice fires from the refetch landing in
    // maybeRefreshFocusTotal, against logged totals only (see
    // maybeFireGoalNotice for why). onChange invokes the listener immediately,
    // so no extra bootstrap call is needed.
    this.goalTimerListener = () => {
      void this.maybeRefreshFocusTotal();
    };
    this.timer.onChange(this.goalTimerListener);

    // Idle heartbeat: every trigger above is engine-emit-driven, and the engine
    // is silent while idle — so an app left open across local midnight keeps
    // yesterday's total on screen until the first interaction of the new day.
    // The refetch is fully guarded (30s TTL, stale-date bypass), so quiet beats
    // are nearly free; when the date stamp is stale it refetches, and the
    // landing force-renders the status bar and pushes into open views. The
    // window-focus kick corrects a laptop waking from overnight sleep
    // immediately instead of within a minute.
    this.registerInterval(
      window.setInterval(() => {
        void this.maybeRefreshFocusTotal();
      }, FOCUS_TOTAL_HEARTBEAT_MS)
    );
    this.registerDomEvent(window, "focus", () => {
      void this.maybeRefreshFocusTotal();
    });

    // Safety net for the remembered music position. Every deliberate save is a
    // boundary (pause, stop, track end, panel close, unload); this catches the
    // force-quit/crash case, and writes nothing unless the position moved.
    this.registerInterval(
      window.setInterval(() => {
        this.flushMusicPosition();
      }, MUSIC_POSITION_SAVE_MS)
    );

    void this.setStatusBarVisibility(this.settings.showInStatusBar, false);

    // Defer auto-open until Obsidian has finished initial layout setup.
    this.app.workspace.onLayoutReady(() => {
      this.maybeAutoOpenView();
    });
  }

  /**
   * Shared runner for the marker-maintenance actions (check / repair /
   * remove): one at a time, failures reported instead of thrown.
   */
  private async runMarkerMaintenance(label: string, action: () => Promise<void>): Promise<void> {
    if (this.repairInFlight) return;
    this.repairInFlight = true;
    try {
      await action();
    } catch (e) {
      logger.error(`Failed to ${label} pomodoro markers`, e);
      new Notice(`Gentle pomodoro: ${label} failed — see the developer console for details.`);
    } finally {
      this.repairInFlight = false;
    }
  }

  /**
   * Dry run for the ≤0.5.0 marker misplacement (issue #2): count affected
   * lines without changing any file, and log the per-file breakdown so the
   * user can inspect before repairing or removing.
   */
  async checkPomodoroMarkers(): Promise<void> {
    await this.runMarkerMaintenance("check", async () => {
      const result = await scanMisplacedPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      if (result.linesAffected === 0) {
        new Notice(
          `Gentle pomodoro: no misplaced 🍅 markers found (${result.filesScanned} file(s) scanned). Nothing to repair.`
        );
        return;
      }
      for (const f of result.affected) {
        logger.warn(`Misplaced 🍅 marker check: ${f.lines} line(s) in "${f.path}"`);
      }
      new Notice(
        `Gentle pomodoro: found ${result.linesAffected} misplaced 🍅 marker(s) in ${result.filesAffected} of ${result.filesScanned} file(s). Nothing was changed — the affected files are listed in the developer console.`
      );
    });
  }

  /**
   * One-shot fix for task lines written by ≤0.5.0, whose 🍅 marker landed
   * after the Tasks fields and hid them from the Tasks plugin (issue #2).
   * Rewrites only lines whose marker is in a harmful position, keeping the
   * counts, and reports what it did.
   */
  async repairPomodoroMarkers(): Promise<void> {
    await this.runMarkerMaintenance("repair", async () => {
      const scan = await scanMisplacedPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      if (scan.linesAffected === 0) {
        new Notice(
          `Gentle pomodoro: no misplaced 🍅 markers found (${scan.filesScanned} file(s) scanned).`
        );
        return;
      }

      const confirmed = await confirmAction(this.app, {
        title: "Repair misplaced pomodoro markers?",
        body: `Move ${scan.linesAffected} misplaced 🍅 marker(s) in ${scan.filesAffected} file(s) back in front of the Tasks fields? Their counts are kept.`,
        ctaText: `Repair ${scan.linesAffected} marker(s)`,
      });
      if (!confirmed) return;

      const result = await repairPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      new Notice(
        `Gentle pomodoro: repaired ${result.linesAffected} task line(s) in ${result.filesAffected} file(s).`
      );
    });
  }

  /**
   * Alternative to repair: delete misplaced 🍅 markers, restoring affected
   * lines to their pre-bug form (their lifetime counts are lost). Correctly
   * placed markers are never touched.
   */
  async removeMisplacedPomodoroMarkers(): Promise<void> {
    await this.runMarkerMaintenance("remove", async () => {
      const scan = await scanMisplacedPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      if (scan.linesAffected === 0) {
        new Notice(
          `Gentle pomodoro: no misplaced 🍅 markers found (${scan.filesScanned} file(s) scanned).`
        );
        return;
      }

      const confirmed = await confirmAction(this.app, {
        title: "Remove misplaced pomodoro markers?",
        body: `Delete ${scan.linesAffected} misplaced 🍅 marker(s) in ${scan.filesAffected} file(s)? Their lifetime counts will be lost.`,
        ctaText: `Remove ${scan.linesAffected} marker(s)`,
        destructive: true,
      });
      if (!confirmed) return;

      const result = await removeMisplacedPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      new Notice(
        `Gentle pomodoro: removed ${result.linesAffected} misplaced 🍅 marker(s) in ${result.filesAffected} file(s).`
      );
    });
  }

  /**
   * The counter's "uninstall": delete every plugin-written 🍅 marker,
   * correctly placed or misplaced. A `🍅 N` the user typed mid-description
   * is never touched (see removeAnyPomodoroMarker).
   */
  async removeAllPomodoroMarkers(): Promise<void> {
    await this.runMarkerMaintenance("remove", async () => {
      const scan = await scanAllPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      if (scan.linesAffected === 0) {
        new Notice(`Gentle pomodoro: no 🍅 markers found (${scan.filesScanned} file(s) scanned).`);
        return;
      }

      const confirmed = await confirmAction(this.app, {
        title: "Remove all pomodoro markers?",
        body: `Delete ${scan.linesAffected} 🍅 marker(s) in ${scan.filesAffected} file(s)? All lifetime counts will be lost and this cannot be undone — consider backing up your vault first.`,
        ctaText: `Remove ${scan.linesAffected} marker(s)`,
        destructive: true,
      });
      if (!confirmed) return;

      const result = await removeAllPomodoroMarkersInVault(this.app, this.settings.tasksPath);
      new Notice(
        `Gentle pomodoro: removed ${result.linesAffected} 🍅 marker(s) in ${result.filesAffected} file(s).`
      );
    });
  }

  override onunload() {
    // Best effort — saveSettings is async and a hard quit may cut it short,
    // which is what the MUSIC_POSITION_SAVE_MS interval backstops.
    this.flushMusicPosition();

    if (this.autoOpenObserver) {
      this.autoOpenObserver.disconnect();
      this.autoOpenObserver = null;
    }

    if (this.goalTimerListener) {
      this.timer.offChange(this.goalTimerListener);
      this.goalTimerListener = null;
    }

    this.destroyStatusBar();

    // Release the tick loop + shared AudioContext so they don't leak across
    // plugin disable/enable cycles.
    if (this.timer) this.timer.dispose();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_GENTLE_POMO, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<GentlePomoSettings> | null;
    // Migrate legacy "sunset" → "classic" (renamed in 2026-05-26). Saved
    // once so future loads don't repeat the rewrite.
    let migrated = false;
    if (loaded && (loaded.theme as unknown) === "sunset") {
      loaded.theme = "classic";
      migrated = true;
    }
    // First-run/upgrade default for the task-selector toggle: derive it once from
    // the tasks path (hidden when no path is set, shown when a path exists), then
    // persist so the user's explicit choice sticks on later loads.
    const deriveTaskSelector = !loaded || loaded.showTaskSelector === undefined;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (deriveTaskSelector) {
      this.settings.showTaskSelector = this.settings.tasksPath.trim() !== "";
      migrated = true;
    }
    if (migrated) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private maybeAutoOpenView() {
    if (!this.settings.autoOpenOnStartup) return;

    if (!this.isSettingsModalOpen()) {
      void this.activateView();
      return;
    }

    if (this.autoOpenObserver) return;

    this.autoOpenObserver = new MutationObserver(() => {
      if (!this.isSettingsModalOpen()) {
        this.autoOpenObserver?.disconnect();
        this.autoOpenObserver = null;
        void this.activateView();
      }
    });

    this.autoOpenObserver.observe(activeDocument.body, { childList: true, subtree: true });
  }

  private isSettingsModalOpen(): boolean {
    return Boolean(
      activeDocument.querySelector(
        ".modal.mod-settings, .modal-container.mod-settings, .modal.mod-community-plugins, .modal-container.mod-community-plugins"
      )
    );
  }

  async setStatusBarVisibility(show: boolean, persist = true) {
    if (persist) {
      this.settings.showInStatusBar = show;
      await this.saveSettings();
    }

    if (show) {
      this.createStatusBar();
    } else {
      this.destroyStatusBar();
    }
  }

  private createStatusBar() {
    if (this.statusBarEl) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gp-status");

    this.statusDot = this.statusBarEl.createDiv("gp-status-dot");
    this.statusLabel = this.statusBarEl.createSpan({ cls: "gp-status-label" });
    this.statusModeEl = this.statusLabel.createSpan({ cls: "gp-status-mode" });
    this.statusTimeEl = this.statusLabel.createSpan({ cls: "gp-status-time" });
    this.statusFocusTotal = this.statusBarEl.createSpan({ cls: "gp-status-focus-total" });

    this.registerDomEvent(this.statusDot, "click", (evt) => {
      evt.preventDefault();
      void this.activateView();
    });

    this.registerDomEvent(this.statusLabel, "click", async (evt) => {
      evt.preventDefault();
      this.settings.showStatusBarTimeLeft = !this.settings.showStatusBarTimeLeft;
      await this.saveSettings();
      this.updateStatusBar(this.timer.getState(), true);
    });

    this.statusTimerListener = (state) => {
      this.updateStatusBar(state);
    };
    this.timer.onChange(this.statusTimerListener);
    this.updateStatusBar(this.timer.getState(), true);
  }

  private destroyStatusBar() {
    if (this.statusTimerListener) {
      this.timer.offChange(this.statusTimerListener);
      this.statusTimerListener = null;
    }
    if (this.statusBarEl) {
      this.statusBarEl.remove();
    }
    this.statusBarEl = null;
    this.statusDot = null;
    this.statusLabel = null;
    this.statusModeEl = null;
    this.statusTimeEl = null;
    this.statusFocusTotal = null;
  }

  private updateStatusBar(state: TimerState, force = false): void {
    if (
      !this.statusBarEl ||
      !this.statusDot ||
      !this.statusLabel ||
      !this.statusModeEl ||
      !this.statusTimeEl ||
      !this.statusFocusTotal
    ) {
      return;
    }

    const absSeconds = Math.ceil(Math.abs(state.remainingMs) / 1000);
    const modeLabel = state.mode === "focus" ? "Focus" : "Break";
    const timeText = this.formatSeconds(absSeconds, state.remainingMs < 0);
    const showTimeLeft = this.settings.showStatusBarTimeLeft;

    if (
      !force &&
      this.lastStatusRender &&
      this.lastStatusRender.second === absSeconds &&
      this.lastStatusRender.mode === state.mode &&
      this.lastStatusRender.running === state.isRunning
    ) {
      return;
    }

    this.lastStatusRender = {
      second: absSeconds,
      mode: state.mode,
      running: state.isRunning,
    };

    this.statusDot.toggleClass("gp-mode-focus", state.mode === "focus");
    this.statusDot.toggleClass("gp-mode-break", state.mode === "break");
    this.statusDot.toggleClass("gp-running", state.isRunning);

    this.statusBarEl.toggleClass("gp-show-time", showTimeLeft);
    this.statusModeEl.setText(modeLabel);
    this.statusTimeEl.setText(timeText);

    const { text: totalText, met: goalMet } = this.focusGoalText(state);
    this.statusFocusTotal.setText(totalText);
    this.statusFocusTotal.toggleClass("gp-status-goal-met", goalMet);

    // Mirror the same goal progress into the view (which surfaces it on mobile,
    // where Obsidian hides the status bar). The view also pushes this from its own
    // timer subscription, so this is just a belt-and-suspenders refresh during
    // status-bar updates; the view element is CSS-hidden on desktop.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO)) {
      if (leaf.view instanceof GentlePomoView) {
        leaf.view.setGoalProgress(totalText, goalMet);
      }
    }

    this.statusBarEl.setAttribute(
      "aria-label",
      showTimeLeft ? `${modeLabel} ${timeText}` : `${modeLabel} (time hidden)`
    );

    void this.maybeRefreshFocusTotal();
  }

  /** Focus seconds counted toward today's goal: the date-guarded cached base
   *  (a base fetched on an earlier day counts as 0 until the refetch lands)
   *  plus the live in-progress focus session. */
  private currentFocusSeconds(state: TimerState): number {
    const base = effectiveFocusBaseSeconds(
      this.statusFocusBaseSeconds,
      this.statusFocusBaseDate,
      todayLocalStr()
    );
    return base + this.getLiveFocusSeconds(state);
  }

  /** "Today Xh / Yh" focus-time + goal text and whether the goal is met, from the
   *  current focus total. Shared by the status bar and the in-view mobile meter. */
  private focusGoalText(state: TimerState): { text: string; met: boolean } {
    const focusTotalSeconds = this.currentFocusSeconds(state);
    const goalMinutes = this.settings.dailyFocusGoalMinutes;
    let text = `Today ${this.formatHoursMinutes(focusTotalSeconds)}`;
    let met = false;
    if (goalMinutes > 0) {
      text += ` / ${this.formatHoursMinutes(goalMinutes * 60)}`;
      met = focusTotalSeconds >= goalMinutes * 60;
    }
    return { text, met };
  }

  /** Push the current focus-goal text into a view's in-view meter. Independent of the
   *  status bar, so the goal renders on mobile (where the status bar is hidden) and even
   *  when "Show in status bar" is off. Called by the view on open and on every timer tick. */
  refreshViewGoalProgress(view: GentlePomoView, state: TimerState = this.timer.getState()): void {
    const { text, met } = this.focusGoalText(state);
    view.setGoalProgress(text, met);
    void this.maybeRefreshFocusTotal();
  }

  /** Ask every open view to duck its lofi music under a sound cue. Called by
   *  TimerEngine.playSound (the engine can't touch the DOM); views without an
   *  active, playing music iframe no-op. */
  duckMusicInOpenViews(cueDurationSec: number): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO)) {
      if (leaf.view instanceof GentlePomoView) {
        leaf.view.duckMusic(cueDurationSec);
      }
    }
  }

  /**
   * The remembered music position, or null when the feature is off or nothing
   * is stored. Read once per iframe build — never on the render hot path.
   */
  musicResumeState(): MusicResumeState | null {
    if (!this.settings.musicResume || this.settings.lastMusicVideoId === null) return null;
    return {
      videoId: this.settings.lastMusicVideoId,
      playlistId: this.settings.lastMusicPlaylistId,
      seconds: this.settings.lastMusicSeconds,
    };
  }

  /**
   * Track where the music has reached. Called from the embed's ~4Hz message
   * stream, so it stays three field writes and a dirty flag — the disk write is
   * deferred to flushMusicPosition (boundaries + the slow interval), because
   * data.json lives in the vault and every save is sync traffic.
   */
  recordMusicPosition(position: MusicResumeState): void {
    if (!this.settings.musicResume) return;
    const seconds = Math.floor(position.seconds);
    if (
      this.settings.lastMusicVideoId === position.videoId &&
      this.settings.lastMusicPlaylistId === position.playlistId &&
      this.settings.lastMusicSeconds === seconds
    ) {
      return; // same whole second — the 4Hz stream collapses to ~1 update/sec
    }
    this.settings.lastMusicVideoId = position.videoId;
    this.settings.lastMusicPlaylistId = position.playlistId;
    this.settings.lastMusicSeconds = seconds;
    this.musicPositionDirty = true;
  }

  /**
   * Forget the position — ⏹ Stop, a finished track, and turning resume off all
   * mean "open this from the top next time". Saved at once rather than on the
   * next boundary: it answers a deliberate action, not a background sample.
   */
  clearMusicPosition(): void {
    this.musicPositionDirty = false;
    if (
      this.settings.lastMusicVideoId === null &&
      this.settings.lastMusicPlaylistId === null &&
      this.settings.lastMusicSeconds === 0
    ) {
      return;
    }
    this.settings.lastMusicVideoId = null;
    this.settings.lastMusicPlaylistId = null;
    this.settings.lastMusicSeconds = 0;
    void this.saveSettings();
  }

  /** Persist a moved position. No-op when it hasn't changed since the last save. */
  flushMusicPosition(): void {
    if (!this.musicPositionDirty) return;
    this.musicPositionDirty = false;
    void this.saveSettings();
  }

  /** Fire the once-per-day "goal hit" notice. Fed *logged* seconds only —
   *  deliberately no live in-progress time: the notice lands at the session
   *  boundary alongside the end bell instead of interrupting mid-focus, and
   *  time that never reaches the log (Obsidian quit or plugin disabled
   *  mid-session) can never consume the once-per-day flag. The status bar and
   *  in-view meter still count live seconds — display is reversible, the
   *  notice is not. Called only from maybeRefreshFocusTotal's landing: the
   *  logged total is this check's sole input, and it only changes when a
   *  fetch lands, so that is the one place the crossing can newly become true. */
  private maybeFireGoalNotice(loggedSeconds: number) {
    const today = todayLocalStr();
    if (
      !shouldFireGoalNotice(
        loggedSeconds,
        this.settings.dailyFocusGoalMinutes,
        this.settings.goalNoticeEnabled,
        this.settings.lastGoalHitDate,
        today
      )
    ) {
      return;
    }
    const goalHm = this.formatHoursMinutes(this.settings.dailyFocusGoalMinutes * 60);
    new Notice(`[GentlePomo] Daily focus goal hit: ${goalHm}`);
    this.settings.lastGoalHitDate = today;
    void this.saveSettings();
  }

  private getLiveFocusSeconds(state: TimerState): number {
    if (state.mode !== "focus") return 0;
    if (!state.isRunning && state.remainingMs === state.totalMs) return 0;
    const elapsedMs = state.totalMs - state.remainingMs;
    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    return elapsedSeconds;
  }

  /** Drop the focus-total TTL so the next check refetches immediately. Called
   *  by LogManager.writeLog the moment a focus line lands, so the refetch —
   *  and the goal notice riding on its landing — arrives with the
   *  end-of-session bell rather than up to a TTL later. (If a fetch is
   *  already in flight at that instant, its landing re-stamps the TTL and the
   *  fresh line waits for the next beat — worst case ~90s, self-healing.) */
  invalidateFocusTotalCache(): void {
    this.statusFocusLastFetchMs = 0;
  }

  private async maybeRefreshFocusTotal() {
    if (this.statusFocusFetchInFlight) return;
    const now = Date.now();
    const today = todayLocalStr();
    // Midnight rollover invalidates the base immediately; the TTL alone would
    // let yesterday's total linger into the new day.
    const baseStale = this.statusFocusBaseDate !== today;
    if (!baseStale && now - this.statusFocusLastFetchMs < FOCUS_TOTAL_CACHE_TTL_MS) return;

    this.statusFocusFetchInFlight = true;
    try {
      // `today` is resolved before the read so the stamp matches the day the
      // log file was picked, even if midnight passes during the await.
      const totalSeconds = await this.logManager.getTodayFocusSeconds();
      this.statusFocusBaseSeconds = totalSeconds;
      this.statusFocusBaseDate = today;
      this.statusFocusLastFetchMs = Date.now();
      // Goal-notice check rides on the landing. Guard: if midnight passed
      // during the await, `totalSeconds` describes yesterday's file — don't
      // feed it to today's check (the now-stale stamp forces a refetch on the
      // next beat, which re-lands with the new day's total).
      if (today === todayLocalStr()) {
        this.maybeFireGoalNotice(totalSeconds);
      }
      const state = this.timer.getState();
      this.updateStatusBar(state, true);
      // The status-bar path mirrors into open views only while the bar exists;
      // push directly so the in-view meter corrects with the bar hidden too.
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GENTLE_POMO)) {
        if (leaf.view instanceof GentlePomoView) {
          this.refreshViewGoalProgress(leaf.view, state);
        }
      }
    } finally {
      this.statusFocusFetchInFlight = false;
    }
  }

  private formatSeconds(totalSeconds: number, overtime = false): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const timeText = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return overtime ? `+${timeText}` : timeText;
  }

  private formatHoursMinutes(totalSeconds: number): string {
    const totalMinutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
}
