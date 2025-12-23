import {
    App,
    ItemView,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
    setIcon,
    TFile,
    // moment,
} from "obsidian";

import { LogManager } from "./logManager"; 

declare const moment: any;

const VIEW_TYPE_GENTLE_POMO = "gentle-pomo-view";

type PomoMode = "focus" | "break";

interface GentlePomoSettings {
    focusMinutes: number;
    breakMinutes: number;
    autoStartBreak: boolean;
    autoStartFocus: boolean;
    showInStatusBar: boolean;
    soundEnabled: boolean;
    soundVolume: number;
    tasksPath: string; // Path to search for tasks
    logFolderPath: string; // Path for logs
}

const DEFAULT_SETTINGS: GentlePomoSettings = {
    focusMinutes: 25,
    breakMinutes: 5,
    autoStartBreak: false,
    autoStartFocus: false,
    showInStatusBar: true,
    soundEnabled: true,
    soundVolume: 0.7,
    tasksPath: "", // Default empty (search everywhere or root)
    logFolderPath: "", // Default empty
};

interface TimerState {
    mode: PomoMode;
    isRunning: boolean;
    remainingMs: number;
    totalMs: number;
}

type TimerListener = (state: TimerState) => void;

class TimerEngine {
    private state: TimerState;
    private intervalId: number | null = null;
    private listeners: Set<TimerListener> = new Set();
    private plugin: GentlePomoPlugin;
    
    // Track the target end time (timestamp)
    private targetTime: number | null = null;

    // Track current task name for logging
    public currentTaskName: string = "No Task"; 
    public currentTaskPath: string | undefined; 

    constructor(plugin: GentlePomoPlugin) {
        this.plugin = plugin;
        const total = plugin.settings.focusMinutes * 60 * 1000;
        this.state = {
            mode: "focus",
            isRunning: false,
            remainingMs: total,
            totalMs: total,
        };
    }

    // Method to update task name and sync with LogManager
    setTask(name: string, path?: string) {
        this.currentTaskName = name;
        this.currentTaskPath = path;
        // If a session is running (or paused), update its log entry immediately
        this.plugin.logManager.updateTask(name, path);
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

    private handleFinished() {
        // Log the finished session
        this.plugin.logManager.endSession("finished");

        if (this.plugin.settings.soundEnabled) {
            this.playChime();
        }
        if (this.state.mode === "focus") {
            this.switchMode("break", this.plugin.settings.autoStartBreak);
        } else {
            this.switchMode("focus", this.plugin.settings.autoStartFocus);
        }
    }

    private async playChime() {
        // 1. Try to play bundled mp3 file: gentle-pomo-new-notification.mp3
        try {
            const pluginDir = this.plugin.manifest.dir;
            if (pluginDir) {
                const soundFile = `${pluginDir}/gentle-pomo-new-notification.mp3`;
                const exists = await this.plugin.app.vault.adapter.exists(soundFile);
                
                if (exists) {
                    const arrayBuffer = await this.plugin.app.vault.adapter.readBinary(soundFile);
                    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
                    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                    
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    
                    const gain = ctx.createGain();
                    gain.gain.value = this.plugin.settings.soundVolume;
                    
                    source.connect(gain);
                    gain.connect(ctx.destination);
                    source.start(0);
                    return; // Exit if successful
                }
            }
        } catch (e) {
            console.error("[GentlePomo] Failed to play bundled sound:", e);
        }

        // 2. Fallback to generated beep
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(this.plugin.settings.soundVolume, ctx.currentTime);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.5);
        osc.stop(ctx.currentTime + 0.5);
    }

    switchMode(mode: PomoMode, autoStart = false) {
        const minutes =
            mode === "focus"
                ? this.plugin.settings.focusMinutes
                : this.plugin.settings.breakMinutes;

        const total = minutes * 60 * 1000;

        this.state = {
            mode,
            isRunning: autoStart,
            remainingMs: total,
            totalMs: total,
        };
        this.emit();

        if (autoStart) {
            // Start logging for auto-start
            this.plugin.logManager.startSession(mode, this.currentTaskName, minutes, this.currentTaskPath);
            // Set target time immediately for auto-start
            this.targetTime = Date.now() + total;
            this.startLoop();
        } else {
            this.targetTime = null;
            this.clearLoop();
        }
    }

