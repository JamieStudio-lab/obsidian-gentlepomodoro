import { describe, it, expect } from "vitest";
import {
  QUERY_COLUMNS,
  QUERY_PRESETS,
  dailyTotals,
  dqlEscape,
  dqlString,
  fenced,
  addQueryColumn,
  arrangeQueryColumns,
  formatQueryColumns,
  moveShownColumn,
  presetColumns,
  removeQueryColumn,
  queryCode,
  queryFolder,
  queryOptions,
  resolveQueryColumns,
  resolveQueryKinds,
  resolveQueryRange,
  resolveQuerySort,
  sessionsTable,
  sessionsTableJs,
  timeByTask,
  type QueryOptions,
} from "../logQueries";
import { DEFAULT_SETTINGS } from "../constants";
import { LOG_FILE_SUFFIX, LOG_TAIL_KEYS } from "../logLine";
import { dailyLogPath } from "../logFolder";

/**
 * The Log tables' code, as text (logQueries.ts). What the code DOES is
 * tests/dataviewEngine.test.ts's: it runs every variant in Dataview's own
 * engine. This holds what the settings make of their stored values, and the
 * text itself, letter for letter: the 0.7.0 preview's, with review round 2's
 * three changes (a line Convert wrote with no Type, a file Dataview cannot
 * date, a session counted once in time by task), each run in the engine.
 */

const SIMPLE_WEEK: QueryOptions = {
  folder: "Pomodoro_logs",
  dayStartHour: 0,
  columns: presetColumns("simple"),
  range: "week",
  kinds: "focus",
  skipped: true,
  sort: "newest",
};

