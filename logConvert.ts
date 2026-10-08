/**
 * Old daily logs brought to version 2, and a read-only look at what the logs
 * say (0.6.9). Pure — text in, text out; the Check log and Convert old log
 * lines commands read and write the files.
 *
 * parseLogLine reads every shape a session line has had. What this module
 * decides is what a line becomes: a version 1 line is written again as
 * version 2 with the same fields, in the same order, with the same values.
 * Nothing is made up — a line that had no ID or Type gets none, and none gets
 * an Overtime, which only a session timed by 0.6.9 knows. Four leftovers of
 * early versions are cleaned on the way, each counted on its own so the dry
 * run can say what will change. A line this module cannot rewrite exactly is
 * left as it is and listed, and so is anything it cannot read.
 */
import { NO_TASK_LABEL } from "./constants";
import { frontmatterRowCount } from "./logFrontmatter";
import {
  LOG_FILE_SUFFIX,
  asciiDigits,
  dailyLogFileName,
  formatV2Line,
  looksLikeLogLine,
  parseLogLine,
  readLogPauses,
  readLogTime,
  repeatedReading,
  sanitizeAlias,
  type LogLineKind,
  type LogTaskRef,
  type ParsedLogLine,
} from "./logLine";

/**
 * What converting did, in lines. A converted line counts under "converted"
 * and under every clean-up it needed:
 *
 * - checkbox: the marker had a checkbox before it (the first test lines, Dec
 *   2025). Dropped — `- [ ] ☕ Rest` was an open task to the Tasks plugin.
 * - fffd: a U+FFFD left in the task name where an early version cut 🔼 in half.
 * - priority: a priority emoji left in the task name.
 * - idMoved: a 🆔 in the task name, moved to its own ID field (or dropped when
 *   the line's ID already says the same).
 * - digits: dates written in another script's digits (F14), now 0-9.
 * - sanitized: a task name tidied the way 0.6.9 writes one — brackets, `::`,
 *   a link inside it. Spaces alone are not counted.
 *
 * And lines left as they are: alreadyV2; unrecognised (looks like a session
 * but cannot be read, or not rewritten exactly — listed); otherText (notes,
 * headings).
 */
export const LOG_CONVERSION_KINDS = [
  "converted",
  "checkbox",
  "fffd",
  "priority",
  "idMoved",
  "digits",
  "sanitized",
  "alreadyV2",
  "unrecognised",
  "otherText",
] as const;
export type LogConversionKind = (typeof LOG_CONVERSION_KINDS)[number];
export type LogConversionCounts = Record<LogConversionKind, number>;

export function emptyConversionCounts(): LogConversionCounts {
  return {
    converted: 0,
    checkbox: 0,
    fffd: 0,
    priority: 0,
    idMoved: 0,
    digits: 0,
    sanitized: 0,
    alreadyV2: 0,
    unrecognised: 0,
    otherText: 0,
  };
}

/** Adds one file's counts into a running total. */
export function addConversionCounts(into: LogConversionCounts, from: LogConversionCounts): void {
  for (const kind of LOG_CONVERSION_KINDS) into[kind] += from[kind];
}

/** A line the converter left alone although it looks like a session. */
export interface UnconvertedLine {
  /** 1-based, as an editor counts. */
  line: number;
  text: string;
  /**
   * "unreadable": parseLogLine cannot read it. "inexact": it reads, but
   * written as version 2 it would not read back the same — a `]` in a link's
   * path closes a field early, a value ending in a backslash never closes.
   */
  reason: "unreadable" | "inexact";
}

export interface LogConversion {
  content: string;
  counts: LogConversionCounts;
  unrecognised: UnconvertedLine[];
}

// What early versions left in a task name. Only the five Tasks priorities:
// 🔥 is not one, and a name may mean it.
const PRIORITY_REGEX = /[🔺⏫🔼🔽⏬]\uFE0F?/gu;
const REPLACEMENT_CHAR_REGEX = /\uFFFD/gu;
const ID_IN_NAME_REGEX = /🆔\uFE0F?[ \t]*([A-Za-z0-9_-]+)/gu;
const CHECKBOX_REGEX = /\[.\] $/u;
// Fields holding written times. Total, Scheduled and the rest were always
// String(number), so native digits there would be a hand edit, and a reader
// skips them today; turning them into numbers would change a day's total.
const TIME_KEYS = new Set(["Start", "End", "Pauses"]);

