/**
 * The Dataview code the settings' Copy buttons give (0.7.0, "Dataview tables").
 *
 * The plugin draws nothing in a note: it hands the user ordinary Dataview and
 * DataviewJS code with their log folder filled in, which they paste, own and
 * change. Settings in, text out — nothing here reads the vault.
 *
 * Every expression is a form that was run in Dataview 0.5.68's own engine
 * before it was written here, and tests/dataviewEngine.test.ts runs every
 * variant this file can make through that engine again (a copy of its
 * main.js, under tests/fixtures/dataview). Dataview's gotchas, each of which
 * would show a wrong table without an error:
 *
 * - A cell that fails drops its ROW, silently: Dataview has no `null / 60`,
 *   so `round(s.Planned / 60)` would hide every line written before 0.7.0.
 *   A number that can be missing is read through `default(…, 0)` inside a
 *   `choice` that shows "-" when it is missing (choice evaluates both sides).
 * - A list item's fields keep their case: `s.Total`, never `s.total`, and
 *   `s.task` is Dataview's own true/false.
 * - `FROM "<folder>"` takes every note in it, so a note that quotes a log line
 *   would be counted: the file name must end like a daily log's.
 * - Grouping by `s.Task` groups by the task's NOTE (links compare by path);
 *   `string(s.Task)` keeps two tasks of one note apart.
 * - `contains()` matches substrings inside strings, so the kinds are written
 *   out as ORs.
 * - A line Convert rewrote from a log older than the Type field has no Type
 *   (nothing is invented on it), and `s.Type = "focus"` alone leaves it out
 *   of every table while the daily goal counts it: such a line is known by
 *   the marker it begins with, and by a Total — a line from before 0.6.9
 *   begins with the marker too, but Dataview reads no field from it.
 *
 * A log line's keys are read here as `s.Key`, never written as the line
 * writes them: only logLine.ts may (tests/logLine.test.ts).
 */
import { normalizePath } from "obsidian";
import type { LogFolderProblem } from "./logFolder";
import { LOG_FILE_SUFFIX, LOG_FOCUS_MARKER, LOG_REST_MARKER, resolveDayStartHour } from "./logLine";
import type { GentlePomoSettings } from "./types";

/** A whole-minutes cell from a seconds field that older lines may not have. */
const minutesDql = (key: string) =>
  `choice(s.${key} != null, round(default(s.${key}, 0) / 60), null)`;
const minutesJs = (key: string) =>
  `typeof s.${key} === "number" ? Math.round(s.${key} / 60) : null`;

/**
 * One column the sessions table can show, in catalog order: the order a
 * column is added in when a stored list lacks it, and the order of the
 * columns a preset leaves off.
 */
export interface QueryColumn {
  id: string;
  /** In the settings list. */
  label: string;
  /** The table's header. */
  head: string;
  /** The cell in DQL: `s` is the line's list item, `file` its log file. */
  dql: string;
  /** The same in DataviewJS: `s` the list item, `p` its page. */
  js: string;
}

