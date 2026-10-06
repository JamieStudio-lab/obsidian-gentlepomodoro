import { Notice, TFile, getLinkpath, normalizePath, type App } from "obsidian";
import type GentlePomoPlugin from "./main";
import { logger } from "./logger";
import { confirmAction, type ConfirmOptions } from "./confirmModal";
import {
  FOCUS_TOTAL_CACHE_TTL_MS,
  LOG_GOAL_WRITE_DELAY_MS,
  MIN_SESSION_SECONDS,
  NO_TASK_LABEL,
  TASK_RENAME_DELAY_MS,
} from "./constants";
import {
  duplicateTaskIds,
  filesInFolder,
  findTaskTextById,
  pathAfterMove,
  taskNameAfterEdit,
} from "./taskLoader";
import {
  formatLogLine,
  logDateNames,
  logicalDate,
  logTaskId,
  loggedTotalSeconds,
  parseFocusTotalSeconds,
  parseLogLine,
  replaceTaskValue,
  type SessionLog,
} from "./logLine";
import {
  REFRESH_SKIPS,
  emptyRefreshSkips,
  refreshExamples,
  refreshLeftAlone,
  refreshLogContent,
  refreshTargets,
  renameLogContent,
  type RefreshNotes,
  type RefreshedName,
  type ResolveLink,
  type TaskRename,
} from "./logRename";
import {
  activeReachedAt,
  activeSecondsWithin,
  resolveTaskSwitchLogging,
  sameTask,
  segmentLogs,
  type ClosedSegment,
  type SegmentLine,
} from "./logSegments";
import type { MomentFactory, MomentLike } from "./momentTypes";
import type { DeviceStorage } from "./deviceStorage";
import { frontmatterRowCount, recordLogGoal, resolveGoalMinutes } from "./logFrontmatter";
import { dailyLogPath, logFolderProblem, logFolderProblemNotice } from "./logFolder";
import { plannedSessionEnd, type LongSessionQuestion } from "./sessionGaps";
import {
  OPEN_SESSION_KEY,
  PENDING_GOALS_KEY,
  UNFINISHED_SESSIONS_KEY,
  UNWRITTEN_LINES_KEY,
  UNWRITTEN_LINE_NOTICE,
  readPendingGoals,
  type PendingGoal,
  readSavedSession,
  readSavedSessions,
  readUnwrittenLines,
  recoveredLongSession,
  recoveredSession,
  sameSavedSession,
  unwrittenLinesWrittenMessage,
  worthRecovering,
  type RecoveryAnswer,
  type SavedSession,
  type UnwrittenLines,
} from "./sessionRecovery";

declare const moment: MomentFactory;

type ActiveSessionLog = Omit<SessionLog, "endTime">;
type LoggedPause = SessionLog["pauses"][number];

/** A 🆔 the log names that is on task lines of its note it cannot tell apart (F2). */
export interface DuplicateTaskId {
  taskId: string;
  /** The note holding the copies. */
  path: string;
}

/** How the engine ends a session — see LogManager.endSession. */
export interface SessionEnd {
  /** The end instant in ms; now when left out. */
  endAt?: number;
  /** Active seconds past the planned end; 0 when left out. */
  overtimeSeconds?: number;
}

/**
 * The pauses as they stand at `end`: one that began at or after it is dropped,
 * one still going then is cut there. Only an end earlier than now — the zero
 * crossing's — can change anything.
 */
