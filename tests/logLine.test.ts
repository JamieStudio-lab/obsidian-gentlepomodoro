import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_START_HOURS,
  dailyLogFileName,
  formatLogLine,
  formatTaskValue,
  logSeconds,
  logicalDate,
  parseFocusTotalSeconds,
  parseLogLine,
  replaceTaskValue,
  resolveDayStartHour,
  sanitizeAlias,
  stamp,
  type SessionLog,
} from "../logLine";
import type { MomentLike } from "../momentTypes";

// The real moment, with the locales that write native digits loaded into the
// SAME instance (a locale file requires "../moment", so both go through require).
const require = createRequire(import.meta.url);
const moment = require("moment") as ((input?: unknown) => MomentLike) & {
  locale(key?: string): string;
};
require("moment/locale/ar");
require("moment/locale/fa");
moment.locale("en");

afterEach(() => {
  moment.locale("en");
});

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) =>
  moment(new Date(y, mo - 1, d, h, mi, s, ms));

describe("sanitizeAlias", () => {
  it("keeps what a wikilink shows: its alias, else its target", () => {
    expect(sanitizeAlias("Read [[Some Paper]] today")).toBe("Read Some Paper today");
    expect(sanitizeAlias("Read [[Papers/Some Paper|the paper]]")).toBe("Read the paper");
    expect(sanitizeAlias("[[a|[[b]]]]")).toBe("b");
  });

  it("turns any other bracket into a parenthesis", () => {
    expect(sanitizeAlias("Fix [bug] in parser")).toBe("Fix (bug) in parser");
    expect(sanitizeAlias("Fix a]b")).toBe("Fix a)b");
    expect(sanitizeAlias("Read [paper](https://x.org/1)")).toBe("Read (paper)(https://x.org/1)");
  });

  it("turns '::' into ':', so a name cannot hold a field", () => {
    expect(sanitizeAlias("Write report Total:: 7")).toBe("Write report Total: 7");
    expect(sanitizeAlias("a:::b")).toBe("a:b");
    expect(sanitizeAlias("Note: x")).toBe("Note: x");
  });

  it("puts a name on one line and collapses runs of spaces", () => {
    expect(sanitizeAlias("  one\ntwo\r\nthree\tfour   five\u2028six ")).toBe(
      "one two three four five six"
    );
  });

  it("drops a trailing backslash, which would escape the field's closing bracket", () => {
    expect(sanitizeAlias("ab\\")).toBe("ab");
    expect(sanitizeAlias("ab \\ \\\\ ")).toBe("ab");
    expect(sanitizeAlias("a\\b")).toBe("a\\b");
  });

  it("keeps '|', tags, emoji and everything else", () => {
    const name = "Compare A | B #task/research/x 📚 ⏫ (v2) — ok";
    expect(sanitizeAlias(name)).toBe(name);
  });

  it("gives the same answer twice (a rename compares what it wrote)", () => {
    for (const name of [
      "Read [[Some Paper]] [x]",
      "a::: b \\",
      "[[a|b]] :: c\nd",
      "x [[y",
      "z]] w",
    ]) {
      expect(sanitizeAlias(sanitizeAlias(name))).toBe(sanitizeAlias(name));
    }
  });
});

describe("formatTaskValue", () => {
  it("links a session that had a note, and names one that had none", () => {
    expect(formatTaskValue("Write docs", "Projects/Docs.md")).toBe(
      "[[Projects/Docs.md|Write docs]]"
    );
    expect(formatTaskValue("Write docs")).toBe("Write docs");
    expect(formatTaskValue("")).toBe("No Task");
    expect(formatTaskValue("[[]]", "Projects/Docs.md")).toBe("[[Projects/Docs.md]]");
  });
});