export const QUERY_COLUMNS = [
  { id: "date", label: "Date", head: "Date", dql: "file.day", js: "p.file.day" },
  {
    id: "start",
    label: "Start",
    head: "Start",
    // Not date(s.Start, format): it THROWS on text that does not match, which
    // drops the row; a substring is null on a missing Start and never throws.
    dql: "substring(s.Start, 11, 16)",
    js: "s.Start ? s.Start.slice(11, 16) : null",
  },
  {
    id: "end",
    label: "End",
    head: "End",
    dql: "substring(s.End, 11, 16)",
    js: "s.End ? s.End.slice(11, 16) : null",
  },
  { id: "task", label: "Task", head: "Task", dql: "s.Task", js: "s.Task ?? null" },
  {
    id: "minutes",
    label: "Minutes",
    head: "Minutes",
    dql: minutesDql("Total"),
    js: minutesJs("Total"),
  },
  // Unknown on a line from before 0.7.0, so it shows "-" there — never the
  // Scheduled it may have differed from (the maintainer's call, choice 6).
  {
    id: "planned",
    label: "Planned (min)",
    head: "Planned",
    dql: minutesDql("Planned"),
    js: minutesJs("Planned"),
  },
  {
    id: "overtime",
    label: "Overtime (min)",
    head: "Overtime",
    dql: minutesDql("Overtime"),
    js: minutesJs("Overtime"),
  },
  {
    id: "pauses",
    label: "Pauses",
    head: "Pauses",
    // Pauses is text to Dataview (`[]` or `["a - b", …]`): count the " - ".
    dql: 'choice(s.Pauses != null, length(split(s.Pauses, " - ")) - 1, null)',
    js: 'typeof s.Pauses === "string" ? s.Pauses.split(" - ").length - 1 : null',
  },
  { id: "status", label: "Status", head: "Status", dql: "s.Status", js: "s.Status ?? null" },
  { id: "type", label: "Type", head: "Type", dql: "s.Type", js: "s.Type ?? null" },
  { id: "endedby", label: "Ended by", head: "Ended by", dql: "s.EndedBy", js: "s.EndedBy ?? null" },
  {
    id: "startedby",
    label: "Started by",
    head: "Started by",
    dql: "s.StartedBy",
    js: "s.StartedBy ?? null",
  },
  { id: "cycle", label: "Cycle", head: "Cycle", dql: "s.Cycle", js: "s.Cycle ?? null" },
  // On a line that has Session, a missing Slept or Dropped means 0; without
  // Session the line is older and the value unknown.
  {
    id: "slept",
    label: "Slept (min)",
    head: "Slept",
    dql: "choice(s.Session != null, round(default(s.Slept, 0) / 60), null)",
    js: "s.Session ? Math.round((s.Slept ?? 0) / 60) : null",
  },
  {
    id: "dropped",
    label: "Dropped (min)",
    head: "Dropped",
    dql: "choice(s.Session != null, round(default(s.Dropped, 0) / 60), null)",
    js: "s.Session ? Math.round((s.Dropped ?? 0) / 60) : null",
  },
  { id: "device", label: "Device", head: "Device", dql: "s.Device", js: "s.Device ?? null" },
  {
    id: "session",
    label: "Session ID",
    head: "Session",
    dql: "s.Session",
    js: "s.Session ?? null",
  },
  {
    id: "offset",
    label: "UTC offset (h)",
    head: "UTC offset",
    dql: "choice(s.Offset != null, default(s.Offset, 0) / 60, null)",
    js: 'typeof s.Offset === "number" ? s.Offset / 60 : null',
  },
] as const satisfies readonly QueryColumn[];

export type QueryColumnId = (typeof QUERY_COLUMNS)[number]["id"];

/** One column as the user set it: where it is in the list, and whether it shows. */
export interface ColumnChoice {
  id: QueryColumnId;
  on: boolean;
}

/** The two starting points the Simple and Detailed buttons give. */
export const QUERY_PRESETS = {
  simple: ["date", "start", "task", "minutes", "status"],
  detailed: [
    "date",
    "start",
    "end",
    "task",
    "minutes",
    "planned",
    "overtime",
    "pauses",
    "status",
    "endedby",
  ],
} as const satisfies Record<string, readonly QueryColumnId[]>;

export type QueryPreset = keyof typeof QUERY_PRESETS;

const columnOf = (id: string): (typeof QUERY_COLUMNS)[number] | undefined =>
  QUERY_COLUMNS.find((column) => column.id === id);

/** A preset's columns on, in its order, then every other column off, in catalog order. */
export function presetColumns(name: QueryPreset): ColumnChoice[] {
  const on: readonly string[] = QUERY_PRESETS[name];
  return [
    ...QUERY_PRESETS[name].map((id) => ({ id, on: true })),
    ...QUERY_COLUMNS.filter((column) => !on.includes(column.id)).map((column) => ({
      id: column.id,
      on: false,
    })),
  ];
}

/**
 * The columns as data.json keeps them: one string, every column in the user's
 * order, a leading `-` marking one off —
 * `date,start,task,minutes,status,-end,…`. A string, never an array: the
 * shallow merge of the defaults would share an array by reference.
 */