/** Whitespace-blind form, to tell a real tidy-up from spacing. */
const squash = (text: string): string => text.replace(/\s+/gu, " ").trim();

interface ConvertedTask {
  value: string;
  kinds: LogConversionKind[];
  /** The ID taken out of the name, when the line has no ID field to hold it. */
  movedId: string | null;
}

function convertTask(task: LogTaskRef, lineId: string | undefined): ConvertedTask {
  // A link with no alias shows its path, which is not a name to clean.
  if (task.path !== undefined && !task.raw.slice(2, -2).includes("|")) {
    return { value: task.raw, kinds: [], movedId: null };
  }
  const kinds: LogConversionKind[] = [];
  let name = task.name;
  let movedId: string | null = null;
  // One 🆔 only, and one the line does not contradict: two in a name, or an
  // ID field naming another task, leave the name as it is.
  const ids = [...name.matchAll(ID_IN_NAME_REGEX)];
  if (ids.length === 1 && (lineId === undefined || lineId === ids[0][1])) {
    name = name.replace(ID_IN_NAME_REGEX, "");
    if (lineId === undefined) movedId = ids[0][1];
    kinds.push("idMoved");
  }
  const withoutReplacement = name.replace(REPLACEMENT_CHAR_REGEX, "");
  if (withoutReplacement !== name) kinds.push("fffd");
  const withoutPriority = withoutReplacement.replace(PRIORITY_REGEX, "");
  if (withoutPriority !== withoutReplacement) kinds.push("priority");
  const clean = sanitizeAlias(withoutPriority);
  if (squash(clean) !== squash(withoutPriority)) kinds.push("sanitized");
  // formatTaskValue's shape, with the path kept exactly as written.
  let value: string;
  if (task.path === undefined) value = clean || NO_TASK_LABEL;
  else value = clean ? `[[${task.path}|${clean}]]` : `[[${task.path}]]`;
  return { value, kinds, movedId };
}

/** The line as version 2, or null when that would not read back the same. */
function convertV1Line(parsed: ParsedLogLine): { text: string; kinds: LogConversionKind[] } | null {
  const kinds = new Set<LogConversionKind>(["converted"]);
  const prefix = parsed.prefix.replace(CHECKBOX_REGEX, "");
  if (prefix !== parsed.prefix) kinds.add("checkbox");
  const lineId = parsed.values.get("ID");
  const fields: [string, string][] = [];
  for (const field of parsed.fields) {
    let value = field.value;
    let movedId: string | null = null;
    if (parsed.task && field.start === parsed.task.start) {
      const task = convertTask(parsed.task, lineId);
      value = task.value;
      movedId = task.movedId;
      for (const kind of task.kinds) kinds.add(kind);
    } else if (TIME_KEYS.has(field.key)) {
      const ascii = asciiDigits(value);
      if (ascii !== value) kinds.add("digits");
      value = ascii;
    }
    fields.push([field.key, value]);
    // Where the writer puts ID: straight after Task.
    if (movedId !== null) fields.push(["ID", movedId]);
  }
  // A block ID or tags at the end of the line stay at its end, after the
  // fields: Obsidian finds `^id` nowhere else.
  const rest = parsed.rest;
  const text = formatV2Line(prefix, parsed.kind, fields) + (rest === "" ? "" : ` ${rest}`);
  // Read back: a value the v2 reader closes early (a `]` in a link's path, a
  // trailing backslash) would lose every field after it, so such a line
  // stays in version 1, where it still reads.
  const back = parseLogLine(text);
  const exact =
    back !== null &&
    back.format === "v2" &&
    back.kind === parsed.kind &&
    back.prefix === prefix &&
    back.rest === rest &&
    back.fields.length === fields.length &&
    back.fields.every((f, i) => f.key === fields[i][0] && f.value === fields[i][1]);
  return exact ? { text, kinds: [...kinds] } : null;
}

/**
 * A log file's text with every version 1 session line rewritten as version 2.
 * Every other line is kept byte for byte, line endings included (a CRLF file
 * stays CRLF), and running it on its own output changes nothing. The file's
 * properties are not lines of the log: kept as they are, however they read.
 */
