/**
 * The daily log, read for templates (0.6.9): `plugin.api`, reachable from a
 * dataviewjs block as `app.plugins.plugins["gentle-pomo"]?.api`.
 *
 * Why it exists: every review template carried its own regex copy of the log
 * parser — which is why the version 2 line format broke them — and its own
 * daily goal, which disagreed with the plugin's. Through this a template reads
 * the log the way the plugin does (parseLogLine, both formats), counts a day
 * the way the goal meter does (parseFocusTotalSeconds), and takes each day's
 * goal from the day's own file (logFrontmatter.ts), so an old review keeps
 * the goal its day had after the setting changes.
 *
 * READ-ONLY, and versioned: `version` moves only when a member changes
 * meaning, and members are added, never taken away within a version. Nothing
 * here writes; files are read with Vault.cachedRead. Every call returns new
 * objects, built from the file's text, so a template that changes them
 * changes nothing of the plugin's. A date that is not YYYY-MM-DD rejects the
 * promise with a message saying so — never a throw inside the caller's block.
 */
import type { MomentLike } from "./momentTypes";
import type { GentlePomoSettings } from "./types";
import { dailyLogPath } from "./logFolder";
import { frontmatterRowCount, readLogGoal, resolveGoalMinutes } from "./logFrontmatter";
import {
  logDateNames,
  logPauseTexts,
  logSeconds,
  logTaskId,
  logicalDate,
  parseFocusTotalSeconds,
  parseLogLine,
  readLogTime,
  resolveDayStartHour,
  type ParsedLogLine,
} from "./logLine";

/** The API's version: what a template checks before it relies on a member. */
export const LOG_API_VERSION = 1;
/** The most days one getDays call reads: a year and a bit. */
export const LOG_API_MAX_DAYS = 400;

/** A focus line's task. */
export interface LogApiTask {
  /** The name as logged, its tags kept — `No Task` when none was linked. */
  name: string;
  /** The task's note, as a vault path; the link as written when it leads to
   *  no note any more; null when the line has no link. */
  path: string | null;
}

/** One pause of a focus line, as written. */
export interface LogApiPause {
  start: string;
  end: string;
}

/** One session line of a day's log — either format — as the plugin reads it. */
export interface LogApiSession {
  kind: "focus" | "rest";
  /** "focus", "short-break" or "long-break"; null on the oldest lines, which have none. */
  type: string | null;
  /** Focus lines only; null on a Rest line. */
  task: LogApiTask | null;
  /** The task's 🆔, or null. */
  id: string | null;
  /** `YYYY-MM-DD HH:mm:ss`, as written; null when the line has none. */
  start: string | null;
  end: string | null;
  /** Seconds, or null when the field is missing or not a number. */
  scheduled: number | null;
  total: number | null;
  /** Active seconds past the planned end; null on lines from before 0.6.9. */
  overtime: number | null;
  /** [] when there were none or the line has no Pauses (Rest lines); null
   *  when the field cannot be read. */
  pauses: LogApiPause[] | null;
  /** "finished" or "cancelled" on focus lines; null on Rest lines. */
  status: string | null;
}

/** One day of the log. */
export interface DayLog {
  /** The date asked for, YYYY-MM-DD. */
  date: string;
  /** The day's log file, or null when there is none (or no log folder). */
  path: string | null;
  /**
   * The day's goal in minutes. Today and later: the setting now (0 when the
   * goal is off). An earlier day: the goal its file recorded — or null when it
   * recorded none (logged before 0.6.9, or with the goal off), so a template
   * can fall back to its own.
   */
  goalMinutes: number | null;
  /** What the goal meter counts for the day: the focus lines' Totals, skipped
   *  (cancelled) ones left out. A session still running is not in it. */
  focusSeconds: number;
  /** Every session line, in file order. */
  sessions: LogApiSession[];
}

/** `app.plugins.plugins["gentle-pomo"].api`. */
export interface GentlePomoApi {
  readonly version: typeof LOG_API_VERSION;
  /** The daily focus goal setting in minutes; 0 when it is off. */
  dailyGoalMinutes(): number;
  /** "Day starts at": the hour (0-6) before which a session counts for the day before. */
  dayStartHour(): number;
  /** The path of `date`'s log file (whether or not it exists yet); null with
   *  no log folder set, or when `date` is not YYYY-MM-DD. */
  logPath(date: string): string | null;
  /** One day of the log. Rejects when `date` is not YYYY-MM-DD. */
  getDay(date: string): Promise<DayLog>;
  /** Each day from `from` to `to`, both included, in order — at most
   *  LOG_API_MAX_DAYS. Rejects on a bad date, a range the wrong way round,
   *  or one too long. */
  getDays(from: string, to: string): Promise<DayLog[]>;
}

