import { Notice, TFile, normalizePath } from "obsidian";
import type GentlePomoPlugin from "./main";
import { FOCUS_TOTAL_CACHE_TTL_MS } from "./constants";
import { findTaskNameById, findTaskNameByIdInContent } from "./taskLoader";
import type { MomentFactory, MomentLike } from "./momentTypes";

declare const moment: MomentFactory;

export interface SessionLog {
  mode: "focus" | "break";
  taskName: string;
  taskPath?: string; // Store the file path of the task
  scheduledDurationMinutes: number;
  startTime: MomentLike;
  endTime: MomentLike;
  pauses: { start: MomentLike; end: MomentLike }[];
  status: "finished" | "cancelled";
  taskId?: string; // Tasks plugin ID
  // null/undefined when mode is "focus"; otherwise distinguishes short vs long break.
  breakType?: "short" | "long" | null;
}

type ActiveSessionLog = Omit<SessionLog, "endTime">;

// Pure helper: format a completed session as a single log line.
// Exported so tests can lock in the inline-field schema that users' Dataview queries depend on.
export function formatLogLine(session: SessionLog): string {
  let totalPauseMs = 0;
  const pauseStrings = session.pauses.map((p) => {
    totalPauseMs += p.end.diff(p.start);
    return `${p.start.format("YYYY-MM-DD HH:mm:ss")} - ${p.end.format("YYYY-MM-DD HH:mm:ss")}`;
  });

  const totalDurationMs = session.endTime.diff(session.startTime) - totalPauseMs;
  const totalSeconds = Math.floor(totalDurationMs / 1000);
  const scheduledSeconds = session.scheduledDurationMinutes * 60;

  const startFmt = session.startTime.format("YYYY-MM-DD HH:mm:ss");
  const endFmt = session.endTime.format("YYYY-MM-DD HH:mm:ss");

  if (session.mode === "focus") {
    let taskStr = session.taskName === "No Task" ? "No Task" : `${session.taskName}`;
    if (session.taskPath && session.taskName !== "No Task") {
      taskStr = `[[${session.taskPath}|${session.taskName}]]`;
    }
    const pauseJson = JSON.stringify(pauseStrings);
    const idStr = session.taskId ? ` | ID:: ${session.taskId}` : "";
    return `- 🍅 Focus | Task:: ${taskStr}${idStr} | Start:: ${startFmt} | End:: ${endFmt} | Scheduled:: ${scheduledSeconds} | Pauses:: ${pauseJson} | Total:: ${totalSeconds} | Status:: ${session.status} | Type:: focus`;
  }

  const breakTypeStr = session.breakType === "long" ? "long-break" : "short-break";
  return `- ☕ Rest | Start:: ${startFmt} | End:: ${endFmt} | Scheduled:: ${scheduledSeconds} | Total:: ${totalSeconds} | Type:: ${breakTypeStr}`;
}

/**
 * Pure helper: should the "daily goal hit" notice fire?
 *
 * Returns true when all of:
 *  - goal is configured (> 0 minutes)
 *  - notice is enabled
 *  - current focus seconds today have crossed the goal threshold
 *  - notice hasn't already fired today (date-keyed flag)
 */
export function shouldFireGoalNotice(
  currentSeconds: number,
  goalMinutes: number,
  noticeEnabled: boolean,
  lastGoalHitDate: string | null,
  today: string
): boolean {
  if (goalMinutes <= 0) return false;
  if (!noticeEnabled) return false;
  if (currentSeconds < goalMinutes * 60) return false;
  if (lastGoalHitDate === today) return false;
  return true;
}

// Pure helper: sum Total:: seconds across all focus lines in a log file's content.
export function parseFocusTotalSeconds(content: string): number {
  const lines = content.split("\n");
  let total = 0;
  for (const line of lines) {
    if (!line.includes("🍅 Focus")) continue;
    const totalMatch = line.match(/Total::\s*(\d+)/);
    if (!totalMatch) continue;
    const seconds = parseInt(totalMatch[1], 10);
    if (!Number.isNaN(seconds)) total += seconds;
  }
  return total;
}

export class LogManager {
  private plugin: GentlePomoPlugin;
  private currentSession: ActiveSessionLog | null = null;
  private currentPauseStart: MomentLike | null = null;
  private focusTotalCacheDate: string | null = null;
  private focusTotalCacheSeconds = 0;
  private focusTotalCacheAt = 0;

  constructor(plugin: GentlePomoPlugin) {
    this.plugin = plugin;
  }

