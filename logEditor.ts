/**
 * Writing the daily log without typing a line (0.6.9, C6): "Add a session"
 * and "Fix a logged session". Until then only a running timer could write a
 * line, so a session done on paper, a forgotten timer or the wrong task meant
 * hand-editing the inline format — and the real logs held six hand-edited
 * lines whose Total no longer matched their own times.
 *
 * Pure: no obsidian, the moments are the caller's. Every line is built by
 * logLine.ts's formatter and builder, so it is valid by construction; this
 * module decides what goes into it, where it goes in the file, and that a
 * line edited elsewhere meanwhile is never overwritten.
 */
import { MIN_SESSION_SECONDS, NO_TASK_LABEL } from "./constants";
import {
  LOG_DATE_FORMAT,
  asciiDigits,
  formatLogLine,
  formatV2Line,
  logSeconds,
  logTaskId,
  logicalDate,
  parseLogLine,
  readLogPauses,
  readLogTime,
  repeatedReading,
  stamp,
  type LogLineKind,
  type ParsedLogLine,
  type SessionLog,
} from "./logLine";
import type { MomentLike } from "./momentTypes";
import { frontmatterRowCount } from "./logFrontmatter";
import { describeDuration } from "./sessionGaps";

export type SessionKind = "focus" | "short-break" | "long-break";
export type SessionStatus = "finished" | "cancelled";

export const SESSION_KIND_OPTIONS: readonly { value: SessionKind; label: string }[] = [
  { value: "focus", label: "Focus" },
  { value: "short-break", label: "Short break" },
  { value: "long-break", label: "Long break" },
];

// "cancelled" is what Skip writes, so that is the word the user knows it by.
export const SESSION_STATUS_OPTIONS: readonly { value: SessionStatus; label: string }[] = [
  { value: "finished", label: "Finished" },
  { value: "cancelled", label: "Skipped" },
];

/** A session's task as its line names it. No path means unlinked (F36). */
export interface SessionTask {
  name: string;
  path?: string;
  id?: string;
}

/** What the session dialog edits, as typed: the text boxes stay strings. */
export interface SessionForm {
  kind: SessionKind;
  /** null: no task. */
  task: SessionTask | null;
  /** YYYY-MM-DD, the calendar date the session started on. */
  date: string;
  /** HH:mm, 24-hour. */
  time: string;
  /** Active minutes: the time spent, pauses left out. */
  minutes: string;
  status: SessionStatus;
}

export type ToMoment = (ms: number) => MomentLike;

/** The longest session the dialog takes, in minutes: a day. */
export const MAX_SESSION_MINUTES = 24 * 60;
const MIN_SESSION_MINUTES = Math.ceil(MIN_SESSION_SECONDS / 60);

export const FORM_DATE_MESSAGE = "Enter the date as YYYY-MM-DD, e.g. 2026-10-02.";
export const FORM_TIME_MESSAGE = "Enter the start time as HH:MM on a 24-hour clock, e.g. 09:30.";
export const FORM_MINUTES_MESSAGE = `Enter the active minutes as a whole number from ${String(MIN_SESSION_MINUTES)} to ${String(MAX_SESSION_MINUTES)}.`;
export const FORM_FUTURE_MESSAGE = "That session would end in the future.";
export const FORM_OTHER_DAY_MESSAGE =
  "That moves the session to another day's log. Delete it here and add it on that day instead.";
export const FORM_UNSAFE_MESSAGE =
  "This line can't be rewritten without losing part of it. Edit it by hand instead.";

/** The task as the dialog's button names it. A line logged without a task
 *  says "No Task", and shows so: whether it is linked is its path (F36). */
export function sessionTaskLabel(task: SessionTask | null): string {
  return task === null ? "No task" : task.name;
}

function sameTask(a: SessionTask | null, b: SessionTask | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.path === b.path && a.id === b.id;
}

/** A form's start, as epoch seconds read the way a log line's are; null when
 *  the date or the time is not one. */
