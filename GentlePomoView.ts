import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { TimerListener, TimerState } from "./types";
import { DEFAULT_SETTINGS, VIEW_TYPE_GENTLE_POMO, NO_TASK_LABEL, ONE_MINUTE_MS } from "./constants";
import { TimerEngine } from "./TimerEngine";
import { loadTasks as fetchTasks, groupTasksByDate } from "./taskLoader";
import { buildDayNightIcon, DAY_NIGHT_ICON_ORDER, type DayNightIcon } from "./icons";

export class GentlePomoView extends ItemView {
  plugin: GentlePomoPlugin;
  timer: TimerEngine;
  timerShape!: HTMLDivElement;
  timerVisual!: HTMLDivElement;
  dayNightIndicator!: HTMLDivElement;
  private dayNightIconEls: Partial<Record<DayNightIcon, HTMLSpanElement>> = {};
  timeLabel!: HTMLDivElement;
  totalTimeLabel!: HTMLDivElement;
  modeLabel!: HTMLDivElement;
  goalProgressEl!: HTMLDivElement;
  settingsPanel!: HTMLDivElement;
  settingsVisible = false;

  // Wrappers for animation
  adjustWrapper!: HTMLDivElement;
  secondaryControlsWrapper!: HTMLDivElement;

  // Task List Elements
  taskListContainer!: HTMLDivElement;
  taskListVisible = false;
  taskBtn!: HTMLButtonElement;

