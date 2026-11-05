import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_START_HOURS,
  DEVICE_NAME_MAX,
  LOG_TAIL_KEYS,
  NOTE_FACES,
  NOTE_SEPARATOR,
  NOTE_TEXT_MAX,
  cleanNoteText,
  cyclePosition,
  dailyLogFileName,
  flattenLinks,
  formatLogLine,
  formatNoteValue,
  formatTaskValue,
  isSessionId,
  lastSessionNoteTarget,
  logInteger,
  logSeconds,
  logicalDate,
  newSessionId,
  parseFocusTotalSeconds,
  parseLogLine,
  parseNoteValue,
  readLogTail,
  readLogTime,
  readSessionNote,
  replaceTaskValue,
  resolveDayStartHour,
  sanitizeAlias,
  sanitizeDevice,
  sanitizeNote,
  setSessionNote,
  sleptSeconds,
  stamp,
  type FocusNote,
  type NoteFace,
  type SessionLog,
} from "../logLine";
import { NO_TASK_LABEL } from "../constants";
import type { MomentLike } from "../momentTypes";
import { offsetAt } from "./logTail";

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

const TAIL_FIELD_TEXT = new RegExp(`\\b(?:${LOG_TAIL_KEYS.join("|")})::`);

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
    // The tail's keys too (0.7.0): Dataview code reads `s.Planned`, a
    // reader of the line's text would name `Planned::`.
    expect(code).not.toMatch(TAIL_FIELD_TEXT);
    expect(code).not.toContain("🍅 Focus");
    expect(code).not.toContain("☕ Rest");
  });

  it("would see a tail key named with '::'", () => {
    // The pattern is built from the list, which the tail's own tests pin.
    for (const key of LOG_TAIL_KEYS) expect(`x ${key}:: 1`).toMatch(TAIL_FIELD_TEXT);
    expect('values.get("Planned")').not.toMatch(TAIL_FIELD_TEXT);
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

/* ===== The tail (0.7.0) ===== */

// The ten fields every version since 0.6.9 writes, in their order.
const CORE_KEYS = [
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
];

describe("the tail's keys (0.7.0)", () => {
  it("are these eleven, in the order a line writes them: Note (0.7.1) last", () => {
    expect([...LOG_TAIL_KEYS]).toEqual([
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
      "Note",
    ]);
  });

  it("none ends in another log key, case aside: a greedy `.*Total::` must never read one", () => {
    // EndOffset was the first name for OffsetChange, and it ended in Offset.
    const all = [...CORE_KEYS, ...LOG_TAIL_KEYS];
    for (const key of LOG_TAIL_KEYS) {
      for (const other of all) {
        if (other === key) continue;
        expect(key.toLowerCase().endsWith(other.toLowerCase()), `${key} ends in ${other}`).toBe(
          false
        );
      }
    }
  });

  it("none is Day or Date: a list item's field of that name takes Dataview's file.day", () => {
    for (const key of LOG_TAIL_KEYS) {
      expect(["day", "date"]).not.toContain(key.toLowerCase());
    }
  });
});

describe("Session IDs (0.7.0)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("are s and nine characters of Crockford's lower-case base 32", () => {
    for (let i = 0; i < 2000; i++) {
      const id = newSessionId();
      expect(id).toMatch(/^s[0-9abcdefghjkmnpqrstvwxyz]{9}$/);
      expect(isSessionId(id)).toBe(true);
    }
  });

  it("take each byte's low five bits, so all 32 characters come up alike", () => {
    const chars = Array.from({ length: 32 }, (_, i) => newSessionId((b) => b.fill(i))[1]);
    expect(chars.join("")).toBe("0123456789abcdefghjkmnpqrstvwxyz");
    expect(newSessionId((b) => b.fill(255))).toBe("szzzzzzzzz");
    expect(newSessionId((b) => b.fill(32))).toBe("s000000000");
    expect(newSessionId((b) => b.set([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe("s012345678");
  });

  it("come from crypto.getRandomValues, nine bytes at a time", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    newSessionId();
    expect(spy).toHaveBeenCalledTimes(1);
    const bytes = spy.mock.calls[0][0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes as Uint8Array).length).toBe(9);
  });

  it("fall back to Math.random only where there is no crypto", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.99); // byte 253 → 29 → "x"
    expect(newSessionId()).toBe("sxxxxxxxxx");
  });

  it("do not repeat over many sessions", () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => newSessionId()));
    expect(ids.size).toBe(20_000);
  });

  it("are told from anything else", () => {
    for (const bad of [
      "s00000000",
      "s0000000000",
      "S000000000",
      "s00000000i",
      "s00000000l",
      "s00000000o",
      "s00000000u",
      " s000000000",
      12,
      null,
      undefined,
    ]) {
      expect(isSessionId(bad), String(bad)).toBe(false);
    }
  });
});