  /** Open a new session or resume from pause (idempotent if a session is already active). */
  startSession(
    mode: "focus" | "break",
    taskName: string,
    durationMinutes: number,
    taskPath?: string,
    taskId?: string,
    breakType?: "short" | "long" | null
  ) {
    // If a session is already active (e.g. resuming from pause), don't overwrite start time
    if (this.currentSession) {
      this.resumeSession();
      return;
    }

    this.currentSession = {
      mode,
      taskName: taskName || "No Task",
      taskPath,
      taskId,
      scheduledDurationMinutes: durationMinutes,
      startTime: moment(),
      pauses: [],
      status: "cancelled",
      breakType,
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
      end: pauseEnd,
    });
    this.currentPauseStart = null;
  }

  // Allow updating task name mid-session
  updateTask(newTaskName: string, newTaskPath?: string, newTaskId?: string) {
    if (this.currentSession) {
      this.currentSession.taskName = newTaskName || "No Task";
      this.currentSession.taskPath = newTaskPath;
      this.currentSession.taskId = newTaskId;
    }
  }

  /** Close the active session and append a log line; invalidates today's focus-total cache. */
  async endSession(status: "finished" | "cancelled") {
    if (!this.currentSession) return;

    // If we were paused when ending, close the pause loop
    if (this.currentPauseStart) {
      this.resumeSession();
    }

    const session: SessionLog = {
      ...this.currentSession,
      endTime: moment(),
      status,
    };

    await this.writeLog(session);

    // Reset state
    this.currentSession = null;
    this.currentPauseStart = null;
  }

  /** Rewrite the Task:: field on all log lines that reference `taskId`. Used when the task is renamed. */
  async updateLoggedTaskName(taskId: string, taskName: string, taskPath?: string) {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath || !taskId) return;

    const app = this.plugin.app;
    const normalizedFolder = normalizePath(folderPath);
    const files = app.vault
      .getFiles()
      .filter((f) => f.extension === "md" && f.path.startsWith(normalizedFolder));

    if (files.length === 0) return;

    for (const file of files) {
      const content = await app.vault.read(file);
      const lines = content.split("\n");
      let changed = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("🍅 Focus") || !line.includes(`| ID:: ${taskId} |`)) continue;

        const updated = this.updateLogLineTaskName(line, taskId, taskName, taskPath);
        if (updated !== line) {
          lines[i] = updated;
          changed = true;
        }
      }

      if (changed) {
        await app.vault.modify(file, lines.join("\n"));
      }
    }
  }

  /** Refresh ALL log files' Task:: fields by re-resolving each ID-bearing line against the source task. */
  async refreshLoggedTaskNamesById() {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) {
      new Notice("Gentle pomodoro: log folder path is not set.");
      return;
    }

    const app = this.plugin.app;
    const normalizedFolder = normalizePath(folderPath);
    const logFiles = app.vault
      .getFiles()
      .filter((f) => f.extension === "md" && f.path.startsWith(normalizedFolder));

    if (logFiles.length === 0) {
      new Notice("Gentle pomodoro: no log files found.");
      return;
    }

    const taskContentCache = new Map<string, string | null>();
    const taskNameCache = new Map<string, string | null>();

    let filesUpdated = 0;
    let linesUpdated = 0;

    for (const file of logFiles) {
      const content = await app.vault.read(file);
      const lines = content.split("\n");
      let changed = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ref = this.parseLogLineTaskRef(line);
        if (!ref || !ref.taskPath) continue;

        const cacheKey = `${ref.taskPath}::${ref.taskId}`;
        let latestName = taskNameCache.get(cacheKey);
        if (latestName === undefined) {
          let taskContent = taskContentCache.get(ref.taskPath);
          if (taskContent === undefined) {
            const taskFile = app.vault.getAbstractFileByPath(ref.taskPath);
            if (taskFile instanceof TFile) {
              taskContent = await app.vault.read(taskFile);
            } else {
              taskContent = null;
            }
            taskContentCache.set(ref.taskPath, taskContent);
          }

          latestName = taskContent ? findTaskNameByIdInContent(taskContent, ref.taskId) : null;
          taskNameCache.set(cacheKey, latestName);
        }

        if (!latestName) continue;

        const updated = this.updateLogLineTaskName(line, ref.taskId, latestName, ref.taskPath);
        if (updated !== line) {
          lines[i] = updated;
          changed = true;
          linesUpdated += 1;
        }
      }

      if (changed) {
        await app.vault.modify(file, lines.join("\n"));
        filesUpdated += 1;
      }
    }

    new Notice(`[GentlePomo] Updated ${linesUpdated} log line(s) across ${filesUpdated} file(s).`);
  }

  private parseLogLineTaskRef(line: string): { taskId: string; taskPath?: string } | null {
    if (!line.includes("🍅 Focus") || !line.includes("| ID:: ")) return null;

    const idMatch = line.match(/\|\s*ID::\s*([^|]+)\s*\|/);
    if (!idMatch) return null;

    const taskSegmentRegex = /Task::\s(\[\[[^\]]+\]\]|[^|]+)\s\|/;
    const taskMatch = line.match(taskSegmentRegex);
    if (!taskMatch) return null;

    const taskStr = taskMatch[1].trim();
    const linkMatch = taskStr.match(/^\[\[([^|\]]+)\|([^\]]+)\]\]$/);
    const taskPath = linkMatch ? linkMatch[1] : undefined;

    return { taskId: idMatch[1].trim(), taskPath };
  }

  private updateLogLineTaskName(
    line: string,
    taskId: string,
    taskName: string,
    taskPath?: string
  ): string {
    if (!line.includes(`| ID:: ${taskId} |`)) return line;

    const taskSegmentRegex = /Task::\s(\[\[[^\]]+\]\]|[^|]+)\s\|/;
    const match = line.match(taskSegmentRegex);
    if (!match) return line;

    const oldTaskStr = match[1].trim();
    const linkMatch = oldTaskStr.match(/^\[\[([^|\]]+)\|([^\]]+)\]\]$/);
    const pathToUse = taskPath || (linkMatch ? linkMatch[1] : undefined);
    const safeName = taskName || "No Task";

    const newTaskStr =
      pathToUse && safeName !== "No Task" ? `[[${pathToUse}|${safeName}]]` : safeName;

    return line.replace(taskSegmentRegex, `Task:: ${newTaskStr} |`);
  }

  private async writeLog(session: SessionLog) {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) return; // Logging disabled if no path set

    const app = this.plugin.app;
    const adapter = app.vault.adapter;

    // Refresh task name from file if ID is available (handles renames)
    if (session.mode === "focus" && session.taskId && session.taskPath) {
      const latestName = await findTaskNameById(app, session.taskPath, session.taskId);
      if (latestName) {
        session.taskName = latestName;
      }
    }

    // 1. Ensure folder exists
    const normalizedFolder = normalizePath(folderPath);
    if (!(await adapter.exists(normalizedFolder))) {
      await app.vault.createFolder(normalizedFolder);
    }

    // 2. Determine File Name based on Start Time
    const dateStr = session.startTime.format("YYYY-MM-DD");
    const fileName = `${dateStr}-gentle-pomodoro-log.md`;
    const filePath = normalizePath(`${normalizedFolder}/${fileName}`);

    // 3. Format the line via the pure helper (tested in tests/logManager.test.ts).
    const line = formatLogLine(session);

    // 4. Append to File
    if (await adapter.exists(filePath)) {
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await app.vault.append(file, `\n${line}`);
      }
    } else {
      await app.vault.create(filePath, line);
    }

    if (session.mode === "focus") {
      this.focusTotalCacheAt = 0;
    }
  }

  /** Today's total focus seconds, summed from today's log file. Cached for FOCUS_TOTAL_CACHE_TTL_MS. */
  async getTodayFocusSeconds(): Promise<number> {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) return 0;

    const dateStr = moment().format("YYYY-MM-DD");
    const now = Date.now();

    if (
      this.focusTotalCacheDate === dateStr &&
      now - this.focusTotalCacheAt < FOCUS_TOTAL_CACHE_TTL_MS
    ) {
      return this.focusTotalCacheSeconds;
    }

    const fileName = `${dateStr}-gentle-pomodoro-log.md`;
    const normalizedFolder = normalizePath(folderPath);
    const filePath = normalizePath(`${normalizedFolder}/${fileName}`);
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      this.focusTotalCacheDate = dateStr;
      this.focusTotalCacheSeconds = 0;
      this.focusTotalCacheAt = now;
      return 0;
    }

    const content = await this.plugin.app.vault.read(file);
    const totalSeconds = parseFocusTotalSeconds(content);

    this.focusTotalCacheDate = dateStr;
    this.focusTotalCacheSeconds = totalSeconds;
    this.focusTotalCacheAt = now;
    return totalSeconds;
  }
}
