import { Notice, Plugin, WorkspaceLeaf } from "obsidian";

import { confirmAction } from "./confirmModal";
import { GentlePomoSettingTab } from "./GentlePomoSettingTab";
import { GentlePomoView } from "./GentlePomoView";
import { LogManager, shouldFireGoalNotice } from "./logManager";
import { logger } from "./logger";
import {
  removeAllPomodoroMarkersInVault,
  removeMisplacedPomodoroMarkersInVault,
  repairPomodoroMarkersInVault,
  scanAllPomodoroMarkersInVault,
  scanMisplacedPomodoroMarkersInVault,
} from "./taskLoader";
import { TimerEngine } from "./TimerEngine";
import { DEFAULT_SETTINGS, FOCUS_TOTAL_CACHE_TTL_MS, VIEW_TYPE_GENTLE_POMO } from "./constants";
import type { GentlePomoSettings, PomoMode, TimerListener, TimerState } from "./types";
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
  private statusFocusLastFetchMs = 0;
  private statusFocusFetchInFlight = false;
  private statusTimerListener: TimerListener | null = null;
  private autoOpenObserver: MutationObserver | null = null;
  private repairInFlight = false;

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
        body: `Delete ${scan.linesAffected} 🍅 marker(s) in ${scan.filesAffected} file(s)? All lifetime counts will be lost.`,
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
    if (this.autoOpenObserver) {
      this.autoOpenObserver.disconnect();
      this.autoOpenObserver = null;
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

    const focusTotalSeconds = this.statusFocusBaseSeconds + this.getLiveFocusSeconds(state);
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

    this.maybeFireGoalNotice(focusTotalSeconds);
    void this.maybeRefreshFocusTotal();
  }

  /** "Today Xh / Yh" focus-time + goal text and whether the goal is met, from the
   *  current focus total. Shared by the status bar and the in-view mobile meter. */
  private focusGoalText(state: TimerState): { text: string; met: boolean } {
    const focusTotalSeconds = this.statusFocusBaseSeconds + this.getLiveFocusSeconds(state);
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

  private maybeFireGoalNotice(currentSeconds: number) {
    const today = todayLocalStr();
    if (
      !shouldFireGoalNotice(
        currentSeconds,
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

  private async maybeRefreshFocusTotal() {
    if (this.statusFocusFetchInFlight) return;
    const now = Date.now();
    if (now - this.statusFocusLastFetchMs < FOCUS_TOTAL_CACHE_TTL_MS) return;

    this.statusFocusFetchInFlight = true;
    try {
      const totalSeconds = await this.logManager.getTodayFocusSeconds();
      this.statusFocusBaseSeconds = totalSeconds;
      this.statusFocusLastFetchMs = Date.now();
      this.updateStatusBar(this.timer.getState(), true);
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