describe("sanitizeDevice (0.7.0)", () => {
  it("takes out every 🍅, ☕ and #: no break reads as focus, no name as a tag", () => {
    expect(sanitizeDevice("🍅 Focus box")).toBe("Focus box");
    expect(sanitizeDevice("☕ Rest")).toBe("Rest");
    expect(sanitizeDevice("#task/design/side")).toBe("task/design/side");
    expect(sanitizeDevice("🍅🍅 Focus 🍅")).toBe("Focus");
    // Taking out only the markers would leave this one: its # goes, and the
    // 🍅 Focus it then spells is a focus line's marker on a Rest line.
    expect(sanitizeDevice("🍅 #Focus")).toBe("Focus");
  });

  it("collapses white space, and cuts at 40 code points, never inside one", () => {
    expect(sanitizeDevice("  Work\n\tlaptop   2 ")).toBe("Work laptop 2");
    expect(DEVICE_NAME_MAX).toBe(40);
    const long = sanitizeDevice("🎧".repeat(50));
    expect(long).toBe("🎧".repeat(40));
    expect(sanitizeDevice("x".repeat(45))).toBe("x".repeat(40));
  });

  it("then makes it safe as a task name is: no bracket, no '::', no trailing backslash", () => {
    expect(sanitizeDevice("x] [Total:: 999")).toBe("x) (Total: 999");
    expect(sanitizeDevice("[[Laptops/Work|Work laptop]]")).toBe("Work laptop");
    expect(sanitizeDevice("Laptop \\")).toBe("Laptop");
  });

  it("leaves nothing for a name of only what it takes out", () => {
    for (const name of ["", "   ", "🍅", "#", "☕ #\n", "\\"])
      expect(sanitizeDevice(name)).toBe("");
  });

  // Each of these breaks under another order of the steps.
  it.each([
    ["a '#' between two colons, which removed after sanitizeAlias makes a '::'", "a:#:b", "a:b"],
    [
      "a '#' after a backslash, which removed after sanitizeAlias leaves it last",
      "Laptop\\#",
      "Laptop",
    ],
    [
      "a cut that ends on a backslash, which only sanitizeAlias after the cut takes off",
      `${"x".repeat(39)}\\y`,
      "x".repeat(39),
    ],
    [
      "spaces collapsed before the cut, so the name after them is kept",
      `a${" ".repeat(50)}b`,
      "a b",
    ],
    [
      "what is taken out before the cut, so it costs none of the 40",
      `${"🍅#".repeat(5)}${"x".repeat(40)}`,
      "x".repeat(40),
    ],
  ])("orders its steps: %s", (_label, name, written) => {
    expect(sanitizeDevice(name)).toBe(written);
  });

  it("keeps every line readable, whatever is typed (seeded fuzz)", () => {
    // mulberry32, as tests/logConvert.test.ts: its low bits vary too.
    let seed = 70;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const pieces = [
      "🍅",
      "☕",
      "#",
      " Focus",
      " Rest",
      ":",
      "::",
      "[",
      "]",
      "[[",
      "]]",
      "|",
      "\\",
      " ",
      "\n",
      "\t",
      "\u2028",
      "\u0085",
      "Total",
      "Status:: cancelled",
      "x",
      "é",
      "🎧",
      "task/",
      "2026",
    ];
    const rest: SessionLog = {
      mode: "break",
      taskName: "",
      scheduledDurationMinutes: 5,
      startTime: local(2026, 10, 2, 10, 0),
      endTime: local(2026, 10, 2, 10, 5),
      pauses: [],
      status: "finished",
      breakType: "short",
      sessionId: "s000000000",
    };
    for (let n = 0; n < 5000; n++) {
      let name = "";
      const count = next(30);
      for (let i = 0; i < count; i++) name += pieces[next(pieces.length)];
      const device = sanitizeDevice(name);
      expect(device, JSON.stringify(name)).not.toMatch(/[🍅☕#[\]\t\n\r\u0085\u2028\u2029]|::/u);
      expect(device, JSON.stringify(name)).toBe(device.trim());
      expect(device.endsWith("\\"), JSON.stringify(name)).toBe(false);
      expect([...device].length).toBeLessThanOrEqual(DEVICE_NAME_MAX);
      expect(sanitizeDevice(device)).toBe(device);
      if (device === "") continue;
      // On a line, it reads back as written and moves no other field.
      const line = formatLogLine({ ...session(), sessionId: "s000000000", device });
      const parsed = parseLogLine(line);
      expect(parsed?.values.get("Device"), JSON.stringify(name)).toBe(device);
      expect(parsed?.values.get("Total")).toBe("1800");
      expect(parsed?.values.get("Status")).toBe("finished");
      // A break never reads as a focus, to the reviews' gate or to ours.
      const restLine = formatLogLine({ ...rest, device });
      expect(restLine.includes("🍅 Focus"), JSON.stringify(name)).toBe(false);
      expect(restLine.match(/#/g)).toBeNull();
      expect(parseFocusTotalSeconds(restLine)).toBe(0);
    }
  });
});

describe("cyclePosition (0.7.0)", () => {
  it("is the place in the long-break cycle of the count the session moved the day to", () => {
    // The day's count is never reset after a long break.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => cyclePosition(n, 4))).toEqual([
      1, 2, 3, 4, 1, 2, 3, 4, 1,
    ]);
    expect([1, 2, 3].map((n) => cyclePosition(n, 1))).toEqual([1, 1, 1]);
    expect(cyclePosition(7, 3)).toBe(1);
  });

  it("puts a long break after the focus whose place is the cycle's length", () => {
    for (let every = 1; every <= 8; every++) {
      for (let n = 1; n <= 30; n++) {
        expect(cyclePosition(n, every) === every).toBe(n % every === 0);
      }
    }
  });
});

describe("logInteger (0.7.0)", () => {
  const read = (value: string) => {
    const parsed = parseLogLine(`- ☕ Rest [Start:: x] [Offset:: ${value}]`);
    if (!parsed) throw new Error("not a line");
    return logInteger(parsed, "Offset");
  };

  it("reads a signed whole number, which logSeconds cannot", () => {
    expect(read("-240")).toBe(-240);
    expect(read("330")).toBe(330);
    expect(read("0")).toBe(0);
    expect(read("-0")).toBe(0);
    expect(Object.is(read("-0"), 0)).toBe(true);
    const parsed = parseLogLine("- ☕ Rest [Start:: x] [Offset:: -240]");
    expect(parsed && logSeconds(parsed, "Offset")).toBeNull();
  });

  it("reads nothing that is not exactly one", () => {
    for (const bad of ["+60", "1.5", "60m", "- 60", "", "x"]) expect(read(bad), bad).toBeNull();
    const parsed = parseLogLine("- ☕ Rest [Start:: x]");
    expect(parsed && logInteger(parsed, "Offset")).toBeNull();
  });
});

describe("readLogTail (0.7.0)", () => {
  // A made-up 0.7.0 focus line with every field, and the line 0.6.9 wrote.
  const PLAIN =
    "- 🍅 Focus [Task:: No Task] [Start:: 2026-11-01 01:50:00] [End:: 2026-11-01 01:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 2100] [Status:: finished] [Type:: focus] [Overtime:: 600]";
  const FULL =
    `${PLAIN} [Session:: s7k2m9qx4w] [StartedBy:: auto] [EndedBy:: planned-end] [Planned:: 1500] ` +
    "[Cycle:: 4] [Offset:: -240] [OffsetChange:: -60] [Slept:: 120] [Dropped:: 600] [Device:: 2026]";
  const tailOf = (line: string) => {
    const parsed = parseLogLine(line);
    if (!parsed) throw new Error(`not a line: ${line}`);
    return readLogTail(parsed);
  };
  /** FULL with one field's value replaced, or the field taken out (null). */
  const withField = (key: string, value: string | null) =>
    FULL.replace(
      new RegExp(` \\[${key}:: [^\\]]*\\]`),
      value === null ? "" : ` [${key}:: ${value}]`
    );

  it("reads every field: text as written, numbers signed where they may be", () => {
    expect(tailOf(FULL)).toEqual({
      sessionId: "s7k2m9qx4w",
      startedBy: "auto",
      endedBy: "planned-end",
      planned: 1500,
      cycle: 4,
      offset: -240,
      endOffset: -300,
      slept: 120,
      dropped: 600,
      // Text, though Dataview would read it as a number.
      device: "2026",
      face: null,
      note: null,
    });
    expect(tailOf(withField("OffsetChange", "60"))?.endOffset).toBe(-180);
    expect(tailOf(withField("Offset", "330"))?.endOffset).toBe(270);
  });

  it("is null on a line with no Session: every field of it unknown, nothing worked out", () => {
    expect(tailOf(PLAIN)).toBeNull();
    expect(tailOf(V1_FOCUS)).toBeNull();
    // A tail field without Session is no tail.
    expect(tailOf(withField("Session", null))).toBeNull();
    expect(tailOf(formatLogLine(session({ endedBy: "stop", plannedSeconds: 1500 })))).toBeNull();
  });

  it("takes a Session field for the tail by being there, not by its value", () => {
    // Readers do not check values: an ID typed by hand is still the line's.
    for (const id of ["s7k2", "12345", "S7K2M9QX4W"]) {
      expect(tailOf(withField("Session", id))?.sessionId, id).toBe(id);
    }
  });

  it("takes a missing Slept, Dropped or OffsetChange as 0 — on a line with Session", () => {
    expect(tailOf(withField("Slept", null))?.slept).toBe(0);
    expect(tailOf(withField("Dropped", null))?.dropped).toBe(0);
    expect(tailOf(withField("OffsetChange", null))?.endOffset).toBe(-240);
  });

  it("takes any other missing field as null: a missing Cycle moved no count", () => {
    for (const [key, member] of [
      ["StartedBy", "startedBy"],
      ["EndedBy", "endedBy"],
      ["Planned", "planned"],
      ["Cycle", "cycle"],
      ["Offset", "offset"],
      ["Device", "device"],
    ] as const) {
      expect(tailOf(withField(key, null))?.[member], key).toBeNull();
    }
    expect(tailOf(withField("Offset", null))?.endOffset).toBeNull();
  });

  it("reads a number that is not exactly a whole one as null, never as 0 or its digits", () => {
    for (const key of ["Planned", "Cycle", "Slept", "Dropped"]) {
      const member = key.toLowerCase() as "planned" | "cycle" | "slept" | "dropped";
      for (const bad of ["12s", "1.5", "-5", "+60", "x"]) {
        expect(tailOf(withField(key, bad))?.[member], `${key} ${bad}`).toBeNull();
      }
    }
    expect(tailOf(withField("Offset", "-4h"))).toMatchObject({ offset: null, endOffset: null });
    expect(tailOf(withField("OffsetChange", "x"))).toMatchObject({
      offset: -240,
      endOffset: null,
    });
  });

  it("reads back what formatLogLine wrote", () => {
    const at = local(2026, 10, 2, 10, 0);
    const line = formatLogLine(
      session({
        startTime: at,
        endTime: local(2026, 10, 2, 10, 35),
        sessionId: "s000000000",
        startedBy: "start",
        endedBy: "time-up",
        plannedSeconds: 1500,
        cycle: 1,
        device: "Desk",
      })
    );
    expect(tailOf(line)).toEqual({
      sessionId: "s000000000",
      startedBy: "start",
      endedBy: "time-up",
      planned: 1500,
      cycle: 1,
      offset: Number(offsetAt(new Date(at.valueOf()))),
      endOffset: Number(offsetAt(new Date(at.valueOf()))),
      slept: 0,
      dropped: 0,
      device: "Desk",
      face: null,
      note: null,
    });
  });
});

describe("sleptSeconds (0.7.0)", () => {
  const ms = (h: number, mi: number, s = 0) => new Date(2026, 9, 2, h, mi, s).getTime();
  const span = {
    startTime: local(2026, 10, 2, 13, 0),
    endTime: local(2026, 10, 2, 14, 0),
  };

  it("is the sleeps' share of the line's span, in whole seconds", () => {
    expect(sleptSeconds({ ...span, sleeps: [[ms(13, 10), ms(13, 50)]] })).toBe(2400);
    // Cut at either end of the span, and summed.
    expect(
      sleptSeconds({
        ...span,
        sleeps: [
          [ms(12, 50), ms(13, 5)],
          [ms(13, 55), ms(14, 20)],
        ],
      })
    ).toBe(600);
    // Cut to the second as the written times are.
    expect(sleptSeconds({ ...span, sleeps: [[ms(13, 10) + 999, ms(13, 11) + 1]] })).toBe(60);
  });

  it("is 0 with no sleep, or none in the span", () => {
    expect(sleptSeconds(span)).toBe(0);
    expect(sleptSeconds({ ...span, sleeps: [] })).toBe(0);
    expect(sleptSeconds({ ...span, sleeps: [[ms(14, 0), ms(15, 0)]] })).toBe(0);
    expect(sleptSeconds({ ...span, sleeps: [[ms(11, 0), ms(13, 0)]] })).toBe(0);
  });
});

describe("formatLogLine — the tail (0.7.0)", () => {
  // A plain October day in New York: four hours behind UTC.
  inZone("America/New_York");

  const ID = "s7k2m9qx4w";
  const ms = (h: number, mi: number) => new Date(2026, 9, 2, h, mi).getTime();
  /** A focus with every tail field: 10:00–10:35, paused 10:10–10:15 (a sleep 10:11–10:14). */
  const full = (overrides: Partial<SessionLog> = {}) =>
    session({
      sessionId: ID,
      startedBy: "auto",
      endedBy: "planned-end",
      plannedSeconds: 1800.9,
      cycle: 3,
      sleeps: [[ms(10, 11), ms(10, 14)]],
      droppedSeconds: 600,
      device: "  Work [laptop] ",
      ...overrides,
    });

  it("writes nothing new without a Session ID: the line 0.6.9 wrote, byte for byte", () => {
    const plain = formatLogLine(session());
    expect(plain.endsWith("[Overtime:: 300]")).toBe(true);
    for (const sessionId of [
      undefined,
      "",
      "s7k2m9qx",
      "S7K2M9QX4W",
      "s7k2m9qx4w ",
      "sILO000000",
    ]) {
      expect(formatLogLine(full({ sessionId })), String(sessionId)).toBe(plain);
    }
    expect(formatLogLine(session({ mode: "break", breakType: "short", cycle: 2 }))).toMatch(
      /\[Type:: short-break\]$/
    );
  });

  it("writes it after Overtime on a focus, every field in the tail's order", () => {
    const line = formatLogLine(full());
    expect(line).toBe(
      `${formatLogLine(session())} [Session:: ${ID}] [StartedBy:: auto] [EndedBy:: planned-end] ` +
        "[Planned:: 1800] [Cycle:: 3] [Offset:: -240] [Slept:: 180] [Dropped:: 600] [Device:: Work (laptop)]"
    );
    const parsed = parseLogLine(line);
    const keys = parsed?.fields.map((f) => f.key) ?? [];
    expect(keys.slice(0, CORE_KEYS.length)).toEqual(CORE_KEYS);
    // Never a Note: the timer has none when it writes the line (0.7.1).
    expect(keys.slice(CORE_KEYS.length)).toEqual(
      LOG_TAIL_KEYS.filter((k) => k !== "OffsetChange" && k !== "Note")
    );
  });

  it("writes it after Type on a rest line, with no Cycle: only a counted focus has a place", () => {
    const line = formatLogLine(full({ mode: "break", breakType: "long", pauses: [] }));
    expect(line).toMatch(
      new RegExp(`\\[Type:: long-break\\] \\[Session:: ${ID}\\] \\[StartedBy:: auto\\]`)
    );
    expect(parseLogLine(line)?.values.has("Cycle")).toBe(false);
  });

  it("leaves out what is 0 or unknown, and writes only plain whole numbers", () => {
    const line = formatLogLine(
      full({
        startedBy: undefined,
        endedBy: undefined,
        plannedSeconds: Number.NaN,
        cycle: 0,
        sleeps: [[ms(9, 0), ms(9, 30)]],
        droppedSeconds: 0.4,
        device: "🍅 #",
      })
    );
    expect(line.endsWith(`[Overtime:: 300] [Session:: ${ID}] [Offset:: -240]`)).toBe(true);
    expect(formatLogLine(full({ plannedSeconds: -5 }))).toContain("[Planned:: 0]");
    expect(formatLogLine(full({ cycle: 2.7 }))).toContain("[Cycle:: 2]");
    expect(formatLogLine(full())).not.toMatch(/::\s*\+|::\s*(?:true|false)\]/);
  });

  it("reads back through parseLogLine: text as text, every number as written", () => {
    const parsed = parseLogLine(formatLogLine(full()));
    if (!parsed) throw new Error("not a line");
    expect(parsed.values.get("Session")).toBe(ID);
    expect(parsed.values.get("Device")).toBe("Work (laptop)");
    expect(logInteger(parsed, "Offset")).toBe(-240);
    expect(logSeconds(parsed, "Planned")).toBe(1800);
    expect(logSeconds(parsed, "Slept")).toBe(180);
    // The goal meter's count is the ten fields' alone.
    expect(parseFocusTotalSeconds(formatLogLine(full({ device: "Status:: cancelled" })))).toBe(
      1800
    );
  });
});

// Each case: a wall-clock start, the minutes it ran, the hours to add first
// (to reach the second pass of a repeated hour), and Offset / OffsetChange.
type OffsetCase = [
  string,
  [number, number, number, number, number],
  number,
  number,
  string,
  string | null,
];

describe.each<[string, OffsetCase[]]>([
  [
    "America/Chicago",
    [
      ["a plain day in daylight time", [2026, 10, 2, 10, 0], 25, 0, "-300", null],
      ["a plain day in standard time", [2026, 12, 2, 10, 0], 25, 0, "-360", null],
      // 2026-11-01 02:00 CDT → 01:00 CST.
      ["across the fall-back", [2026, 11, 1, 1, 50], 25, 0, "-300", "-60"],
      ["in the repeated hour's second pass", [2026, 11, 1, 1, 10], 25, 1, "-360", null],
      // 2026-03-08 02:00 CST → 03:00 CDT.
      ["across the spring-forward", [2026, 3, 8, 1, 50], 25, 0, "-360", "60"],
    ],
  ],
  [
    "Europe/Berlin",
    [
      ["a plain day in summer time", [2026, 10, 2, 10, 0], 25, 0, "120", null],
      // 2026-10-25 03:00 CEST → 02:00 CET.
      ["across the fall-back", [2026, 10, 25, 2, 50], 25, 0, "120", "-60"],
      ["in the repeated hour's second pass", [2026, 10, 25, 2, 10], 25, 1, "60", null],
      // 2026-03-29 02:00 CET → 03:00 CEST.
      ["across the spring-forward", [2026, 3, 29, 1, 50], 25, 0, "60", "60"],
    ],
  ],
  [
    "Asia/Kolkata",
    [["half an hour off the hour, no change", [2026, 10, 2, 10, 0], 25, 0, "330", null]],
  ],
])("the tail's Offset in %s (0.7.0)", (zone, cases) => {
  inZone(zone);

  it.each(cases)("%s", (_label, [y, mo, d, h, mi], minutes, plusHours, offset, change) => {
    const start = local(y, mo, d, h, mi).add(plusHours, "hours");
    const end = start.clone().add(minutes, "minutes");
    const line = formatLogLine({
      mode: "focus",
      taskName: "Night reading",
      scheduledDurationMinutes: minutes,
      startTime: start,
      endTime: end,
      pauses: [],
      status: "finished",
      overtimeSeconds: 0,
      sessionId: "s000000000",
    });
    const parsed = parseLogLine(line);
    if (!parsed) throw new Error("not a line");
    expect(parsed.values.get("Offset")).toBe(offset);
    expect(parsed.values.get("OffsetChange") ?? null).toBe(change);
    expect(parsed.values.get("Total")).toBe(String(minutes * 60));
    // Start text and Offset name the instant — in a repeated hour's second
    // pass too, which the text alone reads as the first (readLogTime).
    const startText = parsed.values.get("Start") ?? "";
    const [yy, mm, dd, hh, mn, ss] = startText.split(/[- :]/).map(Number);
    const instant = Date.UTC(yy, mm - 1, dd, hh, mn, ss) - Number(offset) * 60_000;
    expect(instant).toBe(start.valueOf());
    expect((readLogTime(startText) ?? 0) * 1000 === start.valueOf()).toBe(plusHours === 0);
    // And Offset + OffsetChange is the offset at End — as readLogTail reads it.
    const endOffset = Number(offset) + Number(change ?? 0);
    expect(endOffset).toBe(-new Date(end.valueOf()).getTimezoneOffset());
    expect(readLogTail(parsed)).toMatchObject({ offset: Number(offset), endOffset });
  });
});

/* ===== The focus note (0.7.1) ===== */

describe("flattenLinks (0.7.1)", () => {
  it("shows each link as its alias, else its target, to a fixpoint", () => {
    expect(flattenLinks("Read [[Some Paper]] and [[P/Q|the other]]")).toBe(
      "Read Some Paper and the other"
    );
    expect(flattenLinks("[[a|[[b|[[c]]]]]]")).toBe("c");
    expect(flattenLinks("[x] [[ ]] [[a")).toBe("[x]   [[a");
  });

  it("is what sanitizeAlias flattens with: a task name keeps what its link shows", () => {
    for (const name of ["Read [[Paper]]", "[[a|[[b]]]]", "x [[p|y]] z [[q]]"]) {
      expect(sanitizeAlias(name)).toBe(sanitizeAlias(flattenLinks(name)));
    }
  });
});

describe("sanitizeNote (0.7.1)", () => {
  it("puts every run of line breaks, with the space around it, as ' / '", () => {
    expect(sanitizeNote("stuck\non refs")).toBe("stuck / on refs");
    expect(sanitizeNote("a  \r\n\t b")).toBe("a / b");
    // A blank line is one run, not two.
    expect(sanitizeNote("a\n\n \nb")).toBe("a / b");
    for (const br of ["\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\r\n"]) {
      expect(sanitizeNote(`a${br}b`), JSON.stringify(br)).toBe("a / b");
    }
  });

  it("drops a line break at the start or the end", () => {
    expect(sanitizeNote("\n  went fine \r\n")).toBe("went fine");
    expect(sanitizeNote("\n\n")).toBe("");
  });

  it("takes out every 🍅 and ☕, with the U+FE0F after one", () => {
    expect(sanitizeNote("🍅 Focus on ☕ Rest")).toBe("Focus on Rest");
    expect(sanitizeNote("coffee ☕\uFE0F then")).toBe("coffee then");
    expect(sanitizeNote("☕\uFE0F")).toBe("");
  });

  it("makes every # a full-width ＃, so no word is a tag", () => {
    expect(sanitizeNote("#idea for #task/design/x")).toBe("＃idea for ＃task/design/x");
  });

  it("makes every run of % one, so no %% comment opens", () => {
    expect(sanitizeNote("100%% sure %%% x %")).toBe("100% sure % x %");
  });

  it("flattens links first, so flattening cannot re-form what a later step took out", () => {
    expect(sanitizeNote("[[x|%]]%")).toBe("%");
    expect(sanitizeNote("a [[x| ]] b")).toBe("a b");
    expect(sanitizeNote("a [[x|\n]] b")).toBe("a / b");
    expect(sanitizeNote("[[x|#]]")).toBe("＃");
    // The 🍅 goes before the links: taken out of here it leaves one, whose
    // flattening would re-form a %%.
    expect(sanitizeNote("[🍅[x|%]🍅]%")).toBe("%");
  });

  it("then makes it safe as a task name is: no bracket, no '::', no trailing backslash", () => {
    expect(sanitizeNote("stuck] [Total:: 999")).toBe("stuck) (Total: 999");
    expect(sanitizeNote("see a::b")).toBe("see a:b");
    expect(sanitizeNote("done \\")).toBe("done");
    expect(sanitizeNote("a\\b")).toBe("a\\b");
  });

  it("collapses white space and trims", () => {
    expect(sanitizeNote("  a \t\u00a0 b  ")).toBe("a b");
  });

  it("keeps as typed what needs no escaping inside [Note:: …]", () => {
    const kept = 'a | b · "c" `d` $e *f* https://x.org/?q=1&r=2 🎧 👩‍🌾 é';
    expect(sanitizeNote(kept)).toBe(kept);
  });

  it(`cuts at ${NOTE_TEXT_MAX} code points, and says so`, () => {
    expect(NOTE_TEXT_MAX).toBe(500);
    expect(cleanNoteText("x".repeat(501))).toEqual({ text: "x".repeat(500), cut: true });
    expect(cleanNoteText("x".repeat(500))).toEqual({ text: "x".repeat(500), cut: false });
    // Space at either end is no text cut off.
    expect(cleanNoteText(` ${"x".repeat(500)}\n `)).toEqual({ text: "x".repeat(500), cut: false });
    // What is taken out costs none of the 500.
    expect(cleanNoteText(`${"🍅".repeat(20)}${"x".repeat(500)}`).cut).toBe(false);
  });

  it("never cuts inside a code point", () => {
    const cut = sanitizeNote("🎧".repeat(600));
    expect(cut).toBe("🎧".repeat(500));
    // Under the u flag a surrogate class matches only one left alone.
    expect(cut).not.toMatch(/[\ud800-\udfff]/u);
    expect(sanitizeNote(`x${"🎧".repeat(600)}`)).toBe(`x${"🎧".repeat(499)}`);
  });

  it("cuts before it takes a trailing backslash off, so none is left at the cut", () => {
    expect(sanitizeNote(`${"x".repeat(499)}\\y`)).toBe("x".repeat(499));
  });

  it("is idempotent", () => {
    for (const text of ["a\n\nb", "[[x|%]]%", "#a %%b", "x".repeat(700), "a]::b\\", "🍅\n☕"]) {
      expect(sanitizeNote(sanitizeNote(text)), JSON.stringify(text)).toBe(sanitizeNote(text));
    }
  });
});

describe("parseNoteValue (0.7.1)", () => {
  it.each<[string, FocusNote]>([
    ["smile", { face: "smile", text: "" }],
    ["meh · x", { face: "meh", text: "x" }],
    ["frown · stuck on refs", { face: "frown", text: "stuck on refs" }],
    ["x", { face: null, text: "x" }],
    // A face only in lower case, and only before exactly " · " and words.
    ["Smile · x", { face: null, text: "Smile · x" }],
    ["meh·x", { face: null, text: "meh·x" }],
    ["meh - x", { face: null, text: "meh - x" }],
    ["meh · ", { face: null, text: "meh ·" }],
    ["meh ·", { face: null, text: "meh ·" }],
    ["mehx", { face: null, text: "mehx" }],
    ["smiley", { face: null, text: "smiley" }],
    // The face is the first word only.
    ["meh · smile · x", { face: "meh", text: "smile · x" }],
    ["  smile  ", { face: "smile", text: "" }],
    // A hand-typed extra space after the separator is no part of the words.
    ["meh ·  x", { face: "meh", text: "x" }],
  ])("reads %j", (value, note) => {
    expect(parseNoteValue(value)).toEqual(note);
  });

  it("is null for no value", () => {
    expect(parseNoteValue(undefined)).toBeNull();
    expect(parseNoteValue("")).toBeNull();
    expect(parseNoteValue("   ")).toBeNull();
  });

  it("knows exactly three faces", () => {
    expect([...NOTE_FACES]).toEqual(["frown", "meh", "smile"]);
    expect([...NOTE_SEPARATOR].map((c) => c.codePointAt(0))).toEqual([0x20, 0xb7, 0x20]);
  });
});

describe("formatNoteValue (0.7.1)", () => {
  it("writes a face, words, or both", () => {
    expect(formatNoteValue({ face: "meh", text: "stuck on the second paragraph" })).toBe(
      "meh · stuck on the second paragraph"
    );
    expect(formatNoteValue({ face: "smile", text: "" })).toBe("smile");
    expect(formatNoteValue({ face: null, text: "stuck on refs" })).toBe("stuck on refs");
  });

  it("is null for neither: no field", () => {
    expect(formatNoteValue({ face: null, text: "" })).toBeNull();
    expect(formatNoteValue({ face: null, text: " \n🍅 " })).toBeNull();
  });

  it("cleans the words, and a face with words cleaned away is the face alone", () => {
    expect(formatNoteValue({ face: "frown", text: "a]\nb #c" })).toBe("frown · a) / b ＃c");
    expect(formatNoteValue({ face: "frown", text: " ☕ " })).toBe("frown");
  });

  it("takes no face it does not know", () => {
    const odd = { face: "grin" as NoteFace, text: "x" };
    expect(formatNoteValue(odd)).toBe("x");
  });

  it("reads back as written (words that read as a face are the card's to move)", () => {
    for (const face of [...NOTE_FACES, null]) {
      for (const text of ["", "went fine", "smile · twice", "a]\nb"]) {
        const value = formatNoteValue({ face, text });
        if (value === null) continue;
        if (face === null) continue;
        expect(parseNoteValue(value)).toEqual({ face, text: sanitizeNote(text) });
      }
    }
    // Words alone that read as a face come back with it: noteFromInput
    // (focusNote.ts) takes the face out of the words before a save.
    expect(parseNoteValue(formatNoteValue({ face: null, text: "meh" }) ?? "")).toEqual({
      face: "meh",
      text: "",
    });
  });
});

/** A made-up 0.7.0 day: properties, a split session's two parts, a break, another focus. */
const NOTE_ID = "s7k2m9qx4w";
const OTHER_ID = "s000000000";
const REST_ID = "s111111111";
const noteFocus = (id: string, task: string, extra = "") =>
  `- 🍅 Focus [Task:: [[Projects/Docs.md|${task}]]] [Start:: 2026-11-03 10:00:00] ` +
  "[End:: 2026-11-03 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
  `[Status:: finished] [Type:: focus] [Overtime:: 0] [Session:: ${id}] [StartedBy:: start] ` +
  `[EndedBy:: stop] [Planned:: 1500] [Cycle:: 1] [Offset:: -300] [Device:: Desk]${extra}`;
const NOTE_REST =
  "- ☕ Rest [Start:: 2026-11-03 10:25:00] [End:: 2026-11-03 10:30:00] [Scheduled:: 300] " +
  `[Total:: 300] [Type:: short-break] [Session:: ${REST_ID}] [StartedBy:: auto] ` +
  "[EndedBy:: time-up] [Planned:: 300] [Offset:: -300]";
const NOTE_PROPERTIES = [
  "---",
  "goal_minutes: 120",
  "example: |",
  // A session line inside a property is no session line.
  `  ${noteFocus(OTHER_ID, "In a property")}`,
  "---",
];
const NOTE_DAY = [
  ...NOTE_PROPERTIES,
  noteFocus(NOTE_ID, "Part one"),
  noteFocus(NOTE_ID, "Part two"),
  NOTE_REST,
  noteFocus(NOTE_ID, "Part three", " ^block"),
  noteFocus(OTHER_ID, `Follow up ${NOTE_ID}`),
  "",
].join("\n");
const rowsOf = (content: string) => content.split("\n");
const NOTE_ROW = NOTE_PROPERTIES.length + 3; // "Part three": the session's last line
const set = (content: string, id: string, note: FocusNote | null) => {
  const next = setSessionNote(content, id, note);
  if (next === null) throw new Error(`no line for ${id}`);
  return next;
};
/** Every row but `row` is as it was. */
const onlyRowChanged = (before: string, after: string, row: number) => {
  const a = rowsOf(before);
  const b = rowsOf(after);
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) if (i !== row) expect(b[i], `row ${i}`).toBe(a[i]);
};

