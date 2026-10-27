/**
 * The daily log's line format, written and read in one place (0.6.9).
 *
 * Up to 0.6.8 a line was `- 🍅 Focus | Task:: … | Start:: … | Total:: …`, and
 * Dataview read NOTHING from it: inside a list item it only takes bracketed
 * `[Key:: value]` fields (or one whole-line field, whose key the `|` breaks).
 * Version 2 keeps every field name, the order and the value text, and only
 * swaps `| Key:: value` for `[Key:: value]`:
 *
 *   - 🍅 Focus [Task:: [[path|name]]] [ID:: abc] [Start:: …] [End:: …] [Scheduled:: 1500] [Pauses:: […]] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]
 *   - ☕ Rest [Start:: …] [End:: …] [Scheduled:: 300] [Total:: 300] [Type:: short-break]
 *
 * Old files stay as they are until the user converts them, so every reader
 * goes through `parseLogLine`, which reads both — a file holding both kinds
 * must add up the same. No other regex over log lines belongs anywhere else in
 * the plugin (tests/logLine.test.ts holds the sources to that).
 *
 * 0.7.0 adds a TAIL after those fields, on the lines its timer, a recovery or
 * "Add a session" writes — the ten fields before it byte for byte as 0.6.9
 * wrote them (LOG_TAIL_KEYS says what, formatLogLine when):
 *
 *   … [Overtime:: 0] [Session:: s7k2m9qx4w] [StartedBy:: start] [EndedBy:: time-up] [Planned:: 1500] [Cycle:: 2] [Offset:: -240]
 *
 * No `obsidian` import: the date helpers take the moment they are given.
 */
import { NO_TASK_LABEL } from "./constants";
import { frontmatterRowCount } from "./logFrontmatter";
import type { MomentLike } from "./momentTypes";

/** What opened a session: Start, an auto-start, a Reset while running, or "Add a session". */
export const STARTED_BY = ["start", "auto", "reset", "added"] as const;
export type StartedBy = (typeof STARTED_BY)[number];

/**
 * What ended it: the clock at zero with the next session starting by itself,
 * Stop, Stop's "End at planned end", Skip, the startup's "Log it" and "Log up
 * to planned end", or "Add a session". Every value is a lasting contract once
 * written: a reader may match on it.
 */
export const ENDED_BY = [
  "time-up",
  "stop",
  "planned-end",
  "skip",
  "recovered",
  "recovered-planned-end",
  "added",
] as const;
export type EndedBy = (typeof ENDED_BY)[number];

/**
 * The tail's fields, in the order a line writes them (0.7.0). On a line that
 * has Session, a missing Slept, Dropped or OffsetChange means 0; a line with
 * no Session is older, and every one of these is unknown on it — never
 * worked out after the fact.
 *
 * No key may END in another log key (a review's greedy `.*Total::` or
 * `.*Offset::` would read it — hence OffsetChange, not EndOffset), and none
 * may be Day or Date: a list item's field of that name takes the place of
 * Dataview's `file.day` for the whole file. tests/logLine.test.ts holds both.
 */
export const LOG_TAIL_KEYS = [
  "Session",
  "StartedBy",
  "EndedBy",
  "Planned",
  "Cycle",
  "Offset",
  "OffsetChange",
  "Slept",
  "Dropped",
  "Device",
] as const;

export interface SessionLog {
  mode: "focus" | "break";
  taskName: string;
  // The task's note. Undefined means unlinked — never a name comparison: a task
  // can be called "No Task" (F36).
  taskPath?: string;
  scheduledDurationMinutes: number;
  startTime: MomentLike;
  endTime: MomentLike;
  pauses: { start: MomentLike; end: MomentLike }[];
  status: "finished" | "cancelled";
  taskId?: string; // Tasks plugin ID
  // null/undefined when mode is "focus"; otherwise distinguishes short vs long break.
  breakType?: "short" | "long" | null;
  // Seconds of active time past the planned end; focus lines only. Missing = 0.
  overtimeSeconds?: number;

  // The tail (0.7.0). Written only with a sessionId (isSessionId): a session
  // without one — Fix's template, a session a 0.6.9 run saved — gets a line
  // exactly as 0.6.9 wrote it.
  /** One ID per timed session, shared by every line a split session writes. */
  sessionId?: string;
  startedBy?: StartedBy;
  endedBy?: EndedBy;
  /** The clock's plan at the end in seconds, ±5 included: what Overtime is past. */
  plannedSeconds?: number;
  /** Its place in the long-break cycle, 1…longBreakEvery (cyclePosition): a
   *  focus that moved the count only. */
  cycle?: number;
  /** The spans (ms) the sleep check paused for — about how long the computer
   *  slept; a line's Slept is its share. */
  sleeps?: readonly (readonly [number, number])[];
  /** Active seconds a planned end left out, so Total + Dropped is what the
   *  timer measured; only the last line of a split session carries it. */
  droppedSeconds?: number;
  /** This device's name as typed; sanitizeDevice cleans it on the way in. */
  device?: string;
}

