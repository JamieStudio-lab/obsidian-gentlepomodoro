/**
 * Export sessions (0.7.0): the log's sessions as a CSV or JSON Lines file,
 * for a spreadsheet or a script. The daily Markdown log stays the record —
 * this only reads it, through the read API (logApi.ts), so the file holds
 * exactly what a template reads: both line formats, the tail as readLogTail
 * takes it, nothing worked out that the line does not say.
 *
 * The pure part: the dialog's choices, the folder and date checks, the
 * records, the two file formats, the file name and the Notices. logTools.ts
 * asks, reads, writes the file with Vault.create and reads it back.
 */
import { TFile, TFolder, normalizePath } from "obsidian";
import {
  LOG_API_MAX_DAYS,
  calendarDate,
  dateAfter,
  dateText,
  daysBetween,
  type DayLog,
  type LogApiPause,
  type LogApiTask,
} from "./logApi";
import type { FolderLookup } from "./logFolder";
import { LOG_FILE_SUFFIX, asciiDigits, readLogTime } from "./logLine";

/* ===== The dialog's choices ===== */

/** The Format row's choices: the setting's value, the label, the extension. */
export const EXPORT_FORMATS = [
  { value: "csv", label: "CSV (for spreadsheets)" },
  { value: "jsonl", label: "JSON Lines (for scripts)" },
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number]["value"];

/** The Days row's choices. "custom" is what typing a date switches it to. */
export const EXPORT_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "this-year", label: "This year" },
  { value: "all", label: "Everything" },
  { value: "custom", label: "Choose dates" },
] as const;
export type ExportRange = (typeof EXPORT_RANGES)[number]["value"];

/** The Sessions row's choices. */
export const EXPORT_KINDS = [
  { value: "all", label: "Focus and breaks" },
  { value: "focus", label: "Focus only" },
] as const;
export type ExportKinds = (typeof EXPORT_KINDS)[number]["value"];

/** The folder the dialog offers until one is used (SPEC choice 8: typed, never picked). */
export const EXPORT_DEFAULT_FOLDER = "Pomodoro exports";

/** What the dialog hands back. Dates and folder as typed; checkExportForm says whether they do. */
export interface ExportForm {
  range: ExportRange;
  from: string;
  to: string;
  kinds: ExportKinds;
  format: ExportFormat;
  folder: string;
}

/** A stored format if the row offers it, else CSV: an id list, never `in`. */
export function resolveExportFormat(value: unknown): ExportFormat {
  return EXPORT_FORMATS.find((choice) => choice.value === value)?.value ?? "csv";
}

/** The folder the dialog opens with: the one last exported to, else the default. */
export function exportFolderSetting(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : EXPORT_DEFAULT_FOLDER;
}

/* ===== Dates ===== */

/** The first and last day that have a log file. */
export interface LogDateSpan {
  earliest: string;
  latest: string;
}

/**
 * The days the daily log files in `paths` are for, from their names — a name
 * in another script's digits as the day it names (asciiDigits). Null when
 * none is one. Every file the read API can read for a day is among these
 * (dailyLogFiles lists the folder, subfolders included), so no day outside
 * the span has a session.
 */
export function logFileDates(paths: readonly string[]): LogDateSpan | null {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name.endsWith(LOG_FILE_SUFFIX)) continue;
    const date = asciiDigits(name.slice(0, -LOG_FILE_SUFFIX.length));
    if (calendarDate(date) === null) continue;
    if (earliest === null || date < earliest) earliest = date;
    if (latest === null || date > latest) latest = date;
  }
  return earliest === null || latest === null ? null : { earliest, latest };
}

/** `date` moved by `days` calendar days. */
function shifted(date: string, days: number): string {
  const day = calendarDate(date);
  if (day === null) throw new Error(`Not a date: ${date}`);
  return dateText(dateAfter(day, days));
}

/**
 * The From and To a Days choice stands for, `today` the plugin's today
 * (logicalDate, "Day starts at" applied). Ranges that run to now end today,
 * except Everything, which ends at the latest log file when one is dated
 * later — a device in a time zone ahead writes tomorrow's file before today
 * is over here. Null for Choose dates (the boxes keep what they hold), and
 * for Everything when there is no log file yet.
 */