describe("stamp and logicalDate", () => {
  it("writes English digits whatever language Obsidian is in", () => {
    // Obsidian calls moment.locale(<app language>); in Arabic and Persian
    // format() gives native digits, which no date reader can parse.
    for (const lang of ["ar", "fa"]) {
      moment.locale(lang);
      const at = local(2026, 10, 2, 9, 5, 7);
      expect(at.format("YYYY-MM-DD")).not.toBe("2026-10-02");
      expect(stamp(at, "YYYY-MM-DD HH:mm:ss")).toBe("2026-10-02 09:05:07");
      expect(logicalDate(at, 0)).toBe("2026-10-02");
      // The moment it was given keeps its own locale.
      expect(at.format("YYYY-MM-DD")).not.toBe("2026-10-02");
    }
  });

  it("writes a whole log line in English digits under Arabic", () => {
    moment.locale("ar");
    const line = formatLogLine({
      mode: "focus",
      taskName: "Write docs",
      scheduledDurationMinutes: 25,
      startTime: local(2026, 10, 2, 10, 0),
      endTime: local(2026, 10, 2, 10, 30),
      pauses: [{ start: local(2026, 10, 2, 10, 10), end: local(2026, 10, 2, 10, 15) }],
      status: "finished",
    });
    expect(line).toContain("[Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:30:00]");
    expect(line).toContain('[Pauses:: ["2026-10-02 10:10:00 - 2026-10-02 10:15:00"]]');
    expect(line).toMatch(/^[\x20-\x7E🍅]*$/u);
  });

  it("starts the day at midnight by default", () => {
    expect(logicalDate(local(2026, 10, 2, 0, 0), 0)).toBe("2026-10-02");
    expect(logicalDate(local(2026, 10, 1, 23, 59, 59), 0)).toBe("2026-10-01");
  });

  it("counts the hours before 'Day starts at' as the day before", () => {
    expect(logicalDate(local(2026, 10, 2, 3, 59, 59), 4)).toBe("2026-10-01");
    expect(logicalDate(local(2026, 10, 2, 4, 0), 4)).toBe("2026-10-02");
    expect(logicalDate(local(2026, 10, 1, 0, 30), 6)).toBe("2026-09-30");
  });

  it("reads anything but a whole hour 0-6 as midnight", () => {
    expect(DAY_START_HOURS).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const hour of DAY_START_HOURS) expect(resolveDayStartHour(hour)).toBe(hour);
    for (const bad of [7, -1, 1.5, "4", Number.NaN, null, undefined]) {
      expect(resolveDayStartHour(bad)).toBe(0);
      expect(logicalDate(local(2026, 10, 2, 0, 30), bad)).toBe("2026-10-02");
    }
  });

  it("names the daily log file", () => {
    expect(dailyLogFileName("2026-10-02")).toBe("2026-10-02-gentle-pomodoro-log.md");
  });
});

/**
 * Runs a describe block's tests in another time zone. Node re-reads TZ when
 * it is assigned, and moment works on Date, so both follow it.
 */
function inZone(zone: string): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

// Each case: [wall clock y, mo, d, h, mi, the hours to add after it (to reach
// the second pass of a repeated hour), day start hour, the day it belongs to].
type ChangeNightCase = [number, number, number, number, number, number, number, string];

describe.each<[string, number, ChangeNightCase[]]>([
  [
    "Europe/Berlin",
    // 2026-03-29 04:30 is summer time: two hours ahead of UTC.
    -120,
    [
      // Spring forward, 2026-03-29 02:00 → 03:00.
      [2026, 3, 29, 4, 30, 0, 4, "2026-03-29"],
      [2026, 3, 29, 3, 0, 0, 3, "2026-03-29"],
      [2026, 3, 29, 3, 30, 0, 4, "2026-03-28"],
      [2026, 3, 29, 1, 30, 0, 2, "2026-03-28"],
      // Fall back, 2026-10-25 03:00 → 02:00: 02:00-02:59 comes twice.
      [2026, 10, 25, 3, 30, 0, 4, "2026-10-24"],
      [2026, 10, 25, 4, 0, 0, 4, "2026-10-25"],
      [2026, 10, 25, 2, 30, 1, 3, "2026-10-24"],
      [2026, 10, 25, 3, 0, 0, 3, "2026-10-25"],
    ],
  ],
  [
    "America/Chicago",
    // 2026-03-29 04:30 is daylight time: five hours behind UTC.
    300,
    [
      // Spring forward, 2026-03-08 02:00 → 03:00.
      [2026, 3, 8, 4, 30, 0, 4, "2026-03-08"],
      [2026, 3, 8, 3, 0, 0, 3, "2026-03-08"],
      [2026, 3, 8, 3, 30, 0, 4, "2026-03-07"],
      // Fall back, 2026-11-01 02:00 → 01:00: 01:00-01:59 comes twice.
      [2026, 11, 1, 2, 30, 0, 3, "2026-10-31"],
      [2026, 11, 1, 3, 30, 0, 4, "2026-10-31"],
      [2026, 11, 1, 4, 0, 0, 4, "2026-11-01"],
      [2026, 11, 1, 1, 30, 1, 2, "2026-10-31"],
      [2026, 11, 1, 2, 0, 0, 2, "2026-11-01"],
    ],
  ],
])("logicalDate on the nights the clocks change, in %s", (zone, offset, cases) => {
  inZone(zone);

  it("runs in that zone", () => {
    expect(new Date(2026, 2, 29, 4, 30).getTimezoneOffset()).toBe(offset);
  });

  it.each(cases)(
    "%i-%i-%i %i:%i (+%i h) with the day starting at %i:00 belongs to %s, by its clock hour",
    (y, mo, d, h, mi, plusHours, dayStart, expected) => {
      const when = local(y, mo, d, h, mi).add(plusHours, "hours");
      expect(logicalDate(when, dayStart)).toBe(expected);
    }
  );

  it("files every quarter-hour of both nights under its clock date, or the day before before the start hour", () => {
    // Every quarter-hour of Europe's and America's change weekends, against
    // the rule read straight off Date: the local date, one day earlier when
    // the local hour is early.
    const weekends = [
      [2, 7],
      [2, 28],
      [9, 24],
      [9, 31],
    ].map(([mo, d]) => new Date(2026, mo, d));
    for (const night of weekends) {
      for (let ms = night.getTime(); ms < night.getTime() + 3 * 86_400_000; ms += 900_000) {
        for (const dayStart of DAY_START_HOURS) {
          const clock = new Date(ms);
          if (clock.getHours() < dayStart) clock.setDate(clock.getDate() - 1);
          const want = [
            clock.getFullYear(),
            String(clock.getMonth() + 1).padStart(2, "0"),
            String(clock.getDate()).padStart(2, "0"),
          ].join("-");
          expect(logicalDate(moment(ms), dayStart), new Date(ms).toString()).toBe(want);
        }
      }
    }
  });
});

