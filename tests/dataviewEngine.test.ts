import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  DATAVIEW_BUNDLE,
  buildIndex,
  cellText,
  runDataviewJs,
  runDql,
  setNow,
  type FakeFiles,
  type TableResult,
} from "./dataviewEngine";
import {
  QUERY_COLUMNS,
  QUERY_KINDS,
  QUERY_RANGES,
  QUERY_SORTS,
  dailyTotals,
  formatQueryColumns,
  presetColumns,
  sessionsTable,
  sessionsTableJs,
  timeByTask,
  todayDql,
  todayJs,
  type ColumnChoice,
  type QueryOptions,
  type QueryRange,
} from "../logQueries";
import {
  formatLogLine,
  logSeconds,
  parseFocusTotalSeconds,
  parseLogLine,
  type ParsedLogLine,
  type SessionLog,
} from "../logLine";
import { convertLogContent } from "../logConvert";
import { NO_TASK_LABEL } from "../constants";
import type { MomentLike } from "../momentTypes";

/**
 * The code the Copy buttons give, run in Dataview 0.5.68's own engine
 * (tests/dataviewEngine.ts) over a made-up vault: every variant logQueries.ts
 * can make — each Days choice, both Sessions choices, skipped focus in and
 * out, both orders, every column on, the two presets, the daily totals, time
 * by task, the DataviewJS table, a "Day starts at" hour, and a log folder
 * named with spaces and quotes. Dataview drops a row whose cell fails
 * WITHOUT a word, so each table is held to a count worked out apart from
 * Dataview — from the plugin's own reading of the same lines — and to no
 * row error at all; the DQL and DataviewJS tables must give the same rows.
 *
 * The vault holds 0.7.0 lines (the plugin's own writer), 0.6.9 lines (the
 * same writer without a Session ID), lines Convert rewrote from a log older
 * than the Type field (no Type), a pre-0.6.9 line Dataview reads nothing
 * from, a split session that comes back to its task, a note in each log
 * folder with no date, a dated note there that quotes a log line, which only
 * the file-name guard keeps out, and a log-named file Dataview cannot date.
 */

const require = createRequire(import.meta.url);
const moment = require("moment") as (input?: unknown) => MomentLike;

const at = (day: string, time: string): MomentLike => moment(new Date(`${day}T${time}:00`));

const WRITING = { taskName: "Draft intro #task/research/paper", taskPath: "Projects/Writing.md" };
const OUTLINE = {
  taskName: "Outline section 2 #task/research/paper",
  taskPath: "Projects/Writing.md",
};
const ADMIN = { taskName: "Inbox", taskPath: "Projects/Admin.md" };
const NO_TASK = { taskName: NO_TASK_LABEL };

interface Span {
  day: string;
  from: string;
  to: string;
}

/** A focus line, by the plugin's own writer: 0.6.9's without `tail`, 0.7.0's with. */
function focus(
  span: Span,
  task: { taskName: string; taskPath?: string },
  more: Partial<SessionLog> = {}
): string {
  return formatLogLine({
    mode: "focus",
    ...task,
    scheduledDurationMinutes: 25,
    startTime: at(span.day, span.from),
    endTime: at(span.day, span.to),
    pauses: [],
    status: "finished",
    overtimeSeconds: 0,
    ...more,
  });
}

function rest(span: Span, breakType: "short" | "long", more: Partial<SessionLog> = {}): string {
  return formatLogLine({
    mode: "break",
    taskName: NO_TASK_LABEL,
    scheduledDurationMinutes: breakType === "long" ? 15 : 5,
    startTime: at(span.day, span.from),
    endTime: at(span.day, span.to),
    pauses: [],
    status: "finished",
    breakType,
    ...more,
  });
}

/** A line from before the Type field, as Convert old log lines writes it: no Type. */
const converted = (v1: string): string => convertLogContent(v1).content;

const tail = (id: string, more: Partial<SessionLog> = {}): Partial<SessionLog> => ({
  sessionId: `s00000000${id}`,
  startedBy: "start",
  endedBy: "time-up",
  plannedSeconds: 1500,
  ...more,
});