export function exportRangeDates(
  range: ExportRange,
  today: string,
  span: LogDateSpan | null
): { from: string; to: string } | null {
  const month = today.slice(0, 7);
  switch (range) {
    case "7":
      return { from: shifted(today, -6), to: today };
    case "30":
      return { from: shifted(today, -29), to: today };
    case "this-month":
      return { from: `${month}-01`, to: today };
    case "last-month": {
      // The day before this month's first is last month's last.
      const to = shifted(`${month}-01`, -1);
      return { from: `${to.slice(0, 7)}-01`, to };
    }
    case "this-year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "all":
      return span === null
        ? null
        : { from: span.earliest, to: span.latest > today ? span.latest : today };
    case "custom":
      return null;
  }
}

/**
 * The days from `from` to `to`, both included, in runs the read API takes in
 * one call (LOG_API_MAX_DAYS) — the export itself has no limit.
 */
export function exportChunks(from: string, to: string): { from: string; to: string }[] {
  const first = calendarDate(from);
  const last = calendarDate(to);
  if (first === null || last === null) return [];
  const chunks: { from: string; to: string }[] = [];
  const span = daysBetween(first, last);
  for (let start = 0; start <= span; start += LOG_API_MAX_DAYS) {
    const end = Math.min(start + LOG_API_MAX_DAYS - 1, span);
    chunks.push({ from: dateText(dateAfter(first, start)), to: dateText(dateAfter(first, end)) });
  }
  return chunks;
}

export const NO_LOG_FILES_YET = "There are no log files yet.";

/** Why From and To cannot be exported, or null. The read API's rule: 2026-02-30 is no date. */
export function checkExportDates(from: string, to: string): string | null {
  const first = from.trim();
  const last = to.trim();
  if (calendarDate(first) === null)
    return "From must be a date written YYYY-MM-DD, like 2026-10-02.";
  if (calendarDate(last) === null) return "To must be a date written YYYY-MM-DD, like 2026-10-02.";
  if (first > last) return "From must be on or before To.";
  return null;
}

/* ===== The folder ===== */

export const EXPORT_FOLDER_TOP_LEVEL = "Pick a folder inside the vault.";
export const EXPORT_FOLDER_HIDDEN = "Hidden folders aren't synced or listed. Pick another folder.";
export const EXPORT_FOLDER_CHARACTERS =
  'Obsidian can\'t save a file in a folder whose name has ":" in it, nor on Windows or Android one with * ? " < > |. Pick another folder.';
export const EXPORT_FOLDER_NEW_NAME =
  "Obsidian on Windows can't make a folder whose name ends with a dot or a space, or is one Windows keeps (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9). Pick another name.";

/**
 * What Obsidian's checkPath refuses on SOME device (app.js, 1.13.7, jD),
 * refused on every device: a vault syncs, and what is made on a Mac is made
 * again on each device it syncs to. In ANY part of a path — Vault.create
 * checks every folder a new file goes into, existing or not: ":" everywhere,
 * `* " < > | ?` on Windows, `* ? < > "` on Android. ("\" and "/" are
 * already the path's slashes, normalizePath's.)
 */
const FORBIDDEN_CHARACTER = /[:*?"<>|]/u;
/**
 * And in a folder still to be made (createFolder), on Windows: a name ending
 * in "." or " ", and one of the device names Windows keeps, before its last
 * "." (qD). Windows refuses those in any part of a path itself.
 */
const UNCREATABLE_NEW_NAME = /[. ]$|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.[^.]*)?$/iu;

export type ExportFolderCheck = { kind: "ok"; path: string } | { kind: "problem"; message: string };

/**
 * The folder typed in the dialog, as the export writes to it: trimmed and
 * normalizePath'd, each folder on the way that exists in the vault's own
 * spelling — another capitalisation of an existing folder is that folder, as
 * the log folder row treats one (F37) — and the rest as typed, to be created.
 *
 * Refused: the vault's top level (the file would sit among the notes), and a
 * folder with any part starting with "." — the config folder among them —
 * which Obsidian neither syncs nor lists, so the file could not be found from
 * inside it. A path a file is in the way of. And a name Obsidian would
 * refuse the file or a folder to be made (FORBIDDEN_CHARACTER,
 * UNCREATABLE_NEW_NAME): said here, in the dialog, which stays open, rather
 * than as a failed export after it closed. A folder that exists is never made
 * again, so only the characters a file inside it is refused for are judged
 * in its name.
 */