export function formatQueryColumns(columns: readonly ColumnChoice[]): string {
  return columns.map((column) => (column.on ? column.id : `-${column.id}`)).join(",");
}

/**
 * The stored columns, never trusted as stored (a hand-edited or synced
 * data.json, or one from a later version): ids trimmed and lower-cased,
 * unknown ones and repeats dropped (the first wins), and any column the value
 * lacks added off, in catalog order — so a column a later version adds
 * shows up at the end. Simple when it is not text or leaves nothing on.
 */
export function resolveQueryColumns(raw: unknown): ColumnChoice[] {
  if (typeof raw !== "string") return presetColumns("simple");
  const out: ColumnChoice[] = [];
  for (const part of raw.split(",")) {
    let text = part.trim().toLowerCase();
    const on = !text.startsWith("-");
    if (!on) text = text.slice(1).trim();
    const column = columnOf(text);
    if (column === undefined || out.some((c) => c.id === column.id)) continue;
    out.push({ id: column.id, on });
  }
  for (const column of QUERY_COLUMNS) {
    if (!out.some((c) => c.id === column.id)) out.push({ id: column.id, on: false });
  }
  return out.some((c) => c.on) ? out : presetColumns("simple");
}

/**
 * The columns with the one at `index` swapped with its neighbour `delta`
 * (−1 up, +1 down) away, or null at either end. Off columns move too, so one
 * switched on later shows where the user put it.
 */
export function moveQueryColumn(
  columns: readonly ColumnChoice[],
  index: number,
  delta: -1 | 1
): ColumnChoice[] | null {
  const to = index + delta;
  if (index < 0 || index >= columns.length || to < 0 || to >= columns.length) return null;
  const next = columns.map((c) => ({ ...c }));
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/**
 * The columns with `id` switched on or off, its place kept — or null when that
 * would leave none on, as a table needs one.
 */
export function switchQueryColumn(
  columns: readonly ColumnChoice[],
  id: QueryColumnId,
  on: boolean
): ColumnChoice[] | null {
  const next = columns.map((c) => (c.id === id ? { ...c, on } : { ...c }));
  return next.some((c) => c.on) ? next : null;
}

/** The Days row's choices; a note pasted into a daily note follows its day. */
export const QUERY_RANGES = [
  { value: "note", label: "This note's day" },
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "all", label: "All days" },
] as const;
export type QueryRange = (typeof QUERY_RANGES)[number]["value"];

/** The Sessions row's choices. */
export const QUERY_KINDS = [
  { value: "focus", label: "Focus only" },
  { value: "all", label: "Focus and breaks" },
] as const;
export type QueryKinds = (typeof QUERY_KINDS)[number]["value"];

/** The Order row's choices. */
export const QUERY_SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
] as const;
export type QuerySort = (typeof QUERY_SORTS)[number]["value"];

/** A stored choice if the list offers it, else `fallback`: an id list, never `in`. */
function resolveChoice<T extends string>(
  choices: readonly { value: T }[],
  value: unknown,
  fallback: T
): T {
  return choices.find((choice) => choice.value === value)?.value ?? fallback;
}

export const resolveQueryRange = (value: unknown): QueryRange =>
  resolveChoice(QUERY_RANGES, value, "week");
export const resolveQueryKinds = (value: unknown): QueryKinds =>
  resolveChoice(QUERY_KINDS, value, "focus");
export const resolveQuerySort = (value: unknown): QuerySort =>
  resolveChoice(QUERY_SORTS, value, "newest");

/** Everything the code is made from, every setting already resolved. */
export interface QueryOptions {
  /** The log folder as the vault spells it (queryFolder), not yet quoted. */
  folder: string;
  dayStartHour: number;
  columns: readonly ColumnChoice[];
  range: QueryRange;
  kinds: QueryKinds;
  /** Include skipped (cancelled) focus in the sessions table. */
  skipped: boolean;
  sort: QuerySort;
}

type QuerySettings = Pick<
  GentlePomoSettings,
  "dayStartHour" | "queryColumns" | "queryRange" | "queryKinds" | "querySkipped" | "querySort"