/** The days and their lines, latest last. Each day file has its own goal. */
const DAYS: { day: string; goal: number; lines: string[] }[] = [
  {
    day: "2026-09-01",
    goal: 60,
    lines: [
      focus({ day: "2026-09-01", from: "09:00", to: "09:25" }, WRITING, { taskId: "abc123" }),
    ],
  },
  // The edges of the last 30 days and the last 7, today being the 23rd: the
  // 24th of September and the 17th of October are in, the day before each out.
  ...["2026-09-23", "2026-09-24", "2026-10-16", "2026-10-17"].map((day) => ({
    day,
    goal: 100,
    lines: [focus({ day, from: "08:00", to: "08:30" }, OUTLINE)],
  })),
  {
    day: "2026-10-14",
    goal: 120,
    lines: [
      focus({ day: "2026-10-14", from: "09:00", to: "09:25" }, WRITING, { taskId: "abc123" }),
      rest({ day: "2026-10-14", from: "09:25", to: "09:30" }, "short"),
    ],
  },
  {
    day: "2026-10-20",
    goal: 120,
    lines: [
      // Rewritten by Convert from a log older than the Type field, which
      // invents no Type: the daily goal counts them, so the tables must too.
      // Each starts at a time no other line does, so a test can find it.
      converted(
        "- 🍅 Focus | Task:: [[Projects/Writing.md|Draft intro #task/research/paper]] | Start:: 2026-10-20 07:05:00 | End:: 2026-10-20 07:30:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished"
      ),
      converted(
        "- ☕ Rest | Start:: 2026-10-20 07:35:00 | End:: 2026-10-20 07:50:00 | Scheduled:: 900 | Total:: 900"
      ),
      // Notes of the user's own that begin with a marker's word and carry a
      // Total: the goal never reads them (parseLogLine refuses them), and no
      // table may — one Total Dataview reads as a duration would make a
      // day's sum fail, which drops the whole day from the totals.
      "- 🍅 Focus today, in all [Total:: 4h]",
      "- 🍅 Focused reading [Total:: 600]",
      "- ☕ Rest of the week off [Total:: 300]",
      // And notes that begin with the marker and a link, as a log line
      // begins with a field: no Total, so no table takes them.
      "- 🍅 Focus [[Projects/Writing.md]] went well",
      "- ☕ Rest [[Projects/Admin.md]] after lunch",
      // A link and a Total, but no Start: the duration would fail the day's
      // sum, which drops the whole day.
      "- 🍅 Focus [[Projects/Writing.md]] felt slow, about [Total:: 1h]",
      "- ☕ Rest [[Projects/Admin.md]] by hand [Total:: 600]",
      // Fields as a log line has them, but not a session's: one without a
      // Total, one without a Start. The plugin reads both; no table shows them.
      "- 🍅 Focus [Task:: Plan the week] [Start:: 2026-10-20 06:00:00]",
      "- ☕ Rest [Total:: 120]",
      // A session split at two switches that comes back to its task: two
      // lines for Writing under one Session, which time by task counts once.
      focus(
        { day: "2026-10-20", from: "09:00", to: "09:10" },
        WRITING,
        tail("m", { endedBy: "stop", cycle: 1 })
      ),
      focus(
        { day: "2026-10-20", from: "09:10", to: "09:12" },
        ADMIN,
        tail("m", { endedBy: "stop", cycle: 1 })
      ),
      focus(
        { day: "2026-10-20", from: "09:12", to: "09:25" },
        WRITING,
        tail("m", { endedBy: "stop", cycle: 1 })
      ),
    ],
  },
  {
    day: "2026-10-21",
    goal: 120,
    lines: [
      // Before 0.6.9: Dataview reads no field from it, so no table shows it.
      "- 🍅 Focus | Task:: X | Start:: 2026-10-21 08:00:00 | End:: 2026-10-21 08:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus",
      "- ☕ Rest | Start:: 2026-10-21 08:25:00 | End:: 2026-10-21 08:30:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break",
      rest({ day: "2026-10-21", from: "09:25", to: "09:30" }, "short"),
      focus({ day: "2026-10-21", from: "10:00", to: "10:25" }, WRITING, { taskId: "abc123" }),
    ],
  },
  {
    day: "2026-10-22",
    goal: 90,
    lines: [
      focus({ day: "2026-10-22", from: "09:00", to: "09:30" }, WRITING, {
        taskId: "abc123",
        overtimeSeconds: 300,
      }),
      focus({ day: "2026-10-22", from: "11:00", to: "11:02" }, NO_TASK, { status: "cancelled" }),
      // The day's first 0.7.0 line: the upgrade happened at lunch.
      focus(
        { day: "2026-10-22", from: "14:00", to: "14:25" },
        ADMIN,
        tail("a", { endedBy: "planned-end", cycle: 1, droppedSeconds: 40 })
      ),
    ],
  },
  {
    day: "2026-10-23",
    goal: 120,
    lines: [
      focus(
        { day: "2026-10-23", from: "09:00", to: "09:25" },
        WRITING,
        tail("b", { taskId: "abc123", cycle: 2 } as Partial<SessionLog>)
      ),
      rest(
        { day: "2026-10-23", from: "09:25", to: "09:30" },
        "short",
        tail("c", { startedBy: "auto", plannedSeconds: 300 })
      ),
      // A session split at a task switch: two lines, one Session.
      focus(
        { day: "2026-10-23", from: "10:00", to: "10:12" },
        OUTLINE,
        tail("d", { startedBy: "reset", endedBy: "stop", cycle: 3 })
      ),
      focus(
        { day: "2026-10-23", from: "10:12", to: "10:25" },
        ADMIN,
        tail("d", { startedBy: "reset", endedBy: "stop", cycle: 3 })
      ),
      focus({ day: "2026-10-23", from: "13:00", to: "14:10" }, NO_TASK, {
        ...tail("e", { startedBy: "auto", endedBy: "stop", cycle: 4 }),
        pauses: [{ start: at("2026-10-23", "13:10"), end: at("2026-10-23", "13:50") }],
        sleeps: [[at("2026-10-23", "13:10").valueOf(), at("2026-10-23", "13:50").valueOf()]],
        overtimeSeconds: 300,
        device: "Work laptop",
      }),
      focus({ day: "2026-10-23", from: "15:00", to: "15:03" }, ADMIN, {
        ...tail("f", { endedBy: "skip" }),
        status: "cancelled",
      }),
      rest(
        { day: "2026-10-23", from: "16:00", to: "16:15" },
        "long",
        tail("g", { startedBy: "auto", plannedSeconds: 900 })
      ),
      focus(
        { day: "2026-10-23", from: "17:00", to: "17:25" },
        WRITING,
        tail("h", { endedBy: "recovered-planned-end", cycle: 1 })
      ),
      focus(
        { day: "2026-10-23", from: "18:00", to: "18:20" },
        WRITING,
        tail("j", { startedBy: "added", endedBy: "added" })
      ),
      focus({ day: "2026-10-23", from: "19:00", to: "19:31" }, ADMIN, {
        ...tail("k", { startedBy: "auto", endedBy: "recovered", plannedSeconds: 1800, cycle: 2 }),
        scheduledDurationMinutes: 30,
        overtimeSeconds: 60,
      }),
      // Written by hand, and no session: a Type that is only PART of one of
      // the plugin's. `contains()` would take both — it matches inside text,
      // and inside each string of a list — so the kinds must be ORs.
      "- A walk outside [Type:: break]",
      "- Half a session, typed by hand [Type:: focu]",
    ],
  },
];