describe("setSessionNote (0.7.1)", () => {
  it("adds the note to the session's LAST focus line, after its last field and before text", () => {
    const after = set(NOTE_DAY, NOTE_ID, { face: "meh", text: "stuck on refs" });
    onlyRowChanged(NOTE_DAY, after, NOTE_ROW);
    expect(rowsOf(after)[NOTE_ROW]).toBe(
      noteFocus(NOTE_ID, "Part three", " [Note:: meh · stuck on refs] ^block")
    );
  });

  it("puts it after Device, the last field, every other field as it was", () => {
    const day = noteFocus(OTHER_ID, "Solo");
    const after = set(day, OTHER_ID, { face: "smile", text: "" });
    expect(after).toBe(`${day} [Note:: smile]`);
    const before = parseLogLine(day)?.fields.map((f) => [f.key, f.value]);
    const fields = parseLogLine(after)?.fields.map((f) => [f.key, f.value]);
    expect(fields).toEqual([...(before ?? []), ["Note", "smile"]]);
  });

  it("puts it after a field someone added by hand after Device", () => {
    const day = noteFocus(OTHER_ID, "Solo", " [Mood:: ok]");
    expect(set(day, OTHER_ID, { face: null, text: "x" })).toBe(`${day} [Note:: x]`);
  });

  it("replaces the note there in place, and takes off a second one", () => {
    const day = noteFocus(OTHER_ID, "Solo", " [Note:: frown] [Mood:: ok] [Note:: old]");
    expect(set(day, OTHER_ID, { face: "smile", text: "better" })).toBe(
      noteFocus(OTHER_ID, "Solo", " [Note:: smile · better] [Mood:: ok]")
    );
  });

  it("takes every note off, each with the one space before it, for no note", () => {
    const bare = noteFocus(OTHER_ID, "Solo", " [Mood:: ok]");
    const day = noteFocus(OTHER_ID, "Solo", " [Note:: frown] [Mood:: ok] [Note:: old]");
    expect(set(day, OTHER_ID, null)).toBe(bare);
    expect(set(day, OTHER_ID, { face: null, text: " 🍅\n" })).toBe(bare);
    // None there: nothing to write.
    expect(set(bare, OTHER_ID, null)).toBe(bare);
  });

  it("formats the note itself: raw words never reach the line", () => {
    const day = noteFocus(OTHER_ID, "Solo");
    const after = set(day, OTHER_ID, { face: null, text: "a] [Total:: 9\nb #c %%" });
    expect(after).toBe(`${day} [Note:: a) (Total: 9 / b ＃c %]`);
    expect(parseLogLine(after)?.values.get("Total")).toBe("1500");
    expect(rowsOf(after)).toHaveLength(1);
  });

  it("is null when no focus line of the session is there", () => {
    expect(setSessionNote(NOTE_DAY, "s222222222", { face: "meh", text: "" })).toBeNull();
    // A rest line takes no note.
    expect(setSessionNote(NOTE_DAY, REST_ID, { face: "meh", text: "" })).toBeNull();
    // Nor a session whose only line is inside the properties.
    const props = `${NOTE_PROPERTIES.join("\n")}\n${NOTE_REST}\n`;
    expect(setSessionNote(props, OTHER_ID, { face: "meh", text: "" })).toBeNull();
    // Nor an ID that is not one, nor a line without Session, nor a v1 line.
    expect(setSessionNote(NOTE_DAY, "s7k2", { face: "meh", text: "" })).toBeNull();
    expect(setSessionNote(V1_FOCUS, NOTE_ID, { face: "meh", text: "" })).toBeNull();
  });

  it("finds the session by its ID exactly, never inside another value", () => {
    // OTHER_ID's line, last in the file, names NOTE_ID in its task: not NOTE_ID's.
    const after = set(NOTE_DAY, NOTE_ID, { face: "smile", text: "" });
    expect(rowsOf(after)[NOTE_ROW]).toContain("[Note:: smile]");
    expect(rowsOf(after)[NOTE_ROW + 1]).not.toContain("Note::");
    const longer = noteFocus(OTHER_ID, "x").replace(OTHER_ID, `${OTHER_ID}0`);
    expect(setSessionNote(longer, OTHER_ID, { face: "smile", text: "" })).toBeNull();
  });

  it("keeps a CRLF file's line endings and a byte order mark, every other byte too", () => {
    const crlf = `\uFEFF${noteFocus(OTHER_ID, "A")}\r\n${noteFocus(NOTE_ID, "B")}\r\n${NOTE_REST}\r\n`;
    const after = set(crlf, NOTE_ID, { face: "frown", text: "tired" });
    expect(after).toBe(
      `\uFEFF${noteFocus(OTHER_ID, "A")}\r\n${noteFocus(NOTE_ID, "B")} [Note:: frown · tired]\r\n${NOTE_REST}\r\n`
    );
    // The first line, behind the mark, can take one too.
    expect(set(crlf, OTHER_ID, { face: "meh", text: "" })).toBe(
      `\uFEFF${noteFocus(OTHER_ID, "A")} [Note:: meh]\r\n${noteFocus(NOTE_ID, "B")}\r\n${NOTE_REST}\r\n`
    );
  });

  it("gives the content back unchanged for the note already there, and is idempotent", () => {
    const note: FocusNote = { face: "meh", text: "half done" };
    const once = set(NOTE_DAY, NOTE_ID, note);
    expect(set(once, NOTE_ID, note)).toBe(once);
    expect(set(once, NOTE_ID, { face: "meh", text: " half \n" })).not.toBe(once);
    expect(set(once, NOTE_ID, { face: "meh", text: "  half   done " })).toBe(once);
    const cleared = set(once, NOTE_ID, null);
    expect(cleared).toBe(NOTE_DAY);
    expect(set(cleared, NOTE_ID, null)).toBe(cleared);
  });
});