export function checkExportFolder(
  input: string,
  vault: Pick<FolderLookup, "getRoot">,
  configDir = ""
): ExportFolderCheck {
  const value = input.trim();
  const path = value === "" ? "/" : normalizePath(value);
  if (path === "/") return { kind: "problem", message: EXPORT_FOLDER_TOP_LEVEL };
  const names = path.split("/");
  const config = configDir.trim() === "" ? null : normalizePath(configDir);
  if (
    names.some((name) => name.startsWith(".")) ||
    (config !== null && (path === config || path.startsWith(`${config}/`)))
  ) {
    return { kind: "problem", message: EXPORT_FOLDER_HIDDEN };
  }
  if (names.some((name) => FORBIDDEN_CHARACTER.test(name))) {
    return { kind: "problem", message: EXPORT_FOLDER_CHARACTERS };
  }
  const nameOf = (item: { path: string }) => item.path.slice(item.path.lastIndexOf("/") + 1);
  const uncreatable: ExportFolderCheck = { kind: "problem", message: EXPORT_FOLDER_NEW_NAME };
  const spelled: string[] = [];
  let at: TFolder | null = vault.getRoot();
  for (const name of names) {
    if (at === null) {
      if (UNCREATABLE_NEW_NAME.test(name)) return uncreatable;
      spelled.push(name);
      continue;
    }
    const children: TFolder["children"] = at.children;
    const same = children.filter((child) => nameOf(child).toLowerCase() === name.toLowerCase());
    // The exact name first; another capitalisation only where no exact one is.
    const folders = same.filter((child): child is TFolder => child instanceof TFolder);
    const folder = folders.find((child) => nameOf(child) === name) ?? folders[0];
    if (folder !== undefined) {
      spelled.push(nameOf(folder));
      at = folder;
      continue;
    }
    const file = same.find((child) => child instanceof TFile);
    if (file !== undefined) {
      return {
        kind: "problem",
        message: `"${[...spelled, nameOf(file)].join("/")}" is a file. Pick a folder.`,
      };
    }
    if (UNCREATABLE_NEW_NAME.test(name)) return uncreatable;
    spelled.push(name);
    at = null;
  }
  return { kind: "ok", path: spelled.join("/") };
}

/** Why the dialog's values cannot be exported, or null: said on its problem line. */
export function checkExportForm(
  form: ExportForm,
  span: LogDateSpan | null,
  vault: Pick<FolderLookup, "getRoot">,
  configDir = ""
): string | null {
  if (form.range === "all" && span === null) return NO_LOG_FILES_YET;
  const dates = checkExportDates(form.from, form.to);
  if (dates !== null) return dates;
  const folder = checkExportFolder(form.folder, vault, configDir);
  return folder.kind === "problem" ? folder.message : null;
}

/* ===== The records ===== */

/**
 * One session line, as the file holds it: the read API's session as it is —
 * every member, the tail's included — plus the log day, the line's times with
 * its UTC offset (`startIso`, `endIso`) and the day's file. Named member by
 * member, in this order, so the order of a JSON Lines object is fixed and a
 * member the API gains later is not exported by accident.
 */
export interface ExportRecord {
  /** The log day: the file's date, "Day starts at" applied — not Start's calendar date. */
  date: string;
  kind: "focus" | "rest";
  type: string | null;
  start: string | null;
  end: string | null;
  /** Start and End with Offset and endOffset, `2026-10-23T09:00:00-05:00`;
   *  null where the offset is unknown (every line from before 0.7.0). */
  startIso: string | null;
  endIso: string | null;
  task: LogApiTask | null;
  id: string | null;
  scheduled: number | null;
  planned: number | null;
  total: number | null;
  overtime: number | null;
  pauses: LogApiPause[] | null;
  status: string | null;
  sessionId: string | null;
  startedBy: string | null;
  endedBy: string | null;
  cycle: number | null;
  offset: number | null;
  endOffset: number | null;
  slept: number | null;
  dropped: number | null;
  device: string | null;
  /** The day's file (DayLog.path). */
  logFile: string | null;
}

const LOG_TIME_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// The widest offset ISO 8601 readers take: ±18:00. Real zones stay within ±14.
const MAX_OFFSET_MINUTES = 18 * 60;