const TODAY_LINES = DAYS.find((d) => d.day === "2026-10-23")?.lines ?? [];

/** The two log folders: an ordinary one, and one with spaces and quotes, nested. */
const PLAIN = "Pomodoro_logs";
const AWKWARD = 'Focus logs/Q4 "deep" work';
const FOLDERS = [PLAIN, AWKWARD];

/** Where the code is pasted: a daily note (This note's day — not today), and a
 *  note with no date. */
const DAILY_NOTE = "Daily/2026-10-22.md";
const WEEK_NOTE = "Reviews/Week.md";

function vault(): FakeFiles {
  const files: FakeFiles = {};
  for (const folder of FOLDERS) {
    for (const { day, goal, lines } of DAYS) {
      files[`${folder}/${day}-gentle-pomodoro-log.md`] = {
        contents: `---\ngoal_minutes: ${String(goal)}\n---\n\n${lines.join("\n")}\n`,
        frontmatter: { goal_minutes: goal },
      };
    }
    files[`${folder}/About this folder.md`] = {
      contents: "# About\n\n- a plain bullet\n- [Mood:: calm] an unrelated field\n",
    };
    // Dated, in the folder, and a list item with a focus line's fields: only
    // the file-name guard keeps it out of every table.
    files[`${folder}/2026-10-23 notes.md`] = {
      contents: `# Notes\n\nCopied from the log:\n\n${TODAY_LINES[0]}\n`,
    };
    // Named like a daily log, in digits Dataview cannot date (0.6.8 wrote
    // such names): no day, so no table shows it — in DQL as in DataviewJS,
    // and not under "This note's day" in a note that has no day either.
    files[`${folder}/٢٠٢٦-١٠-٢٢-gentle-pomodoro-log.md`] = {
      contents: `${TODAY_LINES[0]}\n${TODAY_LINES[1]}\n`,
    };
  }
  files["Projects/Writing.md"] = { contents: "# Writing\n\n- [ ] Draft intro 🆔 abc123\n" };
  files["Projects/Admin.md"] = { contents: "# Admin\n\n- [ ] Inbox\n" };
  files[DAILY_NOTE] = { contents: "# Thursday\n" };
  files[WEEK_NOTE] = { contents: "# Week review\n" };
  return files;
}

/* ===== What the tables should hold, worked out apart from Dataview ===== */

interface Expected {
  day: string;
  parsed: ParsedLogLine;
  type: string;
  /** What the goal counts it as: its Type, or with no Type its marker. */
  kind: "focus" | "rest" | "";
  start: string;
}

/**
 * With no Type, a line is known by its marker — and only as a session when
 * it has a Start and a Total, as every line the timer, Convert or Fix writes
 * does (the rule logQueries.ts states); else it is no session at all.
 */
function kindOf(parsed: ParsedLogLine): Expected["kind"] {
  const type = parsed.values.get("Type");
  if (type === undefined) {
    return parsed.values.has("Start") && parsed.values.has("Total") ? parsed.kind : "";
  }
  if (type === "focus") return "focus";
  return type === "short-break" || type === "long-break" ? "rest" : "";
}