describe("readSessionNote (0.7.1)", () => {
  it("reads the note on the session's last focus line", () => {
    expect(readSessionNote(NOTE_DAY, NOTE_ID)).toEqual({ found: true, note: null });
    const after = set(NOTE_DAY, NOTE_ID, { face: "smile", text: "went well" });
    expect(readSessionNote(after, NOTE_ID)).toEqual({
      found: true,
      note: { face: "smile", text: "went well" },
    });
    // A note on an earlier part is not the session's.
    const early = rowsOf(NOTE_DAY);
    early[NOTE_PROPERTIES.length] += " [Note:: frown]";
    expect(readSessionNote(early.join("\n"), NOTE_ID)).toEqual({ found: true, note: null });
  });

  it("finds nothing where setSessionNote would write nothing", () => {
    for (const id of ["s222222222", REST_ID, "s7k2"]) {
      expect(readSessionNote(NOTE_DAY, id), id).toEqual({ found: false });
    }
  });
});

describe("lastSessionNoteTarget (0.7.1)", () => {
  it("is the file's last focus line with a Session", () => {
    expect(lastSessionNoteTarget(NOTE_DAY)).toEqual({
      sessionId: OTHER_ID,
      start: "2026-11-03 10:00:00",
      end: "2026-11-03 10:25:00",
      taskName: `Follow up ${NOTE_ID}`,
    });
  });

  it("passes over rest lines, lines without Session and the properties", () => {
    const day = [
      ...NOTE_PROPERTIES,
      noteFocus(NOTE_ID, "Mine"),
      NOTE_REST,
      formatLogLine(session()),
      V1_FOCUS,
      "",
    ].join("\n");
    expect(lastSessionNoteTarget(day)?.sessionId).toBe(NOTE_ID);
    expect(lastSessionNoteTarget(`${NOTE_PROPERTIES.join("\n")}\n${NOTE_REST}`)).toBeNull();
    expect(lastSessionNoteTarget("")).toBeNull();
  });

  it("names an unlinked session No Task", () => {
    const line = noteFocus(NOTE_ID, "x").replace("[Task:: [[Projects/Docs.md|x]]] ", "");
    expect(lastSessionNoteTarget(line)?.taskName).toBe(NO_TASK_LABEL);
    const bare = noteFocus(NOTE_ID, "x").replace("[[Projects/Docs.md|x]]", "No Task");
    expect(lastSessionNoteTarget(bare)?.taskName).toBe(NO_TASK_LABEL);
  });
});

