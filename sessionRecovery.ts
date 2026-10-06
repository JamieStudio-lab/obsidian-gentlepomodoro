/**
 * What is kept on this device so a quit or a failed write does not lose a
 * session (0.6.9): the session in progress (F23), and a log line that could
 * not be written (F53) — and, beside them, a change of the daily goal not yet
 * recorded in its day's log file (PENDING_GOALS_KEY).
 *
 * Until 0.6.9 the open session lived in LogManager's memory alone. Quitting
 * Obsidian, a plugin update, disable and enable, or iOS closing a
 * backgrounded app all dropped it without a line or a word. Now it is saved
 * at every change and once a minute while it runs, and the next start offers
 * it back: "Log it" ends it where the timer was last seen running — within a
 * minute of a quit or a crash on a computer, and at about when the app was
 * left on a phone that suspends it, which saves nothing while away.
 *
 * Pure: the shapes as stored, how they are read back (defensively — a stored
 * value is still input), and the wording. LogManager keeps them; the plugin
 * asks.
 */
import { MIN_SESSION_SECONDS } from "./constants";
import { LOG_FILE_SUFFIX, loggedTotalSeconds, type SessionLog } from "./logLine";
import { activeReachedAt, pausesWithin, type ClosedSegment } from "./logSegments";
import type { MomentLike } from "./momentTypes";
import { describeDuration, isLongSession, type LongSessionQuestion } from "./sessionGaps";

/** The session in progress, as last saved. */
export const OPEN_SESSION_KEY = "gentle-pomodoro-open-session";
/** Sessions found at startup and not yet logged or discarded. */
export const UNFINISHED_SESSIONS_KEY = "gentle-pomodoro-unfinished-sessions";
/** Log lines that could not be written, oldest first. */
export const UNWRITTEN_LINES_KEY = "gentle-pomodoro-unwritten-lines";
/**
 * Goal changes not yet written to their day's log file (LogManager.goalChanged):
 * `{ path, minutes, at }` for each day a change was made on — the value set
 * last on it, and when (ms). Kept so a quit within the write's delay, or a
 * phone that suspends the app, loses none: the next start writes them.
 */
export const PENDING_GOALS_KEY = "gentle-pomodoro-pending-goals";

/** A goal change kept for its day's log file: the minutes set, and when (ms). */
export interface PendingGoal {
  minutes: number;
  at: number;
}

/** A segment a task switch closed (logSegments.ts), its end in ms. */
export interface SavedSegment {
  taskName: string;
  taskPath?: string;
  taskId?: string;
  endMs: number;
}

/** The open session as LogManager holds it, every instant in ms. */
export interface SavedSession {
  mode: "focus" | "break";
  taskName: string;
  taskPath?: string;
  taskId?: string;
  startMs: number;
  /** The pauses that have ended, [start, end]. */
  pauses: [number, number][];
  /** The pause still open, or null while running. */
  pauseStartMs: number | null;
  scheduledMinutes: number;
  breakType: "short" | "long" | null;
  segments: SavedSegment[];
  /** The planned active time on the clock (±5 included), what Overtime is
   *  counted past; null when unknown, and then the scheduled length is. */
  plannedMs: number | null;
  /** When it was last saved: the latest instant it is known to have run. */
  lastSeenMs: number;
}

/** Lines that failed to write, and where they were going. */
export interface UnwrittenLines {
  path: string;
  folder: string;
  lines: string[];
  /** Holds a focus line, so today's total must be read again once written. */
  focus: boolean;
}

const isMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

function readSegment(raw: unknown): SavedSegment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.taskName !== "string" || !isMs(r.endMs)) return null;
  if (!optionalText(r.taskPath) || !optionalText(r.taskId)) return null;
  return { taskName: r.taskName, taskPath: r.taskPath, taskId: r.taskId, endMs: r.endMs };
}