/** Every line Dataview can read (version 2), through the plugin's own reader. */
const READABLE: Expected[] = DAYS.flatMap(({ day, lines }) =>
  lines
    .map((line) => parseLogLine(line))
    .filter((p): p is ParsedLogLine => p !== null && p.format === "v2")
    .map((parsed) => ({
      day,
      parsed,
      type: parsed.values.get("Type") ?? "",
      kind: kindOf(parsed),
      start: parsed.values.get("Start") ?? "",
    }))
);

/** The day files a Days choice covers, for "today" `today`. */
function daysIn(range: QueryRange, today: string, origin: string): string[] {
  const all = DAYS.map((d) => d.day);
  const back = (n: number) => moment(new Date(`${today}T12:00:00`)).subtract(n, "days");
  const since = (n: number) => all.filter((d) => d >= stampDay(back(n)));
  switch (range) {
    case "note":
      return origin === DAILY_NOTE ? ["2026-10-22"] : [];
    case "today":
      return all.filter((d) => d === today);
    case "week":
      return since(6);
    case "month":
      return since(29);
    case "all":
      return all;
  }
}

function stampDay(m: MomentLike): string {
  return (m as unknown as { format(f: string): string }).format("YYYY-MM-DD");
}

function expectedSessions(o: QueryOptions, today: string, origin: string): Expected[] {
  const days = daysIn(o.range, today, origin);
  const rows = READABLE.filter(
    (line) =>
      days.includes(line.day) &&
      (o.kinds === "all" ? line.kind !== "" : line.kind === "focus") &&
      (o.skipped || line.parsed.values.get("Status") !== "cancelled")
  );
  rows.sort((a, b) => (a.start < b.start ? -1 : 1));
  return o.sort === "oldest" ? rows : rows.reverse();
}

/** The focus that counts toward the goal: not skipped. */
function countedFocus(range: QueryRange, today: string, origin: string): Expected[] {
  const days = daysIn(range, today, origin);
  return READABLE.filter(
    (line) =>
      days.includes(line.day) &&
      line.kind === "focus" &&
      line.parsed.values.get("Status") !== "cancelled"
  );
}

const minutes = (lines: Expected[]) =>
  Math.round(lines.reduce((sum, l) => sum + (logSeconds(l.parsed, "Total") ?? 0), 0) / 60);

/** Sessions as the totals count them: a line without a Session is one, a Session once. */
function sessionCount(lines: Expected[]): number {
  const ids = lines.map((l) => l.parsed.values.get("Session"));
  return ids.filter((id) => id === undefined).length + new Set(ids.filter(Boolean)).size;
}

/**
 * Each column's cell as the harness prints it, from the plugin's own reading
 * of the line: the oracle every column is held to, so a column that shows
 * another field — in both languages at once — is caught.
 */
function expectedCell(id: string, line: Expected, kinds: QueryOptions["kinds"]): string {
  const value = (key: string) => line.parsed.values.get(key);
  const text = (key: string) => (value(key) === undefined ? "-" : JSON.stringify(value(key)));
  const mins = (key: string) => {
    const seconds = logSeconds(line.parsed, key);
    return seconds === null ? "-" : String(Math.round(seconds / 60));
  };
  const hasSession = value("Session") !== undefined;
  switch (id) {
    case "date":
      return `date(${line.day} 00:00)`;
    case "start":
      return JSON.stringify(line.start.slice(11, 16));
    case "end":
      return JSON.stringify((value("End") ?? "").slice(11, 16));
    case "task": {
      if (kinds === "all" && line.kind === "rest") {
        return line.type === "long-break" ? '"Long break"' : '"Break"';
      }
      const task = value("Task");
      if (task === undefined) return "-";
      return task.startsWith("[[") ? task : JSON.stringify(task);
    }
    case "minutes":
      return mins("Total");
    case "planned":
      return mins("Planned");
    case "overtime":
      return mins("Overtime");
    case "pauses": {
      const pauses = value("Pauses");
      return pauses === undefined ? "-" : String(pauses.split(" - ").length - 1);
    }
    case "status":
      return text("Status");
    case "type":
      return text("Type");
    case "endedby":
      return text("EndedBy");
    case "startedby":
      return text("StartedBy");
    case "cycle":
      return value("Cycle") ?? "-";
    case "slept":
      return hasSession ? String(Math.round((logSeconds(line.parsed, "Slept") ?? 0) / 60)) : "-";
    case "dropped":
      return hasSession ? String(Math.round((logSeconds(line.parsed, "Dropped") ?? 0) / 60)) : "-";
    case "device":
      return text("Device");
    case "session":
      return text("Session");
    case "offset": {
      const written = value("Offset");
      return written === undefined ? "-" : String(Number(written) / 60);
    }
  }
  throw new Error(`no expected cell for the column ${id}`);
}

/* ===== Running ===== */