    start() {
        if (this.state.isRunning) return;
        this.state.isRunning = true;

        // Start or Resume Logging
        const minutes = this.state.mode === "focus" 
            ? this.plugin.settings.focusMinutes 
            : this.plugin.settings.breakMinutes;
        this.plugin.logManager.startSession(this.state.mode, this.currentTaskName, minutes, this.currentTaskPath); 
        
        // Set target based on current remaining time
        this.targetTime = Date.now() + this.state.remainingMs;
        
        this.emit();
        this.startLoop();
    }

    pause() {
        if (!this.state.isRunning) return;

        // NEW: Log Pause
        this.plugin.logManager.pauseSession(); 

        this.state.isRunning = false;
        this.targetTime = null; // Stop tracking wall clock
        this.clearLoop();
        this.emit();
    }

    finish() {
        this.handleFinished();
    }

    skip() {
        // Differentiate status based on mode
        // Focus: Skip -> Cancelled (stopped work early)
        // Rest: Skip -> Finished (stopped rest early, effectively finishing it)
        const status = this.state.mode === "focus" ? "cancelled" : "finished";
        this.plugin.logManager.endSession(status);

        const nextMode: PomoMode = this.state.mode === "focus" ? "break" : "focus";
        this.switchMode(nextMode, false);
    }

    cancel() {
        // NEW: Log cancellation
        this.plugin.logManager.endSession("cancelled");
        this.switchMode(this.state.mode, false);
    }

    reset() {
        this.cancel();
    }

    addMinutes(delta: number) {
        const deltaMs = delta * 60 * 1000;

        // 1. Update the Total Duration
        let newTotal = this.state.totalMs + deltaMs;
        const minTotal = 60 * 1000; // Minimum 1 minute
        if (newTotal < minTotal) newTotal = minTotal;

        // 2. Update Remaining Time with Clamp
        const oldRemaining = this.state.remainingMs;
        let newRemaining = oldRemaining + deltaMs;
        
        // Clamp: Remaining cannot exceed the new Total
        if (newRemaining > newTotal) newRemaining = newTotal;
        
         // Apply changes
        this.state.totalMs = newTotal;
        this.state.remainingMs = newRemaining;

        // 3. FIX: Shift the Wall-Clock Target
        // If we don't do this, the timer will "jump back" to the old time 
        // on the next tick because it compares against a fixed targetTime.
        if (this.state.isRunning && this.targetTime !== null) {
            // Calculate the actual change applied (accounting for clamping)
            const effectiveChange = newRemaining - oldRemaining; 
            this.targetTime += effectiveChange;
            }
        this.emit();
    }

    updateDuration(mode: PomoMode, minutes: number) {
        if (this.state.mode === mode) {
            const newTotal = minutes * 60 * 1000;
            if (!this.state.isRunning && this.state.remainingMs === this.state.totalMs) {
                 this.state.remainingMs = newTotal;
            }
            this.state.totalMs = newTotal;
            this.emit();
        }
    }
}

// --- Task Interface & Logic ---
interface TaskItem {
    text: string;
    cleanText: string;
    status: string;
    path: string;
    scheduled: string | null; // YYYY-MM-DD
    due: string | null;       // YYYY-MM-DD
    effectiveDateStr: string; // The date used for sorting (Scheduled or Due)
}

class GentlePomoView extends ItemView {
    plugin: GentlePomoPlugin;
    timer: TimerEngine;
    timerShape!: HTMLDivElement; // Timer Shape Element
    timeLabel!: HTMLDivElement; // Time Label
    totalTimeLabel!: HTMLDivElement; // Total Time Label
    modeLabel!: HTMLDivElement;
    settingsPanel!: HTMLDivElement;
    settingsVisible = false;

    // Wrapper for animation
    adjustWrapper!: HTMLDivElement;
    
    // Task List Elements
    taskListContainer!: HTMLDivElement;
    taskListVisible = false;
    taskBtn!: HTMLButtonElement;

    private timerListener: TimerListener | null = null;

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