export const LOG_FOCUS_MARKER = "🍅 Focus";
export const LOG_REST_MARKER = "☕ Rest";
export const LOG_DATE_FORMAT = "YYYY-MM-DD";
export const LOG_TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";
export const LOG_FILE_SUFFIX = "-gentle-pomodoro-log.md";

/**
 * Date text that is stored or used as a key — file names, Start/End/Pauses,
 * today's date. Always in English digits: Obsidian sets moment's locale to the
 * app language, and Arabic, Persian, Bengali and Nepali format digits natively,
 * which Dataview's date grammar and every `\d` reader then cannot see, and a
 * language change mid-day renamed today's file (F14).
 */
export function stamp(m: MomentLike, format: string): string {
  return m.clone().locale("en").format(format);
}

/** The hours "Day starts at" offers: midnight to 6:00. */
export const DAY_START_HOURS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The stored hour if it is one of DAY_START_HOURS, else midnight. */
export function resolveDayStartHour(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6
    ? value
    : 0;
}

/**
 * The day a moment belongs to: its date, or the day before when its clock
 * hour is earlier than `dayStartHour`, so with a 4:00 start a session at 01:30
 * counts for the day before. The one rule for the log file's name (by session
 * start), today's total, the goal notice and the long-break counter — they
 * must agree, or a session is filed under one day and counted under another.
 *
 * Read off the wall clock, never by taking hours off the instant: on a night
 * the clocks change, `subtract(4, "hours")` crosses the jump, so 04:30 on the
 * spring-forward morning landed on the day before, and 03:30 after the
 * fall-back on the same day.
 */
export function logicalDate(m: MomentLike, dayStartHour: unknown): string {
  return stamp(logicalDay(m, dayStartHour), LOG_DATE_FORMAT);
}

/**
 * The same day as the app language writes it: the name 0.6.8 and earlier gave
 * the day's log file, before `stamp`. Under Arabic, Persian, Bengali or Nepali
 * it is not logicalDate, and on the day 0.6.9 is installed the morning's
 * sessions are still in a file of that name — so today's total reads it too
 * (F4). Elsewhere it is logicalDate.
 */
export function appLanguageLogicalDate(m: MomentLike, dayStartHour: unknown): string {
  return logicalDay(m, dayStartHour).format(LOG_DATE_FORMAT);
}

/**
 * Every name the log file of `m`'s day may have: logicalDate's, and under a
 * language that writes its own digits the name 0.6.8 gave it too (F4). Today's
 * total reads both, and so does the read API (logApi.ts), so the two count a
 * day the same.
 */
export function logDateNames(m: MomentLike, dayStartHour: unknown): string[] {
  return [...new Set([logicalDate(m, dayStartHour), appLanguageLogicalDate(m, dayStartHour)])];
}

function logicalDay(m: MomentLike, dayStartHour: unknown): MomentLike {
  const day = m.clone();
  if (day.hour() < resolveDayStartHour(dayStartHour)) day.subtract(1, "day");
  return day;
}

/** The daily log's file name for a `logicalDate`. */
export function dailyLogFileName(date: string): string {
  return `${date}${LOG_FILE_SUFFIX}`;
}

// The zero of each script whose digits moment's locales write (Arabic,
// Persian, Devanagari, Bengali, Gurmukhi, Gujarati, Tamil, Kannada, Tibetan,
// Myanmar, Khmer), and of their neighbours a hand edit could carry (NKo, Oriya,
// Telugu, Malayalam, Sinhala, Thai, Lao, Shan, Mongolian, full width). Each
// script's 0-9 are ten code points in a row from its zero.
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66,
  0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0xff10,
];

/**
 * The text with every digit of those scripts written 0-9. Logs written before
 * 0.6.9 under Arabic, Persian, Bengali or Nepali carry dates like
 * ٢٠٢٦-١٠-٠٢ (F14); this is how they are read, and converted.
 */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    return zero === undefined ? digit : String(code - zero);
  });
}