const ALL_ON: ColumnChoice[] = QUERY_COLUMNS.map((c) => ({ id: c.id, on: true }));

const options = (over: Partial<QueryOptions> = {}): QueryOptions => ({
  folder: PLAIN,
  dayStartHour: 0,
  columns: ALL_ON,
  range: "week",
  kinds: "focus",
  skipped: true,
  sort: "newest",
  ...over,
});

const texts = (table: TableResult) => table.rows.map((row) => row.map(cellText));

let index: unknown;
beforeAll(async () => {
  index = await buildIndex(vault());
});

/** Midday on 2026-10-23, local time: "today" for every test but the hour's. */
const NOON = new Date(2026, 9, 23, 12, 0);

describe("the Dataview fixture", () => {
  it("is Dataview 0.5.68's main.js as the plugin directory ships it, with its licence", () => {
    // The vault's own copy at the time it was taken: if this changes, the
    // fixture was replaced and every count here was checked against another
    // engine.
    const sha1 = createHash("sha1").update(readFileSync(DATAVIEW_BUNDLE)).digest("hex");
    expect(sha1).toBe("ada06164ae4cfba6d75721cf884a953a0acd7801");
    const licence = readFileSync(resolve(dirname(DATAVIEW_BUNDLE), "LICENSE.txt"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Copyright (c) 2021 Michael Brenan");
  });

  it("reads the new fields as Dataview's own worker does: numbers, text, signed offsets", async () => {
    setNow(NOON);
    const table = await runDql(
      [
        "```dataview",
        'TABLE WITHOUT ID typeof(s.Session) AS "a", typeof(s.Planned) AS "b", typeof(s.Offset) AS "c", typeof(s.Slept) AS "d", typeof(s.Device) AS "e"',
        `FROM "${PLAIN}"`,
        "FLATTEN file.lists AS s",
        'WHERE s.Device != null AND endswith(file.name, "-gentle-pomodoro-log")',
        "```",
      ].join("\n"),
      index,
      WEEK_NOTE
    );
    expect(texts(table)).toEqual([['"string"', '"number"', '"number"', '"number"', '"string"']]);
  });
});

describe("the sessions table, every variant", () => {
  const variants: QueryOptions[] = [];
  for (const folder of FOLDERS)
    for (const { value: range } of QUERY_RANGES)
      for (const { value: kinds } of QUERY_KINDS)
        for (const skipped of [true, false])
          for (const { value: sort } of QUERY_SORTS)
            variants.push(options({ folder, range, kinds, skipped, sort }));
  const name = (o: QueryOptions) =>
    `${o.folder === PLAIN ? "plain" : "awkward"} folder, ${o.range}, ${o.kinds}, ${o.skipped ? "with" : "without"} skipped, ${o.sort}`;

  it.each(variants.map((o) => [name(o), o] as const))(
    "%s: every row, in order, the same in DQL and DataviewJS",
    async (_name, o) => {
      setNow(NOON);
      for (const origin of [DAILY_NOTE, WEEK_NOTE]) {
        const want = expectedSessions(o, "2026-10-23", origin);
        const dql = await runDql(sessionsTable(o), index, origin);
        const js = await runDataviewJs(sessionsTableJs(o), index, origin);
        expect(dql.rowErrors, origin).toEqual([]);
        expect(dql.headers).toEqual(QUERY_COLUMNS.map((c) => c.head));
        expect(js.headers).toEqual(dql.headers);
        expect(dql.rows.length, origin).toBe(want.length);
        expect(texts(js), origin).toEqual(texts(dql));
        // In order: the day, then the start, of each line.
        expect(texts(dql).map((row) => [row[0], row[1]])).toEqual(
          want.map((l) => [`date(${l.day} 00:00)`, JSON.stringify(l.start.slice(11, 16))])
        );
      }
    }
  );

  it("finds rows at all in the variants that should have them", async () => {
    setNow(NOON);
    // Guards the guard: a fake vault Dataview read nothing from would pass
    // every count above with zero rows.
    const table = await runDql(
      sessionsTable(options({ range: "all", kinds: "all" })),
      index,
      WEEK_NOTE
    );
    expect(table.rows.length).toBe(READABLE.filter((l) => l.kind !== "").length);
    expect(table.rows.length).toBeGreaterThan(15);
  });
});

describe("the sessions table's cells", () => {
  const column = (table: TableResult, head: string) => {
    const at = table.headers.indexOf(head);
    expect(at, head).toBeGreaterThan(-1);
    return texts(table).map((row) => row[at]);
  };
  const oldest = options({ range: "all", kinds: "all", sort: "oldest" });
  const want = expectedSessions(oldest, "2026-10-23", WEEK_NOTE);
  const hasSession = want.map((l) => l.parsed.values.has("Session"));

  it("shows - for Planned on a line from before 0.7.0, never its Scheduled", async () => {
    setNow(NOON);
    const table = await runDql(sessionsTable(oldest), index, WEEK_NOTE);
    const planned = column(table, "Planned");
    planned.forEach((cell, i) => {
      expect(cell, want[i].start).toBe(
        hasSession[i] ? String(logSeconds(want[i].parsed, "Planned")! / 60) : "-"
      );
    });
    expect(planned).toContain("-");
  });

  it("shows Slept and Dropped as 0 on a 0.7.0 line without them, and - on an older line", async () => {
    setNow(NOON);
    const table = await runDql(sessionsTable(oldest), index, WEEK_NOTE);
    for (const head of ["Slept", "Dropped"]) {
      const cells = column(table, head);
      cells.forEach((cell, i) => {
        const key = head === "Slept" ? "Slept" : "Dropped";
        const written = logSeconds(want[i].parsed, key);
        const expected = !hasSession[i] ? "-" : String(Math.round((written ?? 0) / 60));
        expect(cell, `${head} ${want[i].start}`).toBe(expected);
      });
    }
    expect(column(table, "Slept")).toContain("40");
    expect(column(table, "Dropped")).toContain("1");
  });

  it("names a break in the Task column, and keeps a focus line's link", async () => {
    setNow(NOON);
    const table = await runDql(sessionsTable(oldest), index, WEEK_NOTE);
    const tasks = column(table, "Task");
    want.forEach((line, i) => {
      if (line.type === "long-break") expect(tasks[i]).toBe('"Long break"');
      else if (line.kind === "rest") expect(tasks[i]).toBe('"Break"');
      else expect(tasks[i]).not.toMatch(/Break/);
    });
    expect(tasks).toContain("[[Projects/Writing.md|Draft intro #task/research/paper]]");
  });

  it.each([["focus" as const], ["all" as const]])(
    "shows every column's own field, %s: each cell against the plugin's reading of its line",
    async (kinds) => {
      setNow(NOON);
      const o = options({ range: "all", kinds, sort: "oldest" });
      const lines = expectedSessions(o, "2026-10-23", WEEK_NOTE);
      for (const table of [
        await runDql(sessionsTable(o), index, WEEK_NOTE),
        await runDataviewJs(sessionsTableJs(o), index, WEEK_NOTE),
      ]) {
        expect(table.headers).toEqual(QUERY_COLUMNS.map((c) => c.head));
        expect(texts(table)).toEqual(
          lines.map((line) => QUERY_COLUMNS.map((c) => expectedCell(c.id, line, kinds)))
        );
      }
      // The oracle's own reach: these lines put a value, not "-", in every
      // column, so no column could pass by being empty everywhere.
      for (const c of QUERY_COLUMNS) {
        expect(
          lines.some((line) => expectedCell(c.id, line, kinds) !== "-"),
          c.id
        ).toBe(true);
      }
    }
  );

  it("shows a line Convert wrote with no Type: in Focus only as in Focus and breaks", async () => {
    setNow(NOON);
    const at = (rows: string[][], start: string) =>
      rows.filter((r) => r[0] === "date(2026-10-20 00:00)" && r[1] === start).length;
    for (const kinds of ["focus", "all"] as const) {
      const o = options({ range: "all", kinds, sort: "oldest" });
      for (const table of [
        await runDql(sessionsTable(o), index, WEEK_NOTE),
        await runDataviewJs(sessionsTableJs(o), index, WEEK_NOTE),
      ]) {
        const rows = texts(table);
        expect(at(rows, '"07:05"'), kinds).toBe(1);
        expect(at(rows, '"07:35"'), kinds).toBe(kinds === "all" ? 1 : 0);
      }
    }
  });

  it("counts pauses and shows the offset in hours", async () => {
    setNow(NOON);
    const table = await runDql(sessionsTable(oldest), index, WEEK_NOTE);
    expect(column(table, "Pauses")).toContain("1");
    const offset = column(table, "UTC offset");
    want.forEach((line, i) => {
      const written = line.parsed.values.get("Offset");
      expect(offset[i]).toBe(written === undefined ? "-" : String(Number(written) / 60));
    });
  });

  it.each([
    ["Simple", presetColumns("simple")],
    ["Detailed", presetColumns("detailed")],
  ] as const)("runs the %s preset, its columns only", async (_name, columns) => {
    setNow(NOON);
    const o = options({ columns, range: "all", kinds: "all" });
    const dql = await runDql(sessionsTable(o), index, WEEK_NOTE);
    const js = await runDataviewJs(sessionsTableJs(o), index, WEEK_NOTE);
    const heads = columns
      .filter((c) => c.on)
      .map((c) => QUERY_COLUMNS.find((q) => q.id === c.id)!.head);
    expect(dql.headers).toEqual(heads);
    expect(dql.rowErrors).toEqual([]);
    expect(dql.rows.length).toBe(READABLE.filter((l) => l.kind !== "").length);
    expect(texts(js)).toEqual(texts(dql));
    expect(formatQueryColumns(columns)).toMatch(/^date,start,/);
  });
});

describe("the daily totals", () => {
  it.each(
    QUERY_RANGES.flatMap(({ value: range }) =>
      QUERY_SORTS.map(({ value: sort }) => [range, sort] as const)
    )
  )(
    "%s, %s: focus minutes, sessions (a split one once) and the day's goal",
    async (range, sort) => {
      setNow(NOON);
      for (const folder of FOLDERS) {
        const o = options({ folder, range, sort });
        const table = await runDql(dailyTotals(o), index, DAILY_NOTE);
        expect(table.rowErrors).toEqual([]);
        const days = [
          ...new Set(countedFocus(range, "2026-10-23", DAILY_NOTE).map((l) => l.day)),
        ].sort();
        if (sort === "newest") days.reverse();
        expect(texts(table)).toEqual(
          days.map((day) => {
            const lines = countedFocus(range, "2026-10-23", DAILY_NOTE).filter(
              (l) => l.day === day
            );
            const goal = DAYS.find((d) => d.day === day)!.goal;
            return [
              `date(${day} 00:00)`,
              String(minutes(lines)),
              String(sessionCount(lines)),
              String(goal),
            ];
          })
        );
      }
    }
  );

  it("counts the split session once: six sessions in seven lines on the 23rd", async () => {
    setNow(NOON);
    const table = await runDql(dailyTotals(options({ range: "today" })), index, DAILY_NOTE);
    expect(texts(table)).toEqual([["date(2026-10-23 00:00)", "156", "6", "120"]]);
  });
});

describe("time by task", () => {
  it.each(QUERY_RANGES.map(({ value }) => value))(
    "%s: one row per task (two tasks of one note apart), most minutes first, a session once",
    async (range) => {
      setNow(NOON);
      for (const folder of FOLDERS) {
        const table = await runDql(timeByTask(options({ folder, range })), index, DAILY_NOTE);
        expect(table.rowErrors).toEqual([]);
        const lines = countedFocus(range, "2026-10-23", DAILY_NOTE);
        const tasks = [...new Set(lines.map((l) => l.parsed.values.get("Task") ?? ""))];
        const want = tasks
          .map((task) => {
            const of = lines.filter((l) => l.parsed.values.get("Task") === task);
            return [JSON.stringify(task), String(minutes(of)), String(sessionCount(of))];
          })
          .sort((a, b) => Number(b[1]) - Number(a[1]));
        expect(texts(table)).toEqual(want);
      }
    }
  );

  it("counts a split session that comes back to its task once: two lines, one session", async () => {
    setNow(NOON);
    const o = options({ range: "all" });
    const rows = texts(await runDql(timeByTask(o), index, DAILY_NOTE));
    const writing = rows.find((row) => row[0].includes("Draft intro"));
    const lines = countedFocus("all", "2026-10-23", DAILY_NOTE).filter((l) =>
      (l.parsed.values.get("Task") ?? "").includes("Draft intro")
    );
    expect(lines.length).toBeGreaterThan(sessionCount(lines));
    expect(writing?.[2]).toBe(String(sessionCount(lines)));
  });

  it("keeps the two tasks of Writing.md apart", async () => {
    setNow(NOON);
    const table = await runDql(timeByTask(options({ range: "today" })), index, DAILY_NOTE);
    expect(texts(table).map((row) => row[0])).toEqual([
      '"[[Projects/Writing.md|Draft intro #task/research/paper]]"',
      '"[[Projects/Admin.md|Inbox]]"',
      '"No Task"',
      '"[[Projects/Writing.md|Outline section 2 #task/research/paper]]"',
    ]);
  });
});

describe("Day starts at", () => {
  // 01:30 on the 24th: with a 4:00 start the plugin's today is still the
  // 23rd, and the copied code must say so too.
  const LATE = new Date(2026, 9, 24, 1, 30);

  it.each([
    [4, 8],
    [0, 0],
  ] as const)("with %s:00, today at 01:30 shows %s focus lines", async (hour, count) => {
    setNow(LATE);
    for (const folder of FOLDERS) {
      const o = options({ folder, range: "today", dayStartHour: hour });
      const dql = await runDql(sessionsTable(o), index, WEEK_NOTE);
      const js = await runDataviewJs(sessionsTableJs(o), index, WEEK_NOTE);
      expect(dql.rowErrors).toEqual([]);
      expect(dql.rows.length).toBe(count);
      expect(texts(js)).toEqual(texts(dql));
      const totals = await runDql(dailyTotals(o), index, WEEK_NOTE);
      expect(totals.rows.length).toBe(count > 0 ? 1 : 0);
      const byTask = await runDql(timeByTask(o), index, WEEK_NOTE);
      expect(byTask.rows.length).toBe(count > 0 ? 4 : 0);
    }
  });

  describe("on the mornings the clocks change, in America/Chicago", () => {
    // The copied "today" must be the day logicalDate gives, read off the
    // clock's hour. Taking 4 hours off the instant gets two of them a day
    // wrong: 04:30 just after spring forward and 03:30 just after fall back.
    let saved: string | undefined;
    beforeAll(() => {
      saved = process.env.TZ;
      process.env.TZ = "America/Chicago";
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    it.each([
      ["2026-03-08T09:30:00Z", "2026-03-08"], // 04:30 CDT, an hour after spring forward
      ["2026-03-08T08:30:00Z", "2026-03-07"], // 03:30 CDT, before the 4:00 start
      ["2026-11-01T09:30:00Z", "2026-10-31"], // 03:30 CST, after fall back
      ["2026-11-01T10:00:00Z", "2026-11-01"], // 04:00 CST
      ["2026-11-01T06:30:00Z", "2026-10-31"], // 01:30 CDT, the first pass
    ])("at %s the plugin's today is %s, in both languages", async (instant, day) => {
      setNow(new Date(instant));
      const o = options({ range: "today", dayStartHour: 4 });
      const dql = await runDql(
        [
          "```dataview",
          `TABLE WITHOUT ID dateformat(${todayDql(o)}, "yyyy-MM-dd") AS "Today"`,
          `FROM "${PLAIN}"`,
          "LIMIT 1",
          "```",
        ].join("\n"),
        index,
        WEEK_NOTE
      );
      expect(dql.rowErrors).toEqual([]);
      expect(dql.rows.map((row) => cellText(row[0]))).toEqual([JSON.stringify(day)]);
      const js = await runDataviewJs(
        [
          "```dataviewjs",
          `dv.table(["Today"], [[${todayJs(o)}.toFormat("yyyy-MM-dd")]]);`,
          "```",
        ].join("\n"),
        index,
        WEEK_NOTE
      );
      expect(js.rows.map((row) => cellText(row[0]))).toEqual([JSON.stringify(day)]);
    });
  });

  it("counts the week back from the plugin's today", async () => {
    setNow(LATE);
    const o = options({ range: "week", dayStartHour: 4, kinds: "all" });
    const dql = await runDql(sessionsTable(o), index, WEEK_NOTE);
    const js = await runDataviewJs(sessionsTableJs(o), index, WEEK_NOTE);
    expect(dql.rows.length).toBe(expectedSessions(o, "2026-10-23", WEEK_NOTE).length);
    expect(texts(js)).toEqual(texts(dql));
  });
});

describe("the README's two example queries", () => {
  // README.md says they were run in Dataview; this runs them, so an edit to
  // them is held to the same counts as the copied code.
  const readme = readFileSync(resolve(dirname(DATAVIEW_BUNDLE), "../../../README.md"), "utf8");
  const examples = [...readme.matchAll(/^```dataview\n[\s\S]*?^```$/gm)]
    .map((m) => m[0])
    .filter((block) => block.includes('FROM "Your log folder"'));
  const run = (block: string) =>
    runDql(block.replace('FROM "Your log folder"', `FROM "${PLAIN}"`), index, WEEK_NOTE);

  it("are both there", () => {
    expect(examples).toHaveLength(2);
  });

  it("list the latest twenty focus sessions, a line Convert wrote with no Type among them", async () => {
    setNow(NOON);
    const focus = READABLE.filter((l) => l.kind === "focus").sort((a, b) =>
      a.start < b.start ? 1 : -1
    );
    const starts = (table: TableResult) => texts(table).map((row) => row[1]);
    const table = await run(examples[0]);
    expect(table.rowErrors).toEqual([]);
    expect(starts(table)).toEqual(focus.slice(0, 20).map((l) => JSON.stringify(l.start)));
    // And without its LIMIT, which would cut a wrong row a sort puts last:
    // every focus line, and nothing that is not one.
    expect(examples[0]).toContain("\nLIMIT 20\n");
    const all = await run(examples[0].replace("\nLIMIT 20\n", "\n"));
    expect(all.rowErrors).toEqual([]);
    expect(starts(all)).toEqual(focus.map((l) => JSON.stringify(l.start)));
  });

  it("add up each day's focus the way the daily goal does, once its old lines are converted", async () => {
    setNow(NOON);
    const table = await run(examples[1]);
    expect(table.rowErrors).toEqual([]);
    const days = [...new Set(countedFocus("all", "2026-10-23", WEEK_NOTE).map((l) => l.day))]
      .sort()
      .reverse();
    // Against the goal's own count of each day's file, less the lines still
    // in the old format, which Dataview reads nothing from.
    const goalMinutes = (day: string) => {
      const lines = DAYS.find((d) => d.day === day)?.lines ?? [];
      const readable = lines.filter((line) => parseLogLine(line)?.format !== "v1");
      return Math.round(parseFocusTotalSeconds(readable.join("\n")) / 60);
    };
    expect(texts(table)).toEqual(
      days.map((day) => [`date(${day} 00:00)`, String(goalMinutes(day))])
    );
    expect(days).toContain("2026-10-20");
  });
});