describe("the columns setting", () => {
  it("offers every column once, with a header and both forms of its cell", () => {
    const ids = QUERY_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(18);
    for (const c of QUERY_COLUMNS) {
      expect(c.label, c.id).not.toBe("");
      expect(c.head, c.id).not.toBe("");
      expect(c.dql, c.id).toMatch(/\b(s|file)\./);
    }
  });

  it("offers a column for every field of the tail but OffsetChange", () => {
    // OffsetChange is in the UTC offset at the end, which the table does not
    // show; every other tail field has its column.
    const read = QUERY_COLUMNS.map((c) => c.dql).join(" ");
    for (const key of LOG_TAIL_KEYS.filter((k) => k !== "OffsetChange")) {
      expect(read, key).toContain(`s.${key}`);
    }
  });

  it("puts a preset's columns first, on, then the rest off in catalog order", () => {
    const simple = presetColumns("simple");
    expect(simple.filter((c) => c.on).map((c) => c.id)).toEqual(QUERY_PRESETS.simple);
    expect(simple.slice(0, QUERY_PRESETS.simple.length).every((c) => c.on)).toBe(true);
    const rest = QUERY_COLUMNS.map((c) => c.id).filter(
      (id) => !(QUERY_PRESETS.simple as readonly string[]).includes(id)
    );
    expect(simple.slice(QUERY_PRESETS.simple.length).map((c) => c.id)).toEqual(rest);
    expect(presetColumns("detailed").filter((c) => c.on)).toHaveLength(10);
  });

  it("stores one string, a - before a column that is off, and reads it back", () => {
    expect(DEFAULT_SETTINGS.queryColumns).toBe(
      "date,start,task,minutes,status,-end,-planned,-overtime,-pauses,-type,-endedby,-startedby,-cycle,-slept,-dropped,-device,-session,-offset"
    );
    expect(resolveQueryColumns(DEFAULT_SETTINGS.queryColumns)).toEqual(presetColumns("simple"));
    const detailed = presetColumns("detailed");
    expect(resolveQueryColumns(formatQueryColumns(detailed))).toEqual(detailed);
  });

  it("is never trusted as stored", () => {
    // Case and spaces, an unknown id, a repeat (the first wins), and every
    // column the value lacks added off; the off ones in catalog order,
    // whatever order the value put them in.
    const read = resolveQueryColumns(" Task , -DATE, nonsense, task, - offset, minutes, -minutes");
    expect(read.slice(0, 2)).toEqual([
      { id: "task", on: true },
      { id: "minutes", on: true },
    ]);
    expect(read).toHaveLength(QUERY_COLUMNS.length);
    expect(read.slice(2).every((c) => !c.on)).toBe(true);
    expect(read.slice(2).map((c) => c.id)).toEqual(
      QUERY_COLUMNS.map((c) => c.id).filter((id) => !["task", "minutes"].includes(id))
    );
  });

  it("falls back to Simple when nothing would show, or the value is not text", () => {
    for (const raw of ["", "-date,-task", "nonsense", 3, null, undefined, ["date"]]) {
      expect(resolveQueryColumns(raw), String(raw)).toEqual(presetColumns("simple"));
    }
  });

  // The Columns row: the shown columns in their order, then the others in
  // catalog order — what its list and its "Add a column" buttons show.
  const shown = (columns: readonly { id: string; on: boolean }[] | null) =>
    columns?.filter((c) => c.on).map((c) => c.id);
  const hiddenInOrder = (columns: readonly { id: string; on: boolean }[] | null) =>
    columns?.filter((c) => !c.on).map((c) => c.id);
  const catalogWithout = (ids: string[]) =>
    QUERY_COLUMNS.map((c) => c.id as string).filter((id) => !ids.includes(id));

  it("arranges the shown columns in their order, then the rest in catalog order", () => {
    // Out of order, the off columns among the on ones, as no reading leaves
    // them now (resolveQueryColumns arranges too).
    const stored = [
      { id: "offset", on: false },
      { id: "task", on: true },
      { id: "end", on: false },
      { id: "date", on: true },
      ...QUERY_COLUMNS.filter(
        (c) => !["offset", "task", "end", "date", "start"].includes(c.id)
      ).map((c) => ({ id: c.id, on: false })),
      { id: "start", on: true },
    ] as Parameters<typeof arrangeQueryColumns>[0];
    expect(resolveQueryColumns(formatQueryColumns(stored))).toEqual(arrangeQueryColumns(stored));
    const arranged = arrangeQueryColumns(stored);
    expect(shown(arranged)).toEqual(["task", "date", "start"]);
    expect(hiddenInOrder(arranged)).toEqual(catalogWithout(["task", "date", "start"]));
    expect(arranged).toHaveLength(QUERY_COLUMNS.length);
    // A preset is already arranged, and the list given is left as it was.
    expect(arrangeQueryColumns(presetColumns("detailed"))).toEqual(presetColumns("detailed"));
    expect(stored[0]).toEqual({ id: "offset", on: false });
  });

  it("adds a column at the end of the table, and only one that is not in it", () => {
    const columns = resolveQueryColumns("-end,task,-offset,date");
    const added = addQueryColumn(columns, "offset");
    expect(shown(added)).toEqual(["task", "date", "offset"]);
    expect(hiddenInOrder(added)).toEqual(catalogWithout(["task", "date", "offset"]));
    expect(addQueryColumn(columns, "task")).toBeNull();
    expect(addQueryColumn(columns, "nonsense" as never)).toBeNull();
    expect(shown(columns)).toEqual(["task", "date"]);
  });

  it("removes a column back among the others in catalog order, never the last one", () => {
    const columns = resolveQueryColumns("device,task,date");
    const removed = removeQueryColumn(columns, "device");
    expect(shown(removed)).toEqual(["task", "date"]);
    // Back in its catalog place among the others, not where it was.
    expect(hiddenInOrder(removed)).toEqual(catalogWithout(["task", "date"]));
    expect(removeQueryColumn(columns, "end")).toBeNull();
    expect(removeQueryColumn(resolveQueryColumns("task"), "task")).toBeNull();
    expect(shown(columns)).toEqual(["device", "task", "date"]);
  });

  it("moves a shown column past the shown one next to it, whatever lies between in storage", () => {
    // Hidden columns between shown ones: ↑ on task must pass date at once,
    // not swap with the hidden start and look as if nothing happened.
    const columns = resolveQueryColumns("date,-start,task,-end,minutes");
    expect(shown(moveShownColumn(columns, "task", -1))).toEqual(["task", "date", "minutes"]);
    expect(shown(moveShownColumn(columns, "task", 1))).toEqual(["date", "minutes", "task"]);
    expect(moveShownColumn(columns, "date", -1)).toBeNull();
    expect(moveShownColumn(columns, "minutes", 1)).toBeNull();
    expect(moveShownColumn(columns, "start", -1)).toBeNull();
    expect(hiddenInOrder(moveShownColumn(columns, "task", -1))).toEqual(
      catalogWithout(["date", "task", "minutes"])
    );
    expect(shown(columns)).toEqual(["date", "task", "minutes"]);
  });

  it("arranges a list given in any order before moving or adding, as each says", () => {
    // Not from resolveQueryColumns, which arranges already: a list with
    // hidden columns between the shown ones, as a caller could pass.
    const raw = [
      { id: "offset", on: false },
      { id: "date", on: true },
      { id: "start", on: false },
      { id: "task", on: true },
      { id: "end", on: false },
      { id: "minutes", on: true },
      ...QUERY_COLUMNS.filter(
        (c) => !["offset", "date", "start", "task", "end", "minutes"].includes(c.id)
      ).map((c) => ({ id: c.id, on: false })),
    ] as Parameters<typeof arrangeQueryColumns>[0];
    expect(shown(moveShownColumn(raw, "task", -1))).toEqual(["task", "date", "minutes"]);
    expect(hiddenInOrder(moveShownColumn(raw, "task", -1))).toEqual(
      catalogWithout(["date", "task", "minutes"])
    );
    const added = addQueryColumn(raw, "end");
    expect(shown(added)).toEqual(["date", "task", "minutes", "end"]);
    expect(hiddenInOrder(added)).toEqual(catalogWithout(["date", "task", "minutes", "end"]));
    expect(hiddenInOrder(removeQueryColumn(raw, "task"))).toEqual(
      catalogWithout(["date", "minutes"])
    );
  });

  it("writes an arranged list back as it reads", () => {
    const added = addQueryColumn(presetColumns("simple"), "end");
    expect(added).not.toBeNull();
    if (added === null) return;
    expect(resolveQueryColumns(formatQueryColumns(added))).toEqual(added);
    expect(formatQueryColumns(added).startsWith("date,start,task,minutes,status,end,-")).toBe(true);
  });
});