const session = (overrides: Partial<SessionLog> = {}): SessionLog => ({
  mode: "focus",
  taskName: "Write docs #task/research/x",
  taskPath: "Projects/01 Research/Docs.md",
  taskId: "abc123",
  scheduledDurationMinutes: 25,
  startTime: local(2026, 10, 2, 10, 0),
  endTime: local(2026, 10, 2, 10, 35),
  pauses: [{ start: local(2026, 10, 2, 10, 10), end: local(2026, 10, 2, 10, 15) }],
  status: "finished",
  overtimeSeconds: 300,
  ...overrides,
});

const V1_FOCUS =
  "- 🍅 Focus | Task:: [[Projects/Docs.md|Write docs #task/research/x]] | ID:: abc123 | " +
  "Start:: 2026-09-30 09:00:00 | End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | " +
  "Total:: 1500 | Status:: finished | Type:: focus";

describe("parseLogLine — version 2", () => {
  it("reads every field of a focus line, in order, as written", () => {
    const line = formatLogLine(session());
    const parsed = parseLogLine(line);

    expect(parsed?.kind).toBe("focus");
    expect(parsed?.format).toBe("v2");
    expect(parsed?.prefix).toBe("- ");
    expect(parsed?.rest).toBe("");
    expect(parsed?.fields.map((f) => [f.key, f.value])).toEqual([
      ["Task", "[[Projects/01 Research/Docs.md|Write docs #task/research/x]]"],
      ["ID", "abc123"],
      ["Start", "2026-10-02 10:00:00"],
      ["End", "2026-10-02 10:35:00"],
      ["Scheduled", "1500"],
      ["Pauses", '["2026-10-02 10:10:00 - 2026-10-02 10:15:00"]'],
      ["Total", "1800"],
      ["Status", "finished"],
      ["Type", "focus"],
      ["Overtime", "300"],
    ]);
    for (const field of parsed?.fields ?? []) {
      expect(line.slice(field.start, field.end)).toBe(field.value);
    }
    expect(parsed?.task).toMatchObject({
      path: "Projects/01 Research/Docs.md",
      name: "Write docs #task/research/x",
    });
    expect(parsed && logSeconds(parsed, "Total")).toBe(1800);
    expect(parsed && logSeconds(parsed, "Overtime")).toBe(300);
  });

  it("reads a rest line, which has no Task", () => {
    const parsed = parseLogLine(
      formatLogLine(session({ mode: "break", breakType: "long", pauses: [] }))
    );
    expect(parsed?.kind).toBe("rest");
    expect(parsed?.task).toBeNull();
    expect([...(parsed?.values.keys() ?? [])]).toEqual([
      "Start",
      "End",
      "Scheduled",
      "Total",
      "Type",
    ]);
    expect(parsed?.values.get("Type")).toBe("long-break");
  });

  it("gives back the sanitized name of every awkward task name, with every field intact", () => {
    for (const name of [
      "Compare A | B #task/research/x",
      "Fix a]b [c] thing",
      "Read [[Some Paper]] and [[P/Q|the other]]",
      "Write report [Total:: 7] [Status:: cancelled]",
      "ends in a backslash \\",
      "No Task",
      "line\nbreak\ttab",
      "Run `x` (now) ^b #tag/y ⏫ 📚",
    ]) {
      const parsed = parseLogLine(formatLogLine(session({ taskName: name })));
      expect(parsed?.task?.name).toBe(sanitizeAlias(name));
      expect(parsed?.task?.path).toBe("Projects/01 Research/Docs.md");
      expect(parsed?.values.get("Total")).toBe("1800");
      expect(parsed?.values.get("Status")).toBe("finished");
      expect(parsed?.fields).toHaveLength(10);
    }
  });

  it("reads an unlinked Task as a name with no path", () => {
    const parsed = parseLogLine(
      formatLogLine(session({ taskName: "No Task", taskPath: undefined }))
    );
    expect(parsed?.task).toMatchObject({ raw: "No Task", name: "No Task" });
    expect(parsed?.task?.path).toBeUndefined();
  });

  it("closes a field where Dataview does: by bracket depth, a backslash escaping", () => {
    // Both read with Dataview 0.5.68's own index worker: Task "x [y] z" and
    // "a\] b", Total 5 on each.
    const nested = parseLogLine("- 🍅 Focus [Task:: x [y] z] [Total:: 5]");
    expect(nested?.values.get("Task")).toBe("x [y] z");
    expect(nested?.values.get("Total")).toBe("5");
    const escaped = parseLogLine("- 🍅 Focus [Task:: a\\] b] [Total:: 5]");
    expect(escaped?.values.get("Task")).toBe("a\\] b");
    expect(escaped?.values.get("Total")).toBe("5");
  });

  it("keeps text after the last field apart, and reads a CRLF line", () => {
    const parsed = parseLogLine("- 🍅 Focus [Task:: A] [Total:: 900] great session\r");
    expect(parsed?.rest).toBe("great session");
    expect(parsed?.values.get("Total")).toBe("900");
    expect(parseLogLine(`${formatLogLine(session())}\r`)?.values.get("Overtime")).toBe("300");
  });
});