function pausesUntil(pauses: LoggedPause[], end: MomentLike): LoggedPause[] {
  const limit = end.valueOf();
  return pauses
    .filter((p) => p.start.valueOf() < limit)
    .map((p) => (p.end.valueOf() > limit ? { start: p.start, end } : p));
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

/**
 * Pure helper: seconds to count from the cached focus-total base.
 *
 * The base was summed from the log file of `baseDate`, so it only describes
 * that day — the log's day, as "Day starts at" counts it. Once the day turns
 * it is yesterday's total and must count as 0 until a fresh fetch lands —
 * otherwise an app kept open across the turn feeds yesterday's seconds into
 * the goal math and fires a spurious "goal hit" notice on the first session
 * of the new day.
 */
export function effectiveFocusBaseSeconds(
  baseSeconds: number,
  baseDate: string | null,
  today: string
): number {
  return baseDate === today ? baseSeconds : 0;
}

/** What LogManager keeps on this device (sessionRecovery.ts). */
export interface LogManagerDevice {
  storage: DeviceStorage;
  /** The open session's planned active time in ms, as on the clock (±5
   *  included) — what a recovered focus's Overtime is counted past. */
  plannedMs: () => number | null;
}

/**
 * The daily log's text with `lines` added at the end (F39). A line break goes
 * in front only when the text does not already end in one, the file's own
 * line ending is used (a CRLF file stays CRLF), and the text ends in a line
 * break. Until 0.6.9 files were created without one and every append put one
 * in front, so a file an editor or a sync tool had ended with a line break
 * got a blank line that split the list, and a CRLF file an LF line.
 */
export function appendToLog(content: string, lines: readonly string[]): string {
  if (lines.length === 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const block = lines.join(eol) + eol;
  if (content === "" || content.endsWith("\n")) return content + block;
  return content + eol + block;
}

/** The last line of `content` that is not blank, or null. */
export function lastLogLine(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length === 0 ? null : lines[lines.length - 1];
}

/**
 * A line kept to be written later (F53) with its Task link following a note
 * that was renamed or moved, or a folder above it (F27) — as Obsidian updates
 * the links of the lines already in the log. Any other line comes back as it
 * is, and so does one `follows` turns down (LogManager.taskNoteMoved): a
 * link to a note deleted before a folder above it was renamed.
 */
export function taskLinkAfterMove(
  line: string,
  oldPath: string,
  newPath: string,
  follows: (from: string, to: string) => boolean = () => true
): string {
  const parsed = parseLogLine(line);
  const task = parsed?.task;
  if (!parsed || !task || task.path === undefined) return line;
  const moved = pathAfterMove(task.path, oldPath, newPath);
  if (moved === null || !follows(task.path, moved)) return line;
  // `[[path|name]]` or `[[path]]`: only the path changes.
  return replaceTaskValue(line, parsed, `[[${moved}${task.raw.slice(2 + task.path.length)}`);
}

/** A stored unfinished list without `saved`; what it cannot read is kept. */
function storedWithout(raw: unknown, saved: SavedSession): unknown[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((entry) => {
    const other = readSavedSession(entry);
    return other === null || !sameSavedSession(other, saved);
  });
}

/** `lines` without the ones `content` already holds. */
function linesNotIn(content: string, lines: readonly string[]): string[] {
  const present = new Set(content.split(/\r?\n/));
  return lines.filter((line) => !present.has(line));
}

/**
 * Create the log folder if missing, tolerating a sync race that creates it
 * first. Shared with the session dialog (logTools.ts), which writes the same
 * files.
 */
export async function ensureLogFolder(app: App, normalizedFolder: string): Promise<void> {
  if (await app.vault.adapter.exists(normalizedFolder)) return;
  try {
    await app.vault.createFolder(normalizedFolder);
  } catch (e) {
    // A concurrent write or sync may have created it between the check and
    // here; only swallow that case, re-throw anything else.
    if (await app.vault.adapter.exists(normalizedFolder)) return;
    throw e;
  }
}

/**
 * A log line's link as a vault path, the way Obsidian resolves it — so a link
 * it shortened when the note moved (`[[Toy|…]]`) still leads to the note
 * (F10) — or, failing that, the text as an exact path; null when it leads to
 * no note. A `#heading` part is no part of the path, as for Obsidian
 * (getLinkpath). The renames, Refresh and the read API (logApi.ts) all read
 * links this way.
 */
export function resolveLogLink(app: App, linktext: string, sourcePath: string): string | null {
  const linkpath = getLinkpath(linktext);
  const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (dest) return dest.path;
  const exact = app.vault.getAbstractFileByPath(linkpath);
  return exact instanceof TFile ? exact.path : null;
}

/** Obsidian's Vault.create rejects with this when the path is taken. */
function isAlreadyExists(e: unknown): boolean {
  return e instanceof Error && /already exists/i.test(e.message);
}

export class LogManager {
  private plugin: GentlePomoPlugin;
  private currentSession: ActiveSessionLog | null = null;
  private currentPauseStart: MomentLike | null = null;
  // The segments task switches closed in the open focus, oldest first — only
  // with "Split at the switch" (logSegments.ts). The open session's own task
  // is the segment still going.
  private closedSegments: ClosedSegment[] = [];
  private focusTotalCacheDate: string | null = null;
  private focusTotalCacheSeconds = 0;
  private focusTotalCacheAt = 0;
  // Renames waiting out TASK_RENAME_DELAY_MS, by 🆔, and their timers.
  private pendingRenames = new Map<string, TaskRename>();
  private renameTimers = new Map<string, number>();
  // The log rewrites, chained so that one runs at a time.
  private walks: Promise<void> = Promise.resolve();
  private refreshInFlight = false;
  // The goal setting changed: the file of each day it changed on is given the
  // value set last that day once the typing stops (goalChanged), kept on this
  // device until it is, with the time it was made at.
  private goalTimer: number | null = null;
  private pendingGoals = new Map<string, PendingGoal>();
  private disposed = false;
  // This device's storage (sessionRecovery.ts); null keeps everything in
  // memory, as before 0.6.9.
  private readonly device: LogManagerDevice | null;
  // Whether the open session is saved on this device, so a discard clears it.
  private openSaved = false;
  // Sessions an earlier run left open, waiting for "Log it" or "Discard".
  private unfinished: SavedSession[] = [];
  private offering = false;
  // Lines a write failed on, oldest first, retried before the next write and
  // at startup (F53).
  private unwritten: UnwrittenLines[] = [];
  private retrying: Promise<number> | null = null;

  constructor(plugin: GentlePomoPlugin, device: LogManagerDevice | null = null) {
    this.plugin = plugin;
    this.device = device;
    if (device) this.takeSavedState(device.storage);
  }

  /**
   * What an earlier run left on this device. Its open session is moved to the
   * unfinished list here, at construction — before anything can start a
   * session, whose first save would write over it. A session under a minute
   * is dropped: logging it would write nothing (F59).
   */
  private takeSavedState(storage: DeviceStorage) {
    this.unwritten = readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY));
    this.pendingGoals = readPendingGoals(storage.load(PENDING_GOALS_KEY));
    this.unfinished = readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY));
    const raw = storage.load(OPEN_SESSION_KEY);
    if (raw === null) return;
    const saved = readSavedSession(raw);
    if (
      saved !== null &&
      worthRecovering(saved, (ms) => moment(ms)) &&
      !this.unfinished.some((other) => sameSavedSession(other, saved))
    ) {
      this.unfinished.push(saved);
      storage.save(UNFINISHED_SESSIONS_KEY, this.unfinished);
    }
    // Only once the list holds it: a crash in between leaves it in both, and
    // the next start keeps one copy (sameSavedSession) — never none.
    storage.save(OPEN_SESSION_KEY, null);
  }

  /**
   * Open a new session, or resume the open one from a pause. Never across
   * modes (F21): a session of the other mode still open here is a stray — a
   * Start that landed while the last end was still writing — and resuming it
   * logged a break as a 🍅 Focus line that counted toward the goal.
   */
  startSession(
    mode: "focus" | "break",
    taskName: string,
    durationMinutes: number,
    taskPath?: string,
    taskId?: string,
    breakType?: "short" | "long" | null
  ) {
    if (this.currentSession && this.currentSession.mode !== mode) {
      logger.warn(`Discarded an open ${this.currentSession.mode} session to start a ${mode}`);
      this.discardSession();
    }
    // If a session is already active (e.g. resuming from pause), don't overwrite start time
    if (this.currentSession) {
      this.resumeSession();
      return;
    }

    this.closedSegments = [];
    this.currentSession = {
      mode,
      taskName: taskName || NO_TASK_LABEL,
      taskPath,
      taskId,
      scheduledDurationMinutes: durationMinutes,
      startTime: moment(),
      pauses: [],
      status: "cancelled",
      breakType,
    };
    this.saveOpenSession();
  }

  /** Open a pause, at `at` (ms) — the last tick before a computer slept — or now. */
  pauseSession(at?: number) {
    if (!this.currentSession) return;
    this.currentPauseStart = at === undefined ? moment() : moment(at);
    this.saveOpenSession();
  }

  resumeSession() {
    if (!this.currentSession || !this.currentPauseStart) return;

    const pauseEnd = moment();
    this.currentSession.pauses?.push({
      start: this.currentPauseStart,
      end: pauseEnd,
    });
    this.currentPauseStart = null;
    this.saveOpenSession();
  }

  /**
   * Save the open session on this device, seen running now (F23): at every
   * start, pause, resume and task change, once a minute while it runs
   * (heartbeat) and at unload. A quit or a crash then loses at most the time
   * since the last save: a minute on a computer, but a phone that suspends
   * the app saves nothing while it is away. Never after dispose — a session an unload's last
   * continuation opens will never run. Never with no log folder either (the
   * shipped default): ending it would write nothing, so the next start would
   * ask about a session it could only throw away.
   */
  private saveOpenSession(seenAt = Date.now()) {
    const open = this.currentSession;
    if (!this.device || !open || this.disposed || !this.keepsLog()) return;
    const saved: SavedSession = {
      mode: open.mode,
      taskName: open.taskName,
      taskPath: open.taskPath,
      taskId: open.taskId,
      startMs: open.startTime.valueOf(),
      pauses: open.pauses.map((p) => [p.start.valueOf(), p.end.valueOf()]),
      pauseStartMs: this.currentPauseStart ? this.currentPauseStart.valueOf() : null,
      scheduledMinutes: open.scheduledDurationMinutes,
      breakType: open.breakType ?? null,
      segments: this.closedSegments.map((segment) => ({
        taskName: segment.taskName,
        taskPath: segment.taskPath,
        taskId: segment.taskId,
        endMs: segment.end.valueOf(),
      })),
      plannedMs: this.device.plannedMs(),
      lastSeenMs: seenAt,
    };
    this.device.storage.save(OPEN_SESSION_KEY, saved);
    this.openSaved = true;
  }

  /** Whether a session's lines are written at all: no log folder, no log. */
  private keepsLog(): boolean {
    return Boolean(this.plugin.settings.logFolderPath);
  }

  /** The once-a-minute save while a session runs (main.ts's interval). Paused,
   *  there is nothing new to save: a recovered session ends where it paused. */
  heartbeat() {
    if (this.currentSession && !this.currentPauseStart) this.saveOpenSession();
  }

  /**
   * The clock's planned length changed (±5): saved at once, paused too. A
   * recovered focus counts its Overtime past it, and a ±5 made while paused
   * reached the device only at the next resume — so a quit before then
   * logged Overtime past the old length (F16).
   */
  plannedLengthChanged() {
    if (this.currentSession) this.saveOpenSession();
  }

  /**
   * The open session ended or was thrown away: nothing to recover. After
   * dispose (F19) a reloaded plugin may have saved its own session here
   * since, so the key is cleared only while it still holds this one — an end
   * whose write was under way at unload, its line in the log now.
   */
  private forgetOpenSession(open: ActiveSessionLog | null) {
    if (!this.device || !this.openSaved) return;
    this.openSaved = false;
    if (this.disposed && !(open && this.storedOpenSessionIs(open))) return;
    this.device.storage.save(OPEN_SESSION_KEY, null);
  }

  private storedOpenSessionIs(open: ActiveSessionLog): boolean {
    const stored = this.device
      ? readSavedSession(this.device.storage.load(OPEN_SESSION_KEY))
      : null;
    return stored?.mode === open.mode && stored.startMs === open.startTime.valueOf();
  }

  /**
   * The linked task changed mid-session. A different task is a SWITCH: with
   * "Split at the switch" the segment so far is kept for the task it was for,
   * if it ran a minute; a shorter one joins the next part, or the one before
   * it if it is the last (segmentLogs), and the default gives the whole
   * session to the task linked at the end (F52). `renamed` is the linked task
   * under a new name (a rename read off its 🆔), never a switch.
   */
  updateTask(newTaskName: string, newTaskPath?: string, newTaskId?: string, renamed = false) {
    const open = this.currentSession;
    if (!open) return;
    const next = {
      taskName: newTaskName || NO_TASK_LABEL,
      taskPath: newTaskPath,
      taskId: newTaskId,
    };
    if (!renamed && open.mode === "focus" && this.splitsAtSwitch() && !sameTask(open, next)) {
      const now = moment();
      if (this.segmentActiveSeconds(now) >= MIN_SESSION_SECONDS) {
        this.closedSegments.push({
          taskName: open.taskName,
          taskPath: open.taskPath,
          taskId: open.taskId,
          end: now,
        });
      }
    }
    open.taskName = next.taskName;
    open.taskPath = next.taskPath;
    open.taskId = next.taskId;
    this.saveOpenSession();
  }

  private splitsAtSwitch(): boolean {
    return resolveTaskSwitchLogging(this.plugin.settings.taskSwitchLogging) === "split";
  }

  /** The open session's pauses as they stand at `at`, an open one closed there. */
  private pausesAt(at: MomentLike): LoggedPause[] {
    const open = this.currentSession;
    if (!open) return [];
    const pauses = [...open.pauses];
    if (this.currentPauseStart) pauses.push({ start: this.currentPauseStart, end: at });
    return pausesUntil(pauses, at);
  }

  /** Active seconds of the segment still going: since the last switch, or the start. */
  private segmentActiveSeconds(at: MomentLike): number {
    const open = this.currentSession;
    if (!open) return 0;
    const last = this.closedSegments[this.closedSegments.length - 1];
    return activeSecondsWithin(this.pausesAt(at), last ? last.end : open.startTime, at);
  }

  /**
   * The open session's active time if it ended at `at` (ms), as its line would
   * write Total; null with no session open. What Stop's long-session question
   * is judged on.
   */
  openSessionActiveSeconds(at: number): number | null {
    const open = this.currentSession;
    if (!open) return null;
    const end = moment(at);
    return loggedTotalSeconds({
      startTime: open.startTime,
      endTime: end,
      pauses: this.pausesAt(end),
    });
  }

  /**
   * The instant (ms) the open session's active time reached `activeSeconds`,
   * pauses as they stood at `at` (activeReachedAt); null with no session open.
   * "End at planned end" ends there.
   */
  openSessionReachedAt(activeSeconds: number, at: number): number | null {
    const open = this.currentSession;
    if (!open) return null;
    return activeReachedAt(open.startTime, this.pausesAt(moment(at)), activeSeconds);
  }

  /**
   * Throw the open session away: no line, nothing counted. Reset (F7), and
   * the engine's guard against a stray session outliving its mode.
   */
  discardSession() {
    const open = this.currentSession;
    this.currentSession = null;
    this.currentPauseStart = null;
    this.closedSegments = [];
    // Every end comes through here too (endSession's finally), logged or
    // under a minute: either way there is nothing left to offer back.
    this.forgetOpenSession(open);
  }

  /**
   * The day the open session will be filed under — its START, as "Day starts
   * at" counts days — or null when none is open. The meter counts a running
   * session toward today only when this is today (F8).
   */
  openSessionDay(): string | null {
    if (!this.currentSession) return null;
    return logicalDate(this.currentSession.startTime, this.plugin.settings.dayStartHour);
  }

  /**
   * Close the active session and append its log line; invalidates today's
   * focus-total cache. True when the session counted — at least
   * MIN_SESSION_SECONDS of active time — and false when it did not or none was
   * open, in which case nothing is written and the engine adds no 🍅 and no
   * long-break step (F59). A failed write still counts: the time was worked.
   *
   * `end.endAt` ends it at that instant instead of now: the zero crossing that
   * auto-starts the next session ends this one at its planned end however late
   * the tick ran (F3). An open pause closes there, and pauses are cut to it.
   * `end.overtimeSeconds` is the active time past the planned end, the focus
   * line's Overtime.
   */
  async endSession(status: "finished" | "cancelled", end: SessionEnd = {}): Promise<boolean> {
    const open = this.currentSession;
    // After dispose it stays saved, for the next start to offer (F19): a
    // continuation of the unloaded plugin writes nothing.
    if (!open || this.disposed) return false;
    const closed = this.closedSegments;

    try {
      const endTime = end.endAt === undefined ? moment() : moment(end.endAt);
      // A new list, never the open session's own: a pause or resume landing
      // while this line is written must not reach into it.
      const pauses = [...open.pauses];
      if (this.currentPauseStart) pauses.push({ start: this.currentPauseStart, end: endTime });

      const session: SessionLog = {
        ...open,
        pauses: pausesUntil(pauses, endTime),
        endTime,
        status,
        overtimeSeconds: end.overtimeSeconds ?? 0,
      };

      // The whole session is judged, a split one too: its segments are
      // lines, not sessions.
      if (loggedTotalSeconds(session) < MIN_SESSION_SECONDS) return false;
      await this.writeLog(segmentLogs(session, closed));
      return true;
    } finally {
      // In a finally (F22): a session left open after a failed end was
      // resumed by the next start, and that line then carried both sessions.
      // Only if it is still this session — one opened meanwhile is not ours.
      if (this.currentSession === open) this.discardSession();
    }
  }

  /**
   * The linked task's note was renamed or moved — or a folder above it. The
   * open session and the segments a split closed follow it, and so does a
   * rename still waiting for its walk; a line logged with the old path would
   * be a dead link nothing repairs, as Obsidian has already updated its links
   * by then (C1).
   *
   * A DELETED note is not followed, on purpose: the lines still to be written
   * keep their link as it was, to the note now gone — what 0.6.8 wrote, and
   * what Obsidian leaves in the log's older lines of that task. Reviews count
   * only linked sessions and take the area from the link's alias, so the bare
   * name 0.6.9 first wrote there dropped that one session to "No Task". The
   * timer lets go of the task once that session ends (TimerEngine.onFileDelete).
   *
   * Nor once a folder it was in is renamed after it went: a link follows a
   * move only while a note is at its path or at the one the move gives it.
   * Obsidian updates only the links that lead to a note — a deleted note's
   * lead nowhere — so following by the path alone wrote a link to a path
   * that never held the note, while the older lines of that task kept the
   * old one. Both paths are asked because Obsidian says a folder was renamed
   * before it moves the notes in it, each of which then says so for itself
   * (FileSystemAdapter.rename, app.js 1.13.7): at the folder's word the note
   * is still at its old path, at its own already at the new one. A deleted
   * note is at neither.
   */
  taskNoteMoved(oldPath: string, newPath: string) {
    const isNote = (path: string) =>
      this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile;
    const follows = (from: string, to: string) => isNote(from) || isNote(to);
    const follow = (item: { taskPath?: string }) => {
      const from = item.taskPath;
      const moved = pathAfterMove(from, oldPath, newPath);
      if (from !== undefined && moved !== null && follows(from, moved)) item.taskPath = moved;
    };
    if (this.currentSession) follow(this.currentSession);
    this.closedSegments.forEach(follow);
    this.pendingRenames.forEach(follow);
    this.saveOpenSession();
    // The lines still to be written follow it too (F27): the sessions an
    // earlier run left, and the lines a write failed on — which Obsidian
    // would have updated with the rest of the log, had they been in it.
    this.changeUnfinished(follow);
    let changed = false;
    for (const entry of this.unwritten) {
      const lines = entry.lines.map((line) => taskLinkAfterMove(line, oldPath, newPath, follows));
      if (lines.every((line, i) => line === entry.lines[i])) continue;
      entry.lines = lines;
      changed = true;
    }
    if (changed && !this.disposed) this.saveUnwritten();
  }

  /** Apply `change` to each unfinished session and its segments, and save
   *  them if a task path moved. Never after dispose (F19): the stored list may
   *  be a reloaded plugin's by then. */
  private changeUnfinished(change: (item: { taskPath?: string }) => void) {
    let changed = false;
    const apply = (item: { taskPath?: string }) => {
      const before = item.taskPath;
      change(item);
      if (item.taskPath !== before) changed = true;
    };
    for (const saved of this.unfinished) {
      apply(saved);
      saved.segments.forEach(apply);
    }
    if (changed && !this.disposed) {
      this.device?.storage.save(UNFINISHED_SESSIONS_KEY, this.unfinished);
    }
  }

  /**
   * Rewrite a renamed task's past log lines, TASK_RENAME_DELAY_MS after the
   * last rename of it (F26). Obsidian saves a note every 2 s while it is being
   * typed in, and each save that changed the name walked and rewrote every log
   * — writing the half-typed names into history and through Sync. Walks run
   * one at a time; a rename of the same 🆔 meanwhile waits for the walk after.
   * The timer takes the new name at once: only history waits.
   */
  scheduleTaskRename(rename: TaskRename) {
    if (this.disposed) return;
    this.pendingRenames.set(rename.taskId, { ...rename });
    const waiting = this.renameTimers.get(rename.taskId);
    if (waiting !== undefined) window.clearTimeout(waiting);
    this.renameTimers.set(
      rename.taskId,
      window.setTimeout(() => this.startTaskRename(rename.taskId), TASK_RENAME_DELAY_MS)
    );
  }

  private startTaskRename(taskId: string) {
    this.renameTimers.delete(taskId);
    const rename = this.pendingRenames.get(taskId);
    this.pendingRenames.delete(taskId);
    if (!rename) return;
    void this.queueWalk(() => this.updateLoggedTaskName(rename));
  }

  /** Run `walk` once every walk queued before it has finished. */
  private queueWalk<T>(walk: () => Promise<T>): Promise<T> {
    const run = this.walks.then(walk);
    this.walks = run.then(
      () => undefined,
      (e: unknown) => logger.error("A log rewrite failed", e)
    );
    return run;
  }

  /** Resolves once every rewrite queued so far has finished. */
  walksSettled(): Promise<void> {
    return this.walks;
  }

  /**
   * Plugin unload: the renames still waiting are dropped, not started — no
   * vault writes from a plugin being turned off. "Refresh log task names by
   * ID" catches up on them. The open session is saved, seen running now, and
   * left saved: an update or a reload mid-session offers it back at the next
   * start (F23). Paused too, with the planned length as the clock has it now
   * (F16): it still ends where its pause began (savedSessionEnd).
   *
   * A goal change still waiting for its write (goalChanged) is not written
   * either, for the renames' reason: a vault write after unload would race
   * the reloaded plugin's own. It is kept on this device from the moment it
   * is made, and the next start writes it (writeWaitingGoals) — into the
   * file of the day it was made on, whichever day that start is, unless that
   * file was written after it (goalFor). Only a device that keeps nothing
   * (storage full or blocked) loses it.
   */
  dispose() {
    if (this.currentSession) this.saveOpenSession();
    this.disposed = true;
    this.renameTimers.forEach((timer) => window.clearTimeout(timer));
    this.renameTimers.clear();
    this.pendingRenames.clear();
    if (this.goalTimer !== null) window.clearTimeout(this.goalTimer);
    this.goalTimer = null;
  }

  /** A log line's link as a vault path (resolveLogLink). */
  private readonly resolveLink: ResolveLink = (linktext, sourcePath) =>
    resolveLogLink(this.plugin.app, linktext, sourcePath);

  /**
   * Rewrite the past lines of a renamed task: the lines carrying its 🆔 whose
   * own link leads to its note (renameLogContent). Each file through
   * Vault.process, which reads and writes in one step, so a session line
   * appended meanwhile is never lost (F25); a file that fails is reported and
   * the walk goes on (F41). Files that would not change are not written.
   */
  async updateLoggedTaskName(rename: TaskRename) {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath || !rename.taskId) return;

    const app = this.plugin.app;
    const files = filesInFolder(app, folderPath).filter((f) => f.extension === "md");
    let failed = 0;

    for (const file of files) {
      try {
        const content = await app.vault.read(file);
        if (!content.includes(rename.taskId)) continue;
        if (renameLogContent(content, file.path, rename, this.resolveLink).lines === 0) continue;
        await app.vault.process(
          file,
          (data) => renameLogContent(data, file.path, rename, this.resolveLink).content
        );
      } catch (e) {
        failed++;
        logger.warn(`Could not rename the task in "${file.path}"`, e);
      }
    }

    if (failed > 0) {
      new Notice(
        `Gentle pomodoro: couldn't rename the task in ${failed} log file(s). Run "Refresh log task names by ID" to try again.`
      );
    }
  }

  /**
   * "Refresh log task names by ID": every 🆔 line takes its task's name as the
   * task line reads now — a rename made while the task was not linked never
   * reached the log. A dry run first, then a dialog with the count and a few
   * examples, then the write (F12). One at a time.
   */
  async refreshLoggedTaskNamesById(
    confirm: (options: ConfirmOptions) => Promise<boolean> = (options) =>
      confirmAction(this.plugin.app, options)
  ) {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      await this.refreshTaskNames(confirm);
    } catch (e) {
      logger.error("Failed to refresh the log's task names", e);
      new Notice(
        "Gentle pomodoro: couldn't refresh the task names — see the developer console for details."
      );
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async refreshTaskNames(confirm: (options: ConfirmOptions) => Promise<boolean>) {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) {
      new Notice("Gentle pomodoro: log folder path is not set.");
      return;
    }

    const app = this.plugin.app;
    const logFiles = filesInFolder(app, folderPath).filter((f) => f.extension === "md");
    if (logFiles.length === 0) {
      // A stored top level or capitalisation the vault lacks: the timer still
      // writes the logs, so say what is wrong instead of "none found" (F29).
      const problem = logFolderProblem(folderPath, app.vault);
      new Notice(
        problem
          ? logFolderProblemNotice(folderPath, problem)
          : "Gentle pomodoro: no log files found."
      );
      return;
    }

    // Read everything first — the logs, then the notes their 🆔 lines link to
    // — so the plan, and later the write inside Vault.process, run without
    // awaiting anything.
    const logs: { file: TFile; content: string }[] = [];
    let failedFiles = 0;
    for (const file of logFiles) {
      try {
        logs.push({ file, content: await app.vault.read(file) });
      } catch (e) {
        failedFiles++;
        logger.warn(`Could not read "${file.path}"`, e);
      }
    }
    const notes = await this.readRefreshNotes(logs);

    const skipped = emptyRefreshSkips();
    const renamed: RefreshedName[] = [];
    const changing: TFile[] = [];
    for (const { file, content } of logs) {
      const plan = refreshLogContent(content, file.path, notes);
      for (const kind of REFRESH_SKIPS) skipped[kind] += plan.skipped[kind];
      if (plan.renamed.length === 0) continue;
      renamed.push(...plan.renamed);
      changing.push(file);
    }
    const leftAlone = refreshLeftAlone(skipped, failedFiles);

    if (renamed.length === 0) {
      new Notice(`Gentle pomodoro: no task names to update.${leftAlone}`);
      return;
    }

    const confirmed = await confirm({
      title: "Update task names in the log?",
      body: `${renamed.length} log line(s) in ${changing.length} file(s) will take their task's current name. Each line keeps its own tags.`,
      list: refreshExamples(renamed),
      ctaText: `Update ${renamed.length} line(s)`,
    });
    if (!confirmed) return;

    const written = await this.queueWalk(() => this.writeRefresh(changing, notes));
    new Notice(
      `Gentle pomodoro: updated ${written.lines} line(s) in ${written.files} file(s).${refreshLeftAlone(skipped, failedFiles + written.failed)}`
    );
  }

  /** The notes the logs' 🆔 lines link to, read once each (CRLF-safe: read only). */
  private async readRefreshNotes(
    logs: readonly { file: TFile; content: string }[]
  ): Promise<RefreshNotes> {
    const app = this.plugin.app;
    const read = new Map<string, readonly string[] | null>();
    for (const { file, content } of logs) {
      for (const path of refreshTargets(content, file.path, this.resolveLink)) {
        if (read.has(path)) continue;
        const note = app.vault.getAbstractFileByPath(path);
        try {
          read.set(
            path,
            note instanceof TFile ? (await app.vault.read(note)).split(/\r?\n/) : null
          );
        } catch (e) {
          read.set(path, null);
          logger.warn(`Could not read "${path}"`, e);
        }
      }
    }
    return { resolve: this.resolveLink, lines: (path) => read.get(path) ?? null };
  }

  /** Refresh's write: each file through Vault.process, planned again on what it holds then. */
  private async writeRefresh(files: readonly TFile[], notes: RefreshNotes) {
    const app = this.plugin.app;
    const written = { lines: 0, files: 0, failed: 0 };
    for (const file of files) {
      let lines = 0;
      try {
        await app.vault.process(file, (data) => {
          const plan = refreshLogContent(data, file.path, notes);
          lines = plan.renamed.length;
          return plan.content;
        });
      } catch (e) {
        written.failed++;
        logger.warn(`Could not update "${file.path}"`, e);
        continue;
      }
      written.lines += lines;
      if (lines > 0) written.files++;
    }
    return written;
  }

  /**
   * The 🆔s the log names that sit on more than one task line of their note,
   * not one of them the single open line (F2, duplicateTaskIds) — sessions of
   * such a task are never renamed, so Check log lists them. Notes that cannot
   * be read are passed over.
   */
  async findDuplicateTaskIds(): Promise<DuplicateTaskId[]> {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) return [];
    const app = this.plugin.app;
    const logs: { file: TFile; content: string }[] = [];
    for (const file of filesInFolder(app, folderPath).filter((f) => f.extension === "md")) {
      try {
        logs.push({ file, content: await app.vault.read(file) });
      } catch (e) {
        logger.warn(`Could not read "${file.path}"`, e);
      }
    }

    const logged = new Map<string, Set<string>>();
    for (const { file, content } of logs) {
      for (const line of content.split(/\r?\n/).slice(frontmatterRowCount(content))) {
        const parsed = parseLogLine(line);
        const taskId = parsed ? logTaskId(parsed) : null;
        const link = parsed?.task?.path;
        if (!taskId || !link) continue;
        const path = this.resolveLink(link, file.path);
        if (path === null) continue;
        const ids = logged.get(path) ?? new Set<string>();
        ids.add(taskId);
        logged.set(path, ids);
      }
    }

    const found: DuplicateTaskId[] = [];
    for (const [path, ids] of logged) {
      const note = app.vault.getAbstractFileByPath(path);
      if (!(note instanceof TFile)) continue;
      try {
        const twice = duplicateTaskIds(await app.vault.read(note));
        for (const taskId of twice) if (ids.has(taskId)) found.push({ taskId, path });
      } catch (e) {
        logger.warn(`Could not read "${path}"`, e);
      }
    }
    return found;
  }

  /** The sessions an earlier run left unfinished, oldest first. */
  unfinishedSessions(): readonly SavedSession[] {
    return this.unfinished;
  }

  /**
   * Ask about each session an earlier run left open (F23): "log" writes it,
   * ended where it was last seen running; "discard" forgets it; "later" — the
   * dialog closed — keeps it for the next start. One question at a time, and
   * one round at a time. Not asked while no log folder is set: "Log it" could
   * write nothing, and the session would be forgotten. They wait, kept, for a
   * start with a folder. Never once disposed (F19): the reloaded plugin asks
   * again, and an answer here too wrote the session twice.
   *
   * `long` is what Stop would have asked about it (recoveredLongSession), or
   * null: a focus past the long-session threshold and its plan is offered a
   * third answer, "planned", which logs it as Stop's "End at planned end"
   * would have (F18). Judged on the setting as it is now.
   */
  async offerUnfinishedSessions(
    ask: (saved: SavedSession, long: LongSessionQuestion | null) => Promise<RecoveryAnswer>
  ) {
    if (this.offering || !this.keepsLog()) return;
    this.offering = true;
    try {
      for (const saved of [...this.unfinished]) {
        if (this.disposed) break;
        const long = recoveredLongSession(
          saved,
          (ms) => moment(ms),
          this.plugin.settings.longSessionPromptHours
        );
        let answer: RecoveryAnswer;
        try {
          answer = await ask(saved, long);
        } catch (e) {
          logger.error("Could not ask about an unfinished session", e);
          answer = "later";
        }
        if (this.disposed) break;
        if (answer === "log") await this.logUnfinished(saved);
        else if (answer === "planned" && long !== null) {
          await this.logUnfinished(saved, plannedSessionEnd(long));
        } else if (answer === "discard") this.forgetUnfinished(saved);
      }
    } finally {
      this.offering = false;
    }
  }

  /**
   * Write an unfinished session's line(s), status finished, ended where it was
   * last seen — or at `end`, the planned end (F18) — and under a minute,
   * nothing (F59). Not counted toward the 🍅
   * or the long-break count: those belong to a session the timer ends, and
   * this one was ended by a quit. A write that fails is kept like any other
   * (F53), so the session is forgotten here either way — unless the log
   * folder was emptied while the question was open: then nothing could be
   * written or kept, and it waits for the next start. After dispose nothing
   * (F19): the reloaded plugin offers it.
   */
  async logUnfinished(
    saved: SavedSession,
    end?: { endAt: number; overtimeSeconds: number }
  ): Promise<void> {
    if (this.disposed || !this.keepsLog()) return;
    const { session, closed } = recoveredSession(saved, (ms) => moment(ms), end);
    try {
      if (loggedTotalSeconds(session) >= MIN_SESSION_SECONDS) {
        await this.writeLog(segmentLogs(session, closed));
      }
    } finally {
      this.forgetUnfinished(saved);
    }
  }

  /**
   * Take a session off the unfinished list. After dispose (F19) the stored
   * list may be a reloaded plugin's: this instance's own is never written over
   * it, and only this session is taken out of it — a Log it whose write was
   * under way at unload, its line in the log now.
   */
  private forgetUnfinished(saved: SavedSession) {
    this.unfinished = this.unfinished.filter((other) => !sameSavedSession(other, saved));
    const storage = this.device?.storage;
    if (!storage) return;
    const list: unknown[] = this.disposed
      ? storedWithout(storage.load(UNFINISHED_SESSIONS_KEY), saved)
      : this.unfinished;
    storage.save(UNFINISHED_SESSIONS_KEY, list.length > 0 ? list : null);
  }

  /**
   * Write the lines a write failed on (F53), oldest first, before the next
   * write and at startup. A line the file already holds is not written again:
   * a write that "failed" by timing out may have landed after all (F38). Stops
   * at the first entry that still fails, keeping it and the ones after it.
   * Resolves to the number of lines written; one run at a time.
   */
  retryUnwrittenLines(): Promise<number> {
    // Never rejects: it runs ahead of every session's write, and from startup
    // with nobody to catch it.
    this.retrying ??= this.retryUnwritten()
      .catch((e: unknown) => {
        logger.error("Could not retry the unwritten session lines", e);
        return 0;
      })
      .finally(() => {
        this.retrying = null;
      });
    return this.retrying;
  }

  private async retryUnwritten(): Promise<number> {
    let written = 0;
    let focus = false;
    while (this.unwritten.length > 0) {
      const entry = this.unwritten[0];
      try {
        await this.ensureFolder(entry.folder);
        await this.appendLines(entry.path, entry.lines, true);
      } catch (e) {
        logger.warn(
          `Still couldn't write ${entry.lines.length} session line(s) to "${entry.path}"`,
          e
        );
        break;
      }
      this.unwritten.shift();
      this.saveUnwritten();
      written += entry.lines.length;
      focus ||= entry.focus;
    }
    if (focus) this.invalidateTodayTotal();
    if (written > 0) new Notice(unwrittenLinesWrittenMessage(written));
    return written;
  }

  private saveUnwritten() {
    this.device?.storage.save(
      UNWRITTEN_LINES_KEY,
      this.unwritten.length > 0 ? this.unwritten : null
    );
  }

  /** Write a session's lines — one, or one per segment of a split session. */
  private async writeLog(parts: SegmentLine[]) {
    // Lines that failed before go first, so the file keeps its order.
    await this.retryUnwrittenLines();

    if (!this.keepsLog()) return; // Logging disabled if no path set
    const folderPath = this.plugin.settings.logFolderPath;

    const app = this.plugin.app;

    // Refresh task name from file if ID is available (handles renames) — but
    // not for the 🍅 counter's count, which is not a rename (taskNameAfterEdit).
    // A read that fails (an iCloud file not downloaded, Obsidian's 60 s file
    // timeout) keeps the linked name: it threw out of endSession before the
    // write, and the session was lost (F22).
    for (const part of parts) {
      if (part.mode !== "focus" || !part.taskId || !part.taskPath) continue;
      try {
        // By the name when the 🆔 is on several lines: the open copy whose
        // name it is, else the one open copy — a ticked copy's name too, as
        // the timer follows a task copied forward — or none (F2, resolveIdLine).
        // Not for a segment a switch closed: its name is history, and a ticked
        // copy it names keeps it — or the time worked on the old copy before
        // the new one was picked was logged under the new one's name.
        const taskText = await findTaskTextById(
          app,
          part.taskPath,
          part.taskId,
          part.taskName,
          part.closedBySwitch !== true
        );
        if (taskText !== null) {
          part.taskName = taskNameAfterEdit(part.taskName, taskText);
        }
      } catch (e) {
        logger.warn("Could not read the task's note; logging the linked name", e);
      }
    }

    const normalizedFolder = normalizePath(folderPath);

    // Filed under the day the session STARTED, as "Day starts at" counts days
    // — every line of a split session too, under the day its first began.
    const session = parts[0];
    const dateStr = logicalDate(session.startTime, this.plugin.settings.dayStartHour);
    const filePath = dailyLogPath(folderPath, dateStr);

    // Format the lines via the pure helper (logLine.ts; tests/logManager.test.ts).
    const lines = parts.map(formatLogLine);

    // Writes can fail on mobile (Obsidian Sync / iCloud conflicts, locked files).
    // Catch here so a write failure never breaks the timer state machine — the
    // caller (endSession → handleFinished/skip) still resolves and advances —
    // and so the user is told instead of losing the session silently.
    try {
      await this.ensureFolder(normalizedFolder);
      await this.appendLines(filePath, lines);
    } catch (e) {
      // The line itself goes to the console and stays on this device to be
      // written later (F53). Until 0.6.9 only the error was logged, and the
      // session's start, end and total were gone for good.
      logger.error(`Failed to write the session log; it will be retried:\n${lines.join("\n")}`, e);
      this.unwritten.push({
        path: filePath,
        folder: normalizedFolder,
        lines,
        focus: session.mode === "focus",
      });
      this.saveUnwritten();
      new Notice(UNWRITTEN_LINE_NOTICE);
      return;
    }

    if (session.mode === "focus") {
      // Invalidate both total caches: the inner one here, and the plugin-level
      // TTL, so the next emit's refetch reads the fresh file immediately and
      // the goal notice (which fires from that refetch's landing) arrives with
      // the end-of-session bell instead of up to a TTL later.
      this.invalidateTodayTotal();
    }
  }

  /** Forget today's focus total, here and in the plugin's tracker, so the next
   *  read goes to the file. After a session is written, and when the log
   *  folder changes (0.6.8) — the cache is keyed on the date alone, so it
   *  would otherwise keep serving the old folder's total until its TTL ran
   *  out. */
  invalidateTodayTotal(): void {
    this.focusTotalCacheAt = 0;
    this.plugin.invalidateFocusTotalCache();
  }

  /** Create the log folder if missing, tolerating a sync race that creates it first. */
  private async ensureFolder(normalizedFolder: string) {
    await ensureLogFolder(this.plugin.app, normalizedFolder);
  }

  /**
   * Append a session's lines to the daily log, creating the file if needed —
   * in one write, so a split session's lines land together or not at all.
   *
   * An indexed file goes through Vault.process (F39): it reads and writes in
   * one step, and appendToLog keeps the file's line endings and leaves no
   * blank line. A new file is created ending in a line break.
   *
   * When create() fails because the file is there after all — the index lags
   * the disk on mobile and right after a sync — the lines are appended through
   * the adapter. Only then (F38): until 0.6.9 every failure took this path, so
   * a create that timed out while its write still landed got the same line
   * appended a second time, and the session counted twice. So it also never
   * appends a block whose last line is already the file's last line.
   *
   * `retry`: lines kept from a failed write, which skip any line the file
   * already holds, wherever it is.
   *
   * Today's file records the goal as it is set now in the same write
   * (goalFor): written or updated while the goal is on, taken out while it is
   * off (recordLogGoal). A past day's file keeps what it has, a change kept
   * for that day apart, and one created now gets one (goalFor). The adapter's
   * append cannot — it adds to the end — so the next write does: a session's,
   * or a change of the setting (goalChanged).
   */
  private async appendLines(filePath: string, lines: string[], retry = false) {
    const app = this.plugin.app;
    const existing = app.vault.getAbstractFileByPath(filePath);
    const goal = this.goalFor(filePath, existing instanceof TFile ? existing : null);
    const record = (data: string) => (goal === null ? data : recordLogGoal(data, goal));
    if (existing instanceof TFile) {
      await app.vault.process(existing, (data) =>
        record(appendToLog(data, retry ? linesNotIn(data, lines) : lines))
      );
      return;
    }
    try {
      await app.vault.create(filePath, record(appendToLog("", lines)));
    } catch (e) {
      if (!isAlreadyExists(e) && !(await app.vault.adapter.exists(filePath))) throw e;
      const data = await app.vault.adapter.read(filePath);
      const landed = lastLogLine(data) === lines[lines.length - 1];
      const todo = retry ? linesNotIn(data, lines) : landed ? [] : lines;
      if (todo.length === 0) return;
      await app.vault.adapter.append(filePath, appendToLog(data, todo).slice(data.length));
    }
  }

  /**
   * The goal to record in the log file at `filePath` (logFrontmatter.ts), the
   * one at `file` — null when there is none yet, and the write creates it:
   *
   * - the file of the day it is now ("Day starts at" counted): the daily goal
   *   setting, 0 when that goal is off, which takes a recorded one out;
   * - a past day's file with a change kept for that day (goalChanged): that
   *   change — unless the file was written after it was made. Another device
   *   may have changed the goal later that day and written it there, and a
   *   change this device could not write in time (a quit, a phone that
   *   suspended the app) must not go over it the next morning: the later
   *   write had the day's last word. The file's modification time tells,
   *   which Obsidian Sync carries over from the device that wrote it. Any
   *   later write counts, as the file cannot say which kind it was — a
   *   session's line this device wrote after the change took it in already
   *   (here, in that write);
   * - a past day's file being created: the change kept for that day, else
   *   the setting as it is now. It recorded none while it was today, as it
   *   was not there: its only session ran past midnight, or a failed write
   *   is being retried. The setting now is the nearest this device knows of
   *   the goal that day ended with — off by a change made since, which a
   *   file that did not exist could not keep apart;
   * - any other: null, which leaves the file's goal as it is. A past day's
   *   file keeps the goal that day had: a session that started before
   *   midnight and is written after it goes into yesterday's file, and leaves
   *   its goal alone.
   */
  private goalFor(filePath: string, file: TFile | null): number | null {
    const setting = resolveGoalMinutes(this.plugin.settings.dailyFocusGoalMinutes);
    if (filePath === this.todayLogPath()) return setting;
    const kept = this.pendingGoals.get(filePath);
    if (file === null) return kept?.minutes ?? setting;
    return kept !== undefined && file.stat.mtime <= kept.at ? kept.minutes : null;
  }

  /** Today's log file, "Day starts at" counted; null with no log folder. */
  private todayLogPath(): string | null {
    const settings = this.plugin.settings;
    if (!settings.logFolderPath) return null;
    return dailyLogPath(settings.logFolderPath, logicalDate(moment(), settings.dayStartHour));
  }

  /**
   * The daily goal setting changed (the settings tab): the file of the day it
   * changed on records the value set last that day — so a goal changed after
   * the day's last session is the one the day keeps once it is past, not the
   * number its last session wrote. One write, LOG_GOAL_WRITE_DELAY_MS after
   * the last change: the settings commit every keystroke before 1.13.
   *
   * The day is taken now, at the change, never when the write runs: a phone
   * suspends the app, and a timer set at 22:00 can fire the next morning,
   * when today's file is another — which held nothing of the change (it may
   * not exist yet), while the day it was made on kept the old goal for good.
   * A change in the last moment of a day goes into that day's file for the
   * same reason: it is the goal that day ended with. The new day's own file
   * is given the setting by its first session's write (goalFor).
   *
   * Kept on this device at once (PENDING_GOALS_KEY), so a quit inside the
   * delay loses nothing either: the next start writes it (writeWaitingGoals)
   * — unless the day's file was written after the change, by then (goalFor).
   */
  goalChanged(): void {
    if (this.disposed) return;
    const path = this.todayLogPath();
    if (path === null) return;
    this.pendingGoals.set(path, {
      minutes: resolveGoalMinutes(this.plugin.settings.dailyFocusGoalMinutes),
      at: Date.now(),
    });
    this.savePendingGoals();
    if (this.goalTimer !== null) window.clearTimeout(this.goalTimer);
    this.goalTimer = window.setTimeout(() => {
      this.goalTimer = null;
      void this.writeWaitingGoals();
    }, LOG_GOAL_WRITE_DELAY_MS);
  }

  /**
   * Write the goal changes still waiting (goalChanged) — at startup the ones
   * an earlier run kept on this device, a quit or an update having cut it
   * short. On the rename walks' chain, one write at a time. Never rejects:
   * writeGoal reports its own failures, and nobody awaits this at startup.
   */
  writeWaitingGoals(): Promise<void> {
    return this.queueWalk(() => this.writePendingGoals());
  }

  /**
   * Each waiting change into its day's file (writeGoal): TODAY's file the
   * setting as it is now (goalFor) — it may have moved since, on another
   * device — and an earlier day's the value set last on that day, unless the
   * file was written after it (goalFor). Let go of once settled, and only if
   * no newer change for that day came meanwhile: that one waits for its own
   * write. A write that failed stays, for the next start. Never after dispose
   * (F19): what is left stays kept, for the reloaded plugin to write.
   */
  private async writePendingGoals(): Promise<void> {
    for (const [path, change] of [...this.pendingGoals]) {
      const settled = await this.writeGoal(path);
      if (this.disposed) return;
      if (!settled || this.pendingGoals.get(path) !== change) continue;
      this.pendingGoals.delete(path);
      this.savePendingGoals();
    }
  }

  private savePendingGoals() {
    this.device?.storage.save(
      PENDING_GOALS_KEY,
      this.pendingGoals.size > 0
        ? [...this.pendingGoals].map(([path, change]) => ({ path, ...change }))
        : null
    );
  }

  /**
   * Give the log file at `path` the goal goalFor gives it (recordLogGoal) —
   * none when it gives null, a later write to a past day's file having had
   * the last word. Only a file that is there: none is created for a goal. A
   * file whose properties
   * the timer leaves alone — one that starts with a byte order mark — stays
   * as it is, and so does one that already says it: read first, written only
   * when it would change, and then through Vault.process, as a session being
   * appended at the same moment must not be lost. Never after dispose:
   * checked once the file is read, the last moment before the write. Today's
   * total does not move — it counts the body's lines, never the properties —
   * and today's goal is the setting itself, read fresh by every display and
   * by the template API's getDay, so nothing is re-read.
   *
   * Resolves to whether that is settled: written, or nothing to write. False
   * when the read or the write failed (reported), or the plugin was unloaded.
   */
  private async writeGoal(path: string): Promise<boolean> {
    const app = this.plugin.app;
    try {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return true;
      const minutes = this.goalFor(path, file);
      if (minutes === null) return true;
      const content = await app.vault.read(file);
      if (this.disposed) return false;
      if (recordLogGoal(content, minutes) === content) return true;
      await app.vault.process(file, (data) => recordLogGoal(data, minutes));
      return true;
    } catch (e) {
      logger.warn(`Could not record the daily goal in "${path}"`, e);
      return false;
    }
  }

  /**
   * Today's total focus seconds, summed from today's log file. Cached for
   * FOCUS_TOTAL_CACHE_TTL_MS. Under a language that writes its own digits the
   * file 0.6.8 named in them is read too, so the morning before the update
   * still counts (F4); the timer writes only the English-digit one.
   */
  async getTodayFocusSeconds(): Promise<number> {
    const folderPath = this.plugin.settings.logFolderPath;
    if (!folderPath) return 0;

    const today = moment();
    const dayStartHour = this.plugin.settings.dayStartHour;
    const dateStr = logicalDate(today, dayStartHour);
    const now = Date.now();

    if (
      this.focusTotalCacheDate === dateStr &&
      now - this.focusTotalCacheAt < FOCUS_TOTAL_CACHE_TTL_MS
    ) {
      return this.focusTotalCacheSeconds;
    }

    const vault = this.plugin.app.vault;
    let totalSeconds = 0;
    for (const date of logDateNames(today, dayStartHour)) {
      const file = vault.getAbstractFileByPath(dailyLogPath(folderPath, date));
      if (file instanceof TFile) totalSeconds += parseFocusTotalSeconds(await vault.read(file));
    }

    this.focusTotalCacheDate = dateStr;
    this.focusTotalCacheSeconds = totalSeconds;
    this.focusTotalCacheAt = now;
    return totalSeconds;
  }
}