>;

export function queryOptions(settings: QuerySettings, folder: string): QueryOptions {
  return {
    folder,
    dayStartHour: resolveDayStartHour(settings.dayStartHour),
    columns: resolveQueryColumns(settings.queryColumns),
    range: resolveQueryRange(settings.queryRange),
    kinds: resolveQueryKinds(settings.queryKinds),
    skipped: settings.querySkipped !== false,
    sort: resolveQuerySort(settings.querySort),
  };
}

/** Why no code can be made: no folder set, or the vault's top level. */
export type QueryFolderRefusal = "none" | "root";

/**
 * The folder to fill in, from the stored setting and what logFolderProblem
 * says of it: normalised as the timer's own path is (dailyLogPath), and the
 * vault's own capitals when the setting spells an existing folder another way
 * — Dataview's folder index tells capitals apart, so the setting's spelling
 * would show an empty table. Not trimmed: a stored " Logs" is the folder the
 * timer writes to (on macOS a real one), and the row trims what is typed.
 */
export function queryFolder(
  stored: string,
  problem: LogFolderProblem | null
): { folder: string } | { refused: QueryFolderRefusal } {
  if (stored.trim() === "") return { refused: "none" };
  if (problem?.kind === "root") return { refused: "root" };
  const folder = normalizePath(problem?.kind === "case" ? problem.real : stored);
  return folder === "/" ? { refused: "root" } : { folder };
}

/** Text as it goes inside a DQL string: Dataview's own two escapes. */
export function dqlEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A DQL string literal. */
export function dqlString(text: string): string {
  return `"${dqlEscape(text)}"`;
}

/**
 * A fenced code block, its fence one backtick longer than the longest run of
 * backticks inside (CommonMark), so a folder named with ``` cannot end it.
 */