    async onOpen() {
        const container = this.containerEl;
        container.empty();
        container.addClass("gp-root");

        // --- Timer Visual Area ---
        const visual = container.createDiv("gp-timer-visual");
        this.timerShape = visual.createDiv("gp-timer-shape");
        
        // Create Layers in Order: Day -> Dusk -> Night 
        this.timerShape.createDiv("gp-layer-day");
        this.timerShape.createDiv("gp-layer-dusk"); // Dusk Layer
        this.timerShape.createDiv("gp-layer-night");

        const content = visual.createDiv("gp-timer-content");
        this.timeLabel = content.createDiv("gp-timer-time");        
        this.totalTimeLabel = content.createDiv("gp-total-time"); // Create the Total Time Label
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

        const stopBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(stopBtn, "square");
        stopBtn.setAttribute("aria-label", "Finish & Next");
        this.registerDomEvent(stopBtn, "click", (evt) => {
            evt.preventDefault();
            this.timer.finish();
        });

        const resetBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(resetBtn, "rotate-ccw");
        resetBtn.setAttribute("aria-label", "Reset Session");
        this.registerDomEvent(resetBtn, "click", (evt) => {
            evt.preventDefault();
            this.timer.reset();
        });

        const skipBtn = row1.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(skipBtn, "skip-forward");
        skipBtn.setAttribute("aria-label", "Skip to Next");
        this.registerDomEvent(skipBtn, "click", (evt) => {
            evt.preventDefault();
            this.timer.skip();
        });

        // ROW 2: -5m, +5m, Settings
        const row2 = controls.createDiv("gp-controls-row");

        // Create wrapper for +/- buttons
        this.adjustWrapper = row2.createDiv("gp-adjust-wrapper");

        const minusBtn = this.adjustWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(minusBtn, "minus");
        this.registerDomEvent(minusBtn, "click", (evt) => {
            evt.preventDefault();
            // Safety check: prevent action if <= 5m (though button should be disabled)
            if (this.timer.getState().remainingMs > 5 * 60 * 1000) {
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
            this.settingsPanel.style.display = this.settingsVisible ? "flex" : "none";
            if (this.settingsVisible) this.renderSettingsPanel();
        });

        // --- Settings Panel ---
        this.settingsPanel = controls.createDiv("gp-settings-panel");
        this.settingsPanel.style.display = "none";
        this.renderSettingsPanel();

        // ROW 3: Task Selector
        const row3 = controls.createDiv("gp-controls-row");
        this.taskBtn = row3.createEl("button", { cls: "gp-btn gp-btn-full" });
        
        // Create internal structure for 2 rows
        const btnLabel = this.taskBtn.createDiv("gp-task-btn-label");
        btnLabel.setText("Current Task");
        
        const btnText = this.taskBtn.createDiv("gp-task-btn-text");
        btnText.setText("Select a task..."); // Default text

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
            if (state.isRunning) {
                startBtn.addClass("gp-hidden");
                pauseBtn.removeClass("gp-hidden");

                // Animate Wrapper In
                this.adjustWrapper.removeClass("gp-hidden-animated");
            } else {
                startBtn.removeClass("gp-hidden");
                pauseBtn.addClass("gp-hidden");

                // Animate Wrapper Out
                this.adjustWrapper.addClass("gp-hidden-animated");
            }

            // Disable Minus Button if remaining time < 5 minutes
            if (state.remainingMs <= 5 * 60 * 1000) {
                minusBtn.setAttribute("disabled", "true");
                minusBtn.addClass("gp-btn-disabled");
            } else {
                minusBtn.removeAttribute("disabled");
                minusBtn.removeClass("gp-btn-disabled");
            }

            const isOvertime = state.remainingMs < 0;

            // Visual Classes for Overtime Glow
            // We apply these to the 'visual' container so CSS can target the shape inside
            visual.toggleClass("gp-state-overtime", isOvertime);
            visual.toggleClass("gp-mode-focus", state.mode === "focus");
            visual.toggleClass("gp-mode-break", state.mode === "break");

            // Main Timer Logic (Remaining / Overtime)
            const absMs = Math.abs(state.remainingMs);
            const totalSec = Math.ceil(absMs / 1000);
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;

            let timeText = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
            if (isOvertime) {
                timeText = "+" + timeText;
                this.timeLabel.addClass("gp-overtime");
                // Total Time Logic (Only in Overtime)
                // Total Elapsed = Original Duration + Overtime Duration
                // Original Duration = state.totalMs
                // Overtime Duration = absMs
                const actualTotalMs = state.totalMs + absMs;
                const tSec = Math.floor(actualTotalMs / 1000);
                const tM = Math.floor(tSec / 60);
                const tS = tSec % 60;                
                this.totalTimeLabel.setText(`Total: ${tM}:${tS.toString().padStart(2, "0")}`);
            } else {
                this.timeLabel.removeClass("gp-overtime");
                this.totalTimeLabel.setText(""); // Clear text when not overtime
            }
            this.timeLabel.setText(timeText);

            this.modeLabel.setText(state.mode === "focus" ? "Focus" : "Rest");
            visual.toggleClass("gp-state-running", state.isRunning);

            // --- Gradient Transition Logic ---
            let progress = 0;
            if (state.totalMs > 0) {
                progress = 1 - state.remainingMs / state.totalMs;
            }
            progress = Math.max(0, Math.min(1, progress));

            // Determine "Sky Phase" (0 = Day, 1 = Night)
            let skyPhase = 0;
            if (state.mode === "focus") {
                skyPhase = progress; // Day -> Night
            } else {
                skyPhase = 1 - progress; // Night -> Day
            }

            // Calculate Opacities for 2-Stage Transition
            // Stage 1 (0.0 - 0.5): Day -> Dusk
            // Stage 2 (0.5 - 1.0): Dusk -> Night            
            let duskOpacity = 0;
            let nightOpacity = 0;
            if (skyPhase < 0.5) {
                // First Half: Fade in Dusk (Day is background)
                // Map 0.0-0.5 to 0.0-1.0
                duskOpacity = skyPhase * 2;
                nightOpacity = 0;
            } else {
                // Second Half: Fade in Night (Dusk is background)
                // Map 0.5-1.0 to 0.0-1.0
                duskOpacity = 1; // Dusk stays fully opaque behind Night
                nightOpacity = (skyPhase - 0.5) * 2;
            }
            this.timerShape.style.setProperty("--gp-dusk-opacity", duskOpacity.toString()); 
            this.timerShape.style.setProperty("--gp-night-opacity", nightOpacity.toString());
        };

        this.plugin.timer.onChange(this.timerListener);
    }