describe("parseLogLine — version 1 (every version before 0.6.9)", () => {
  it("reads a focus line, its Task as a link", () => {
    const parsed = parseLogLine(V1_FOCUS);
    expect(parsed?.format).toBe("v1");
    expect(parsed?.kind).toBe("focus");
    expect([...(parsed?.values.entries() ?? [])]).toEqual([
      ["Task", "[[Projects/Docs.md|Write docs #task/research/x]]"],
      ["ID", "abc123"],
      ["Start", "2026-09-30 09:00:00"],
      ["End", "2026-09-30 09:25:00"],
      ["Scheduled", "1500"],
      ["Pauses", "[]"],
      ["Total", "1500"],
      ["Status", "finished"],
      ["Type", "focus"],
    ]);
    for (const field of parsed?.fields ?? []) {
      expect(V1_FOCUS.slice(field.start, field.end)).toBe(field.value);
    }
    expect(parsed?.task).toMatchObject({
      path: "Projects/Docs.md",
      name: "Write docs #task/research/x",
    });
  });

  it("takes a block ID and tags at the end off the last field, not off a Task", () => {
    const line = `${V1_FOCUS} #review ^abc123`;
    const parsed = parseLogLine(line);
    expect(parsed?.values.get("Type")).toBe("focus");
    expect(parsed?.rest).toBe("#review ^abc123");
    for (const field of parsed?.fields ?? []) {
      expect(line.slice(field.start, field.end)).toBe(field.value);
    }
    // A Status at the end still says the session was skipped.
    const skipped = V1_FOCUS.replace(" | Type:: focus", "").replace("finished", "cancelled");
    expect(parseLogLine(`${skipped} ^s1`)?.values.get("Status")).toBe("cancelled");
    expect(parseFocusTotalSeconds(`${skipped} ^s1`)).toBe(0);
    // A Rest line's Total.
    const rest =
      "- ☕ Rest | Start:: 2026-09-30 09:25:00 | End:: 2026-09-30 09:30:00 | Scheduled:: 300 | Total:: 300 ^r1";
    expect(parseLogLine(rest)).toMatchObject({ rest: "^r1" });
    expect(parseLogLine(rest)?.values.get("Total")).toBe("300");
    // In a Task, tags and the rest are the name.
    const taskLast = "- 🍅 Focus | Start:: 2026-09-30 09:00:00 | Task:: Write #docs ^x";
    expect(parseLogLine(taskLast)?.task?.name).toBe("Write #docs ^x");
    expect(parseLogLine(taskLast)?.rest).toBe("");
    // Text that is not a block ID or a tag stays in the value, as it always did.
    expect(parseLogLine(`${V1_FOCUS} great`)?.values.get("Type")).toBe("focus great");
  });

  it("does not end the Task field at a ' | ' inside the name", () => {
    const line = V1_FOCUS.replace("Write docs", "Compare A | B");
    expect(parseLogLine(line)?.task?.name).toBe("Compare A | B #task/research/x");
    expect(parseLogLine(line)?.values.get("ID")).toBe("abc123");
  });

  it("reads a name written raw by an older version, brackets and links included", () => {
    const line = V1_FOCUS.replace("Write docs", "Read [[Some Paper]] [draft]");
    expect(parseLogLine(line)?.task).toMatchObject({
      path: "Projects/Docs.md",
      name: "Read [[Some Paper]] [draft] #task/research/x",
    });
  });

  it("takes the line's own fields over look-alikes inside the name", () => {
    const line = V1_FOCUS.replace("Write docs", "Odd | Total:: 7 | Status:: cancelled | Task:: x");
    const parsed = parseLogLine(line);
    expect(parsed?.task?.name).toBe(
      "Odd | Total:: 7 | Status:: cancelled | Task:: x #task/research/x"
    );
    expect(parsed?.values.get("Total")).toBe("1500");
    expect(parsed?.values.get("Status")).toBe("finished");
  });

  it("reads the oldest shapes: a checkbox before the marker, no ID, no Type", () => {
    const focus = parseLogLine(
      "- [x] 🍅 Focus | Task:: Garden - Sort seeds | Start:: 2025-12-20 08:15:10 | End:: 2025-12-20 08:16:10 | Scheduled:: 1500 | Pauses:: [] | Total:: 60 | Status:: finished"
    );
    expect(focus).toMatchObject({ kind: "focus", format: "v1", prefix: "- [x] " });
    expect(focus?.task).toMatchObject({ name: "Garden - Sort seeds" });
    expect(focus?.values.has("ID")).toBe(false);
    expect(focus?.values.has("Type")).toBe(false);

    const rest = parseLogLine(
      "- [ ] ☕ Rest | Start:: 2025-12-20 21:40:00 | End:: 2025-12-20 21:40:05 | Scheduled:: 300 | Total:: 5"
    );
    expect(rest).toMatchObject({ kind: "rest", format: "v1", prefix: "- [ ] " });
    expect(rest?.values.get("Total")).toBe("5");
  });

  it("reads the last field clean on a line split from a CRLF file", () => {
    // The rewrites split on "\n" to keep a file's line endings, so each line
    // ends in "\r" — and before Type was written, Status was the last field.
    const line =
      "- 🍅 Focus | Task:: A | Start:: 2026-01-10 09:00:00 | End:: 2026-01-10 09:25:00 | " +
      "Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: cancelled \r";
    const parsed = parseLogLine(line);
    expect(parsed?.values.get("Status")).toBe("cancelled");
    const status = parsed?.fields.find((f) => f.key === "Status");
    expect(status && line.slice(status.start, status.end)).toBe("cancelled");
  });

  it("does not read a line with other text between the marker and its first field", () => {
    // Its fields could be read, but rewriting the line from them would lose
    // the text, so it is not one of the plugin's lines and is left alone.
    expect(parseLogLine("- 🍅 Focus (by hand) | Task:: A | Total:: 900")).toBeNull();
    expect(parseLogLine("- 🍅 Focus (by hand) [Task:: A] [Total:: 900]")).toBeNull();
  });
});