/** A stored session, or null when the value is not one. */
export function readSavedSession(raw: unknown): SavedSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== "focus" && r.mode !== "break") return null;
  if (typeof r.taskName !== "string" || !optionalText(r.taskPath) || !optionalText(r.taskId)) {
    return null;
  }
  if (!isMs(r.startMs) || !isMs(r.lastSeenMs)) return null;
  if (r.pauseStartMs !== null && !isMs(r.pauseStartMs)) return null;
  if (typeof r.scheduledMinutes !== "number" || !Number.isFinite(r.scheduledMinutes)) return null;
  if (r.breakType !== null && r.breakType !== "short" && r.breakType !== "long") return null;
  if (r.plannedMs !== null && !isMs(r.plannedMs)) return null;
  if (!Array.isArray(r.pauses) || !Array.isArray(r.segments)) return null;
  const pauses: [number, number][] = [];
  for (const pause of r.pauses as unknown[]) {
    if (!Array.isArray(pause) || pause.length !== 2) return null;
    const [start, end] = pause as unknown[];
    if (!isMs(start) || !isMs(end) || end < start) return null;
    pauses.push([start, end]);
  }
  const segments: SavedSegment[] = [];
  for (const segment of r.segments as unknown[]) {
    const read = readSegment(segment);
    if (read === null) return null;
    segments.push(read);
  }
  return {
    mode: r.mode,
    taskName: r.taskName,
    taskPath: r.taskPath,
    taskId: r.taskId,
    startMs: r.startMs,
    pauses,
    pauseStartMs: r.pauseStartMs,
    scheduledMinutes: r.scheduledMinutes,
    breakType: r.breakType,
    segments,
    plannedMs: r.plannedMs,
    lastSeenMs: r.lastSeenMs,
  };
}

/** The stored list of unfinished sessions; anything unreadable is left out. */
export function readSavedSessions(raw: unknown): SavedSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readSavedSession).filter((saved) => saved !== null);
}

/** One session, found twice — by a second startup before an answer. */
export function sameSavedSession(a: SavedSession, b: SavedSession): boolean {
  return a.mode === b.mode && a.startMs === b.startMs;
}

/** The stored unwritten lines; anything unreadable is left out. */
export function readUnwrittenLines(raw: unknown): UnwrittenLines[] {
  if (!Array.isArray(raw)) return [];
  const out: UnwrittenLines[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || typeof r.folder !== "string") continue;
    if (!Array.isArray(r.lines) || r.lines.length === 0) continue;
    if (!r.lines.every((line) => typeof line === "string")) continue;
    out.push({
      path: r.path,
      folder: r.folder,
      lines: r.lines,
      focus: r.focus === true,
    });
  }
  return out;
}

/**
 * The stored goal changes, by log file path; anything unreadable is left out
 * — a path that is no daily log's (the write must never reach another note),
 * minutes that are no number of them (a goal, or 0 for none), or no time it
 * was made at: without one, a later write to its file could not be told from
 * an earlier one (LogManager.goalFor).
 */
export function readPendingGoals(raw: unknown): Map<string, PendingGoal> {
  const out = new Map<string, PendingGoal>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || !r.path.endsWith(LOG_FILE_SUFFIX)) continue;
    if (typeof r.minutes !== "number" || !Number.isFinite(r.minutes) || r.minutes < 0) continue;
    if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at < 0) continue;
    out.set(r.path, { minutes: r.minutes, at: r.at });
  }
  return out;
}

/**
 * Where a recovered session ends: where its open pause began, or else where
 * it was last seen running. Time after that cannot be known to have been
 * worked — the app may have been quit, or killed in the background.
 */
export function savedSessionEnd(saved: SavedSession): number {
  return Math.max(saved.startMs, saved.pauseStartMs ?? saved.lastSeenMs);
}

/** Its planned active time in whole seconds: the clock's (±5 included), or else the scheduled length. */
function plannedSeconds(saved: SavedSession): number {
  return Math.floor((saved.plannedMs ?? saved.scheduledMinutes * 60_000) / 1000);
}

/**
 * The session as its log lines will be written: ended at savedSessionEnd,
 * status finished, its pauses cut there, and the segments a split closed.
 * `at` is the moment factory. A focus's Overtime is the active time past the
 * planned length, as the timer counts it.
 *
 * `end` ends it elsewhere, as Stop's `SessionEnd` does: the startup's "Log up
 * to planned end" passes plannedSessionEnd (F18), so the line is the one
 * Stop's "End at planned end" writes — its pauses and its segments cut there,
 * and Overtime what `end` says.
 */