  private timerListener: TimerListener | null = null;
  private lastState: TimerState | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GentlePomoPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = plugin.timer;
  }

  getViewType(): string {
    return VIEW_TYPE_GENTLE_POMO;
  }

  getDisplayText(): string {
    return "Gentle pomodoro";
  }

  override getIcon(): string {
    return "clock";
  }

  override onOpen(): Promise<void> {
    const container = this.containerEl;
    container.empty();
    container.addClass("gp-root");

    // --- Timer Visual Area ---
    const visual = container.createDiv("gp-timer-visual");
    this.timerVisual = visual;

    // Tap-to-peek: touch devices have no hover, so tapping the shape toggles
    // the .gp-peek class — the touch equivalent of the desktop hover reveal
    // that shows the running countdown (see styles.css). Harmless on desktop,
    // where the :hover rule drives the reveal instead.
    this.registerDomEvent(visual, "click", () => {
      visual.toggleClass("gp-peek", !visual.hasClass("gp-peek"));
    });

    // Create Shape
    this.timerShape = visual.createDiv("gp-timer-shape");

    // Create Layers in Order: Day -> Dusk -> Night
    this.timerShape.createDiv("gp-layer-day");
    this.timerShape.createDiv("gp-layer-dusk");
    this.timerShape.createDiv("gp-layer-night");

    // Frosted-glass theme layers (CSS-toggled per theme; built once here).
    const orbs = this.timerShape.createDiv("gp-glass-orbs");
    orbs.createDiv("gp-orb gp-orb-1");
    orbs.createDiv("gp-orb gp-orb-2");
    orbs.createDiv("gp-orb gp-orb-3");
    this.timerShape.createDiv("gp-glass-pane");
    this.timerShape.createDiv("gp-glass-highlight");

    const content = visual.createDiv("gp-timer-content");
    this.dayNightIndicator = content.createDiv("gp-daynight-indicator");
    this.dayNightIndicator.setAttribute("aria-hidden", "true");
    const badge = this.dayNightIndicator.createDiv("gp-daynight-badge");
    const iconStack = badge.createDiv("gp-daynight-icon-stack");

    DAY_NIGHT_ICON_ORDER.forEach((key) => {
      const iconEl = iconStack.createSpan({ cls: "gp-daynight-icon" });
      iconEl.appendChild(buildDayNightIcon(key));
      this.dayNightIconEls[key] = iconEl;
    });

    this.timeLabel = content.createDiv("gp-timer-time");
    this.totalTimeLabel = content.createDiv("gp-total-time");
    this.modeLabel = content.createDiv("gp-mode-label");

    // --- Controls ---
    const controls = container.createDiv("gp-controls");

    // ROW 1: Start, Pause, Stop, Reset, Skip
    const row1 = controls.createDiv("gp-controls-row");

    const startBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn gp-btn-primary" });
    setIcon(startBtn, "play");
    startBtn.setAttribute("aria-label", "Start");
    this.registerDomEvent(startBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.start();
    });

    const pauseBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(pauseBtn, "pause");
    pauseBtn.setAttribute("aria-label", "Pause");
    this.registerDomEvent(pauseBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.pause();
    });

    this.secondaryControlsWrapper = row1.createDiv("gp-animated-wrapper gp-secondary-controls");

    const stopBtn = this.secondaryControlsWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(stopBtn, "square");
    stopBtn.setAttribute("aria-label", "Finish & next");
    this.registerDomEvent(stopBtn, "click", (evt) => {
      evt.preventDefault();
      void this.timer.finish();
    });

    const resetBtn = this.secondaryControlsWrapper.createEl("button", {
      cls: "gp-btn gp-icon-btn",
    });
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.setAttribute("aria-label", "Reset session");
    this.registerDomEvent(resetBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.reset();
    });

    const skipBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(skipBtn, "skip-forward");
    skipBtn.setAttribute("aria-label", "Skip to next");
    this.registerDomEvent(skipBtn, "click", (evt) => {
      evt.preventDefault();
      void this.timer.skip();
    });

    // ROW 2: -5m, +5m, Settings
    const row2 = controls.createDiv("gp-controls-row");

    this.adjustWrapper = row2.createDiv("gp-animated-wrapper gp-adjust-wrapper");

    const minusBtn = this.adjustWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(minusBtn, "minus");
    this.registerDomEvent(minusBtn, "click", (evt) => {
      evt.preventDefault();
      if (this.timer.getState().remainingMs > 5 * ONE_MINUTE_MS) {
        this.timer.addMinutes(-5);
      }
    });

    const plusBtn = this.adjustWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(plusBtn, "plus");
    this.registerDomEvent(plusBtn, "click", (evt) => {
      evt.preventDefault();
      this.timer.addMinutes(5);
    });

    const settingsBtn = row2.createEl("button", { cls: "gp-btn gp-icon-btn" });
    setIcon(settingsBtn, "settings");
    this.registerDomEvent(settingsBtn, "click", (evt) => {
      evt.preventDefault();
      this.settingsVisible = !this.settingsVisible;
      this.settingsPanel.toggleClass("gp-visible", this.settingsVisible);
      settingsBtn.setAttribute("aria-expanded", this.settingsVisible ? "true" : "false");
      if (this.settingsVisible) {
        this.renderSettingsPanel();
        // Give the open transition a moment to start, then scroll the
        // panel into view so the user sees it without manual scrolling.
        window.setTimeout(() => {
          this.settingsPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 50);
      }
    });

    // --- Settings Panel ---
    this.settingsPanel = controls.createDiv("gp-settings-panel");
    this.renderSettingsPanel();

    // ROW 3: Task Selector
    const row3 = controls.createDiv("gp-controls-row");
    this.taskBtn = row3.createEl("button", { cls: "gp-btn gp-btn-full" });

    const btnLabel = this.taskBtn.createDiv("gp-task-btn-label");
    btnLabel.setText("Current task");

    const btnText = this.taskBtn.createDiv("gp-task-btn-text");
    btnText.setText("Select a task...");

    this.registerDomEvent(this.taskBtn, "click", () => {
      this.taskListVisible = !this.taskListVisible;
      if (this.taskListVisible) {
        this.taskListContainer.addClass("gp-visible");
        void this.loadTasks();
      } else {
        this.taskListContainer.removeClass("gp-visible");
      }
    });

    // --- Task List Container ---
    this.taskListContainer = controls.createDiv("gp-task-list");

    // Daily-goal progress, mirrored from the status bar. Hidden on desktop via
    // CSS; revealed on mobile, where Obsidian hides the status bar. Updated by
    // main.ts through setGoalProgress().
    this.goalProgressEl = container.createDiv("gp-goal-progress");

    // (Control-button glyph sizing — including the iPad min-width floor — lives in
    // styles.css; see the `.gp-icon-btn svg.svg-icon` rule in the Mobile & touch section.)

    // --- State Updates ---
    this.timerListener = (state) => {
      this.lastState = state;
      this.applySettings();

      if (state.isRunning) {
        startBtn.addClass("gp-hidden");
        pauseBtn.removeClass("gp-hidden");
        this.secondaryControlsWrapper.removeClass("gp-hidden-animated");
        this.adjustWrapper.removeClass("gp-hidden-animated");
      } else {
        startBtn.removeClass("gp-hidden");
        pauseBtn.addClass("gp-hidden");

        if (state.remainingMs !== state.totalMs) {
          this.secondaryControlsWrapper.removeClass("gp-hidden-animated");
          this.adjustWrapper.removeClass("gp-hidden-animated");
        } else {
          this.secondaryControlsWrapper.addClass("gp-hidden-animated");
          this.adjustWrapper.addClass("gp-hidden-animated");
        }
      }

      if (state.remainingMs <= 5 * ONE_MINUTE_MS) {
        minusBtn.setAttribute("disabled", "true");
        minusBtn.addClass("gp-btn-disabled");
      } else {
        minusBtn.removeAttribute("disabled");
        minusBtn.removeClass("gp-btn-disabled");
      }

      const isOvertime = state.remainingMs < 0;

      visual.toggleClass("gp-state-overtime", isOvertime);
      visual.toggleClass("gp-mode-focus", state.mode === "focus");
      visual.toggleClass("gp-mode-break", state.mode === "break");

      const absMs = Math.abs(state.remainingMs);
      const totalSec = Math.ceil(absMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;

      let timeText = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
      if (isOvertime) {
        timeText = "+" + timeText;
        this.timeLabel.addClass("gp-overtime");
        const actualTotalMs = state.totalMs + absMs;
        const tSec = Math.floor(actualTotalMs / 1000);
        const tM = Math.floor(tSec / 60);
        const tS = tSec % 60;
        this.totalTimeLabel.setText(`Total: ${tM}:${tS.toString().padStart(2, "0")}`);
      } else {
        this.timeLabel.removeClass("gp-overtime");
        this.totalTimeLabel.setText("");
      }
      this.timeLabel.setText(timeText);

      this.modeLabel.setText(state.mode === "focus" ? "Focus" : "Rest");
      visual.toggleClass("gp-state-running", state.isRunning);

      const textEl = this.taskBtn.querySelector(".gp-task-btn-text");
      if (textEl) {
        if (state.taskName === NO_TASK_LABEL) {
          textEl.setText("Select a task...");
        } else {
          textEl.setText(state.taskName);
        }
      }

      // --- Gradient Transition Logic ---
      let progress = 0;
      if (state.totalMs > 0) {
        progress = 1 - state.remainingMs / state.totalMs;
      }
      progress = Math.max(0, Math.min(1, progress));

      let skyPhase = 0;
      if (state.mode === "focus") {
        skyPhase = progress;
      } else {
        skyPhase = 1 - progress;
      }

      let duskOpacity = 0;
      let nightOpacity = 0;
      if (skyPhase < 0.5) {
        duskOpacity = skyPhase * 2;
        nightOpacity = 0;
      } else {
        duskOpacity = 1;
        nightOpacity = (skyPhase - 0.5) * 2;
      }
      visual.style.setProperty("--gp-dusk-opacity", duskOpacity.toString());
      visual.style.setProperty("--gp-night-opacity", nightOpacity.toString());
      // Consumed by frosted-glass orb color-mix() in styles.css. Uses skyPhase
      // (not raw progress) so orbs warm→cool on focus and cool→warm on break,
      // matching the classic theme's narrative arc.
      visual.style.setProperty("--gp-progress", skyPhase.toString());
    };

    this.plugin.timer.onChange(this.timerListener);
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    if (this.timerListener) {
      this.plugin.timer.offChange(this.timerListener);
      this.timerListener = null;
    }
    return Promise.resolve();
  }

  /**
   * Update the in-view daily-goal progress line. Called from main.ts alongside
   * the status-bar update so mobile (no status bar) still sees goal progress.
   * The element is hidden on desktop via CSS, so this is a cheap no-op there.
   */
  setGoalProgress(text: string, met: boolean) {
    if (!this.goalProgressEl) return;
    this.goalProgressEl.setText(text);
    this.goalProgressEl.toggleClass("gp-goal-met", met);
  }

  applySettings() {
    const theme = this.plugin.settings.theme;
    this.containerEl.toggleClass("gp-theme-classic", theme === "classic");
    this.containerEl.toggleClass("gp-theme-frosted-glass", theme === "frosted-glass");

    if (!this.dayNightIndicator) return;
    const enabled = this.plugin.settings.showDayNightIndicator;
    this.dayNightIndicator.toggleClass("gp-hidden", !enabled);
    if (!enabled) return;

    const state = this.lastState ?? this.timer.getState();
    const icon = this.getDayNightIcon(state);
    for (const key of DAY_NIGHT_ICON_ORDER) {
      this.dayNightIconEls[key]?.toggleClass("is-active", key === icon);
    }
  }

  private getDayNightIcon(state: TimerState): DayNightIcon {
    if (state.mode === "focus") {
      if (state.remainingMs <= 0) return "moon";
      if (state.remainingMs <= state.totalMs / 2) return "sunset";
      return "sun";
    }

    if (state.remainingMs <= 0) return "sun";
    if (state.remainingMs <= state.totalMs / 2) return "sunrise";
    return "moon";
  }

  /** Re-render the task picker. Sources tasks via taskLoader so regex parsing stays centralized. */
  async loadTasks() {
    this.taskListContainer.empty();

    const clearItem = this.taskListContainer.createDiv("gp-task-item");
    clearItem.addClass("gp-task-item-clear");
    setIcon(clearItem, "x-circle");
    clearItem.createSpan({ text: "Unlink Current Task" });

    this.registerDomEvent(clearItem, "click", () => {
      this.timer.setTask(NO_TASK_LABEL);
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
    });

    const tasks = await fetchTasks(this.plugin.app, {
      tasksPath: this.plugin.settings.tasksPath,
    });
    const groups = groupTasksByDate(tasks);

    if (groups.length === 0) {
      this.taskListContainer.createDiv({
        cls: "gp-task-item-empty",
        text: "No tasks found for next 3 days.",
      });
      return;
    }

    for (const group of groups) {
      this.taskListContainer.createDiv("gp-task-group-header").setText(group.label);

      for (const task of group.items) {
        const item = this.taskListContainer.createDiv("gp-task-item");
        item.createSpan({ text: task.displayText });

        if (
          task.cleanText === this.timer.currentTaskName &&
          task.path === this.timer.currentTaskPath
        ) {
          item.addClass("gp-task-selected");
          const iconContainer = item.createDiv("gp-task-check-icon");
          setIcon(iconContainer, "check");
        }

        this.registerDomEvent(item, "click", () => {
          this.timer.setTask(task.cleanText, task.path, task.taskId);
          this.taskListVisible = false;
          this.taskListContainer.removeClass("gp-visible");
        });
      }
    }
  }

  renderSettingsPanel() {
    this.settingsPanel.empty();

    const settings = this.plugin.settings;

    const section = (label: string) => {
      this.settingsPanel.createDiv({ cls: "gp-settings-section-label", text: label });
    };

    const numberRow = (
      label: string,
      initial: number,
      onChange: (next: number) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const input = row.createEl("input", { type: "number" });
      input.value = initial.toString();
      this.registerDomEvent(input, "change", () => {
        const val = parseInt(input.value);
        if (val > 0) void onChange(val);
      });
      this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") input.blur();
      });
    };

    const toggleRow = (
      label: string,
      initial: boolean,
      onChange: (next: boolean) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const wrap = row.createEl("label", { cls: "gp-toggle" });
      const input = wrap.createEl("input", { type: "checkbox" });
      input.checked = initial;
      wrap.createSpan({ cls: "gp-toggle-slider" });
      this.registerDomEvent(input, "change", () => void onChange(input.checked));
    };

    const segmentedRow = <T>(
      label: string,
      options: { label: string; value: T }[],
      initial: T,
      onChange: (next: T) => Promise<void>
    ) => {
      const row = this.settingsPanel.createDiv("gp-settings-row");
      row.createSpan({ text: label });
      const seg = row.createDiv({ cls: "gp-segmented", attr: { role: "radiogroup" } });
      // For numeric values we pick the option closest to `initial` (e.g. volume:
      // tolerate any past saved float). For other types, strict equality.
      const initialOpt: { label: string; value: T } =
        typeof initial === "number"
          ? options.reduce((best, opt) =>
              Math.abs((opt.value as number) - (initial as number)) <
              Math.abs((best.value as number) - (initial as number))
                ? opt
                : best
            )
          : (options.find((o) => o.value === initial) ?? options[0]);
      const buttons: HTMLButtonElement[] = [];
      for (const opt of options) {
        const btn = seg.createEl("button", { cls: "gp-segmented-btn", text: opt.label });
        btn.type = "button";
        btn.setAttribute("role", "radio");
        const isActive = opt === initialOpt;
        btn.setAttribute("aria-checked", String(isActive));
        if (isActive) btn.addClass("is-active");
        buttons.push(btn);
        this.registerDomEvent(btn, "click", () => {
          for (const b of buttons) {
            b.removeClass("is-active");
            b.setAttribute("aria-checked", "false");
          }
          btn.addClass("is-active");
          btn.setAttribute("aria-checked", "true");
          void onChange(opt.value);
        });
      }
    };

    section("Timing");
    numberRow("Focus (m)", settings.focusMinutes, async (v) => {
      settings.focusMinutes = v;
      await this.plugin.saveSettings();
      this.timer.updateDuration("focus", v);
    });
    numberRow("Break (m)", settings.breakMinutes, async (v) => {
      settings.breakMinutes = v;
      await this.plugin.saveSettings();
      this.timer.updateDuration("break", v);
    });

    section("Audio");
    toggleRow("Sound", settings.soundEnabled, async (v) => {
      settings.soundEnabled = v;
      await this.plugin.saveSettings();
    });
    segmentedRow(
      "Volume",
      [
        { label: "Low", value: 0.3 },
        { label: "Mid", value: 0.7 },
        { label: "High", value: 1.0 },
      ],
      settings.soundVolume,
      async (v) => {
        settings.soundVolume = v;
        await this.plugin.saveSettings();
      }
    );

    section("Auto-start");
    toggleRow("Auto-start break", settings.autoStartBreak, async (v) => {
      settings.autoStartBreak = v;
      await this.plugin.saveSettings();
    });
    toggleRow("Auto-start focus", settings.autoStartFocus, async (v) => {
      settings.autoStartFocus = v;
      await this.plugin.saveSettings();
    });

    const resetWrap = this.settingsPanel.createDiv("gp-settings-reset");
    const resetBtn = resetWrap.createEl("button", {
      cls: "gp-reset-button",
      text: "Reset to defaults",
    });
    resetBtn.type = "button";
    this.registerDomEvent(resetBtn, "click", async () => {
      settings.focusMinutes = DEFAULT_SETTINGS.focusMinutes;
      settings.breakMinutes = DEFAULT_SETTINGS.breakMinutes;
      settings.soundEnabled = DEFAULT_SETTINGS.soundEnabled;
      settings.soundVolume = DEFAULT_SETTINGS.soundVolume;
      settings.autoStartBreak = DEFAULT_SETTINGS.autoStartBreak;
      settings.autoStartFocus = DEFAULT_SETTINGS.autoStartFocus;
      await this.plugin.saveSettings();
      this.timer.updateDuration("focus", settings.focusMinutes);
      this.timer.updateDuration("break", settings.breakMinutes);
      this.renderSettingsPanel();
    });
  }
}