describe("parseLogLine — not a session", () => {
  it.each([
    "",
    "Some notes here.",
    "- 🍅 Focus",
    "- 🍅 Focus great session",
    "A line that mentions 🍅 Focus | Total:: 900",
    "## 🍅 Focus | Total:: 900",
    "- [ ] Write docs 🍅 3 🆔 abc123",
    "- Total:: 1500",
  ])("%j", (line) => {
    expect(parseLogLine(line)).toBeNull();
  });
});

describe("replaceTaskValue", () => {
  it("rewrites only the Task field, in the line's own format", () => {
    const v2 = formatLogLine(session());
    for (const line of [V1_FOCUS, v2]) {
      const parsed = parseLogLine(line);
      if (!parsed?.task) throw new Error("no task");
      const next = replaceTaskValue(line, parsed, "[[Projects/B.md|New $& $1 name]]");
      expect(next.slice(0, parsed.task.start)).toBe(line.slice(0, parsed.task.start));
      expect(next.endsWith(line.slice(parsed.task.end))).toBe(true);
      const reread = parseLogLine(next);
      expect(reread?.format).toBe(parsed.format);
      expect(reread?.task).toMatchObject({ path: "Projects/B.md", name: "New $& $1 name" });
    }
  });
});

describe("only logLine.ts reads or writes a log line", () => {
  // A second regex over log lines is how the two formats would drift apart:
  // it would read one and not the other, or the old "first Total:: anywhere".
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const codeOnly = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const sources = readdirSync(root).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && name !== "logLine.ts"
  );

  it("finds the sources", () => {
    expect(sources).toContain("logManager.ts");
    expect(sources).toContain("TimerEngine.ts");
  });

  it.each(sources)("%s names no log field and no line marker", (name) => {
    const code = codeOnly(readFileSync(resolve(root, name), "utf8"));
    expect(code).not.toMatch(
      /\b(?:Task|ID|Start|End|Scheduled|Pauses|Total|Status|Type|Overtime)::/
    );
    expect(code).not.toContain("🍅 Focus");
    expect(code).not.toContain("☕ Rest");
  });

  it.each(sources)("%s formats no stored date in the app's language", (name) => {
    // Date text that is kept or compared goes through stamp/logicalDate, which
    // set "en" first. A bare format("YYYY…") follows the app language (F14).
    const code = codeOnly(readFileSync(resolve(root, name), "utf8"));
    expect(code).not.toMatch(/\.format\(\s*["'`]Y/);
  });

  it("dates the goal notice, today's total and the long-break counter by the log's day", () => {
    const main = codeOnly(readFileSync(resolve(root, "main.ts"), "utf8"));
    const engine = codeOnly(readFileSync(resolve(root, "TimerEngine.ts"), "utf8"));
    const manager = codeOnly(readFileSync(resolve(root, "logManager.ts"), "utf8"));
    expect(main).toContain("return logicalDate(moment(), this.settings.dayStartHour);");
    // The goal notice's date and the day the totals tracker keys on: both
    // hosts read the same helper (0.6.9 moved the notice into GoalNotice).
    const host = (name: string) => {
      const start = main.indexOf(`private ${name}(): `);
      expect(start, name).toBeGreaterThan(-1);
      const end = main.indexOf("\n  private ", start + 1);
      return main.slice(start, end === -1 ? undefined : end);
    };
    expect(host("createGoalNoticeHost")).toContain("today: () => this.logicalToday(),");
    expect(host("createFocusTotalHost")).toContain("today: () => this.logicalToday(),");
    // The counter takes the day the line is filed under — the session's start,
    // read before ending it closes the log's session (F24) — and the clock's
    // day only when no session is open.
    expect(engine.replace(/\s+/g, " ")).toContain(
      "const sessionDay = this.plugin.logManager.openSessionDay() ?? logicalDate(moment(), this.plugin.settings.dayStartHour);"
    );
    expect(engine).toContain("this.plugin.settings.sessionCounterDate = sessionDay;");
    expect(manager).toContain(
      "const dateStr = logicalDate(session.startTime, this.plugin.settings.dayStartHour);"
    );
    // Today's total: the log's day, under its English-digit name and the
    // name 0.6.8 gave it in the app language's digits (F4).
    const total = manager.replace(/\s+/g, " ");
    expect(total).toContain(
      "const today = moment(); const dayStartHour = this.plugin.settings.dayStartHour; const dateStr = logicalDate(today, dayStartHour);"
    );
    expect(total).toContain("for (const date of logDateNames(today, dayStartHour)) {");
    const names = codeOnly(readFileSync(resolve(root, "logLine.ts"), "utf8")).replace(/\s+/g, " ");
    expect(names).toContain(
      "return [...new Set([logicalDate(m, dayStartHour), appLanguageLogicalDate(m, dayStartHour)])];"
    );
  });
});