describe("the other choices", () => {
  it("reads each through an id list, falling back to its default", () => {
    expect(resolveQueryRange("month")).toBe("month");
    expect(resolveQueryRange("toString")).toBe("week");
    expect(resolveQueryRange(undefined)).toBe("week");
    expect(resolveQueryKinds("all")).toBe("all");
    expect(resolveQueryKinds("breaks")).toBe("focus");
    expect(resolveQuerySort("oldest")).toBe("oldest");
    expect(resolveQuerySort(1)).toBe("newest");
  });

  it("defaults to the last 7 days, focus only, skipped shown, newest first", () => {
    expect(queryOptions(DEFAULT_SETTINGS, "Logs")).toEqual({
      folder: "Logs",
      dayStartHour: 0,
      columns: presetColumns("simple"),
      range: "week",
      kinds: "focus",
      skipped: true,
      sort: "newest",
    });
  });

  it("takes a Day starts at the row does not offer as midnight", () => {
    expect(queryOptions({ ...DEFAULT_SETTINGS, dayStartHour: 9 }, "L").dayStartHour).toBe(0);
    expect(queryOptions({ ...DEFAULT_SETTINGS, dayStartHour: 4 }, "L").dayStartHour).toBe(4);
  });
});

describe("the folder filled in", () => {
  it("is the setting normalised as the timer's path is, spaces kept", () => {
    // The timer writes to " Pomodoro_logs/…" for a stored " Pomodoro_logs"
    // (dailyLogPath trims nothing), so the copied code must read that folder.
    expect(queryFolder(" Pomodoro_logs", null)).toEqual({ folder: " Pomodoro_logs" });
    expect(dailyLogPath(" Pomodoro_logs", "2026-10-23")).toBe(
      ` Pomodoro_logs/2026-10-23${LOG_FILE_SUFFIX}`
    );
    expect(queryFolder("Pomodoro_logs/", null)).toEqual({ folder: "Pomodoro_logs" });
    expect(queryFolder("Logs//2026", null)).toEqual({ folder: "Logs/2026" });
    expect(queryFolder("   ", null)).toEqual({ refused: "none" });
  });

  it("is the vault's own spelling when the setting spells it another way", () => {
    expect(queryFolder("pomodoro_logs", { kind: "case", real: "Pomodoro_logs" })).toEqual({
      folder: "Pomodoro_logs",
    });
  });

  it("is refused with no folder, or the vault's top level", () => {
    expect(queryFolder("", null)).toEqual({ refused: "none" });
    expect(queryFolder("   ", null)).toEqual({ refused: "none" });
    expect(queryFolder("/", { kind: "root" })).toEqual({ refused: "root" });
    expect(queryFolder("//", null)).toEqual({ refused: "root" });
  });

  it("goes inside Dataview's quotes with Dataview's own two escapes", () => {
    expect(dqlEscape('Logs "2026"\\x')).toBe('Logs \\"2026\\"\\\\x');
    expect(dqlString('a"b')).toBe('"a\\"b"');
    const o = { ...SIMPLE_WEEK, folder: 'Logs "Q4"' };
    expect(sessionsTable(o)).toContain('FROM "Logs \\"Q4\\""');
    // DataviewJS builds the same source text: `"${folder}"`.
    expect(sessionsTableJs(o)).toContain('const folder = "Logs \\\\\\"Q4\\\\\\"";');
  });
});