function formStart(form: Pick<SessionForm, "date" | "time">): number | null {
  const date = asciiDigits(form.date.trim());
  const time = /^(\d{1,2}):(\d{2})$/.exec(asciiDigits(form.time.trim()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) return null;
  return readLogTime(`${date} ${time[1].padStart(2, "0")}:${time[2]}:00`);
}

function formMinutes(form: Pick<SessionForm, "minutes">): number | null {
  const text = asciiDigits(form.minutes.trim());
  if (!/^\d+$/.test(text)) return null;
  const minutes = parseInt(text, 10);
  return minutes >= MIN_SESSION_MINUTES && minutes <= MAX_SESSION_MINUTES ? minutes : null;
}

/**
 * The first problem with the date, time or length, or null. `checkMinutes`
 * false leaves the length alone: a fix that does not touch it keeps a logged
 * length the dialog could not take (under 30 s shows as 0, over a day as
 * more than it allows).
 */
function timingProblem(form: SessionForm, checkMinutes = true): string | null {
  const date = asciiDigits(form.date.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || readLogTime(`${date} 00:00:00`) === null) {
    return FORM_DATE_MESSAGE;
  }
  if (formStart(form) === null) return FORM_TIME_MESSAGE;
  if (checkMinutes && formMinutes(form) === null) return FORM_MINUTES_MESSAGE;
  return null;
}

/**
 * The dialog's starting values for a new session: one focus of the usual
 * length that has just ended. The start is cut to the minute, so the end it
 * implies is never in the future.
 */
export function newSessionForm(nowMs: number, minutes: number, toMoment: ToMoment): SessionForm {
  const length = Math.min(
    MAX_SESSION_MINUTES,
    Math.max(MIN_SESSION_MINUTES, Math.floor(Number.isFinite(minutes) ? minutes : 25))
  );
  const start = toMoment(nowMs).subtract(length, "minutes");
  return {
    kind: "focus",
    task: null,
    date: stamp(start, LOG_DATE_FORMAT),
    time: stamp(start, "HH:mm"),
    minutes: String(length),
    status: "finished",
  };
}

export type SessionFormResult = { ok: true; session: SessionLog } | { ok: false; message: string };

/**
 * A new session from the dialog. Scheduled is the active length and Overtime
 * 0: a session typed in afterwards had no plan to run past, and no pauses are
 * kept, so the line's Total is exactly the minutes given.
 */
export function sessionFromForm(
  form: SessionForm,
  context: { toMoment: ToMoment; nowMs: number }
): SessionFormResult {
  const problem = timingProblem(form);
  if (problem !== null) return { ok: false, message: problem };
  const start = (formStart(form) ?? 0) * 1000;
  const minutes = formMinutes(form) ?? MIN_SESSION_MINUTES;
  const end = start + minutes * 60_000;
  if (end > context.nowMs) return { ok: false, message: FORM_FUTURE_MESSAGE };
  return {
    ok: true,
    session: {
      mode: form.kind === "focus" ? "focus" : "break",
      taskName: form.task?.name ?? NO_TASK_LABEL,
      taskPath: form.task?.path,
      taskId: form.task?.id,
      scheduledDurationMinutes: minutes,
      startTime: context.toMoment(start),
      endTime: context.toMoment(end),
      pauses: [],
      status: form.kind === "focus" ? form.status : "finished",
      breakType: form.kind === "long-break" ? "long" : form.kind === "short-break" ? "short" : null,
      overtimeSeconds: 0,
    },
  };
}

/** One session line of a log file. */
export interface LoggedLine {
  /** 0-based, counting lines the way the file is split for writing. */
  index: number;
  /** The line as written, without its line break. */
  text: string;
  parsed: ParsedLogLine;
  /** Start as epoch seconds, in the pass of a repeated hour its Total fits
   *  (lineTimes); null when it cannot be read. */
  start: number | null;
}

/** A line's written times as instants, in epoch seconds. */
interface LineTimes {
  start: number;
  /** Null when End cannot be read. */
  end: number | null;
  /** Null when Pauses cannot be read; [] when the line has none. */
  pauses: [number, number][] | null;
}

/**
 * A line's Start, End and pauses as instants. A log line carries no UTC
 * offset, so a time in the hour a fall-back night repeats names two instants,
 * and readLogTime takes the first (repeatedReading). Read that way, a session
 * the timer wrote in the second pass — Start 01:50 in Chicago's repeated hour,
 * End 02:15 just after it — spans 85 minutes, not 25, and a fix that moved its
 * start to 02:00 moved its End 70 minutes instead of 10 (F2).
 *
 * So the line is read as the timer wrote it: Start, each pause's start and
 * end, and End, in that order and never going back. Every second-pass instant
 * is later than every first-pass one, so such a reading takes the first pass
 * up to some time and the later pass from there on. The reading taken is one
 * whose span less its pauses agrees with the line's Total — to the second,
 * plus a second per pause, as Check allows — with the least time paused, and
 * nearest the first pass when that still leaves several. A pause's length
 * counts in that reading too: a pause from 01:55 before the clocks go back to
 * 01:05 after it is ten minutes, not fifty back, and one from 00:55 to 01:05
 * in the second pass is seventy minutes when Total says so.
 *
 * When no reading agrees, Start and End are read in the first pass, and each
 * pause time in the pass that puts it inside that span. A line with no Total
 * has nothing to agree with, and is read in the first pass.
 */
function lineTimes(parsed: ParsedLogLine): LineTimes | null {
  const start = readLogTime(parsed.values.get("Start") ?? "");
  if (start === null) return null;
  const end = readLogTime(parsed.values.get("End") ?? "");
  const pauses = readLogPauses(parsed.values.get("Pauses") ?? "[]");
  const total = logSeconds(parsed, "Total");
  if (end === null || pauses === null || total === null) return { start, end, pauses };

  // Every time the line writes, in the order the timer wrote them.
  const written = [start, ...pauses.flat(), end];
  const later = written.map(repeatedReading);
  let best: { reading: number[]; paused: number } | null = null;
  // The times from `k` on in their later pass; k = written.length is all first.
  for (let k = written.length; k >= 0; k--) {
    const reading = written.map((t, i) => (i >= k ? t + later[i] : t));
    if (reading.some((t, i) => i > 0 && t < reading[i - 1])) continue;
    let paused = 0;
    for (let i = 1; i < reading.length - 1; i += 2) paused += reading[i + 1] - reading[i];
    const span = reading[reading.length - 1] - reading[0];
    if (Math.abs(span - paused - total) > 1 + pauses.length) continue;
    // Two readings can agree: the clocks went back before the session, or
    // during a pause an hour longer than its clock times say. The shorter
    // pause wins; the clocks went back in a pause only when nothing else fits.
    if (best === null || paused < best.paused) best = { reading, paused };
  }
  if (best !== null) {
    const reading = best.reading;
    return {
      start: reading[0],
      end: reading[reading.length - 1],
      pauses: pauses.map((_, i): [number, number] => [reading[2 * i + 1], reading[2 * i + 2]]),
    };
  }

  const within = (t: number) => {
    const shifted = t + repeatedReading(t);
    return t < start && shifted > t && shifted <= end ? shifted : t;
  };
  return { start, end, pauses: pauses.map(([a, b]) => [within(a), within(b)]) };
}

/** The session lines of a log file, in file order — none among its properties. */
export function loggedLines(content: string): LoggedLine[] {
  const lines: LoggedLine[] = [];
  const body = frontmatterRowCount(content);
  content.split("\n").forEach((raw, index) => {
    if (index < body) return;
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const parsed = parseLogLine(text);
    if (!parsed) return;
    lines.push({ index, text, parsed, start: lineTimes(parsed)?.start ?? null });
  });
  return lines;
}

const BOM = "\uFEFF";

/** `content` with `line` added at the end, in the file's own line ending, ending in one. */
function appendLine(content: string, line: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (content === "" || content.endsWith("\n")) return content + line + eol;
  return content + eol + line + eol;
}

/**
 * `content` with a session line put where its start belongs: after the last
 * session line that started no later, or before the first when it is the
 * earliest. Every other line keeps its place and its bytes, and a CRLF file
 * stays CRLF. A file with no readable session line — or a line without a
 * readable start — gets it at the end, as the timer writes. Never above or
 * among the file's properties: loggedLines finds no session there.
 */
export function insertSessionLine(content: string, line: string): string {
  const parsed = parseLogLine(line);
  const start = parsed ? readLogTime(parsed.values.get("Start") ?? "") : null;
  const timed = loggedLines(content).filter((l) => l.start !== null);
  if (start === null || timed.length === 0) return appendLine(content, line);
  const earlier = timed.filter((l) => (l.start ?? 0) <= start);
  const rows = content.split("\n");
  const at = earlier.length > 0 ? earlier[earlier.length - 1].index + 1 : timed[0].index;
  // Past the last row only when the file does not end in a line break.
  if (at >= rows.length) return appendLine(content, line);
  const row = content.includes("\r\n") ? `${line}\r` : line;
  // A byte order mark belongs to the file, not to its first line: left on a
  // line that is no longer first, it stops that line being a list item.
  if (at === 0 && rows[0].startsWith(BOM)) {
    rows[0] = rows[0].slice(BOM.length);
    rows.unshift(BOM + row);
  } else {
    rows.splice(at, 0, row);
  }
  return rows.join("\n");
}

/**
 * `content` with one session line replaced — or removed, for `null` — or
 * null when that line is no longer there as it was read: edited, or moved
 * among copies of itself. The line is found at its index, or, when lines
 * before it came or went, as the one line with its exact text. Nothing is
 * ever written over a line the user did not see.
 */
export function replaceSessionLine(
  content: string,
  target: { index: number; text: string },
  replacement: string | null
): string | null {
  const rows = content.split("\n");
  const textOf = (row: string) => (row.endsWith("\r") ? row.slice(0, -1) : row);
  // A session line is never one of the file's properties, however it reads.
  const body = frontmatterRowCount(content);
  let at = -1;
  if (
    target.index >= body &&
    target.index < rows.length &&
    textOf(rows[target.index]) === target.text
  ) {
    at = target.index;
  } else {
    const hits: number[] = [];
    rows.forEach((row, index) => {
      if (index >= body && textOf(row) === target.text) hits.push(index);
    });
    if (hits.length === 1) at = hits[0];
  }
  if (at === -1) return null;
  if (replacement === null) rows.splice(at, 1);
  else rows[at] = rows[at].endsWith("\r") ? `${replacement}\r` : replacement;
  return rows.join("\n");
}

/** The task a logged focus line names — as written, linked or not — or null for a break. */
function lineTask(parsed: ParsedLogLine): SessionTask | null {
  if (parsed.kind !== "focus" || !parsed.task) return null;
  return { name: parsed.task.name, path: parsed.task.path, id: logTaskId(parsed) ?? undefined };
}

function lineKind(parsed: ParsedLogLine): SessionKind {
  if (parsed.kind === "focus") return "focus";
  return parsed.values.get("Type") === "long-break" ? "long-break" : "short-break";
}

/** A logged line's active seconds: its Total, or its span less its pauses. */
function lineSeconds(line: LoggedLine): number | null {
  const total = logSeconds(line.parsed, "Total");
  if (total !== null) return total;
  const times = lineTimes(line.parsed);
  if (times === null || times.end === null) return null;
  const pauses = times.pauses ?? [];
  return Math.max(0, times.end - times.start - pauses.reduce((sum, [a, b]) => sum + (b - a), 0));
}

/**
 * The form's start as an instant (epoch seconds), for a line whose start is
 * `lineStart` and whose Start text reads `written` in the first pass. The
 * dialog shows a line's start as its clock time, so read in the first pass, a
 * start in the second named an instant an hour before the line's own — and
 * every move was measured from there (F2). So when the line's start is in the
 * hour a fall-back night repeats, the form is read in the same pass as the
 * line: the form it opened with reads back as that start, and a move within
 * the repeated hour stays in its pass, however far it goes. Otherwise a time
 * in the repeated hour is read in the pass nearer the line's start, the first
 * on a tie: a start just after the hour moved back into it lands in its
 * second pass.
 */
function formStartNear(
  form: Pick<SessionForm, "date" | "time">,
  lineStart: number,
  written: number | null
): number | null {
  const first = formStart(form);
  if (first === null) return null;
  const later = first + repeatedReading(first);
  if (written !== null && repeatedReading(written) > 0) {
    return lineStart > written ? later : first;
  }
  return Math.abs(later - lineStart) < Math.abs(first - lineStart) ? later : first;
}

/**
 * The dialog's values for a logged line, or null when its start cannot be
 * read (that line is for a text editor). The minutes are rounded; left as
 * they are, the line keeps its exact Total.
 */
export function formFromLine(line: LoggedLine, toMoment: ToMoment): SessionForm | null {
  if (line.start === null) return null;
  const start = toMoment(line.start * 1000);
  const seconds = lineSeconds(line) ?? 0;
  return {
    kind: lineKind(line.parsed),
    task: lineTask(line.parsed),
    date: stamp(start, LOG_DATE_FORMAT),
    time: stamp(start, "HH:mm"),
    minutes: String(Math.round(seconds / 60)),
    status: line.parsed.values.get("Status") === "cancelled" ? "cancelled" : "finished",
  };
}

/** One line for the list of a day's sessions: "09:00 · Focus · 25m · Write docs". */
export function describeLoggedLine(line: LoggedLine): string {
  const start = asciiDigits(line.parsed.values.get("Start") ?? "");
  const time = /\d{2}:\d{2}/.exec(start.slice(10))?.[0] ?? "?";
  const kind = SESSION_KIND_OPTIONS.find((o) => o.value === lineKind(line.parsed));
  // A rest line written before Type existed does not say which break it was.
  const label =
    line.parsed.kind === "rest" && !line.parsed.values.has("Type") ? "Break" : (kind?.label ?? "");
  const parts = [time, label];
  const seconds = lineSeconds(line);
  if (seconds !== null) parts.push(describeDuration(seconds));
  if (line.parsed.values.get("Status") === "cancelled") parts.push("skipped");
  const task = lineTask(line.parsed);
  if (task !== null) parts.push(task.name);
  return parts.join(" · ");
}

// Every field the log has ever written. A field the line carries beyond
// these — one a user added by hand — is kept as it is, at the end.
const LOG_FIELD_KEYS = new Set([
  "Task",
  "ID",
  "Start",
  "End",
  "Scheduled",
  "Pauses",
  "Total",
  "Status",
  "Type",
  "Overtime",
]);

export type EditResult =
  | { kind: "ok"; text: string }
  | { kind: "unchanged" }
  | { kind: "error"; message: string };

const sameForm = (a: SessionForm, b: SessionForm): boolean =>
  a.kind === b.kind &&
  sameTask(a.task, b.task) &&
  a.date.trim() === b.date.trim() &&
  a.time.trim() === b.time.trim() &&
  a.minutes.trim() === b.minutes.trim() &&
  a.status === b.status;

/**
 * A logged line as the dialog edited it. What the user did not change keeps
 * its exact text:
 *
 * - Only the task, the status or the kind changed: Start, End, Pauses,
 *   Scheduled, Total and Overtime are copied as written — a Total someone
 *   corrected by hand stays what counts.
 * - The start moved: the whole session moves with it, pauses included, by
 *   the same amount; its length is untouched.
 * - The minutes changed: the session is that long from its start, with no
 *   pauses (they cannot be placed in a length the user typed), its Overtime
 *   counted past the line's own Scheduled. Only the text in the box counts:
 *   left as it was, the length is not checked and Total stays exact — a line
 *   of 20 s shows "0", which the box would refuse if it were typed.
 *
 * Nothing is invented: a field the line does not have stays away unless what
 * it describes changed, and Overtime is never added. A field the log never
 * writes stays, at the end, and so does text after the fields. A move to
 * another day's file is refused — this rewrites one line in one file — and so
 * is any line that would not read back the same. A start that stays on the
 * day it was on is not a move, even in a file named by another rule: files
 * from before 0.6.9 are named by calendar date, and "Day starts at" can change
 * after a line is written.
 */
export function editedLine(
  line: LoggedLine,
  initial: SessionForm,
  form: SessionForm,
  context: { toMoment: ToMoment; nowMs: number; dayStartHour: number; fileDate: string }
): EditResult {
  if (sameForm(initial, form)) return { kind: "unchanged" };
  const minutesTyped = form.minutes.trim() !== initial.minutes.trim();
  const problem = timingProblem(form, minutesTyped);
  if (problem !== null) return { kind: "error", message: problem };
  const original = line.parsed.values;

  const times = lineTimes(line.parsed);
  const start = times?.start ?? line.start ?? 0;
  // Both read against the line's own start, so a start in a repeated hour
  // moves by what the form says, not by an hour more (formStartNear).
  const written = readLogTime(original.get("Start") ?? "");
  const delta =
    (formStartNear(form, start, written) ?? 0) - (formStartNear(initial, start, written) ?? 0);
  const minutes = formMinutes(form) ?? MIN_SESSION_MINUTES;
  // "026" for "26" is not a new length.
  const minutesChanged = minutesTyped && minutes !== formMinutes(initial);
  const timingChanged = delta !== 0 || minutesChanged;
  const kindChanged = form.kind !== initial.kind;
  const taskChanged = !sameTask(form.task, initial.task);

  let end = times?.end ?? null;
  let pauses = times?.pauses ?? null;
  if (minutesChanged) {
    end = start + delta + minutes * 60;
    pauses = [];
  } else if (end === null || pauses === null) {
    // Moving a session needs its end and its pauses; a line that has them in
    // no readable form keeps its timing as written, or is not touched.
    if (timingChanged) return { kind: "error", message: FORM_UNSAFE_MESSAGE };
    end = start;
    pauses = [];
  } else {
    end += delta;
    pauses = pauses.map(([a, b]) => [a + delta, b + delta]);
  }
  const newStart = start + delta;
  if (timingChanged) {
    if (end * 1000 > context.nowMs) return { kind: "error", message: FORM_FUTURE_MESSAGE };
    const dayOf = (seconds: number) =>
      logicalDate(context.toMoment(seconds * 1000), context.dayStartHour);
    const day = dayOf(newStart);
    if (day !== context.fileDate && day !== dayOf(start)) {
      return { kind: "error", message: FORM_OTHER_DAY_MESSAGE };
    }
  }

  const scheduled = logSeconds(line.parsed, "Scheduled") ?? minutes * 60;
  const task = taskChanged ? form.task : initial.task;
  const at = (seconds: number) => context.toMoment(seconds * 1000);
  const session: SessionLog = {
    mode: form.kind === "focus" ? "focus" : "break",
    taskName: task?.name ?? NO_TASK_LABEL,
    taskPath: task?.path,
    taskId: task?.id,
    scheduledDurationMinutes: scheduled / 60,
    startTime: at(newStart),
    endTime: at(end),
    pauses: pauses.map(([a, b]) => ({ start: at(a), end: at(b) })),
    status: form.status,
    breakType: form.kind === "long-break" ? "long" : form.kind === "short-break" ? "short" : null,
    overtimeSeconds: Math.max(0, minutes * 60 - scheduled),
  };
  // The writer's own line gives the field order and every NEW value; a field
  // nothing changed keeps the line's own text, and stays away if the line had
  // none. Overtime is never added to a line written before it existed.
  const template = parseLogLine(formatLogLine(session));
  if (!template) return { kind: "error", message: FORM_UNSAFE_MESSAGE };
  const statusChanged = form.status !== initial.status;
  const changed: Record<string, boolean> = {
    Task: taskChanged || kindChanged,
    ID: taskChanged || kindChanged,
    Start: timingChanged,
    End: timingChanged,
    Pauses: timingChanged,
    Scheduled: false,
    Total: minutesChanged,
    Status: statusChanged || kindChanged,
    Type: kindChanged,
    Overtime: minutesChanged && original.has("Overtime"),
  };

  const fields: [string, string][] = [];
  for (const field of template.fields) {
    const value = changed[field.key] ? field.value : original.get(field.key);
    if (value !== undefined) fields.push([field.key, value]);
  }
  for (const field of line.parsed.fields) {
    if (!LOG_FIELD_KEYS.has(field.key)) fields.push([field.key, field.value]);
  }

  // The checkbox the oldest lines carried goes, as in the converter: it made
  // a Rest line an open task to the Tasks plugin.
  const prefix = line.parsed.prefix.replace(/\[.\] $/u, "");
  const kind: LogLineKind = form.kind === "focus" ? "focus" : "rest";
  const rest = line.parsed.rest;
  const text = formatV2Line(prefix, kind, fields) + (rest === "" ? "" : ` ${rest}`);

  const back = parseLogLine(text);
  const exact =
    back !== null &&
    back.format === "v2" &&
    back.kind === kind &&
    back.rest === rest &&
    back.fields.length === fields.length &&
    back.fields.every((f, i) => f.key === fields[i][0] && f.value === fields[i][1]);
  if (!exact) return { kind: "error", message: FORM_UNSAFE_MESSAGE };
  return text === line.text ? { kind: "unchanged" } : { kind: "ok", text };
}