export function convertLogContent(content: string): LogConversion {
  const counts = emptyConversionCounts();
  const unrecognised: UnconvertedLine[] = [];
  const body = frontmatterRowCount(content);
  // Split on "\n" and keep each "\r": the file is written back.
  const lines = content.split("\n").map((raw, index) => {
    if (index < body) return raw;
    const cr = raw.endsWith("\r");
    const line = cr ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return raw;
    const parsed = parseLogLine(line);
    if (!parsed) {
      if (looksLikeLogLine(line)) {
        counts.unrecognised++;
        unrecognised.push({ line: index + 1, text: line, reason: "unreadable" });
      } else {
        counts.otherText++;
      }
      return raw;
    }
    if (parsed.format === "v2") {
      counts.alreadyV2++;
      return raw;
    }
    const converted = convertV1Line(parsed);
    if (!converted) {
      counts.unrecognised++;
      unrecognised.push({ line: index + 1, text: line, reason: "inexact" });
      return raw;
    }
    for (const kind of converted.kinds) counts[kind]++;
    return cr ? `${converted.text}\r` : converted.text;
  });
  return { content: lines.join("\n"), counts, unrecognised };
}

/**
 * The name a log file written under another script's digits should have
 * (`٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md` → `2026-10-02-…`), or null when the
 * name is not one. The caller renames it when no file has that name yet, and
 * otherwise merges it into the file that has (mergeLogContent).
 */
export function asciiLogFileName(name: string): string | null {
  if (!name.endsWith(LOG_FILE_SUFFIX)) return null;
  const date = name.slice(0, -LOG_FILE_SUFFIX.length);
  const ascii = asciiDigits(date);
  if (ascii === date || !/^\d{4}-\d{2}-\d{2}$/.test(ascii)) return null;
  return dailyLogFileName(ascii);
}

// --- Merge: one day's log under two names (F4) -------------------------------

const BOM = "\uFEFF";