/** `+05:30` for 330 minutes east of UTC, `-05:00` for -300, `+00:00` for 0. */
function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * A written time with the offset it was written at, as ISO 8601; null when
 * either is unknown, or the time is not one (readLogTime) written 0-9.
 */
function isoTime(text: string | null, offset: number | null): string | null {
  if (text === null || offset === null || Math.abs(offset) > MAX_OFFSET_MINUTES) return null;
  if (!LOG_TIME_TEXT.test(text) || readLogTime(text) === null) return null;
  return `${text.replace(" ", "T")}${offsetText(offset)}`;
}

/** The sessions of `days`, in date and then file order; Focus only leaves the breaks out. */
export function exportRecords(days: readonly DayLog[], kinds: ExportKinds): ExportRecord[] {
  const records: ExportRecord[] = [];
  for (const day of days) {
    for (const s of day.sessions) {
      if (kinds === "focus" && s.kind !== "focus") continue;
      records.push({
        date: day.date,
        kind: s.kind,
        type: s.type,
        start: s.start,
        end: s.end,
        startIso: isoTime(s.start, s.offset),
        endIso: isoTime(s.end, s.endOffset),
        task: s.task === null ? null : { name: s.task.name, path: s.task.path },
        id: s.id,
        scheduled: s.scheduled,
        planned: s.planned,
        total: s.total,
        overtime: s.overtime,
        pauses: s.pauses === null ? null : s.pauses.map((p) => ({ start: p.start, end: p.end })),
        status: s.status,
        sessionId: s.sessionId,
        startedBy: s.startedBy,
        endedBy: s.endedBy,
        cycle: s.cycle,
        offset: s.offset,
        endOffset: s.endOffset,
        slept: s.slept,
        dropped: s.dropped,
        device: s.device,
        logFile: day.path,
      });
    }
  }
  return records;
}

/* ===== The two formats ===== */

/**
 * The CSV file's columns, in order. A contract once shipped: added to at the
 * end, never reordered — a spreadsheet's formulas point at columns.
 */
export const CSV_COLUMNS = [
  "date",
  "kind",
  "type",
  "start",
  "end",
  "startIso",
  "endIso",
  "task",
  "taskPath",
  "id",
  "scheduled",
  "planned",
  "total",
  "overtime",
  "pauseCount",
  "pausedSeconds",
  "status",
  "sessionId",
  "startedBy",
  "endedBy",
  "cycle",
  "offset",
  "endOffset",
  "slept",
  "dropped",
  "device",
  "logFile",
] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];

