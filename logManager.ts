import { App, TFile, normalizePath } from "obsidian";
import GentlePomoPlugin from "./main";

declare const moment: any;

export interface SessionLog {
    mode: "focus" | "break";
    taskName: string;
    taskPath?: string; // Store the file path of the task
    scheduledDurationMinutes: number;
    startTime: any; // moment object
    endTime: any; // moment object
    pauses: { start: any; end: any }[];
    status: "finished" | "cancelled";
}

export class LogManager {
    private plugin: GentlePomoPlugin;
    private currentSession: Partial<SessionLog> | null = null;
    private currentPauseStart: any | null = null;

    constructor(plugin: GentlePomoPlugin) {
        this.plugin = plugin;
    }

    startSession(mode: "focus" | "break", taskName: string, durationMinutes: number, taskPath?: string) {
        // If a session is already active (e.g. resuming from pause), don't overwrite start time
        if (this.currentSession) {
            this.resumeSession();
            return;
        }

        this.currentSession = {
            mode,
            taskName: taskName || "No Task",
            taskPath: taskPath, // Store path
            scheduledDurationMinutes: durationMinutes,
            startTime: moment(),
            pauses: [],
            status: "cancelled" // Default until finished
        };
    }

    pauseSession() {
        if (!this.currentSession) return;
        this.currentPauseStart = moment();
    }

    resumeSession() {
        if (!this.currentSession || !this.currentPauseStart) return;
        
        const pauseEnd = moment();
        this.currentSession.pauses?.push({
            start: this.currentPauseStart,
            end: pauseEnd
        });
        this.currentPauseStart = null;
    }

    // Allow updating task name mid-session
    updateTask(newTaskName: string, newTaskPath?: string) {
        if (this.currentSession) {
            this.currentSession.taskName = newTaskName || "No Task";
            this.currentSession.taskPath = newTaskPath;
        }
    }

    async endSession(status: "finished" | "cancelled") {
        if (!this.currentSession) return;

        // If we were paused when ending, close the pause loop
        if (this.currentPauseStart) {
            this.resumeSession();
        }

        this.currentSession.endTime = moment();
        this.currentSession.status = status;

        await this.writeLog(this.currentSession as SessionLog);
        
        // Reset state
        this.currentSession = null;
        this.currentPauseStart = null;
    }

    private async writeLog(session: SessionLog) {
        const folderPath = this.plugin.settings.logFolderPath;
        if (!folderPath) return; // Logging disabled if no path set

        const app = this.plugin.app;
        const adapter = app.vault.adapter;

        // 1. Ensure folder exists
        const normalizedFolder = normalizePath(folderPath);
        if (!(await adapter.exists(normalizedFolder))) {
            await app.vault.createFolder(normalizedFolder);
        }

        // 2. Determine File Name based on Start Time
        const dateStr = session.startTime.format("YYYY-MM-DD");
        const fileName = `${dateStr}-gentle-pomodoro-log.md`;
        const filePath = normalizePath(`${normalizedFolder}/${fileName}`);

        // 3. Calculate Totals
        let totalPauseMs = 0;
        const pauseStrings = session.pauses.map(p => {
            totalPauseMs += p.end.diff(p.start);
            return `${p.start.format("YYYY-MM-DD HH:mm:ss")} - ${p.end.format("YYYY-MM-DD HH:mm:ss")}`;
        });

        const totalDurationMs = session.endTime.diff(session.startTime) - totalPauseMs;
        const totalSeconds = Math.floor(totalDurationMs / 1000);

        const scheduledSeconds = session.scheduledDurationMinutes * 60; // Convert scheduled minutes to seconds


        // 4. Format Line
        let line = "";
        const startFmt = session.startTime.format("YYYY-MM-DD HH:mm:ss");
        const endFmt = session.endTime.format("YYYY-MM-DD HH:mm:ss");

        if (session.mode === "focus") {
            // - 🍅 Focus | Task:: [[Path|Task Name]] | Start:: ...
            let taskStr = session.taskName === "No Task" ? "No Task" : `${session.taskName}`;
            
            // Create a WikiLink if we have a path. This helps with Dataview matching.
            if (session.taskPath && session.taskName !== "No Task") {
                taskStr = `[[${session.taskPath}|${session.taskName}]]`;
            }

            const pauseJson = JSON.stringify(pauseStrings);
            
            line = `- 🍅 Focus | Task:: ${taskStr} | Start:: ${startFmt} | End:: ${endFmt} | Scheduled:: ${scheduledSeconds} | Pauses:: ${pauseJson} | Total:: ${totalSeconds} | Status:: ${session.status}`;
        } else {
            // - ☕ Rest | Start:: ...
            line = `- ☕ Rest | Start:: ${startFmt} | End:: ${endFmt} | Scheduled:: ${scheduledSeconds} | Total:: ${totalSeconds}`;
        }

        // 5. Append to File
        if (await adapter.exists(filePath)) {
            const file = app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await app.vault.append(file, `\n${line}`);
            }
        } else {
            await app.vault.create(filePath, line);
        }
    }
}
