import { Notice, Plugin, WorkspaceLeaf } from "obsidian";

import { GentlePomoSettingTab } from "./GentlePomoSettingTab";
import { GentlePomoView } from "./GentlePomoView";
import { LogManager, shouldFireGoalNotice } from "./logManager";
import { TimerEngine } from "./TimerEngine";
import { DEFAULT_SETTINGS, FOCUS_TOTAL_CACHE_TTL_MS, VIEW_TYPE_GENTLE_POMO } from "./constants";
import type { GentlePomoSettings, PomoMode, TimerListener, TimerState } from "./types";
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

// Local-timezone YYYY-MM-DD; matches LogManager's daily-log file naming.
const todayLocalStr = (): string => moment().format("YYYY-MM-DD");

export default class GentlePomoPlugin extends Plugin {
  settings!: GentlePomoSettings;
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

    void this.setStatusBarVisibility(this.settings.showInStatusBar, false);

    // Defer auto-open until Obsidian has finished initial layout setup.
    this.app.workspace.onLayoutReady(() => {
      this.maybeAutoOpenView();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
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

    this.autoOpenObserver.observe(document.body, { childList: true, subtree: true });
  }

  private isSettingsModalOpen(): boolean {
    return Boolean(
      document.querySelector(
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
    const goalMinutes = this.settings.dailyFocusGoalMinutes;
    let totalText = `Today ${this.formatHoursMinutes(focusTotalSeconds)}`;
    let goalMet = false;
    if (goalMinutes > 0) {
      totalText += ` / ${this.formatHoursMinutes(goalMinutes * 60)}`;
      goalMet = focusTotalSeconds >= goalMinutes * 60;
    }
    this.statusFocusTotal.setText(totalText);
    this.statusFocusTotal.toggleClass("gp-status-goal-met", goalMet);

    this.statusBarEl.setAttribute(
      "aria-label",
      showTimeLeft ? `${modeLabel} ${timeText}` : `${modeLabel} (time hidden)`
    );

    this.maybeFireGoalNotice(focusTotalSeconds);
    void this.maybeRefreshFocusTotal();
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