const LOG_TIME_REGEX = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * A written time (LOG_TIME_FORMAT, in any script's digits) as whole seconds
 * since the epoch, read as local time the way it was written; null when it is
 * not one. The hour is not checked against the clock: in the hour a daylight
 * saving change skips, Date moves it on, and the line is still a session. In
 * the hour a change REPEATS, the time names two instants and this is the
 * first; repeatedReading says how much later the second is.
 */
export function readLogTime(text: string): number | null {
  const match = LOG_TIME_REGEX.exec(asciiDigits(text.trim()));
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

// How far the clocks go back when daylight saving ends: an hour almost
// everywhere, half an hour on Lord Howe Island, two in old double summer time.
const REPEAT_SECONDS = [3600, 1800, 7200];

/**
 * For a readLogTime reading: how many seconds later the same written time
 * comes round again, or 0 when it names one instant. A log line carries no
 * UTC offset, so a time in the hour a fall-back repeats (01:00-01:59 on the
 * first Sunday of November in New York) reads as its first pass even when the
 * session was in the second. Check uses this so that it does not flag a line
 * the timer wrote across that hour as broken.
 */
export function repeatedReading(seconds: number): number {
  const first = new Date(seconds * 1000);
  for (const shift of REPEAT_SECONDS) {
    const second = new Date((seconds + shift) * 1000);
    if (
      second.getFullYear() === first.getFullYear() &&
      second.getMonth() === first.getMonth() &&
      second.getDate() === first.getDate() &&
      second.getHours() === first.getHours() &&
      second.getMinutes() === first.getMinutes() &&
      second.getSeconds() === first.getSeconds()
    ) {
      return shift;
    }
  }
  return 0;
}

/**
 * The Pauses value — a JSON list of "start - end" — as [start, end] pairs of
 * the text as written; null when it is not that list. The read API gives
 * these; readLogPauses reads them as times.
 */
export function logPauseTexts(value: string): [string, string][] | null {
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const items: unknown[] = list;
  const pauses: [string, string][] = [];
  for (const item of items) {
    if (typeof item !== "string") return null;
    const ends = item.split(" - ");
    if (ends.length !== 2) return null;
    pauses.push([ends[0], ends[1]]);
  }
  return pauses;
}

/**
 * The Pauses value as [start, end] pairs of readLogTime seconds; null when it
 * is not that list, or a time in it cannot be read.
 */
export function readLogPauses(value: string): [number, number][] | null {
  const texts = logPauseTexts(value);
  if (texts === null) return null;
  const pauses: [number, number][] = [];
  for (const [startText, endText] of texts) {
    const start = readLogTime(startText);
    const end = readLogTime(endText);
    if (start === null || end === null) return null;
    pauses.push([start, end]);
  }
  return pauses;
}

/**
 * A task name made safe to sit in `[Task:: [[path|name]]]`, for the writer and
 * for every rename that compares against what was written (F24, F33, F35).
 *
 * - A wikilink keeps what it shows. Obsidian drops a link that holds another
 *   link, so `[[p|Read [[Paper]]]]` lost its backlink to the task.
 * - Brackets become parentheses: one `]` closed the field early for Dataview
 *   and stopped every `[^\]]` reader at it.
 * - `::` becomes `:`, so a name holding "Total:: 7" is not a second field.
 * - Line breaks and tabs become spaces; runs of spaces collapse.
 * - A trailing backslash goes: it escapes the closing bracket, and Dataview
 *   then drops the whole Task field (checked with its own worker).
 *
 * `|` stays (Dataview reads `[[p|A | B]]` as a link shown "A | B"), and so do
 * tags: the maintainer's reviews take a session's area from the `#task/…` tag
 * in this name.
 */
export function sanitizeAlias(name: string): string {
  let text = name;
  for (;;) {
    const flattened = text.replace(/\[\[([^[\]]*)\]\]/g, (_whole, inner: string) => {
      const bar = inner.indexOf("|");
      return bar === -1 ? inner : inner.slice(bar + 1);
    });
    if (flattened === text) break;
    text = flattened;
  }
  return text
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/:{2,}/g, ":")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/[\s\\]+$/u, "")
    .trim();
}

/**
 * The Task field's value: a link when the session had a note, the name alone
 * when it had none. Unlinked is "no path", never "the name is No Task".
 */
export function formatTaskValue(name: string, path?: string): string {
  const alias = sanitizeAlias(name);
  if (path) return alias ? `[[${path}|${alias}]]` : `[[${path}]]`;
  return alias || NO_TASK_LABEL;
}

// Crockford's base 32 in lower case: no i, l, o or u to misread.
const SESSION_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SESSION_ID_REGEX = /^s[0-9a-hjkmnp-tv-z]{9}$/;