/** A written time on its own wall clock, as seconds: the same on any device, in any zone. */
function wallSeconds(text: string): number | null {
  const match = LOG_TIME_TEXT.exec(asciiDigits(text.trim()));
  if (!match || readLogTime(text) === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/**
 * The pauses added up, on the wall clock as written — focus lines only, null
 * when the pauses cannot be read. Exact from the line, and so not corrected
 * for a clock change inside a pause: no pause carries its own offset.
 */
function pausedSeconds(pauses: readonly LogApiPause[]): number | null {
  let total = 0;
  for (const pause of pauses) {
    const start = wallSeconds(pause.start);
    const end = wallSeconds(pause.end);
    if (start === null || end === null) return null;
    total += end - start;
  }
  return total;
}

/** A record's cells: the task split into name and path, the pauses into a count and a sum. */
function csvValues(r: ExportRecord): Record<CsvColumn, string | number | null> {
  const focus = r.kind === "focus";
  return {
    date: r.date,
    kind: r.kind,
    type: r.type,
    start: r.start,
    end: r.end,
    startIso: r.startIso,
    endIso: r.endIso,
    task: r.task?.name ?? null,
    taskPath: r.task?.path ?? null,
    id: r.id,
    scheduled: r.scheduled,
    planned: r.planned,
    total: r.total,
    overtime: r.overtime,
    pauseCount: focus && r.pauses !== null ? r.pauses.length : null,
    pausedSeconds: focus && r.pauses !== null ? pausedSeconds(r.pauses) : null,
    status: r.status,
    sessionId: r.sessionId,
    startedBy: r.startedBy,
    endedBy: r.endedBy,
    cycle: r.cycle,
    offset: r.offset,
    endOffset: r.endOffset,
    slept: r.slept,
    dropped: r.dropped,
    device: r.device,
    logFile: r.logFile,
  };
}

// What makes a spreadsheet read a cell as a formula (OWASP's list).
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. A missing value is an empty cell. Text a spreadsheet would
 * run as a formula — a task named "=HYPERLINK(…)", a hand-typed Device — gets
 * a leading `'`, so it shows as the text it is. Every text cell is guarded,
 * not only the task and the device: a hand-edited line can put anything in
 * any field, and no value the plugin writes starts that way. Numbers never
 * are: an Offset of -300 stays a number. Then RFC 4180's quoting.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const BOM = "\uFEFF";

/**
 * The CSV file: UTF-8 with a byte order mark, so Excel reads 🍅 and accents;
 * CRLF line ends (RFC 4180); a header row first.
 */
export function csvText(records: readonly ExportRecord[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    const values = csvValues(record);
    rows.push(CSV_COLUMNS.map((column) => csvCell(values[column])).join(","));
  }
  return `${BOM}${rows.join("\r\n")}\r\n`;
}

/**
 * The JSON Lines file: one object per line, LF, a final newline, no header,
 * no byte order mark; a missing value is null. U+2028 and U+2029 are written
 * escaped: JSON allows them bare, but a reader that splits text into lines
 * the Unicode way (Python's splitlines) would break a record at one.
 */
export function jsonLinesText(records: readonly ExportRecord[]): string {
  return records
    .map((record) =>
      JSON.stringify(record)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029")
    )
    .map((line) => `${line}\n`)
    .join("");
}

export function exportText(records: readonly ExportRecord[], format: ExportFormat): string {
  return format === "csv" ? csvText(records) : jsonLinesText(records);
}

/** The text as written, without the byte order mark Vault.read drops (app.js, 1.14). */
export function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/* ===== The file ===== */

/** Names tried before the export gives up: the plain one, then " 2" to " 99". */
export const EXPORT_NAME_TRIES = 99;

/**
 * `gentle-pomodoro-sessions-<from>-to-<to>-<HHmmss>.<csv|jsonl>`, the time
 * the export ran keeping two exports of one range apart, then ` 2`, ` 3`… for
 * try `n` — Obsidian's own "Untitled 2" style.
 */
export function exportFileName(
  from: string,
  to: string,
  time: string,
  format: ExportFormat,
  n: number
): string {
  const number = n > 1 ? ` ${String(n)}` : "";
  return `gentle-pomodoro-sessions-${from}-to-${to}-${time}${number}.${format}`;
}

/* ===== What the export says ===== */

export const EXPORT_BUSY_NOTICE = "Gentle pomodoro: an export is already running.";
export const EXPORTING_NOTICE = "Gentle pomodoro: exporting…";
export const EXPORT_FAILED_NOTICE =
  "Gentle pomodoro: couldn't export the sessions — see the developer console for details.";
/** Under the dialog's Folder row. Not "never replaced": see logTools.ts's createExportFile. */
export const EXPORT_FOLDER_NOTE =
  'Saves a new file there, with a number added if the name is taken. CSV and JSON Lines files sync with Obsidian Sync only when "Sync all other types" is on, and show in the file list only with "Show all file types" (Files and links).';

const sessions = (n: number) => `${String(n)} session${n === 1 ? "" : "s"}`;

export function noSessionsMessage(from: string, to: string, kinds: ExportKinds): string {
  const what = kinds === "focus" ? "focus sessions" : "sessions";
  return `Gentle pomodoro: no ${what} from ${from} to ${to}, so nothing was exported.`;
}

/**
 * The second sentence is always there: whether "Show all file types" is on
 * cannot be read through the public API, and without it the file is not in
 * the file list.
 */
export function exportedMessage(count: number, path: string): string {
  return `Gentle pomodoro: exported ${sessions(count)} to "${path}". Turn on "Show all file types" (Files and links) to see it in the file list.`;
}

/** The file was written, but reads back as something else: a sync or another app wrote there too. */
export function exportReadBackMessage(count: number, path: string): string {
  return `Gentle pomodoro: exported ${sessions(count)} to "${path}", but the file doesn't read back as it was written — a sync or another app may have changed it. Export again to be sure.`;
}

export function exportNoNameMessage(folder: string): string {
  return `Gentle pomodoro: every file name for this export in "${folder}" is taken, so nothing was exported.`;
}
