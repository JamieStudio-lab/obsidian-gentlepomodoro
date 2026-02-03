import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type GentlePomoPlugin from "./main";
import type { TimerListener, TaskItem, TimerState } from "./types";
import { VIEW_TYPE_GENTLE_POMO, NO_TASK_LABEL, ONE_MINUTE_MS } from "./constants";
import { TimerEngine } from "./TimerEngine";
import { isPathInFolder, normalizeTaskText, normalizeTaskTextForDisplay } from "./taskLoader"; 
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

type DayNightIcon = "sun" | "sunset" | "moon" | "sunrise";

const DAY_NIGHT_ICON_ORDER: DayNightIcon[] = ["sun", "sunset", "moon", "sunrise"];

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag);

const buildDayNightIcon = (icon: DayNightIcon): SVGSVGElement => {
  const svg = createSvgEl("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const addPath = (d: string) => {
    const p = createSvgEl("path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  };

  if (icon === "sun") {
    const c = createSvgEl("circle");
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", "4");
    svg.appendChild(c);
    addPath(
      "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
    );
    return svg;
  }

  if (icon === "sunset") {
    addPath("M6 18h12");
    addPath("M7 18a5 5 0 0 1 10 0");
    addPath("M12 3v3");
    addPath("M5 12h2M17 12h2");
    addPath("M7 9l1.2 1.2M17 9l-1.2 1.2");
    return svg;
  }

  if (icon === "sunrise") {
    addPath("M6 18h12");
    addPath("M7 18a5 5 0 0 1 10 0");
    addPath("M12 3v3");
    addPath("M5 12h2M17 12h2");
    addPath("M4 15h2M18 15h2");
    return svg;
  }

  // moon
  addPath("M21 12.6A8.5 8.5 0 0 1 11.4 3a7 7 0 1 0 9.6 9.6Z");
  return svg;
};

export class GentlePomoView extends ItemView {
  plugin: GentlePomoPlugin;
  timer: TimerEngine;
  timerShape!: HTMLDivElement;
  dayNightIndicator!: HTMLDivElement;
  private dayNightIconEls: Partial<Record<DayNightIcon, HTMLSpanElement>> = {};
  timeLabel!: HTMLDivElement;
  totalTimeLabel!: HTMLDivElement;
  modeLabel!: HTMLDivElement;
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
    return "Gentle Pomodoro";
  }

  getIcon(): string {
    return "clock";
  }

  onOpen(): Promise<void> {
    const container = this.containerEl;
    container.empty();
    container.addClass("gp-root");

    // --- Timer Visual Area ---
    const visual = container.createDiv("gp-timer-visual");

    // Create Shape
    this.timerShape = visual.createDiv("gp-timer-shape");

    // Create Layers in Order: Day -> Dusk -> Night
    this.timerShape.createDiv("gp-layer-day");
    this.timerShape.createDiv("gp-layer-dusk");
    this.timerShape.createDiv("gp-layer-night");

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

    const resetBtn = this.secondaryControlsWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
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
      if (this.settingsVisible) this.renderSettingsPanel();
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

    this.taskBtn.onclick = async () => {
      this.taskListVisible = !this.taskListVisible;
      if (this.taskListVisible) {
        this.taskListContainer.addClass("gp-visible");
        await this.loadTasks();
      } else {
        this.taskListContainer.removeClass("gp-visible");
      }
    };

    // --- Task List Container ---
    this.taskListContainer = controls.createDiv("gp-task-list");

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
    };

    this.plugin.timer.onChange(this.timerListener);
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    if (this.timerListener) {
      this.plugin.timer.offChange(this.timerListener);
      this.timerListener = null;
    }
    return Promise.resolve();
  }

  applySettings() {
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

  // --- Task Loading Logic ---
  async loadTasks() {
    this.taskListContainer.empty();

    const clearItem = this.taskListContainer.createDiv("gp-task-item");
    clearItem.addClass("gp-task-item-clear");
    setIcon(clearItem, "x-circle");
    clearItem.createSpan({ text: "Unlink Current Task" });

    clearItem.onclick = () => {
      this.timer.setTask(NO_TASK_LABEL);
      this.taskListVisible = false;
      this.taskListContainer.removeClass("gp-visible");
    };

    const tasks: TaskItem[] = [];
    const path = this.plugin.settings.tasksPath;

    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => isPathInFolder(f.path, path) && f.extension === "md");

    const today = moment().startOf("day");
    const limitDate = moment().add(3, "days").endOf("day");

    

    for (const file of files) {
      const content = await this.plugin.app.vault.cachedRead(file);
      const lines = content.split("\n");

      const taskRegex = /^\s*-\s*\[ \]\s+(.*)$/;
      const scheduledRegex = /⏳\s*(\d{4}-\d{2}-\d{2})/;
      const dueRegex = /📅\s*(\d{4}-\d{2}-\d{2})/;
      const taskIdRegex = /🆔\s*([A-Za-z0-9_-]+)/;


      for (const line of lines) {
        const match = line.match(taskRegex);
        if (match) {
          const originalText = match[1];

          const scheduledMatch = originalText.match(scheduledRegex);
          const dueMatch = originalText.match(dueRegex);

          const scheduled = scheduledMatch ? scheduledMatch[1] : null;
          const due = dueMatch ? dueMatch[1] : null;

          const effectiveDateStr = scheduled || due;       
          
          const idMatch = originalText.match(taskIdRegex);
          const taskId = idMatch ? idMatch[1] : undefined;

          if (effectiveDateStr) {
            const dateObj = moment(effectiveDateStr);
            if (dateObj.isSameOrBefore(limitDate)) {
              const cleanText = normalizeTaskText(originalText);
              const displayText = normalizeTaskTextForDisplay(originalText);

              tasks.push({
                text: originalText,
                cleanText: cleanText || "Untitled Task",
                displayText: displayText || cleanText || "Untitled Task",
                status: "todo",
                path: file.path,
                scheduled,
                due,
                effectiveDateStr,
                taskId, 
              });
            }
          }
        }
      }
    }

    tasks.sort((a, b) => {
      if (a.effectiveDateStr !== b.effectiveDateStr) {
        return a.effectiveDateStr.localeCompare(b.effectiveDateStr);
      }
      return a.path.localeCompare(b.path);
    });

    if (tasks.length === 0) {
      this.taskListContainer.createDiv({ cls: "gp-task-item-empty", text: "No tasks found for next 3 days." });
    } else {
      let lastGroupLabel = "";

      tasks.forEach((task) => {
        const dateObj = moment(task.effectiveDateStr);
        let groupLabel = "";

        if (dateObj.isBefore(today)) {
          groupLabel = "Overdue";
        } else if (dateObj.isSame(today, "day")) {
          groupLabel = "Today";
        } else if (dateObj.isSame(moment().add(1, "day"), "day")) {
          groupLabel = "Tomorrow";
        } else {
          groupLabel = dateObj.format("dddd, MMM D");
        }

        if (groupLabel !== lastGroupLabel) {
          this.taskListContainer.createDiv("gp-task-group-header").setText(groupLabel);
          lastGroupLabel = groupLabel;
        }

        const item = this.taskListContainer.createDiv("gp-task-item");
        item.createSpan({ text: task.displayText });

        if (task.cleanText === this.timer.currentTaskName && task.path === this.timer.currentTaskPath) {
          item.addClass("gp-task-selected");
          const iconContainer = item.createDiv("gp-task-check-icon");
          setIcon(iconContainer, "check");
        }

        item.onclick = () => {
            this.timer.setTask(task.cleanText, task.path, task.taskId);
            this.taskListVisible = false;
            this.taskListContainer.removeClass("gp-visible");
        };
      });
    }
  }

  renderSettingsPanel() {
    this.settingsPanel.empty();

    const focusRow = this.settingsPanel.createDiv("gp-settings-row");
    focusRow.createSpan({ text: "Focus (m)" });
    const focusInput = focusRow.createEl("input", { type: "number" });
    focusInput.value = this.plugin.settings.focusMinutes.toString();
    focusInput.onchange = async () => {
      const val = parseInt(focusInput.value);
      if (val > 0) {
        this.plugin.settings.focusMinutes = val;
        await this.plugin.saveSettings();
        this.timer.updateDuration("focus", val);
      }
    };

    const breakRow = this.settingsPanel.createDiv("gp-settings-row");
    breakRow.createSpan({ text: "Break (m)" });
    const breakInput = breakRow.createEl("input", { type: "number" });
    breakInput.value = this.plugin.settings.breakMinutes.toString();
    breakInput.onchange = async () => {
      const val = parseInt(breakInput.value);
      if (val > 0) {
        this.plugin.settings.breakMinutes = val;
        await this.plugin.saveSettings();
        this.timer.updateDuration("break", val);
      }
    };

    const soundRow = this.settingsPanel.createDiv("gp-settings-row");
    soundRow.createSpan({ text: "Sound" });
    const soundToggle = soundRow.createEl("input", { type: "checkbox" });
    soundToggle.checked = this.plugin.settings.soundEnabled;
    soundToggle.onchange = async () => {
      this.plugin.settings.soundEnabled = soundToggle.checked;
      await this.plugin.saveSettings();
    };
  }
}