export function fenced(lang: string, body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** What a daily log's file name ends with, as Dataview gives `file.name` (no .md). */
const LOG_NAME_SUFFIX = LOG_FILE_SUFFIX.replace(/\.md$/, "");
/**
 * A daily log: its name ends like one, and Dataview dates it. A log-named
 * file Dataview cannot date (a name in other digits) has no day to show,
 * and DataviewJS's `!p.file.day` leaves it out too, so the two agree.
 */
const FILE_GUARD = `file.day AND endswith(file.name, ${dqlString(LOG_NAME_SUFFIX)})`;

/**
 * The plugin's "today" in DQL. With "Day starts at" a session at 01:30 is the
 * day before's, so the copied table must be too. The test is the clock's HOUR,
 * as `logicalDate` reads it: taking the hours off the instant instead lands a
 * day out for an hour on both mornings the clocks change. Copied code keeps
 * the hour it was copied with.
 */
export function todayDql(o: QueryOptions): string {
  const h = String(o.dayStartHour);
  return o.dayStartHour > 0
    ? `choice(date(now).hour < ${h}, date(today) - dur(1 day), date(today))`
    : "date(today)";
}

export function todayJs(o: QueryOptions): string {
  const h = String(o.dayStartHour);
  return o.dayStartHour > 0
    ? `(dv.date("now").hour < ${h} ? dv.date("today").minus({ days: 1 }) : dv.date("today"))`
    : 'dv.date("today")';
}

function rangeDql(o: QueryOptions): string | null {
  switch (o.range) {
    case "note":
      return "file.day = this.file.day";
    case "today":
      return `file.day = ${todayDql(o)}`;
    case "week":
      return `file.day >= ${todayDql(o)} - dur(6 days)`;
    case "month":
      return `file.day >= ${todayDql(o)} - dur(29 days)`;
    case "all":
      return null;
  }
}

/** A focus line, a line with no Type known by its marker (see the top). */
const FOCUS_DQL = `(s.Type = "focus" OR (s.Type = null AND s.Total != null AND startswith(s.text, ${dqlString(LOG_FOCUS_MARKER)})))`;
const BREAK_DQL = `(s.Type = "short-break" OR s.Type = "long-break" OR (s.Type = null AND s.Total != null AND startswith(s.text, ${dqlString(LOG_REST_MARKER)})))`;

const KINDS_DQL: Record<QueryKinds, string> = {
  focus: FOCUS_DQL,
  all: `(${FOCUS_DQL} OR ${BREAK_DQL})`,
};

/** The same two tests in DataviewJS, as the code's first lines define them. */
const FOCUS_JS = `const isFocus = (s) => s.Type === "focus" || (s.Type == null && s.Total != null && s.text.startsWith(${JSON.stringify(LOG_FOCUS_MARKER)}));`;
const BREAK_JS = `const isBreak = (s) => s.Type === "short-break" || s.Type === "long-break" || (s.Type == null && s.Total != null && s.text.startsWith(${JSON.stringify(LOG_REST_MARKER)}));`;

/** The Task cell: a break's reads "Break" or "Long break", never the ☕ marker. */
function taskDql(o: QueryOptions): string {
  return o.kinds === "all"
    ? `choice(${FOCUS_DQL}, s.Task, choice(s.Type = "long-break", "Long break", "Break"))`
    : "s.Task";
}

function taskJs(o: QueryOptions): string {
  return o.kinds === "all"
    ? 'isFocus(s) ? s.Task ?? null : s.Type === "long-break" ? "Long break" : "Break"'
    : "s.Task ?? null";
}

function onColumns(o: QueryOptions): (typeof QUERY_COLUMNS)[number][] {
  return o.columns
    .filter((choice) => choice.on)
    .map((choice) => columnOf(choice.id))
    .filter((column): column is (typeof QUERY_COLUMNS)[number] => column !== undefined);
}

/**
 * The file tests (a log file, in the range), asked BEFORE the FLATTEN, so
 * Dataview opens only the days in the range rather than every line of the
 * whole history on each refresh (730 days: 330 ms a run against 20 ms).
 */
function fileWhereDql(o: QueryOptions): string {
  const range = rangeDql(o);
  return `WHERE ${range === null ? FILE_GUARD : `${FILE_GUARD} AND ${range}`}`;
}

/** The line tests, after the FLATTEN: the kinds, and skipped focus left out. */
function lineWhereDql(kinds: QueryKinds, withoutSkipped: boolean): string {
  const parts = [KINDS_DQL[kinds]];
  if (withoutSkipped) parts.push('s.Status != "cancelled"');
  return `WHERE ${parts.join(" AND ")}`;
}

/** The Copy sessions table code: the picked columns, Days, Sessions, skipped and Order applied. */
export function sessionsTable(o: QueryOptions): string {
  const cells = onColumns(o).map(
    (column) => `${column.id === "task" ? taskDql(o) : column.dql} AS ${dqlString(column.head)}`
  );
  return fenced(
    "dataview",
    [
      `TABLE WITHOUT ID ${cells.join(", ")}`,
      `FROM ${dqlString(o.folder)}`,
      fileWhereDql(o),
      "FLATTEN file.lists AS s",
      lineWhereDql(o.kinds, !o.skipped),
      `SORT s.Start ${o.sort === "oldest" ? "ASC" : "DESC"}`,
    ].join("\n")
  );
}

/**
 * Focus minutes, sessions and the goal for each day. Skipped focus is never
 * in it, as the daily goal leaves it out, and a split session's parts share
 * one Session, so they count as one.
 */
export function dailyTotals(o: QueryOptions): string {
  return fenced(
    "dataview",
    [
      'TABLE WITHOUT ID key AS "Day", round(sum(rows.s.Total) / 60) AS "Focus minutes", length(filter(rows.s, (x) => !x.Session)) + length(unique(filter(rows.s.Session, (x) => x))) AS "Sessions", max(rows.goal_minutes) AS "Goal"',
      `FROM ${dqlString(o.folder)}`,
      fileWhereDql(o),
      "FLATTEN file.lists AS s",
      lineWhereDql("focus", true),
      "GROUP BY file.day",
      `SORT key ${o.sort === "oldest" ? "ASC" : "DESC"}`,
    ].join("\n")
  );
}

/**
 * Focus minutes and sessions for each task (its name, tags kept), most
 * first. Sessions are counted as the daily totals count them: a split
 * session that comes back to a task has two lines for it under one Session.
 */
export function timeByTask(o: QueryOptions): string {
  return fenced(
    "dataview",
    [
      'TABLE WITHOUT ID key AS "Task", round(sum(rows.s.Total) / 60) AS "Minutes", length(filter(rows.s, (x) => !x.Session)) + length(unique(filter(rows.s.Session, (x) => x))) AS "Sessions"',
      `FROM ${dqlString(o.folder)}`,
      fileWhereDql(o),
      "FLATTEN file.lists AS s",
      lineWhereDql("focus", true),
      "GROUP BY string(s.Task)",
      "SORT sum(rows.s.Total) DESC",
    ].join("\n")
  );
}

/**
 * The sessions table as DataviewJS, reading the same lines through
 * `dv.pages` — not the plugin's API, so it runs with the plugin off and is
 * the user's own to change. `folder` holds the folder DQL-escaped (`\` and
 * `"`, dqlEscape), as it must stand inside Dataview's quotes; that is its name
 * unless the name holds one of those two.
 */
export function sessionsTableJs(o: QueryOptions): string {
  const today = todayJs(o);
  const lines: string[] = [`const folder = ${JSON.stringify(dqlEscape(o.folder))};`, FOCUS_JS];
  if (o.kinds === "all") lines.push(BREAK_JS);
  switch (o.range) {
    case "note":
      lines.push("const from = dv.current().file.day;", "const to = from;");
      break;
    case "today":
      lines.push(`const from = ${today};`, "const to = from;");
      break;
    case "week":
      lines.push(`const from = ${today}.minus({ days: 6 });`, "const to = null;");
      break;
    case "month":
      lines.push(`const from = ${today}.minus({ days: 29 });`, "const to = null;");
      break;
    case "all":
      lines.push("const from = null;", "const to = null;");
      break;
  }
  lines.push("const rows = [];");
  lines.push('for (const p of dv.pages(`"${folder}"`)) {');
  lines.push(
    `  if (!p.file.day || !p.file.name.endsWith(${JSON.stringify(LOG_NAME_SUFFIX)})) continue;`
  );
  if (o.range === "note") {
    lines.push("  if (!from || +p.file.day !== +from) continue;");
  } else {
    lines.push("  if (from && p.file.day < from) continue;");
    lines.push("  if (to && p.file.day > to) continue;");
  }
  lines.push("  for (const s of p.file.lists) {");
  lines.push(
    o.kinds === "all"
      ? "    if (!isFocus(s) && !isBreak(s)) continue;"
      : "    if (!isFocus(s)) continue;"
  );
  if (!o.skipped) lines.push('    if (s.Status === "cancelled") continue;');
  lines.push("    rows.push({ p, s });");
  lines.push("  }");
  lines.push("}");
  lines.push(
    o.sort === "oldest"
      ? "rows.sort((a, b) => (a.s.Start < b.s.Start ? -1 : 1));"
      : "rows.sort((a, b) => (a.s.Start < b.s.Start ? 1 : -1));"
  );
  const columns = onColumns(o);
  lines.push("dv.table(");
  lines.push(`  [${columns.map((column) => JSON.stringify(column.head)).join(", ")}],`);
  lines.push("  rows.map(({ p, s }) => [");
  for (const column of columns) {
    lines.push(`    ${column.id === "task" ? taskJs(o) : column.js},`);
  }
  lines.push("  ])");
  lines.push(");");
  return fenced("dataviewjs", lines.join("\n"));
}

/** What each Copy button copies. */
export type QueryCopyKind = "sessions" | "sessions-js" | "totals" | "by-task";

export function queryCode(kind: QueryCopyKind, o: QueryOptions): string {
  switch (kind) {
    case "sessions":
      return sessionsTable(o);
    case "sessions-js":
      return sessionsTableJs(o);
    case "totals":
      return dailyTotals(o);
    case "by-task":
      return timeByTask(o);
  }
}