describe("readLogTail — the focus note (0.7.1)", () => {
  const tailOf = (line: string) => {
    const parsed = parseLogLine(line);
    if (!parsed) throw new Error(`not a line: ${line}`);
    return readLogTail(parsed);
  };

  it("reads the face and the words without it", () => {
    const line = noteFocus(NOTE_ID, "x", " [Note:: meh · stuck on refs]");
    expect(tailOf(line)).toMatchObject({ face: "meh", note: "stuck on refs" });
    expect(tailOf(noteFocus(NOTE_ID, "x", " [Note:: smile]"))).toMatchObject({
      face: "smile",
      note: null,
    });
    expect(tailOf(noteFocus(NOTE_ID, "x", " [Note:: Smile · x]"))).toMatchObject({
      face: null,
      note: "Smile · x",
    });
    expect(tailOf(noteFocus(NOTE_ID, "x"))).toMatchObject({ face: null, note: null });
  });

  it("reads no note on a rest line, nor on a line without Session", () => {
    expect(tailOf(`${NOTE_REST} [Note:: smile · by hand]`)).toMatchObject({
      face: null,
      note: null,
    });
    const old = `${formatLogLine(session())} [Note:: smile]`;
    expect(tailOf(old)).toBeNull();
  });
});

describe("a focus note on a line, whatever is typed (seeded fuzz, 0.7.1)", () => {
  it("reads back exactly as formatted, moving nothing else, and cleans idempotently", () => {
    // mulberry32, as the device fuzz above.
    let seed = 71;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const pieces = [
      "[",
      "]",
      "[[",
      "]]",
      "|",
      "\\",
      "\\\\",
      ":",
      "::",
      "#",
      "%",
      "%%",
      "🍅",
      "☕",
      "\uFE0F",
      "\n",
      "\r\n",
      "\r",
      "\v",
      "\u0085",
      "\u2028",
      " ",
      "  ",
      "\t",
      "·",
      " · ",
      "meh",
      "smile",
      "frown",
      "Smile",
      " Focus",
      "Total",
      "Note",
      "x",
      "é",
      "🎧",
      "👩‍🌾",
      "y".repeat(60),
    ];
    const faces = [...NOTE_FACES, null];
    const base = rowsOf(NOTE_DAY);
    const baseFields = JSON.stringify(
      parseLogLine(base[NOTE_ROW])?.fields.map((f) => [f.key, f.value])
    );
    const UNCLEAN = /[🍅☕#[\]\r\n\v\f\u0085\u2028\u2029]|%%|\s{2}/u;
    for (let n = 0; n < 100_000; n++) {
      let text = "";
      const count = next(40);
      for (let i = 0; i < count; i++) text += pieces[next(pieces.length)];
      const face = faces[next(faces.length)];
      // Plain checks, and expect only for one that fails: a hundred
      // thousand rounds of expect() would take the suite's time ten times over.
      const check = (ok: boolean, what: string, got: unknown) => {
        if (!ok) expect({ what, got }, JSON.stringify([face, text])).toBeUndefined();
      };

      const clean = sanitizeNote(text);
      check(sanitizeNote(clean) === clean, "idempotent", clean);
      check(!UNCLEAN.test(clean), "clean", clean);
      check(!clean.endsWith("\\") && clean === clean.trim(), "ends", clean);
      check([...clean].length <= NOTE_TEXT_MAX, "length", clean);

      const value = formatNoteValue({ face, text });
      const after = setSessionNote(NOTE_DAY, NOTE_ID, { face, text });
      if (value === null) {
        check(after === NOTE_DAY, "no note, no change", after);
        continue;
      }
      const rows = rowsOf(after ?? "");
      check(
        rows.length === base.length && rows.every((row, i) => i === NOTE_ROW || row === base[i]),
        "other rows",
        after
      );
      const line = rows[NOTE_ROW];
      const parsed = parseLogLine(line);
      check(parsed?.values.get("Note") === value, "reads back", line);
      const fields = parsed?.fields.filter((f) => f.key !== "Note").map((f) => [f.key, f.value]);
      check(JSON.stringify(fields) === baseFields, "other fields", line);
      check(parsed?.rest === "^block", "text after the fields", line);
      check(
        line.split("🍅 Focus").length === 2 && !/#|%%/.test(line),
        "marker, tag, comment",
        line
      );
      // The words come back as cleaned; words alone that read as a face come
      // back with it (the card moves the face out first).
      const read = parseNoteValue(value);
      const readAs =
        face !== null || read?.face === null
          ? JSON.stringify(read) === JSON.stringify({ face, text: clean })
          : `${read?.face}${read?.text ? NOTE_SEPARATOR + read.text : ""}` === clean;
      check(readAs, "parses back", read);
      check(setSessionNote(after ?? "", NOTE_ID, { face, text }) === after, "idempotent", line);
    }
  });
});