export function recoveredSession(
  saved: SavedSession,
  at: (ms: number) => MomentLike,
  end?: { endAt: number; overtimeSeconds: number }
): { session: SessionLog; closed: ClosedSegment[] } {
  const start = at(saved.startMs);
  const lastSeen = at(savedSessionEnd(saved));
  const endTime = end ? at(end.endAt) : lastSeen;
  const pauses = saved.pauses.map(([s, e]) => ({ start: at(s), end: at(e) }));
  if (saved.pauseStartMs !== null) pauses.push({ start: at(saved.pauseStartMs), end: lastSeen });
  const session: SessionLog = {
    mode: saved.mode,
    taskName: saved.taskName,
    taskPath: saved.taskPath,
    taskId: saved.taskId,
    scheduledDurationMinutes: saved.scheduledMinutes,
    startTime: start,
    endTime,
    pauses: pausesWithin(pauses, start, endTime),
    status: "finished",
    breakType: saved.mode === "focus" ? null : saved.breakType,
  };
  if (end) session.overtimeSeconds = end.overtimeSeconds;
  else {
    session.overtimeSeconds =
      saved.mode === "focus" ? Math.max(0, loggedTotalSeconds(session) - plannedSeconds(saved)) : 0;
  }
  const closed = saved.segments.map((segment) => ({
    taskName: segment.taskName,
    taskPath: segment.taskPath,
    taskId: segment.taskId,
    end: at(segment.endMs),
  }));
  return { session, closed };
}

/**
 * What the startup question asks about a recovered session that Stop would
 * have asked about (isLongSession — a focus over the long-session threshold
 * and past its plan): its active time, its Overtime and where its active
 * time reached the plan (activeReachedAt, as "End at planned end" finds it
 * for the open session). Null for any other session, and for every session
 * while the setting is off: the dialog then has its two answers (F18).
 */
export function recoveredLongSession(
  saved: SavedSession,
  at: (ms: number) => MomentLike,
  hoursSetting: unknown
): LongSessionQuestion | null {
  const { session } = recoveredSession(saved, at);
  const active = loggedTotalSeconds(session);
  const overtime = session.overtimeSeconds ?? 0;
  if (!isLongSession(saved.mode, active, overtime, hoursSetting)) return null;
  return {
    activeSeconds: active,
    overtimeSeconds: overtime,
    plannedEndAt: activeReachedAt(session.startTime, session.pauses, plannedSeconds(saved)),
  };
}

/** Its active time, as its line would write Total. */
export function savedSessionSeconds(saved: SavedSession, at: (ms: number) => MomentLike): number {
  return loggedTotalSeconds(recoveredSession(saved, at).session);
}

/** Worth asking about: a session under a minute would write nothing (F59). */
export function worthRecovering(saved: SavedSession, at: (ms: number) => MomentLike): boolean {
  return savedSessionSeconds(saved, at) >= MIN_SESSION_SECONDS;
}

/**
 * How the user answered; "planned" — offered only for a long session (F18) —
 * logs it up to its planned end; "later" — the dialog closed — asks again
 * next start.
 */
export type RecoveryAnswer = "log" | "planned" | "discard" | "later";

export const RECOVERY_TITLE = "Log an unfinished session?";
export const RECOVERY_LOG_LABEL = "Log it";
export const RECOVERY_PLANNED_LABEL = "Log up to planned end";
export const RECOVERY_DISCARD_LABEL = "Discard";

/**
 * "Unfinished focus from 09:00 (24m)." — `startLabel` as the clock shows it.
 * For a long session, `long` adds how far past its plan it ran and when the
 * plan ended, which is what "Log up to planned end" logs it up to.
 */
export function recoveryMessage(
  mode: SavedSession["mode"],
  startLabel: string,
  activeSeconds: number,
  long?: { overtimeSeconds: number; plannedEndLabel: string } | null
): string {
  const head = `Unfinished ${mode} from ${startLabel} (${describeDuration(activeSeconds)}).`;
  if (!long) return head;
  return `${head} It ran ${describeDuration(long.overtimeSeconds)} past its planned end, ${long.plannedEndLabel}.`;
}

/** The Notice once lines that failed earlier are in the log. */
export function unwrittenLinesWrittenMessage(lines: number): string {
  return `Gentle pomodoro: wrote ${String(lines)} session line(s) that couldn't be written earlier.`;
}

/** The Notice when a session's line cannot be written now. */
export const UNWRITTEN_LINE_NOTICE =
  "Gentle pomodoro: couldn't write the session log. It will try again before the next session is logged, and when Obsidian starts.";