/** A file's rows without their line breaks: a "\r" dropped, and the empty row after a final break. */
function logRows(content: string): string[] {
  const rows = content.split("\n").map((row) => (row.endsWith("\r") ? row.slice(0, -1) : row));
  if (rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** A row's Start as epoch seconds, or null: not a session line, or a Start that cannot be read. */
function rowStart(row: string): number | null {
  const parsed = parseLogLine(row);
  return parsed ? readLogTime(parsed.values.get("Start") ?? "") : null;
}

/** How many of a file's rows hold something, its properties left out: what a
 *  merge moves, as its counts say it. */
export function logLineCount(content: string): number {
  return logRows(content)
    .slice(frontmatterRowCount(content))
    .filter((row) => row.trim() !== "").length;
}

/** A run of rows: a session line with a Start and the rows after it that have none. */
interface RowRun {
  start: number;
  rows: string[];
}

/** A file's rows as the rows before its first Start, then one run per session line with one. */
function rowRuns(rows: readonly string[]): { lead: string[]; runs: RowRun[] } {
  const lead: string[] = [];
  const runs: RowRun[] = [];
  for (const row of rows) {
    const start = rowStart(row);
    if (start !== null) runs.push({ start, rows: [row] });
    else if (runs.length > 0) runs[runs.length - 1].rows.push(row);
    else lead.push(row);
  }
  return { lead, runs };
}

/**
 * A day's 0-9 log file (`into`) with the lines of the same day's file named
 * in other digits (`from`) merged in, by Start (F4). Until 0.6.9 a day could
 * have both — Obsidian in Arabic, Persian, Bengali or Nepali wrote that
 * script's digits, and changing the language mid-day started the second file —
 * and Convert left such a file as it was, its sessions out of every query
 * that names a date with 0-9.
 *
 * `into` keeps every row where it is. Each of `from`'s session lines goes
 * where its Start belongs: after the last of `into`'s sessions that started
 * no later, or before the first when it is the earliest; several in one
 * place, by Start. Unlike "Add a session" (insertSessionLine), which puts its
 * line directly after that session's line, the merge puts it after the rows
 * that follow that session without a Start of their own too: they are that
 * session's notes, and stay with it. A row with no Start — a note, a heading, a blank row, a
 * session whose Start cannot be read — keeps its place relative to its
 * neighbours: it travels with the session line it followed, and rows before a
 * file's first Start stay at its head (`from`'s go just before its first
 * session line, wherever that goes; with none at all, at the end). So no row
 * is dropped or written twice: the result holds every row of both files, each
 * once.
 *
 * Written in `into`'s line ending, ending in one, with `into`'s byte order
 * mark kept at the start of the file; `from`'s mark is dropped, as it belongs
 * to a file that goes. `lines` counts the rows of `from` that hold something
 * (logLineCount).
 *
 * The files' properties (logFrontmatter.ts) are not rows of the log, and
 * never move into its middle, where they would read as a rule and a heading:
 * `into`'s stay on top as they are. When it has none, `from`'s go there
 * instead, without `from`'s mark; when it has its own — or a byte order mark:
 * another program wrote it, and its head stays as that program wrote it, as
 * withLogGoal leaves it — `from`'s are left in the file that goes to the
 * trash, and returned as `droppedProperties` for the console to name.
 */
export function mergeLogContent(
  into: string,
  from: string
): { content: string; lines: number; droppedProperties: string[] } {
  const crlf = into.includes("\r\n") || (!into.includes("\n") && from.includes("\r\n"));
  const target = logRows(into);
  const source = logRows(from);
  const ownProperties = target.splice(0, frontmatterRowCount(into));
  const fromProperties = source.splice(0, frontmatterRowCount(from));
  // Past a byte order mark, the properties begin on the mark's row.
  if (fromProperties.length > 0) fromProperties[0] = fromProperties[0].replace(BOM, "");
  const bom = target.length > 0 && target[0].startsWith(BOM) ? BOM : "";
  if (bom) target[0] = target[0].slice(BOM.length);
  if (source.length > 0 && source[0].startsWith(BOM)) source[0] = source[0].slice(BOM.length);

  const ours = rowRuns(target);
  const theirs = rowRuns(source);
  // `from`'s head goes with its first session line; its runs go in Start
  // order, a tie in file order.
  if (theirs.runs.length > 0) theirs.runs[0].rows.unshift(...theirs.lead);
  const incoming = [...theirs.runs].sort((a, b) => a.start - b.start);
  // slots[k]: the incoming runs that go just before ours.runs[k]; the last, after them all.
  const slots: string[][] = ours.runs.map(() => []);
  slots.push([]);
  for (const run of incoming) {
    let slot = 0;
    ours.runs.forEach((own, k) => {
      if (own.start <= run.start) slot = k + 1;
    });
    slots[slot].push(...run.rows);
  }

  const keepsFrom = ownProperties.length === 0 && bom === "";
  const out = [...(keepsFrom ? fromProperties : ownProperties), ...ours.lead];
  ours.runs.forEach((own, k) => {
    out.push(...slots[k], ...own.rows);
  });
  out.push(...slots[ours.runs.length]);
  if (incoming.length === 0) out.push(...theirs.lead);

  const eol = crlf ? "\r\n" : "\n";
  const content = out.length === 0 ? "" : bom + out.join(eol) + eol;
  return {
    content,
    lines: logLineCount(from),
    droppedProperties: keepsFrom ? [] : fromProperties,
  };
}

/**
 * `content` with one copy of each of `from`'s rows that hold something taken
 * out again — the undo of mergeLogContent when the merged file cannot be moved
 * to the trash, so its lines are not merged a second time by the next Convert.
 * Rows that came in since keep their place; a blank row the merge brought in
 * may stay, which loses nothing. Split and joined on "\n", so the line
 * endings are kept. Properties are never taken out — `content`'s own are not
 * `from`'s rows, and `from`'s, if the merge put them on top, lose nothing
 * where they are.
 */
export function unmergeLogContent(content: string, from: string): string {
  const rows = content.split("\n");
  const body = frontmatterRowCount(content);
  const textOf = (row: string) => (row.endsWith("\r") ? row.slice(0, -1) : row);
  for (const moved of logRows(from).slice(frontmatterRowCount(from))) {
    const text = moved.startsWith(BOM) ? moved.slice(BOM.length) : moved;
    if (text.trim() === "") continue;
    const at = rows.findIndex(
      (row, index) => index >= body && textOf(row).replace(BOM, "") === text
    );
    if (at === -1) continue;
    const bom = rows[at].startsWith(BOM);
    rows.splice(at, 1);
    // The file's byte order mark stays at its start.
    if (bom && rows.length > 0) rows[0] = BOM + rows[0];
  }
  return rows.join("\n");
}

// --- Check: what the logs say that cannot be right (F64) ---------------------

/** Longer than this, counted in active time, a session was likely left running. */
export const LONG_SESSION_SECONDS = 12 * 60 * 60;

/**
 * - total: Total disagrees with End − Start − pauses by more than the
 *   rounding of the written times allows (1 s, and 1 s more per pause). A
 *   Rest line writes no pauses, so it is flagged only when Total is LONGER
 *   than its span — a paused break is shorter, and that is not an error.
 * - overlap: it starts before another session has ended.
 * - long: more than 12 h of active time.
 * - endBeforeStart: it ends before it starts.
 *
 * A written time in the hour a fall-back repeats may be either pass of it
 * (repeatedReading), so a line with one is flagged only when no reading of its
 * times fits: its Start and its End may each be the repeat later than they
 * read, and its Total off its span by whole repeats. The timer writes such
 * lines on that night; they are not errors.
 * - idNames: one 🆔 logged under different task names (tags, the 🍅 count and
 *   the leftovers the converter cleans do not count as a difference).
 */
export const LOG_ANOMALY_KINDS = ["total", "overlap", "long", "endBeforeStart", "idNames"] as const;
export type LogAnomalyKind = (typeof LOG_ANOMALY_KINDS)[number];

export interface LogAnomaly {
  kind: LogAnomalyKind;
  /** The file, as the caller named it. */
  path: string;
  /** 1-based line in that file. */
  line: number;
  /** One sentence for the console. */
  detail: string;
}

export interface LogFileText {
  path: string;
  content: string;
}

interface LoggedSession {
  path: string;
  file: number;
  line: number;
  kind: LogLineKind;
  startText: string;
  endText: string;
  start: number;
  end: number;
  total: number | null;
  /** Whether the line has a Pauses field at all — a Rest line has none. */
  pausesWritten: boolean;
  /** Whole seconds paused; null when the Pauses field cannot be read. */
  paused: number | null;
  pauseCount: number;
  /** How much later Start and End may be than they read (repeatedReading). */
  startLater: number;
  endLater: number;
  /** The longest such repeat among its written times, and how many have one. */
  repeat: number;
  ambiguous: number;
  id?: string;
  name?: string;
}

const TAG_REGEX = /#[^\s#]+/gu;
const POMODORO_COUNT_REGEX = /🍅\uFE0F?\s*\d+(?:\s*\(\d{4}-\d{2}-\d{2}\))?/gu;
const SIGNED_SECONDS_REGEX = /^-?\d+/;

/** A task name as compared across one 🆔's lines. */
function nameKey(name: string): string {
  return squash(
    sanitizeAlias(
      name
        .replace(ID_IN_NAME_REGEX, "")
        .replace(REPLACEMENT_CHAR_REGEX, "")
        .replace(PRIORITY_REGEX, "")
        .replace(POMODORO_COUNT_REGEX, "")
        .replace(TAG_REGEX, "")
    )
  );
}

/** "45s", "12m 5s", "13h 5m" — the status bar's "1h 20m", with seconds when short. */
export function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(seconds / 3600))}h ${String(Math.floor((seconds % 3600) / 60))}m`;
}

function readSession(
  path: string,
  file: number,
  line: number,
  parsed: ParsedLogLine
): LoggedSession | null {
  const startText = parsed.values.get("Start") ?? "";
  const endText = parsed.values.get("End") ?? "";
  const start = readLogTime(startText);
  const end = readLogTime(endText);
  if (start === null || end === null) return null;
  const totalMatch = SIGNED_SECONDS_REGEX.exec(parsed.values.get("Total") ?? "");
  const pausesText = parsed.values.get("Pauses");
  const pauses = pausesText === undefined ? [] : readLogPauses(pausesText);
  const startLater = repeatedReading(start);
  const endLater = repeatedReading(end);
  const repeats = [startLater, endLater, ...(pauses ?? []).flat().map(repeatedReading)].filter(
    (shift) => shift > 0
  );
  return {
    path,
    file,
    line,
    kind: parsed.kind,
    startText,
    endText,
    start,
    end,
    total: totalMatch ? parseInt(totalMatch[0], 10) : null,
    pausesWritten: pausesText !== undefined,
    paused: pauses ? pauses.reduce((sum, [from, to]) => sum + (to - from), 0) : null,
    pauseCount: pauses ? pauses.length : 0,
    startLater,
    endLater,
    repeat: Math.max(0, ...repeats),
    ambiguous: repeats.length,
    id: parsed.values.get("ID"),
    name: parsed.task?.name,
  };
}

/**
 * Everything Check flags across a set of log files, in file and line order.
 * Read-only, and on lines of either format (and in any script's digits), so
 * it can run before a conversion as well as after.
 */
export function scanLogAnomalies(files: readonly LogFileText[]): LogAnomaly[] {
  const anomalies: (LogAnomaly & { file: number })[] = [];
  const sessions: LoggedSession[] = [];
  files.forEach(({ path, content }, file) => {
    const body = frontmatterRowCount(content);
    content.split(/\r?\n/).forEach((text, index) => {
      if (index < body) return;
      const parsed = parseLogLine(text);
      const session = parsed && readSession(path, file, index + 1, parsed);
      if (session) sessions.push(session);
    });
  });

  const flag = (session: LoggedSession, kind: LogAnomalyKind, detail: string) =>
    anomalies.push({ kind, path: session.path, file: session.file, line: session.line, detail });
  // Whether `diff` is within `tolerance` of 0 — or, on a line with times in a
  // repeated hour, of a whole number of repeats, one per such time at most.
  const fits = (s: LoggedSession, diff: number, tolerance: number): boolean => {
    for (let n = -s.ambiguous; n <= s.ambiguous; n++) {
      if (Math.abs(diff - n * s.repeat) <= tolerance) return true;
    }
    return false;
  };
  const endsBeforeStart = (s: LoggedSession) => s.end + s.endLater < s.start;

  for (const s of sessions) {
    if (endsBeforeStart(s)) {
      flag(s, "endBeforeStart", `Ends at ${s.endText}, before it starts at ${s.startText}.`);
      continue;
    }
    const span = s.end - s.start;
    // A Rest line writes no pauses, so its Total is its active time and a
    // paused break is shorter than its span. A line with Pauses (every Focus
    // line) balances: each written time is cut to the second, so each
    // interval may be off by under 1 s.
    const restWithoutPauses = s.kind === "rest" && !s.pausesWritten;
    if (s.total !== null) {
      if (restWithoutPauses) {
        if (s.total - (span + s.endLater) > 1) {
          flag(s, "total", `Total is ${String(s.total)} s, but End − Start is ${String(span)} s.`);
        }
      } else if (s.paused !== null && !fits(s, s.total - (span - s.paused), 1 + s.pauseCount)) {
        flag(
          s,
          "total",
          `Total is ${String(s.total)} s, but End − Start − pauses is ${String(span - s.paused)} s.`
        );
      }
    }
    let active: number | null;
    if (restWithoutPauses) active = s.total === null ? span : Math.min(span, s.total);
    else active = s.paused === null ? null : span - s.paused;
    if (active !== null && active - s.ambiguous * s.repeat > LONG_SESSION_SECONDS) {
      flag(s, "long", `Ran ${describeSeconds(active)} of active time.`);
    }
  }

  // Overlaps: in start order, against the session that ends latest so far.
  // A start in a repeated hour overlaps only if its later reading does too.
  const timed = sessions
    .filter((s) => !endsBeforeStart(s))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let latest: LoggedSession | null = null;
  for (const s of timed) {
    if (latest && s.start + s.startLater < latest.end) {
      flag(
        s,
        "overlap",
        `Starts at ${s.startText}, before the session at ${latest.path} line ${String(latest.line)} ends (${latest.endText}).`
      );
    }
    if (!latest || s.end > latest.end) latest = s;
  }

  // One 🆔, several names: flagged once, at the first line under a new name.
  const byId = new Map<string, { first: string; keys: Set<string> }>();
  for (const s of sessions) {
    // Only a Focus line has a Task, so only a Focus line has a name.
    if (!s.id || s.name === undefined) continue;
    const key = nameKey(s.name);
    const seen = byId.get(s.id);
    if (!seen) {
      byId.set(s.id, { first: s.name, keys: new Set([key]) });
    } else if (!seen.keys.has(key)) {
      seen.keys.add(key);
      if (seen.keys.size === 2) {
        flag(s, "idNames", `🆔 ${s.id} is logged as "${seen.first}" and as "${s.name}".`);
      }
    }
  }

  return anomalies
    .sort((a, b) => a.file - b.file || a.line - b.line)
    .map(({ kind, path, line, detail }) => ({ kind, path, line, detail }));
}

/** How many of each kind, for the Notice. */
export function countAnomalies(anomalies: readonly LogAnomaly[]): Record<LogAnomalyKind, number> {
  const counts: Record<LogAnomalyKind, number> = {
    total: 0,
    overlap: 0,
    long: 0,
    endBeforeStart: 0,
    idNames: 0,
  };
  for (const anomaly of anomalies) counts[anomaly.kind]++;
  return counts;
}