    async onClose() {
        if (this.timerListener) {
            this.plugin.timer.offChange(this.timerListener);
            this.timerListener = null;
        }
    }

    // --- Task Loading Logic ---
    async loadTasks() {
        this.taskListContainer.empty();

        // --- Add "Unlink Task" Option at the top ---
        const clearItem = this.taskListContainer.createDiv("gp-task-item");
        setIcon(clearItem, "x-circle");
        clearItem.createSpan({ text: "Unlink Current Task" });
        // Style it slightly differently to indicate it's an action
        clearItem.style.color = "var(--text-muted)";
        clearItem.style.fontStyle = "italic"; 
        
        clearItem.onclick = () => {
            // Reset the button text
            const textEl = this.taskBtn.querySelector(".gp-task-btn-text");
            if (textEl) textEl.setText("Select a task...");

            // Use the new setter to update both Engine and LogManager
            this.timer.setTask("No Task");
            
            // Close the list
            this.taskListVisible = false;
            this.taskListContainer.removeClass("gp-visible");
        };

        const tasks: TaskItem[] = [];
        const path = this.plugin.settings.tasksPath;
        
        // Get files
        const files = this.plugin.app.vault.getFiles().filter(f => f.path.startsWith(path) && f.extension === "md");

        const today = moment().startOf('day');
        const limitDate = moment().add(3, 'days').endOf('day');

        for (const file of files) {
            const content = await this.plugin.app.vault.cachedRead(file);
            const lines = content.split("\n");
            
            // Regex for tasks: - [ ] ... (Not Done)
            const taskRegex = /^\s*-\s*\[ \]\s+(.*)$/;
            
            // Regex for "Tasks" plugin emojis
            const scheduledRegex = /⏳\s*(\d{4}-\d{2}-\d{2})/;
            const dueRegex = /📅\s*(\d{4}-\d{2}-\d{2})/;
            
            // Regex to clean up:
            // 1. Dates: ⏳ YYYY-MM-DD, 📅 YYYY-MM-DD, 🛫 YYYY-MM-DD, ➕ YYYY-MM-DD
            // 2. Priorities: 🔺, 🔽, 🔥
            // 3. Recurrence: 🔁 ...
            // REMOVED: |#\w+ (We now keep tags)
            const cleanupRegex = /[⏳📅🛫➕]\s*\d{4}-\d{2}-\d{2}|[🔺🔽🔥]\s*\w*|🔁\s*[a-zA-Z0-9\s]+/g;

            for (const line of lines) {
                const match = line.match(taskRegex);
                if (match) {
                    const originalText = match[1];
                    
                    // Extract dates
                    const scheduledMatch = originalText.match(scheduledRegex);
                    const dueMatch = originalText.match(dueRegex);
                    
                    const scheduled = scheduledMatch ? scheduledMatch[1] : null;
                    const due = dueMatch ? dueMatch[1] : null;

                    // 1. Determine Effective Date
                    const effectiveDateStr = scheduled || due;

                    // 2. Filter Logic
                    if (effectiveDateStr) {
                        const dateObj = moment(effectiveDateStr);
                        if (dateObj.isSameOrBefore(limitDate)) {
                            
                            const cleanText = originalText.replace(cleanupRegex, "").trim();
                            
                            tasks.push({
                                text: originalText,
                                cleanText: cleanText || "Untitled Task",
                                status: "todo",
                                path: file.path,
                                scheduled,
                                due,
                                effectiveDateStr
                            });
                        }
                    }
                }
            }
        }

        // 3. Sort: Effective Date -> File Path
        tasks.sort((a, b) => {
            if (a.effectiveDateStr !== b.effectiveDateStr) {
                return a.effectiveDateStr.localeCompare(b.effectiveDateStr);
            }
            return a.path.localeCompare(b.path);
        });

        // 4. Render with Grouping
        if (tasks.length === 0) {
            this.taskListContainer.createDiv({ cls: "gp-task-item-empty", text: "No tasks found for next 3 days." });
        } else {
            let lastGroupLabel = "";

            tasks.forEach(task => {
                const dateObj = moment(task.effectiveDateStr);
                let groupLabel = "";

                if (dateObj.isBefore(today)) {
                    groupLabel = "Overdue";
                } else if (dateObj.isSame(today, 'day')) {
                    groupLabel = "Today";
                } else if (dateObj.isSame(moment().add(1, 'day'), 'day')) {
                    groupLabel = "Tomorrow";
                } else {
                    groupLabel = dateObj.format("dddd, MMM D");
                }

                if (groupLabel !== lastGroupLabel) {
                    this.taskListContainer.createDiv("gp-task-group-header").setText(groupLabel);
                    lastGroupLabel = groupLabel;
                }

                const item = this.taskListContainer.createDiv("gp-task-item");
                // REMOVED: setIcon(item, "circle");
                item.createSpan({ text: task.cleanText });
                
                item.onclick = () => {
                    // Update the text inside the button
                    const textEl = this.taskBtn.querySelector(".gp-task-btn-text");
                    if (textEl) textEl.setText(task.cleanText);

                    // FIX: Use the new setter to update both Engine and LogManager
                    this.timer.setTask(task.cleanText, task.path);
                    
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

class GentlePomoSettingTab extends PluginSettingTab {
    plugin: GentlePomoPlugin;
    constructor(app: App, plugin: GentlePomoPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Gentle Pomodoro Settings" });

        new Setting(containerEl)
            .setName("Tasks Folder Path")
            .setDesc("Folder to search for tasks (e.g., 'Daily Notes'). Leave empty to search entire vault.")
            .addText(text => text
                .setPlaceholder("Example: Projects/Active")
                .setValue(this.plugin.settings.tasksPath)
                .onChange(async (value) => {
                    this.plugin.settings.tasksPath = value;
                    await this.plugin.saveSettings();
                }));

        // Log Folder Setting
        new Setting(containerEl)
            .setName("Pomodoro Logs Folder")
            .setDesc("Folder to store daily log files (e.g., 'Pomodoro_logs').")
            .addText(text => text
                .setPlaceholder("Example: Pomodoro_logs")
                .setValue(this.plugin.settings.logFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.logFolderPath = value;
                    await this.plugin.saveSettings();
                }));
    }
}

export default class GentlePomoPlugin extends Plugin {
    settings!: GentlePomoSettings;
    timer!: TimerEngine;
    logManager!: LogManager; 

    async onload() {
        await this.loadSettings();
        this.logManager = new LogManager(this); 
        this.timer = new TimerEngine(this);

        this.registerView(
            VIEW_TYPE_GENTLE_POMO,
            (leaf) => new GentlePomoView(leaf, this)
        );

        this.addRibbonIcon("clock", "Gentle Pomodoro", () => {
            this.activateView();
        });

        this.addSettingTab(new GentlePomoSettingTab(this.app, this));
    }

    async onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_GENTLE_POMO);
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
        if (leaf) workspace.revealLeaf(leaf);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
	}
}