/** What the API needs from the plugin. */
export interface LogApiHost {
  /** A call, not a reference: loadSettings() replaces the object wholesale. */
  settings(): Pick<GentlePomoSettings, "logFolderPath" | "dayStartHour" | "dailyFocusGoalMinutes">;
  /** The text of the file at `path` (Vault.cachedRead), or null when there is none. */
  read(path: string): Promise<string | null>;
  /** A log line's link as a vault path, or null (resolveLogLink). */
  resolveLink(linktext: string, sourcePath: string): string | null;
  /** Obsidian's moment for an instant, in the app's language: the name 0.6.8
   *  gave a day's file under a language with its own digits comes from it. */
  moment(ms: number): MomentLike;
  now(): number;
}

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** `value` as a calendar date, or null when it is not YYYY-MM-DD (0-9) naming one. */
function calendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== "string") return null;
  const match = DATE_REGEX.exec(value);
  // readLogTime checks the calendar: 2026-02-30 is no date.
  if (!match || readLogTime(`${value} 12:00:00`) === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** `value` as a calendar date; throws, saying what was wrong, when it is not one. */
function requireDate(value: unknown, name: string): CalendarDate {
  const date = calendarDate(value);
  if (date !== null) return date;
  const shown =
    typeof value === "string"
      ? `"${value}"`
      : value === null || value === undefined
        ? String(value)
        : typeof value === "object"
          ? "an object"
          : `a ${typeof value}`;
  throw new Error(
    `Gentle Pomodoro: ${name} must be a date written YYYY-MM-DD, like "2026-10-04", not ${shown}. From a Dataview date: date.toFormat("yyyy-MM-dd").`
  );
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The date `offset` days after `date` — counted in calendar days, so a
 *  night the clocks change is one day like any other. */
function dateAfter(date: CalendarDate, offset: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** YYYY-MM-DD. */
const dateText = (date: CalendarDate) => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;

/** Days from `a` to `b`, negative when `b` is earlier. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/** The Pauses value as written pairs: [] when the line has none, null when it cannot be read. */
function readPauses(parsed: ParsedLogLine): LogApiPause[] | null {
  const value = parsed.values.get("Pauses");
  if (value === undefined) return [];
  return logPauseTexts(value)?.map(([start, end]) => ({ start, end })) ?? null;
}

/** One line, read, as the API gives it. */
function apiSession(
  parsed: ParsedLogLine,
  filePath: string,
  resolveLink: LogApiHost["resolveLink"]
): LogApiSession {
  const task = parsed.task;
  return {
    kind: parsed.kind,
    type: parsed.values.get("Type") ?? null,
    task: task
      ? {
          name: task.name,
          path: task.path === undefined ? null : (resolveLink(task.path, filePath) ?? task.path),
        }
      : null,
    id: logTaskId(parsed),
    start: parsed.values.get("Start") ?? null,
    end: parsed.values.get("End") ?? null,
    scheduled: logSeconds(parsed, "Scheduled"),
    total: logSeconds(parsed, "Total"),
    overtime: logSeconds(parsed, "Overtime"),
    pauses: readPauses(parsed),
    status: parsed.values.get("Status") ?? null,
  };
}

/** The session lines of a log file, past its properties, in file order. */
export function logApiSessions(
  content: string,
  filePath: string,
  resolveLink: LogApiHost["resolveLink"]
): LogApiSession[] {
  const sessions: LogApiSession[] = [];
  for (const line of content.split(/\r?\n/).slice(frontmatterRowCount(content))) {
    const parsed = parseLogLine(line);
    if (parsed) sessions.push(apiSession(parsed, filePath, resolveLink));
  }
  return sessions;
}

/** The API object, frozen so a template cannot swap a member out. */
export function createLogApi(host: LogApiHost): GentlePomoApi {
  const dailyGoalMinutes = () => resolveGoalMinutes(host.settings().dailyFocusGoalMinutes);
  const today = () => logicalDate(host.moment(host.now()), host.settings().dayStartHour);

  /**
   * One day, `today` the logical date the call started on (getDays reads its
   * whole range against one). The files are the ones today's total reads for
   * a day (logDateNames): its 0-9 file and, under a language with its own
   * digits, the one 0.6.8 named in them.
   */
  async function readDay(date: CalendarDate, todayDate: string): Promise<DayLog> {
    const name = dateText(date);
    const settingGoal = name >= todayDate ? dailyGoalMinutes() : null;
    const folder = host.settings().logFolderPath;
    const day: DayLog = {
      date: name,
      path: null,
      goalMinutes: settingGoal,
      focusSeconds: 0,
      sessions: [],
    };
    if (!folder) return day;
    // Noon: past any "Day starts at", so the day named is `date` itself.
    const noon = host.moment(new Date(date.year, date.month - 1, date.day, 12).getTime());
    for (const fileDate of logDateNames(noon, host.settings().dayStartHour)) {
      const filePath = dailyLogPath(folder, fileDate);
      const content = await host.read(filePath);
      if (content === null) continue;
      if (day.path === null) {
        day.path = filePath;
        if (settingGoal === null) day.goalMinutes = readLogGoal(content);
      }
      day.focusSeconds += parseFocusTotalSeconds(content);
      day.sessions.push(
        ...logApiSessions(content, filePath, (link, source) => host.resolveLink(link, source))
      );
    }
    return day;
  }

  return Object.freeze({
    version: LOG_API_VERSION,
    dailyGoalMinutes,
    dayStartHour: () => resolveDayStartHour(host.settings().dayStartHour),
    logPath(date: string): string | null {
      const folder = host.settings().logFolderPath;
      return folder && calendarDate(date) !== null ? dailyLogPath(folder, date) : null;
    },
    async getDay(date: string): Promise<DayLog> {
      return readDay(requireDate(date, "getDay's date"), today());
    },
    async getDays(from: string, to: string): Promise<DayLog[]> {
      const first = requireDate(from, "getDays' from");
      const last = requireDate(to, "getDays' to");
      const span = daysBetween(first, last);
      if (span < 0) {
        throw new Error(`Gentle Pomodoro: getDays' from (${from}) is after its to (${to}).`);
      }
      if (span + 1 > LOG_API_MAX_DAYS) {
        throw new Error(
          `Gentle Pomodoro: getDays reads at most ${String(LOG_API_MAX_DAYS)} days; ${from} to ${to} is ${String(span + 1)}.`
        );
      }
      const todayDate = today();
      const days: DayLog[] = [];
      for (let offset = 0; offset <= span; offset++) {
        days.push(await readDay(dateAfter(first, offset), todayDate));
      }
      return days;
    },
  });
}