describe("the fence", () => {
  it("is three backticks, or one more than the longest run inside", () => {
    expect(fenced("dataview", "x")).toBe("```dataview\nx\n```");
    expect(fenced("dataview", "a ``` b")).toBe("````dataview\na ``` b\n````");
    expect(fenced("dataview", "a ````` b ` c")).toBe("``````dataview\na ````` b ` c\n``````");
  });

  it("cannot be closed early by a folder's name", () => {
    for (const kind of ["sessions", "sessions-js", "totals", "by-task"] as const) {
      const code = queryCode(kind, { ...SIMPLE_WEEK, folder: "Odd ```name" });
      const fence = /^`+/.exec(code)?.[0] ?? "";
      expect(fence.length, kind).toBe(4);
      expect(code.endsWith(`\n${fence}`), kind).toBe(true);
      expect(code.slice(fence.length).split("\n").slice(0, -1).join("\n"), kind).not.toMatch(
        /^````/m
      );
    }
  });
});

describe("the code, letter for letter", () => {
  it("the sessions table", () => {
    expect(sessionsTable(SIMPLE_WEEK)).toBe(
      [
        "```dataview",
        'TABLE WITHOUT ID file.day AS "Date", substring(s.Start, 11, 16) AS "Start", s.Task AS "Task", choice(s.Total != null, round(default(s.Total, 0) / 60), null) AS "Minutes", s.Status AS "Status"',
        'FROM "Pomodoro_logs"',
        'WHERE file.day AND endswith(file.name, "-gentle-pomodoro-log") AND file.day >= date(today) - dur(6 days)',
        "FLATTEN file.lists AS s",
        'WHERE (s.Type = "focus" OR (s.Type = null AND s.Start != null AND s.Total != null AND startswith(s.text, "🍅 Focus [")))',
        "SORT s.Start DESC",
        "```",
      ].join("\n")
    );
  });

  it("the sessions table for DataviewJS", () => {
    expect(sessionsTableJs(SIMPLE_WEEK)).toBe(
      [
        "```dataviewjs",
        'const folder = "Pomodoro_logs";',
        'const isFocus = (s) => s.Type === "focus" || (s.Type == null && s.Start != null && s.Total != null && s.text.startsWith("🍅 Focus ["));',
        'const from = dv.date("today").minus({ days: 6 });',
        "const to = null;",
        "const rows = [];",
        'for (const p of dv.pages(`"${folder}"`)) {',
        '  if (!p.file.day || !p.file.name.endsWith("-gentle-pomodoro-log")) continue;',
        "  if (from && p.file.day < from) continue;",
        "  if (to && p.file.day > to) continue;",
        "  for (const s of p.file.lists) {",
        "    if (!isFocus(s)) continue;",
        "    rows.push({ p, s });",
        "  }",
        "}",
        "rows.sort((a, b) => (a.s.Start < b.s.Start ? 1 : -1));",
        "dv.table(",
        '  ["Date", "Start", "Task", "Minutes", "Status"],',
        "  rows.map(({ p, s }) => [",
        "    p.file.day,",
        "    s.Start ? s.Start.slice(11, 16) : null,",
        "    s.Task ?? null,",
        '    typeof s.Total === "number" ? Math.round(s.Total / 60) : null,',
        "    s.Status ?? null,",
        "  ])",
        ");",
        "```",
      ].join("\n")
    );
  });

  it("the daily totals", () => {
    expect(dailyTotals(SIMPLE_WEEK)).toBe(
      [
        "```dataview",
        'TABLE WITHOUT ID key AS "Day", round(sum(rows.s.Total) / 60) AS "Focus minutes", length(filter(rows.s, (x) => !x.Session)) + length(unique(filter(rows.s.Session, (x) => x))) AS "Sessions", max(rows.goal_minutes) AS "Goal"',
        'FROM "Pomodoro_logs"',
        'WHERE file.day AND endswith(file.name, "-gentle-pomodoro-log") AND file.day >= date(today) - dur(6 days)',
        "FLATTEN file.lists AS s",
        'WHERE (s.Type = "focus" OR (s.Type = null AND s.Start != null AND s.Total != null AND startswith(s.text, "🍅 Focus ["))) AND s.Status != "cancelled"',
        "GROUP BY file.day",
        "SORT key DESC",
        "```",
      ].join("\n")
    );
  });

  it("time by task", () => {
    expect(timeByTask(SIMPLE_WEEK)).toBe(
      [
        "```dataview",
        'TABLE WITHOUT ID key AS "Task", round(sum(rows.s.Total) / 60) AS "Minutes", length(filter(rows.s, (x) => !x.Session)) + length(unique(filter(rows.s.Session, (x) => x))) AS "Sessions"',
        'FROM "Pomodoro_logs"',
        'WHERE file.day AND endswith(file.name, "-gentle-pomodoro-log") AND file.day >= date(today) - dur(6 days)',
        "FLATTEN file.lists AS s",
        'WHERE (s.Type = "focus" OR (s.Type = null AND s.Start != null AND s.Total != null AND startswith(s.text, "🍅 Focus ["))) AND s.Status != "cancelled"',
        "GROUP BY string(s.Task)",
        "SORT sum(rows.s.Total) DESC",
        "```",
      ].join("\n")
    );
  });

  it("reads a Day starts at off the clock's hour, in both languages", () => {
    const o = { ...SIMPLE_WEEK, range: "today" as const, dayStartHour: 4 };
    expect(sessionsTable(o)).toContain(
      "file.day = choice(date(now).hour < 4, date(today) - dur(1 day), date(today))"
    );
    expect(sessionsTableJs(o)).toContain(
      'const from = (dv.date("now").hour < 4 ? dv.date("today").minus({ days: 1 }) : dv.date("today"));'
    );
  });

  it("leaves skipped focus out of the sessions table only when asked", () => {
    expect(sessionsTable(SIMPLE_WEEK)).not.toContain("cancelled");
    expect(sessionsTable({ ...SIMPLE_WEEK, skipped: false })).toContain('s.Status != "cancelled"');
    expect(sessionsTableJs({ ...SIMPLE_WEEK, skipped: false })).toContain(
      'if (s.Status === "cancelled") continue;'
    );
  });
});