/** Whether `value` is a Session ID as newSessionId makes them. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_REGEX.test(value);
}

/**
 * A new Session ID: `s` and nine characters of SESSION_ID_ALPHABET, e.g.
 * `s7k2m9qx4w`. The letter first makes it text to Dataview, which reads an
 * all-digit one as a number. Nine characters (45 bits) keep it apart from
 * every other session ever logged, not just the day's. Each random byte is
 * cut to 5 bits (`& 31`): 256 is a multiple of 32, so no character is more
 * likely than another.
 *
 * From `crypto.getRandomValues`, which the desktop app, both phone web views
 * and Node all have, and which needs no secure context; Math.random only where
 * it is missing — the ID needs to be unlikely to repeat, not secret. `fill`
 * stands in for it in tests.
 */
export function newSessionId(fill?: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(9);
  const random = fill ?? cryptoFill();
  if (random) random(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let id = "s";
  for (const byte of bytes) id += SESSION_ID_ALPHABET[byte & 31];
  return id;
}

/** The global `crypto`'s filler, or null where there is none. Read at each
 *  call, never kept: a test takes it away. */
function cryptoFill(): ((bytes: Uint8Array) => void) | null {
  // `typeof` first: a bare name that is not declared would throw.
  if (typeof crypto === "undefined" || typeof crypto?.getRandomValues !== "function") return null;
  return (bytes) => {
    crypto.getRandomValues(bytes);
  };
}

/** The longest Device a line writes, in code points. */
export const DEVICE_NAME_MAX = 40;

/**
 * A device name made safe to write as Device, or "" for none. In this order,
 * which a fuzz of 200,000 names settled — any other re-forms `🍅 Focus` or
 * leaves a trailing backslash:
 *
 * 1. Every 🍅, ☕ and # goes. The reviews find a focus line by `🍅 Focus`
 *    anywhere on it, so a name holding it made a break count as focus; and
 *    some take a session's area from the first `#task/` on the line.
 * 2. Runs of white space become one space.
 * 3. Cut to DEVICE_NAME_MAX code points, never inside one.
 * 4. sanitizeAlias, as a task name: no bracket to close the field early, no
 *    `::` to start another, no trailing backslash to escape its `]`.
 * 5. Trimmed.
 */
export function sanitizeDevice(name: string): string {
  const plain = name.replace(/[🍅☕#]/gu, "").replace(/\s+/gu, " ");
  return sanitizeAlias([...plain].slice(0, DEVICE_NAME_MAX).join("")).trim();
}

/**
 * The long-break cycle's length, from the setting: a whole number, at least
 * 1 (data.json can hold any number; only the settings row floors it).
 */
export function cycleLength(every: number): number {
  return Math.max(1, Math.floor(every));
}

/**
 * A focus's place in the long-break cycle, 1…`every`: the line's Cycle. `count`
 * is the day's counter as this session moves it — TimerEngine never resets it
 * after a long break, so the 5th focus of a day of 4-and-a-long-break is 1.
 * A long break follows the focus whose place is cycleLength(`every`), and
 * TimerEngine decides it from this very number.
 */
export function cyclePosition(count: number, every: number): number {
  return ((Math.max(1, Math.floor(count)) - 1) % cycleLength(every)) + 1;
}

/** Whole seconds since the epoch: what the written times show. */
const wholeSeconds = (m: MomentLike): number => Math.floor(m.valueOf() / 1000);

/**
 * The seconds of a line's span the computer slept through: its `sleeps` cut to
 * [Start, End], in whole seconds as the line's pauses are counted. Each sleep
 * lies inside a pause (the sleep check pauses from the last tick), so this is
 * never more than the line's paused time. An estimate (README): the gap from
 * the last tick before the sleep to the first after it, which can hold up to
 * about a minute awake at either end.
 */
export function sleptSeconds(
  session: Pick<SessionLog, "startTime" | "endTime" | "sleeps">
): number {
  const from = wholeSeconds(session.startTime);
  const to = wholeSeconds(session.endTime);
  let slept = 0;
  for (const [start, end] of session.sleeps ?? []) {
    const overlap = Math.min(to, Math.floor(end / 1000)) - Math.max(from, Math.floor(start / 1000));
    if (overlap > 0) slept += overlap;
  }
  return slept;
}

/** A count to write: whole and not below 0, or null when it is no number. */
function wholeCount(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/** Minutes east of UTC at `m`, a whole number. */
function minutesEast(m: MomentLike): number {
  return Math.round(m.utcOffset());
}

/**
 * The tail a session's line ends with (LOG_TAIL_KEYS), or none without a
 * Session ID. What each field holds is the caller's (LogManager, the
 * recovery, Add), except Offset and OffsetChange, read off the very moments
 * Start and End are written from — so the Start text and Offset name the
 * instant also for a session recovered the next day in another zone — and
 * Slept, this line's share of the session's sleeps. Cycle only on a focus.
 */
function tailFields(session: SessionLog): [string, string][] {
  if (!isSessionId(session.sessionId)) return [];
  const fields: [string, string][] = [["Session", session.sessionId]];
  if (session.startedBy) fields.push(["StartedBy", session.startedBy]);
  if (session.endedBy) fields.push(["EndedBy", session.endedBy]);
  const planned = wholeCount(session.plannedSeconds);
  if (planned !== null) fields.push(["Planned", String(planned)]);
  const cycle = wholeCount(session.cycle);
  if (session.mode === "focus" && cycle !== null && cycle >= 1) {
    fields.push(["Cycle", String(cycle)]);
  }
  const offset = minutesEast(session.startTime);
  fields.push(["Offset", String(offset)]);
  const change = minutesEast(session.endTime) - offset;
  if (change !== 0) fields.push(["OffsetChange", String(change)]);
  const slept = sleptSeconds(session);
  if (slept > 0) fields.push(["Slept", String(slept)]);
  const dropped = wholeCount(session.droppedSeconds) ?? 0;
  if (dropped > 0) fields.push(["Dropped", String(dropped)]);
  const device = sanitizeDevice(session.device ?? "");
  if (device !== "") fields.push(["Device", device]);
  return fields;
}

/**
 * A session's Total as its line writes it: worked out from the instants cut to
 * the second, as Start, End and the pauses are written, so a line balances
 * exactly — Total = End − Start − pauses (F65). Never below 0: a clock stepped
 * back mid-session made it negative, and every `\d+` reader then skipped the
 * session (F42). LogManager judges "under one minute" by this same number, so
 * no line is ever written with a Total under 60.
 */
export function loggedTotalSeconds(
  session: Pick<SessionLog, "startTime" | "endTime" | "pauses">
): number {
  let pausedSeconds = 0;
  for (const p of session.pauses) pausedSeconds += wholeSeconds(p.end) - wholeSeconds(p.start);
  return Math.max(
    0,
    wholeSeconds(session.endTime) - wholeSeconds(session.startTime) - pausedSeconds
  );
}

/**
 * Format a completed session as one line of the daily log (version 2): the
 * ten fields 0.6.9 wrote, then the tail (tailFields) when it has a Session ID.
 */
export function formatLogLine(session: SessionLog): string {
  const pauseStrings = session.pauses.map(
    (p) => `${stamp(p.start, LOG_TIME_FORMAT)} - ${stamp(p.end, LOG_TIME_FORMAT)}`
  );
  const total = loggedTotalSeconds(session);
  const scheduled = session.scheduledDurationMinutes * 60;
  const start = stamp(session.startTime, LOG_TIME_FORMAT);
  const end = stamp(session.endTime, LOG_TIME_FORMAT);

  const fields: [string, string][] = [];
  if (session.mode === "focus") {
    const overtime = Number.isFinite(session.overtimeSeconds)
      ? Math.max(0, Math.floor(session.overtimeSeconds ?? 0))
      : 0;
    fields.push(["Task", formatTaskValue(session.taskName, session.taskPath)]);
    if (session.taskId) fields.push(["ID", session.taskId]);
    fields.push(
      ["Start", start],
      ["End", end],
      ["Scheduled", String(scheduled)],
      ["Pauses", JSON.stringify(pauseStrings)],
      ["Total", String(total)],
      ["Status", session.status],
      ["Type", "focus"],
      ["Overtime", String(overtime)]
    );
  } else {
    fields.push(
      ["Start", start],
      ["End", end],
      ["Scheduled", String(scheduled)],
      ["Total", String(total)],
      ["Type", session.breakType === "long" ? "long-break" : "short-break"]
    );
  }
  fields.push(...tailFields(session));
  return formatV2Line("- ", session.mode === "focus" ? "focus" : "rest", fields);
}

/**
 * A version 2 line from its parts — the one place `[Key:: value]` is put
 * together, for the writer and for the converter of old lines. The caller
 * makes the values safe (the Task name through sanitizeAlias).
 */
export function formatV2Line(
  prefix: string,
  kind: LogLineKind,
  fields: readonly (readonly [string, string])[]
): string {
  const marker = kind === "focus" ? LOG_FOCUS_MARKER : LOG_REST_MARKER;
  return `${prefix}${marker} ${fields.map(([key, value]) => `[${key}:: ${value}]`).join(" ")}`;
}

export type LogLineKind = "focus" | "rest";
/** "v2" is `[Key:: value]` (0.6.9); "v1" is `| Key:: value` (every earlier version). */
export type LogLineFormat = "v2" | "v1";

/** One field as written. `line.slice(start, end) === value`. */
export interface LogField {
  key: string;
  value: string;
  start: number;
  end: number;
}

/** The Task field, read. `line.slice(start, end) === raw`. */
export interface LogTaskRef {
  /** The value as written: `[[path|name]]`, `[[path]]` or a bare name. */
  raw: string;
  /** Undefined when the value is not a link. */
  path?: string;
  name: string;
  start: number;
  end: number;
}

export interface ParsedLogLine {
  kind: LogLineKind;
  format: LogLineFormat;
  /** What comes before the marker: indentation, the bullet and — on the
   *  oldest lines (Dec 2025) — a checkbox, e.g. "- [x] ". */
  prefix: string;
  /** Every field, in line order. */
  fields: LogField[];
  /** The first value of each key. */
  values: Map<string, string>;
  task: LogTaskRef | null;
  /**
   * Text after the last field that is not a field, trimmed ("" for none). On
   * a version 1 line, whose last field runs to the end of the line, this is a
   * block ID and tags at the end (see readV1).
   */
  rest: string;
}

const MARKER_REGEX = /^(\s*(?:[-*+] )?(?:\[.\] )?)(🍅 Focus|☕ Rest)/u;

// The only keys version 1 ever wrote. A v1 field ends where the next of these
// begins, so a ` | ` inside a task name does not end the Task field.
const V1_KEYS = ["Task", "ID", "Start", "End", "Scheduled", "Pauses", "Total", "Status", "Type"];
const V1_BOUNDARY_REGEX = new RegExp(`\\s*\\|\\s*(${V1_KEYS.join("|")})::`, "g");
// A block ID and tags at the end of a line: ` ^abc123`, ` #tag`.
const LINE_TAIL_REGEX = /(?:\s+(?:\^[A-Za-z0-9-]+|#[^\s#]+))+$/u;
const V2_KEY_REGEX = /^\[([A-Za-z][A-Za-z0-9_]*)::/;
const LOG_LIKE_REGEX = new RegExp(
  `${LOG_FOCUS_MARKER}|${LOG_REST_MARKER}|\\b(?:${[...V1_KEYS, "Overtime"].join("|")})::`,
  "u"
);

/**
 * Whether a line parseLogLine refused still looks like a session — a marker,
 * or one of the log's own `Key::`. The converter and Check list these, since
 * one may be a session line edited by hand into a shape nothing reads; a note
 * or a heading in a log file is not one.
 */
export function looksLikeLogLine(line: string): boolean {
  return LOG_LIKE_REGEX.test(line);
}

/**
 * Read one line of a daily log, in either format; null for anything that is
 * not a session line. Structural only: values are not checked (a hand-edited
 * `Start:: x` still reads as a Start), and spans let a caller rewrite one
 * field and leave every other byte alone.
 */
export function parseLogLine(line: string): ParsedLogLine | null {
  const marker = MARKER_REGEX.exec(line);
  if (!marker) return null;
  const prefix = marker[1];
  const kind: LogLineKind = marker[2] === LOG_FOCUS_MARKER ? "focus" : "rest";
  const bodyStart = marker[0].length;
  let read: FieldRead | null = null;
  for (const reader of FIELD_READERS) {
    read = reader(line, bodyStart);
    if (read) break;
  }
  if (!read) return null;

  const values = new Map<string, string>();
  for (const field of read.fields) {
    if (!values.has(field.key)) values.set(field.key, field.value);
  }
  const taskField = kind === "focus" ? read.fields.find((f) => f.key === "Task") : undefined;
  return {
    kind,
    format: read.format,
    prefix,
    fields: read.fields,
    values,
    task: taskField ? readTask(taskField) : null,
    rest: read.rest,
  };
}

interface FieldRead {
  format: LogLineFormat;
  fields: LogField[];
  rest: string;
}

/** A field's value with its span, trimmed of the space around it. */
function trimmedField(line: string, key: string, from: number, to: number): LogField {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(line[start])) start++;
  while (end > start && /\s/.test(line[end - 1])) end--;
  return { key, value: line.slice(start, end), start, end };
}

/** `[Key:: value]` fields, closed the way Dataview closes them: by bracket
 *  depth, with a backslash escaping the character after it. */
function readV2(line: string, from: number): FieldRead | null {
  const fields: LogField[] = [];
  let at = from;
  for (;;) {
    let next = at;
    while (next < line.length && /\s/.test(line[next])) next++;
    const key = V2_KEY_REGEX.exec(line.slice(next));
    if (!key) break;
    const valueStart = next + key[0].length;
    let depth = 1;
    let close = -1;
    for (let i = valueStart; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\") {
        i++;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) break;
    fields.push(trimmedField(line, key[1], valueStart, close));
    at = close + 1;
  }
  if (fields.length === 0) return null;
  return { format: "v2", fields, rest: line.slice(at).trim() };
}

/**
 * ` | Key:: value` fields. The first boundary must open the body; after it,
 * boundaries are taken from the right and a key already taken is skipped, so
 * a name holding ` | Total:: 7` stays inside the Task field and the line's own
 * Total wins (F35).
 *
 * The last field runs to the end of the line, so a block ID or tags someone
 * put there are taken off it into `rest`: `| Type:: focus ^abc123` is Type
 * "focus". Obsidian finds a block ID only at the very end of a line, so a
 * rewrite that left it inside `[Type:: focus ^abc123]` broke every link to
 * it. Not off a Task field, where tags are part of the name.
 */
function readV1(line: string, from: number): FieldRead | null {
  const body = line.slice(from);
  const matches = [...body.matchAll(V1_BOUNDARY_REGEX)];
  if (matches.length === 0 || matches[0].index !== 0) return null;

  const first = matches[0];
  const seen = new Set<string>([first[1]]);
  const later: RegExpExecArray[] = [];
  for (let i = matches.length - 1; i >= 1; i--) {
    if (seen.has(matches[i][1])) continue;
    seen.add(matches[i][1]);
    later.unshift(matches[i]);
  }
  const kept = [first, ...later];
  const fields = kept.map((match, i) => {
    const valueStart = from + (match.index ?? 0) + match[0].length;
    const nextMatch = kept[i + 1];
    const valueEnd = nextMatch ? from + (nextMatch.index ?? 0) : line.length;
    return trimmedField(line, match[1], valueStart, valueEnd);
  });
  const last = fields[fields.length - 1];
  const tail = last.key === "Task" ? null : LINE_TAIL_REGEX.exec(last.value);
  if (!tail) return { format: "v1", fields, rest: "" };
  fields[fields.length - 1] = trimmedField(line, last.key, last.start, last.start + tail.index);
  return { format: "v1", fields, rest: tail[0].trim() };
}

// Tried in order after the marker; the first that reads any field wins. A
// reader for another shape of line belongs in this list, so every caller of
// parseLogLine sees it at once. Version 2 first: a version 1 body never opens
// with `[Key::`, and a version 2 body never opens with ` | Key::`.
//
// The real logs hold eight shapes of line from before 0.6.9, and all are
// version 1 bodies readV1 takes as they come: a checkbox before the marker
// (Dec 2025, MARKER_REGEX), no ID and no Type (to Feb 2026), an ID but no Type
// (to Mar 2026), Type from May 2026, and Rest lines with and without Type.
// tests/logConvert.test.ts holds one made-up line of each.
const FIELD_READERS: ((line: string, from: number) => FieldRead | null)[] = [readV2, readV1];

/** The Task value as a link (`[[path|name]]`, `[[path]]`) or a bare name. */
function readTask(field: LogField): LogTaskRef {
  const raw = field.value;
  const span = { raw, start: field.start, end: field.end };
  if (raw.startsWith("[[") && raw.endsWith("]]") && raw.length >= 4) {
    const inner = raw.slice(2, -2);
    const bar = inner.indexOf("|");
    if (bar === -1) return { ...span, path: inner, name: inner };
    return { ...span, path: inner.slice(0, bar), name: inner.slice(bar + 1) };
  }
  return { ...span, name: raw };
}

/**
 * The line with its Task field replaced by `value`, every other byte kept —
 * the same format the line was in. Unchanged when the line has no Task field.
 */
export function replaceTaskValue(line: string, parsed: ParsedLogLine, value: string): string {
  if (!parsed.task) return line;
  return line.slice(0, parsed.task.start) + value + line.slice(parsed.task.end);
}

/** The date a line's Start falls on, YYYY-MM-DD in English digits, or null. */
export function logStartDate(parsed: ParsedLogLine): string | null {
  const start = asciiDigits((parsed.values.get("Start") ?? "").trim());
  return /^\d{4}-\d{2}-\d{2}(?=\s|$)/.exec(start)?.[0] ?? null;
}

/** A focus line's 🆔 (its ID field), or null. */
export function logTaskId(parsed: ParsedLogLine): string | null {
  return parsed.kind === "focus" ? (parsed.values.get("ID") ?? null) : null;
}

/** A whole-number field (Total, Scheduled, Overtime), or null. */
export function logSeconds(parsed: ParsedLogLine, key: string): number | null {
  const digits = /^\d+/.exec(parsed.values.get(key) ?? "");
  return digits ? parseInt(digits[0], 10) : null;
}

/**
 * A signed whole-number field, or null when it is not exactly one: Offset and
 * OffsetChange (0.7.0) are negative west of UTC, and logSeconds, which reads
 * the digits a value starts with, reads `-240` as nothing.
 */
export function logInteger(parsed: ParsedLogLine, key: string): number | null {
  const value = parsed.values.get(key) ?? "";
  return /^-?\d+$/.test(value) ? parseInt(value, 10) || 0 : null;
}

/**
 * A line's tail (0.7.0) as read, the absence rules applied: one reading for
 * the read API, Check log and Export, so they cannot take one line three ways.
 * Values are as written, numbers when they are exactly a whole number — never
 * one worked out from the line's other fields.
 */
export interface LogTail {
  /** The Session field as written. */
  sessionId: string;
  /** As written (STARTED_BY, ENDED_BY); null when the field is missing. */
  startedBy: string | null;
  endedBy: string | null;
  /** Seconds; null when missing or not a whole number. */
  planned: number | null;
  /** Null when missing too: the session moved no long-break count. */
  cycle: number | null;
  /** Minutes east of UTC at Start; null when missing or not a whole number. */
  offset: number | null;
  /** Minutes east of UTC at End: Offset + OffsetChange, a missing OffsetChange
   *  being 0. Null when either cannot be read. */
  endOffset: number | null;
  /** Seconds — about how long the computer slept — and seconds a planned end
   *  left out. A missing field is 0; one that is not a whole number, null. */
  slept: number | null;
  dropped: number | null;
  /** As written; null when the field is missing. */
  device: string | null;
}

/** A field that is exactly a whole number not below 0, or null. */
function logCount(parsed: ParsedLogLine, key: string): number | null {
  const value = logInteger(parsed, key);
  return value !== null && value >= 0 ? value : null;
}

/**
 * The tail of `parsed`, or null on a line with no Session: an older line, on
 * which every tail field is unknown. On a line with Session, a missing Slept,
 * Dropped or OffsetChange is 0 (LOG_TAIL_KEYS).
 */
export function readLogTail(parsed: ParsedLogLine): LogTail | null {
  const values = parsed.values;
  const sessionId = values.get("Session");
  if (sessionId === undefined) return null;
  const zeroWhenMissing = (key: string) => (values.has(key) ? logCount(parsed, key) : 0);
  const offset = logInteger(parsed, "Offset");
  const change = values.has("OffsetChange") ? logInteger(parsed, "OffsetChange") : 0;
  return {
    sessionId,
    startedBy: values.get("StartedBy") ?? null,
    endedBy: values.get("EndedBy") ?? null,
    planned: logCount(parsed, "Planned"),
    cycle: logCount(parsed, "Cycle"),
    offset,
    endOffset: offset === null || change === null ? null : offset + change,
    slept: zeroWhenMissing("Slept"),
    dropped: zeroWhenMissing("Dropped"),
    device: values.get("Device") ?? null,
  };
}

/**
 * Sum Total across the focus lines of a log file, either format. Skipped
 * sessions (Status cancelled) are forfeited — they don't count toward the
 * daily goal (classic pomodoro: an interrupted session doesn't count; Stop
 * logs `finished` and still counts, Skip is the discard gesture). Only an
 * explicit `cancelled` is excluded, so hand-edited lines without a Status
 * still count. Read from the line's own fields, so a task name holding
 * "Total:: 7" or "Status:: cancelled" changes nothing (F35). The read API's
 * focusSeconds is this too, so a template counts a day as the meter does.
 */
export function parseFocusTotalSeconds(content: string): number {
  let total = 0;
  // Past the file's properties (logFrontmatter.ts): a value there that looks
  // like a session line is not one.
  for (const line of content.split(/\r?\n/).slice(frontmatterRowCount(content))) {
    const parsed = parseLogLine(line);
    if (!parsed || parsed.kind !== "focus") continue;
    if (parsed.values.get("Status") === "cancelled") continue;
    total += logSeconds(parsed, "Total") ?? 0;
  }
  return total;
}
