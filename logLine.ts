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
 * No `obsidian` import: the date helpers take the moment they are given.
 */
import { NO_TASK_LABEL } from "./constants";
import { frontmatterRowCount } from "./logFrontmatter";
import type { MomentLike } from "./momentTypes";

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

/** Whole seconds since the epoch: what the written times show. */
const wholeSeconds = (m: MomentLike): number => Math.floor(m.valueOf() / 1000);

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

/** Format a completed session as one line of the daily log (version 2). */
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
