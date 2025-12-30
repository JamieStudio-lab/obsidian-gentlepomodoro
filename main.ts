import {
    App,
    ItemView,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
    setIcon,
    TFile,
    TAbstractFile,
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
    taskName: string;
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
            taskName: "No Task",
        };
    }

    // Method to update task name and sync with LogManager
    setTask(name: string, path?: string) {
        this.currentTaskName = name;
        this.currentTaskPath = path;
        this.state.taskName = name;
        // If a session is running (or paused), update its log entry immediately
        this.plugin.logManager.updateTask(name, path);
        this.emit();
    }

    // Handle file modification to check for task completion
    async onFileModify(file: TAbstractFile) {
        // 1. Basic checks
        if (this.currentTaskName === "No Task" || !this.currentTaskPath) return;
        
        // 2. Check if modified file matches current task file
        if (file.path !== this.currentTaskPath) return;

        // 3. If timer is running, do NOT unlink automatically (per requirements)
        if (this.state.isRunning) return;

        // 4. Check completion
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

    private handleFinished() {
        // Log the finished session
        this.plugin.logManager.endSession("finished");

        // Check if task is completed and unlink if so
        this.checkTaskCompletionAndUnlink();

        // REMOVED: if (this.plugin.settings.soundEnabled) { this.playChime(); } 
        // Sound is now handled in finish() or skip() before calling this, 
        // or we can add auto-finish sound logic here if the timer runs out naturally.
        
        // NOTE: If the timer runs out naturally (via startLoop), we still need a sound.
        // Since handleFinished is called by startLoop, let's add a check here for natural completion.
        // However, finish() and skip() call this too. To avoid double sounds, we can rely on the caller
        // OR pass a flag. 
        // But wait, startLoop calls handleFinished() directly when time < 0 (if we had auto-finish logic, 
        // but currently we go into overtime).
        
        // Actually, this plugin goes into OVERTIME, it doesn't auto-finish.
        // So handleFinished is ONLY called by user interaction (Stop/Skip).
        // Therefore, the sound logic in finish() and skip() is sufficient.
        
        if (this.state.mode === "focus") {
            this.switchMode("break", this.plugin.settings.autoStartBreak);
        } else {
            this.switchMode("focus", this.plugin.settings.autoStartFocus);
        }
    }

    private async checkTaskCompletionAndUnlink() {
        if (!this.currentTaskPath || this.currentTaskName === "No Task") return;

        const file = this.plugin.app.vault.getAbstractFileByPath(this.currentTaskPath);
        if (!(file instanceof TFile)) return;

        try {
            const content = await this.plugin.app.vault.read(file);
            const lines = content.split("\n");
            
            // Regex to match completed tasks: - [x] ...
            // Reuse cleanup regex logic (same as in GentlePomoView)
            // Added: ✅ for Tasks plugin completion dates
            const cleanupRegex = /[⏳📅🛫➕✅]\s*\d{4}-\d{2}-\d{2}|[🔺🔽🔥]\s*\w*|🔁\s*[a-zA-Z0-9\s]+/g;
            
            let foundIncomplete = false;
            let foundComplete = false;

            for (const line of lines) {
                // Check for Incomplete: - [ ] ...
                const incompleteMatch = line.match(/^\s*-\s*\[ \]\s+(.*)$/);
                if (incompleteMatch) {
                    const clean = incompleteMatch[1].replace(cleanupRegex, "").trim();
                    if (clean === this.currentTaskName) {
                        foundIncomplete = true;
                        // If we find an incomplete version, we assume the task is still active.
                        break; 
                    }
                }

                // Check for Complete: - [x] ...
                const completeMatch = line.match(/^\s*-\s*\[x\]\s+(.*)$/i);
                if (completeMatch) {
                    const clean = completeMatch[1].replace(cleanupRegex, "").trim();
                    if (clean === this.currentTaskName) {
                        foundComplete = true;
                    }
                }
            }

            // Logic:
            // 1. If we found an incomplete version, the task is still active. Do nothing.
            // 2. If we did NOT find an incomplete version, but DID find a complete version, it means the task was finished. Unlink.
            if (!foundIncomplete && foundComplete) {
                this.setTask("No Task");
            }
        } catch (e) {
            console.error("[GentlePomo] Failed to check task completion", e);
        }
    }

    // CHANGED: Generalized sound player that takes a specific filename
    private async playSound(filename: string) {
        if (!this.plugin.settings.soundEnabled) return;

        try {
            const pluginDir = this.plugin.manifest.dir;
            if (pluginDir) {
                const soundFile = `${pluginDir}/${filename}`;
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
                } else {
                    console.log(`[GentlePomo] Sound file not found: ${soundFile}`);
                }
            }
        } catch (e) {
            console.error(`[GentlePomo] Failed to play sound ${filename}:`, e);
        }
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
            taskName: this.currentTaskName,
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
        
        // Check if this is a fresh start (not a resume)
        // Play War Drum only on fresh Focus start
        const isFreshStart = this.state.remainingMs === this.state.totalMs;

        this.state.isRunning = true;

        // Start or Resume Logging
        const minutes = this.state.mode === "focus" 
            ? this.plugin.settings.focusMinutes 
            : this.plugin.settings.breakMinutes;
        this.plugin.logManager.startSession(this.state.mode, this.currentTaskName, minutes, this.currentTaskPath); 
        
        // Set target based on current remaining time
        this.targetTime = Date.now() + this.state.remainingMs;
        
        // NEW: Play War Drum only on fresh Focus start
        if (isFreshStart && this.state.mode === "focus") {
            this.playSound("war-drum_short.mp3");
        }

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
        // Play specific sounds based on mode when manually finishing
        if (this.state.mode === "focus") {
            this.playSound("singing_bell_short.mp3");
        } else {
            this.playSound("ding-sound.mp3");
        }
        this.handleFinished();
    }

    skip() {
        // Check if we are in a "stopped" state (fresh start, not running, not paused)
        const isStopped = !this.state.isRunning && this.state.remainingMs === this.state.totalMs;

        // Play specific sounds based on mode when skipping, unless stopped
        if (!isStopped) {
            // Logic mirrors finish(): Focus -> Bell, Rest -> Ding
            if (this.state.mode === "focus") {
                this.playSound("singing_bell_short.mp3");
            } else {
                this.playSound("ding-sound.mp3");
            }
        }

        // Differentiate status based on mode
        // Focus: Skip -> Cancelled (stopped work early)
        // Rest: Skip -> Finished (stopped rest early, effectively finishing it)
        const status = this.state.mode === "focus" ? "cancelled" : "finished";
        this.plugin.logManager.endSession(status);

        // Check if task is completed and unlink if so
        this.checkTaskCompletionAndUnlink();

        const nextMode: PomoMode = this.state.mode === "focus" ? "break" : "focus";
        this.switchMode(nextMode, false);
    }

    // Cancel current session without switching modes; not in use currently
    cancel() {
        // Log cancellation
        this.plugin.logManager.endSession("cancelled");

        // Check if task is completed and unlink if so
        this.checkTaskCompletionAndUnlink();

        this.switchMode(this.state.mode, false);
    }

    reset() {
        // Calculate total for current mode
        const minutes = this.state.mode === "focus" 
            ? this.plugin.settings.focusMinutes 
            : this.plugin.settings.breakMinutes;
        const total = minutes * 60 * 1000;

        // Reset time
        this.state.remainingMs = total;
        this.state.totalMs = total;

        // Handle Logging: Keep the current log going. Do not end or clear it.

        if (this.state.isRunning) {
            // If running, just update the target time
            this.targetTime = Date.now() + total;
        } else {
            // If paused/stopped, we are now in fresh state
            this.targetTime = null;
            this.clearLoop();
        }

        this.emit();
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
    // REMOVED: progressRing!: HTMLDivElement; // Progress Ring Element
    timeLabel!: HTMLDivElement; // Time Label
    totalTimeLabel!: HTMLDivElement; // Total Time Label
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

        // Create Shape
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

        // Wrapper for Secondary Controls (Stop, Reset) - Skip moved OUT
        this.secondaryControlsWrapper = row1.createDiv("gp-animated-wrapper gp-secondary-controls");

        const stopBtn = this.secondaryControlsWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(stopBtn, "square");
        stopBtn.setAttribute("aria-label", "Finish & Next");
        this.registerDomEvent(stopBtn, "click", (evt) => {
            evt.preventDefault();
            this.timer.finish();
        });

        const resetBtn = this.secondaryControlsWrapper.createEl("button", { cls: "gp-btn gp-icon-btn" });
        setIcon(resetBtn, "rotate-ccw");
        resetBtn.setAttribute("aria-label", "Reset Session");
        this.registerDomEvent(resetBtn, "click", (evt) => {
            evt.preventDefault();
            this.timer.reset();
        });

        // Skip Button - Now outside the wrapper, always visible
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
        this.adjustWrapper = row2.createDiv("gp-animated-wrapper gp-adjust-wrapper");

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
                
                // Show secondary controls (Stop, Reset, Skip)
                this.secondaryControlsWrapper.removeClass("gp-hidden-animated");

                // Animate Wrapper In
                this.adjustWrapper.removeClass("gp-hidden-animated");
            } else {
                startBtn.removeClass("gp-hidden");
                pauseBtn.addClass("gp-hidden");
                
                // Show secondary controls if paused (active session), hide if fresh/reset
                if (state.remainingMs !== state.totalMs) {
                    this.secondaryControlsWrapper.removeClass("gp-hidden-animated");
                    // Show wrapper if paused
                    this.adjustWrapper.removeClass("gp-hidden-animated");
                } else {
                    this.secondaryControlsWrapper.addClass("gp-hidden-animated");
                    // Hide wrapper if reset
                    this.adjustWrapper.addClass("gp-hidden-animated");
                }
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

            // Update Task Button Text
            const textEl = this.taskBtn.querySelector(".gp-task-btn-text");
            if (textEl) {
                if (state.taskName === "No Task") {
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

            // Determine "Sky Phase" (0 = Day, 1 = Night)
            let skyPhase = 0;
            if (state.mode === "focus") {
                skyPhase = progress; // Day -> Night
            } else {
                skyPhase = 1 - progress; // Night -> Day
            }

            // Calculate Ring Color based on Sky Phase
            // Day Color: #f6d365 (RGB: 246, 211, 101)
            // Night Color: #517fa4 (RGB: 81, 127, 164)
            const r = Math.round(246 + (81 - 246) * skyPhase);
            const g = Math.round(211 + (127 - 211) * skyPhase);
            const b = Math.round(101 + (164 - 101) * skyPhase);

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
            visual.style.setProperty("--gp-dusk-opacity", duskOpacity.toString()); 
            visual.style.setProperty("--gp-night-opacity", nightOpacity.toString());
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
            // 1. Dates: ⏳ YYYY-MM-DD, 📅 YYYY-MM-DD, 🛫 YYYY-MM-DD, ➕ YYYY-MM-DD, ✅ YYYY-MM-DD
            // 2. Priorities: 🔺, 🔽, 🔥
            // 3. Recurrence: 🔁 ...
            // REMOVED: |#\w+ (We now keep tags)
            const cleanupRegex = /[⏳📅🛫➕✅]\s*\d{4}-\d{2}-\d{2}|[🔺🔽🔥]\s*\w*|🔁\s*[a-zA-Z0-9\s]+/g;

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
                
                // Highlight if this is the currently selected task
                if (task.cleanText === this.timer.currentTaskName && task.path === this.timer.currentTaskPath) {
                    item.addClass("gp-task-selected");
                    // Create a separate container for the icon so setIcon doesn't wipe the text
                    const iconContainer = item.createDiv("gp-task-check-icon");
                    setIcon(iconContainer, "check");
                }

                item.onclick = () => {
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

        // Register event to watch for task completion in the background
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            await this.timer.onFileModify(file);
        }));

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
