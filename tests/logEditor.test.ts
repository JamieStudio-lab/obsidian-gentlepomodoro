import { describe, it, expect, beforeAll, afterAll } from "vitest";
import moment from "moment";
import {
  FORM_DATE_MESSAGE,
  FORM_FUTURE_MESSAGE,
  FORM_MINUTES_MESSAGE,
  FORM_OTHER_DAY_MESSAGE,
  FORM_TIME_MESSAGE,
  FORM_UNSAFE_MESSAGE,
  MAX_SESSION_MINUTES,
  describeLoggedLine,
  editedLine,
  formFromLine,
  insertSessionLine,
  loggedLines,
  newSessionForm,
  replaceSessionLine,
  sessionFromForm,
  sessionTaskLabel,
  type LoggedLine,
  type SessionForm,
} from "../logEditor";
import { formatLogLine, parseFocusTotalSeconds, parseLogLine } from "../logLine";
import type { MomentLike } from "../momentTypes";

/**
 * "Add a session" and "Fix a logged session" (0.6.9, C6), the parts that
 * decide what is written: the line, where it goes in the file, and that a
 * line edited meanwhile is never written over. Lines are made up; none is
 * copied from a real log.
 */

const toMoment = (ms: number) => moment(ms) as unknown as MomentLike;
/** A local instant, as a log line writes one. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 10, 2, 18, 0);

const form = (set: Partial<SessionForm> = {}): SessionForm => ({
  kind: "focus",
  task: null,
  date: "2026-10-02",
  time: "09:30",
  minutes: "25",
  status: "finished",
  ...set,
});

const add = (set: Partial<SessionForm> = {}, nowMs = NOW) =>
  sessionFromForm(form(set), { toMoment, nowMs });

/** The one line a form writes, or the reason it was refused. */
const lineFor = (set: Partial<SessionForm> = {}, nowMs = NOW): string => {
  const built = add(set, nowMs);
  return built.ok ? formatLogLine(built.session) : `refused: ${built.message}`;
};

const FOCUS_0800 =
  "- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-10-02 08:00:00] [End:: 2026-10-02 08:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const REST_0825 =
  "- ☕ Rest [Start:: 2026-10-02 08:25:00] [End:: 2026-10-02 08:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]";
const FOCUS_1000 =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const V1_FOCUS_1100 =
  "- 🍅 Focus | Task:: [[Projects/Course.md|Module 3 #task/class/course]] | ID:: bq7m2w | Start:: 2026-10-02 11:00:00 | End:: 2026-10-02 11:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished";

describe("a new session from the dialog", () => {
  it("starts as one focus of the usual length that has just ended", () => {
    const start = newSessionForm(at(2026, 10, 2, 18, 0, 40), 25, toMoment);
    expect(start).toEqual(form({ time: "17:35" }));
    // Cut to the minute, so the end it implies is never in the future.
    expect(add({ time: "17:35" }, at(2026, 10, 2, 18, 0, 40)).ok).toBe(true);
  });

  it("keeps the usual length inside what the dialog accepts", () => {
    expect(newSessionForm(NOW, 0, toMoment).minutes).toBe("1");
    expect(newSessionForm(NOW, Number.NaN, toMoment).minutes).toBe("25");
    expect(newSessionForm(NOW, 5000, toMoment).minutes).toBe(String(MAX_SESSION_MINUTES));
  });

  it("writes a version 2 line through the writer: Scheduled is the length, Overtime 0", () => {
    expect(
      lineFor({
        task: { name: "Write docs #task/develop/docs", path: "Projects/Docs.md", id: "abc123" },
      })
    ).toBe(
      "- 🍅 Focus [Task:: [[Projects/Docs.md|Write docs #task/develop/docs]]] [ID:: abc123] [Start:: 2026-10-02 09:30:00] [End:: 2026-10-02 09:55:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]"
    );
  });

  it("writes no task as the log's own 'No Task', and a skipped focus as cancelled", () => {
    expect(lineFor({ status: "cancelled", minutes: "10" })).toBe(
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 09:30:00] [End:: 2026-10-02 09:40:00] [Scheduled:: 600] [Pauses:: []] [Total:: 600] [Status:: cancelled] [Type:: focus] [Overtime:: 0]"
    );
  });

  it("writes a break as a Rest line of its kind, with no task", () => {
    const task = { name: "Write docs", path: "Projects/Docs.md" };
    expect(lineFor({ kind: "short-break", minutes: "5", task })).toBe(
      "- ☕ Rest [Start:: 2026-10-02 09:30:00] [End:: 2026-10-02 09:35:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]"
    );
    expect(lineFor({ kind: "long-break", minutes: "15" })).toContain("[Type:: long-break]");
  });

  it("takes a one-digit hour and spaces around the values", () => {
    expect(lineFor({ time: " 9:05 ", date: " 2026-10-02 " })).toContain(
      "[Start:: 2026-10-02 09:05:00]"
    );
  });

  it.each([
    ["date", { date: "2026-13-01" }, FORM_DATE_MESSAGE],
    ["date", { date: "2026-02-30" }, FORM_DATE_MESSAGE],
    ["date", { date: "2026/10/02" }, FORM_DATE_MESSAGE],
    ["time", { time: "25:00" }, FORM_TIME_MESSAGE],
    ["time", { time: "9.30" }, FORM_TIME_MESSAGE],
    ["time", { time: "09:60" }, FORM_TIME_MESSAGE],
    // Under a minute is not a session (F59): no line for it here either.
    ["minutes", { minutes: "0" }, FORM_MINUTES_MESSAGE],
    ["minutes", { minutes: "1.5" }, FORM_MINUTES_MESSAGE],
    ["minutes", { minutes: "" }, FORM_MINUTES_MESSAGE],
    ["minutes", { minutes: String(MAX_SESSION_MINUTES + 1) }, FORM_MINUTES_MESSAGE],
  ] as const)("refuses a %s it cannot read", (_what, set, message) => {
    expect(lineFor(set)).toBe(`refused: ${message}`);
  });

  it("accepts the shortest and the longest session", () => {
    expect(lineFor({ minutes: "1" })).toContain("[Total:: 60]");
    expect(lineFor({ date: "2026-09-30", minutes: String(MAX_SESSION_MINUTES) })).toContain(
      "[Total:: 86400]"
    );
  });

  it("refuses a session that has not ended yet", () => {
    // 17:40 + 25 minutes is after 18:00; 17:35 + 25 is exactly 18:00.
    expect(lineFor({ time: "17:40" })).toBe(`refused: ${FORM_FUTURE_MESSAGE}`);
    expect(lineFor({ time: "17:35" })).not.toMatch(/^refused/);
  });

  it("names no task 'No task' on the dialog's button, and a task by its name", () => {
    expect(sessionTaskLabel(null)).toBe("No task");
    expect(sessionTaskLabel({ name: "Write docs #task/develop/docs" })).toBe(
      "Write docs #task/develop/docs"
    );
  });
});

describe("where a new line goes in its day's file", () => {
  const NEW_0900 = lineFor({ time: "09:00", minutes: "20" });

  it("starts a new file ending in a line break", () => {
    expect(insertSessionLine("", NEW_0900)).toBe(`${NEW_0900}\n`);
  });

  it("goes after the last session that started no later, every other line kept", () => {
    const file = `# Today\n${FOCUS_0800}\n${REST_0825}\nA note.\n${FOCUS_1000}\n`;
    expect(insertSessionLine(file, NEW_0900)).toBe(
      `# Today\n${FOCUS_0800}\n${REST_0825}\n${NEW_0900}\nA note.\n${FOCUS_1000}\n`
    );
  });

  it("goes before the first session when it is the earliest", () => {
    const early = lineFor({ time: "07:00" });
    const file = `# Today\n${FOCUS_0800}\n${FOCUS_1000}\n`;
    expect(insertSessionLine(file, early)).toBe(
      `# Today\n${early}\n${FOCUS_0800}\n${FOCUS_1000}\n`
    );
  });

  it("goes at the end when it is the latest, before the final line break", () => {
    const late = lineFor({ time: "11:00" });
    expect(insertSessionLine(`${FOCUS_0800}\n${FOCUS_1000}\n`, late)).toBe(
      `${FOCUS_0800}\n${FOCUS_1000}\n${late}\n`
    );
    // A file that ends without one gets one, and no blank line.
    expect(insertSessionLine(`${FOCUS_0800}\n${FOCUS_1000}`, late)).toBe(
      `${FOCUS_0800}\n${FOCUS_1000}\n${late}\n`
    );
  });

  it("goes after a session that started at the same second", () => {
    const same = lineFor({ time: "08:00", minutes: "5" });
    expect(insertSessionLine(`${FOCUS_0800}\n${FOCUS_1000}\n`, same)).toBe(
      `${FOCUS_0800}\n${same}\n${FOCUS_1000}\n`
    );
  });

  it("reads old-format lines' starts too: a file of both kinds sorts as one", () => {
    const file = `${FOCUS_0800}\n${V1_FOCUS_1100}\n`;
    const late = lineFor({ time: "11:30" });
    expect(insertSessionLine(file, NEW_0900)).toBe(
      `${FOCUS_0800}\n${NEW_0900}\n${V1_FOCUS_1100}\n`
    );
    expect(insertSessionLine(file, late)).toBe(`${FOCUS_0800}\n${V1_FOCUS_1100}\n${late}\n`);
  });

  it("keeps a CRLF file CRLF", () => {
    const file = `${FOCUS_0800}\r\n${FOCUS_1000}\r\n`;
    expect(insertSessionLine(file, NEW_0900)).toBe(
      `${FOCUS_0800}\r\n${NEW_0900}\r\n${FOCUS_1000}\r\n`
    );
    const late = lineFor({ time: "11:00" });
    expect(insertSessionLine(`${FOCUS_0800}\r\n`, late)).toBe(`${FOCUS_0800}\r\n${late}\r\n`);
    // The two cases above both splice. A file that does not end in a line
    // break, and one with no session line to place by, are appended to
    // instead — and that path has to read the file's line ending too.
    expect(insertSessionLine(`${FOCUS_0800}\r\n${FOCUS_1000}`, late)).toBe(
      `${FOCUS_0800}\r\n${FOCUS_1000}\r\n${late}\r\n`
    );
    expect(insertSessionLine("# Notes\r\nNothing.\r\n", NEW_0900)).toBe(
      `# Notes\r\nNothing.\r\n${NEW_0900}\r\n`
    );
  });

  it("keeps a byte order mark at the start of the file when it goes first", () => {
    // Left on the old first line, now the second, the mark stops that line
    // being a list item for Obsidian and Dataview.
    const BOM = "\uFEFF";
    expect(insertSessionLine(`${BOM}${FOCUS_1000}\n`, NEW_0900)).toBe(
      `${BOM}${NEW_0900}\n${FOCUS_1000}\n`
    );
    expect(insertSessionLine(`${BOM}${FOCUS_1000}\r\n`, NEW_0900)).toBe(
      `${BOM}${NEW_0900}\r\n${FOCUS_1000}\r\n`
    );
    // Placed after the first line, nothing about the mark changes.
    expect(insertSessionLine(`${BOM}${FOCUS_0800}\n${FOCUS_1000}\n`, NEW_0900)).toBe(
      `${BOM}${FOCUS_0800}\n${NEW_0900}\n${FOCUS_1000}\n`
    );
    const out = insertSessionLine(`${BOM}${FOCUS_1000}\n`, NEW_0900);
    expect(loggedLines(out).map((l) => l.parsed.prefix)).toEqual([`${BOM}- `, "- "]);
  });

  it("goes at the end of a file with no session it can place it by", () => {
    expect(insertSessionLine("# Notes\nNothing yet.", NEW_0900)).toBe(
      `# Notes\nNothing yet.\n${NEW_0900}\n`
    );
  });

  it("adds up to the old total plus the new session", () => {
    const file = `${FOCUS_0800}\n${REST_0825}\n${FOCUS_1000}\n`;
    expect(parseFocusTotalSeconds(insertSessionLine(file, NEW_0900))).toBe(
      parseFocusTotalSeconds(file) + 1200
    );
  });
});

describe("rewriting one line, only as it was read", () => {
  const file = `# Today\r\n${FOCUS_0800}\r\n${REST_0825}\r\n${FOCUS_1000}\r\n`;
  const lines = loggedLines(file);
  const rest = lines[1];

  it("lists the session lines with their place and start", () => {
    expect(lines.map((l) => [l.index, l.text])).toEqual([
      [1, FOCUS_0800],
      [2, REST_0825],
      [3, FOCUS_1000],
    ]);
    expect(rest.start).toBe(at(2026, 10, 2, 8, 25) / 1000);
  });

  it("replaces the line where it was, keeping its line ending", () => {
    expect(replaceSessionLine(file, rest, "NEW")).toBe(
      `# Today\r\n${FOCUS_0800}\r\nNEW\r\n${FOCUS_1000}\r\n`
    );
  });

  it("deletes it, and only it", () => {
    expect(replaceSessionLine(file, rest, null)).toBe(
      `# Today\r\n${FOCUS_0800}\r\n${FOCUS_1000}\r\n`
    );
  });

  it("refuses when the line was changed meanwhile", () => {
    const edited = file.replace("[Total:: 300]", "[Total:: 240]");
    expect(replaceSessionLine(edited, rest, "NEW")).toBeNull();
    expect(replaceSessionLine(edited, rest, null)).toBeNull();
  });

  it("finds it when lines before it came or went", () => {
    const moved = `A line added on top.\r\n${file}`;
    expect(replaceSessionLine(moved, rest, "NEW")).toBe(
      `A line added on top.\r\n# Today\r\n${FOCUS_0800}\r\nNEW\r\n${FOCUS_1000}\r\n`
    );
  });

  it("refuses when it moved and is there twice: it cannot tell which was meant", () => {
    const twice = `A line added on top.\r\n${file}${REST_0825}\r\n`;
    expect(replaceSessionLine(twice, rest, "NEW")).toBeNull();
  });
});

describe("a logged line in the dialog", () => {
  const line = (text: string): LoggedLine => {
    const found = loggedLines(text)[0];
    if (!found) throw new Error("no session line");
    return found;
  };

  it("fills the dialog from a focus line", () => {
    expect(formFromLine(line(FOCUS_0800), toMoment)).toEqual(
      form({
        task: {
          name: "Plant the tulips #task/other/garden",
          path: "Projects/Garden.md",
          id: "t9k2xq",
        },
        time: "08:00",
      })
    );
  });

  it("fills the dialog from a break, a skipped focus and a rounded length", () => {
    expect(formFromLine(line(REST_0825), toMoment)).toMatchObject({
      kind: "short-break",
      task: null,
      minutes: "5",
    });
    const skipped = FOCUS_1000.replace("finished", "cancelled").replace(
      "[Total:: 1500]",
      "[Total:: 1530]"
    );
    expect(formFromLine(line(skipped), toMoment)).toMatchObject({
      status: "cancelled",
      minutes: "26",
      task: { name: "No Task" },
    });
  });

  it("cannot fill it from a line whose start does not read", () => {
    const bad = FOCUS_1000.replace("2026-10-02 10:00:00", "today at ten");
    expect(formFromLine(line(bad), toMoment)).toBeNull();
  });

  it("describes each line in the day's list", () => {
    expect(describeLoggedLine(line(FOCUS_0800))).toBe(
      "08:00 · Focus · 25m · Plant the tulips #task/other/garden"
    );
    expect(describeLoggedLine(line(REST_0825))).toBe("08:25 · Short break · 5m");
    expect(describeLoggedLine(line(FOCUS_1000.replace("finished", "cancelled")))).toBe(
      "10:00 · Focus · 25m · skipped · No Task"
    );
    // Written before Type: it does not say which break.
    expect(
      describeLoggedLine(
        line(
          "- ☕ Rest | Start:: 2025-12-23 15:00:00 | End:: 2025-12-23 15:15:00 | Scheduled:: 900 | Total:: 900"
        )
      )
    ).toBe("15:00 · Break · 15m");
  });
});

describe("a logged line, edited", () => {
  // A focus with a pause, and a Total someone corrected by hand: 1700 where
  // the span less the pause is 1500.
  const PAUSED =
    '- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-10-02 08:00:17] [End:: 2026-10-02 08:31:17] [Scheduled:: 1500] [Pauses:: ["2026-10-02 08:10:00 - 2026-10-02 08:16:00"]] [Total:: 1700] [Status:: finished] [Type:: focus] [Overtime:: 0]';
  const edit = (text: string, set: Partial<SessionForm>, extra: { dayStartHour?: number } = {}) => {
    const line = loggedLines(text)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    return editedLine(
      line,
      initial,
      { ...initial, ...set },
      { toMoment, nowMs: NOW, dayStartHour: extra.dayStartHour ?? 0, fileDate: "2026-10-02" }
    );
  };
  const textOf = (result: ReturnType<typeof edit>) =>
    result.kind === "ok" ? result.text : result.kind;

  it("changes nothing when nothing was changed", () => {
    expect(edit(PAUSED, {})).toEqual({ kind: "unchanged" });
    expect(edit(V1_FOCUS_1100, {})).toEqual({ kind: "unchanged" });
  });

  it("changes the task alone: every time field keeps its exact text", () => {
    expect(
      textOf(edit(PAUSED, { task: { name: "Weed #task/other/garden", path: "Projects/Weed.md" } }))
    ).toBe(
      '- 🍅 Focus [Task:: [[Projects/Weed.md|Weed #task/other/garden]]] [Start:: 2026-10-02 08:00:17] [End:: 2026-10-02 08:31:17] [Scheduled:: 1500] [Pauses:: ["2026-10-02 08:10:00 - 2026-10-02 08:16:00"]] [Total:: 1700] [Status:: finished] [Type:: focus] [Overtime:: 0]'
    );
  });

  it("writes the new task's own ID: the old task's never stays beside the new link", () => {
    const weed = { name: "Weed #task/other/garden", path: "Projects/Weed.md", id: "w33d01" };
    expect(textOf(edit(PAUSED, { task: weed }))).toBe(
      '- 🍅 Focus [Task:: [[Projects/Weed.md|Weed #task/other/garden]]] [ID:: w33d01] [Start:: 2026-10-02 08:00:17] [End:: 2026-10-02 08:31:17] [Scheduled:: 1500] [Pauses:: ["2026-10-02 08:10:00 - 2026-10-02 08:16:00"]] [Total:: 1700] [Status:: finished] [Type:: focus] [Overtime:: 0]'
    );
    // A line that had no task, so no ID, gains the new one in its place.
    expect(textOf(edit(FOCUS_1000, { task: weed }))).toBe(
      FOCUS_1000.replace(
        "[Task:: No Task]",
        "[Task:: [[Projects/Weed.md|Weed #task/other/garden]]] [ID:: w33d01]"
      )
    );
  });

  it("changes the status alone, and brings an old-format line to version 2 with nothing added", () => {
    expect(textOf(edit(V1_FOCUS_1100, { status: "cancelled" }))).toBe(
      "- 🍅 Focus [Task:: [[Projects/Course.md|Module 3 #task/class/course]]] [ID:: bq7m2w] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: cancelled]"
    );
  });

  it("moves the whole session when the start moves, pauses too, its length untouched", () => {
    expect(textOf(edit(PAUSED, { time: "08:30" }))).toBe(
      '- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-10-02 08:30:17] [End:: 2026-10-02 09:01:17] [Scheduled:: 1500] [Pauses:: ["2026-10-02 08:40:00 - 2026-10-02 08:46:00"]] [Total:: 1700] [Status:: finished] [Type:: focus] [Overtime:: 0]'
    );
  });

  it("trims a forgotten timer: the new length from its start, no pauses, Overtime past the plan", () => {
    const overnight =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-01 23:00:00] [End:: 2026-10-02 09:00:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 36000] [Status:: finished] [Type:: focus] [Overtime:: 34500]";
    const line = loggedLines(overnight)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const result = editedLine(
      line,
      initial,
      { ...initial, minutes: "40" },
      { toMoment, nowMs: NOW, dayStartHour: 0, fileDate: "2026-10-01" }
    );
    expect(textOf(result)).toBe(
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-01 23:00:00] [End:: 2026-10-01 23:40:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 2400] [Status:: finished] [Type:: focus] [Overtime:: 900]"
    );
  });

  it("drops the pauses of a session whose length changed, so the line still balances", () => {
    expect(textOf(edit(PAUSED, { minutes: "20" }))).toBe(
      "- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-10-02 08:00:17] [End:: 2026-10-02 08:20:17] [Scheduled:: 1500] [Pauses:: []] [Total:: 1200] [Status:: finished] [Type:: focus] [Overtime:: 0]"
    );
  });

  it("adds no Overtime to a line written before it existed, even when the length changes", () => {
    expect(textOf(edit(V1_FOCUS_1100, { minutes: "40" }))).not.toContain("Overtime");
  });

  it("refuses a move into another day's log", () => {
    expect(edit(FOCUS_0800, { date: "2026-10-01" })).toEqual({
      kind: "error",
      message: FORM_OTHER_DAY_MESSAGE,
    });
  });

  it("counts days as 'Day starts at' does: 01:30 with a 4:00 start is the day before", () => {
    const late =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-01 23:00:00] [End:: 2026-10-01 23:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
    const line = loggedLines(late)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const moved = { ...initial, date: "2026-10-02", time: "01:30" };
    const context = { toMoment, nowMs: NOW, fileDate: "2026-10-01" };
    expect(editedLine(line, initial, moved, { ...context, dayStartHour: 4 }).kind).toBe("ok");
    expect(editedLine(line, initial, moved, { ...context, dayStartHour: 0 })).toEqual({
      kind: "error",
      message: FORM_OTHER_DAY_MESSAGE,
    });
  });

  it("lets a session be trimmed in a file named by calendar date, when it stays on its day", () => {
    // Before 0.6.9 every file was named by the calendar date its sessions
    // started on, so with a 4:00 day start a 01:30 session sits in the file
    // of the day after the day it counts for. Trimming or moving it within
    // that day is not a move to another day's log.
    const forgotten =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-09-02 01:30:00] [End:: 2026-09-02 09:30:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 28800] [Status:: finished] [Type:: focus]";
    const line = loggedLines(forgotten)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const context = { toMoment, nowMs: NOW, dayStartHour: 4, fileDate: "2026-09-02" };
    const result = (set: Partial<SessionForm>) =>
      editedLine(line, initial, { ...initial, ...set }, context);
    expect(textOf(result({ minutes: "25" }))).toBe(
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-09-02 01:30:00] [End:: 2026-09-02 01:55:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus]"
    );
    // Still 2026-09-01 as the day start counts it, or the file's own day.
    expect(result({ time: "02:00" }).kind).toBe("ok");
    expect(result({ date: "2026-09-01", time: "23:00" }).kind).toBe("ok");
    expect(result({ time: "05:00", minutes: "25" }).kind).toBe("ok");
    // A real move is still refused.
    for (const set of [
      { date: "2026-09-03", time: "10:00" },
      { date: "2026-08-31", time: "10:00" },
    ]) {
      expect(result(set)).toEqual({ kind: "error", message: FORM_OTHER_DAY_MESSAGE });
    }
  });

  it("lets a session be trimmed after 'Day starts at' changed under it", () => {
    // Written with a 4:00 start into 2026-10-01's file; the setting is now midnight.
    const early =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 01:30:00] [End:: 2026-10-02 03:30:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 7200] [Status:: finished] [Type:: focus] [Overtime:: 5700]";
    const line = loggedLines(early)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const context = { toMoment, nowMs: NOW, dayStartHour: 0, fileDate: "2026-10-01" };
    expect(editedLine(line, initial, { ...initial, minutes: "25" }, context).kind).toBe("ok");
  });

  it.each([
    ["20 s, shown as 0 minutes", 20],
    ["27 h, more than the dialog takes", 97200],
  ])("edits the task or status of a line of %s, its Total kept exact", (_name, total) => {
    const start = at(2026, 9, 30, 8, 0) / 1000;
    const stamp = (seconds: number) =>
      moment(seconds * 1000)
        .locale("en")
        .format("YYYY-MM-DD HH:mm:ss");
    const text = `- 🍅 Focus [Task:: No Task] [Start:: ${stamp(start)}] [End:: ${stamp(start + total)}] [Scheduled:: 1500] [Pauses:: []] [Total:: ${String(total)}] [Status:: finished] [Type:: focus] [Overtime:: 0]`;
    const line = loggedLines(text)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const context = { toMoment, nowMs: NOW, dayStartHour: 0, fileDate: "2026-09-30" };
    const status = editedLine(line, initial, { ...initial, status: "cancelled" }, context);
    expect(textOf(status)).toBe(text.replace("finished", "cancelled"));
    const task = editedLine(
      line,
      initial,
      { ...initial, task: { name: "Weed", path: "Projects/Weed.md" } },
      context
    );
    expect(textOf(task)).toBe(
      text.replace("[Task:: No Task]", "[Task:: [[Projects/Weed.md|Weed]]]")
    );
    expect(parseLogLine(textOf(task))?.values.get("Total")).toBe(String(total));
    // A length typed into the box is checked as always.
    expect(editedLine(line, initial, { ...initial, minutes: "1441" }, context)).toEqual({
      kind: "error",
      message: FORM_MINUTES_MESSAGE,
    });
    expect(textOf(editedLine(line, initial, { ...initial, minutes: "5" }, context))).toContain(
      "[Total:: 300]"
    );
  });

  it("does not take the same minutes written another way for a new length", () => {
    // 1530 s shows as 26; "026" is no reason to drop the pauses or round Total.
    const odd = PAUSED.replace("[Total:: 1700]", "[Total:: 1530]");
    expect(formFromLine(loggedLines(odd)[0], toMoment)?.minutes).toBe("26");
    expect(edit(odd, { minutes: "026" })).toEqual({ kind: "unchanged" });
    expect(textOf(edit(odd, { minutes: "026", status: "cancelled" }))).toBe(
      odd.replace("finished", "cancelled")
    );
  });

  it("refuses an edit that would end in the future", () => {
    expect(edit(FOCUS_0800, { time: "17:50" })).toEqual({
      kind: "error",
      message: FORM_FUTURE_MESSAGE,
    });
  });

  it("refuses values it cannot read, as the new-session dialog does", () => {
    expect(edit(FOCUS_0800, { minutes: "0" })).toEqual({
      kind: "error",
      message: FORM_MINUTES_MESSAGE,
    });
  });

  it("turns a focus into a break: the task, its ID, pauses, status and Overtime go", () => {
    expect(textOf(edit(PAUSED, { kind: "short-break" }))).toBe(
      "- ☕ Rest [Start:: 2026-10-02 08:00:17] [End:: 2026-10-02 08:31:17] [Scheduled:: 1500] [Total:: 1700] [Type:: short-break]"
    );
  });

  it("turns a break into a focus with nothing it never had: no pauses, no Overtime", () => {
    expect(
      textOf(edit(REST_0825, { kind: "focus", task: { name: "Write docs", path: "Docs.md" } }))
    ).toBe(
      "- 🍅 Focus [Task:: [[Docs.md|Write docs]]] [Start:: 2026-10-02 08:25:00] [End:: 2026-10-02 08:30:00] [Scheduled:: 300] [Total:: 300] [Status:: finished] [Type:: focus]"
    );
  });

  it("keeps a field it does not know, and text after the fields", () => {
    const extra = `${FOCUS_1000} [Mood:: calm] ^s1000`;
    expect(textOf(edit(extra, { status: "cancelled" }))).toBe(
      `${FOCUS_1000.replace("finished", "cancelled")} [Mood:: calm] ^s1000`
    );
  });

  it("keeps a block ID at the end of an old-format line it rewrites", () => {
    // An old line's last field runs to the end of the line; the ID is not
    // part of it, and inside `[Status:: …]` no link to it would resolve.
    expect(textOf(edit(`${V1_FOCUS_1100} ^c1100`, { status: "cancelled" }))).toBe(
      "- 🍅 Focus [Task:: [[Projects/Course.md|Module 3 #task/class/course]]] [ID:: bq7m2w] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: cancelled] ^c1100"
    );
  });

  it("drops the checkbox the oldest lines carried, as the converter does", () => {
    const boxed =
      "- [x] 🍅 Focus | Task:: Sort the seeds | Start:: 2025-12-22 12:00:00 | End:: 2025-12-22 12:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished";
    const line = loggedLines(boxed)[0];
    const initial = formFromLine(line, toMoment);
    if (!initial) throw new Error("unreadable");
    const result = editedLine(
      line,
      initial,
      { ...initial, status: "cancelled" },
      { toMoment, nowMs: NOW, dayStartHour: 0, fileDate: "2025-12-22" }
    );
    expect(textOf(result)).toBe(
      "- 🍅 Focus [Task:: Sort the seeds] [Start:: 2025-12-22 12:00:00] [End:: 2025-12-22 12:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: cancelled]"
    );
  });

  it("refuses a line that would not read back the same", () => {
    // A `]` in an old-format name closes a version 2 field early.
    const odd =
      "- 🍅 Focus | Task:: Fix [the] bug] | Start:: 2026-10-02 11:00:00 | End:: 2026-10-02 11:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished";
    expect(parseLogLine(odd)?.format).toBe("v1");
    expect(edit(odd, { status: "cancelled" })).toEqual({
      kind: "error",
      message: FORM_UNSAFE_MESSAGE,
    });
  });

  it("adds no field the line never had: a hand-written line without Scheduled stays without", () => {
    const bare = FOCUS_1000.replace(" [Scheduled:: 1500]", "");
    expect(textOf(edit(bare, { status: "cancelled" }))).toBe(bare.replace("finished", "cancelled"));
  });

  it("keeps dates written in other digits as they are when the timing does not change", () => {
    // Convert old log lines is what writes them with 0-9 (F14); an edit of
    // the task or status leaves every time field's text alone.
    const arabic = FOCUS_1000.replace(
      /2026-10-02 10:(\d\d):00/g,
      (_m, mm: string) => `٢٠٢٦-١٠-٠٢ ١٠:${mm === "00" ? "٠٠" : "٢٥"}:٠٠`
    );
    expect(arabic).toContain("[Start:: ٢٠٢٦-١٠-٠٢ ١٠:٠٠:٠٠]");
    expect(textOf(edit(arabic, { status: "cancelled" }))).toBe(
      arabic.replace("finished", "cancelled")
    );
  });

  it("will not move a session whose end cannot be read", () => {
    const noEnd = FOCUS_0800.replace("2026-10-02 08:25:00", "soon");
    expect(edit(noEnd, { time: "08:30" })).toEqual({ kind: "error", message: FORM_UNSAFE_MESSAGE });
    // Its task can still change: its timing is copied as written.
    expect(textOf(edit(noEnd, { task: null }))).toContain("[End:: soon]");
  });

  it("writes lines that read back as the same session", () => {
    for (const set of [{ time: "08:30" }, { minutes: "20" }, { status: "cancelled" as const }]) {
      const text = textOf(edit(PAUSED, set));
      const parsed = parseLogLine(text);
      expect(parsed?.format, JSON.stringify(set)).toBe("v2");
      expect(parsed?.rest).toBe("");
    }
  });
});

/**
 * Runs a describe block's tests in another time zone, as tests/logLine.test.ts
 * does: Node re-reads TZ when it is assigned, and moment works on Date.
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

// Each zone's fall-back night: the hour it repeats, and a 25-minute focus the
// timer wrote in its SECOND pass, ending just after it. [zone, date, the hour
// that repeats, the start (second pass), its end, the move asked for, where
// the end should go, UTC offset in the second pass (minutes, as Date says)].
describe.each([
  ["America/Chicago", "2026-11-01", 1, "01:50", "02:15", "02:00", "02:25", 360],
  ["Europe/Berlin", "2026-10-25", 2, "02:50", "03:15", "03:00", "03:25", -60],
])(
  "a session in the hour a fall-back night repeats, edited, in %s (F2)",
  (zone, date, hour, start, end, moveTo, movedEnd, secondPassOffset) => {
    inZone(zone);
    const line = (from: string, to: string, total: number, pauses = "[]") =>
      `- 🍅 Focus [Task:: No Task] [Start:: ${date} ${from}:00] [End:: ${date} ${to}:00] [Scheduled:: 1500] [Pauses:: ${pauses}] [Total:: ${String(total)}] [Status:: finished] [Type:: focus] [Overtime:: 0]`;
    // Well after both nights, read as an instant: no zone needed.
    const later = Date.UTC(2026, 11, 1);
    const edit = (text: string, set: Partial<SessionForm>) => {
      const logged = loggedLines(text)[0];
      const initial = formFromLine(logged, toMoment);
      if (!initial) throw new Error("unreadable");
      const result = editedLine(
        logged,
        initial,
        { ...initial, ...set },
        { toMoment, nowMs: later, dayStartHour: 0, fileDate: date }
      );
      return result.kind === "ok" ? parseLogLine(result.text)?.values : result.kind;
    };
    const time = (values: ReturnType<typeof edit>, key: string) =>
      typeof values === "string" ? values : values?.get(key)?.slice(11, 16);

    it("runs in that zone", () => {
      const [y, mo, d] = date.split("-").map(Number);
      // The repeated hour's two passes are an hour apart, the later one on standard time.
      expect(new Date(y, mo - 1, d, hour + 2, 0).getTimezoneOffset()).toBe(secondPassOffset);
    });

    it("reads a start in the repeated hour in the pass its Total fits", () => {
      const [y, mo, d] = date.split("-").map(Number);
      const [h, m] = start.split(":").map(Number);
      // The second pass: the wall-clock time at the standard-time offset.
      const second = (Date.UTC(y, mo - 1, d, h, m) + secondPassOffset * 60_000) / 1000;
      expect(loggedLines(line(start, end, 1500))[0].start).toBe(second);
    });

    it("moves the end by what the start moved, not by an hour more", () => {
      const moved = edit(line(start, end, 1500), { time: moveTo });
      expect(time(moved, "Start")).toBe(moveTo);
      expect(time(moved, "End")).toBe(movedEnd);
      expect(typeof moved === "string" ? moved : moved?.get("Total")).toBe("1500");
    });

    it("measures a new length from the start in its own pass", () => {
      const longer = edit(line(start, end, 1500), { minutes: "30" });
      const [h, m] = end.split(":").map(Number);
      expect(time(longer, "End")).toBe(`${String(h).padStart(2, "0")}:${String(m + 5)}`);
    });

    it("moves a pause in the repeated hour with the session", () => {
      // Ten minutes earlier than the line above, with a 5-minute pause: Start
      // and the pause in the second pass, End just after it — 35 minutes,
      // 30 of them active. Moved 20 minutes later, every time moves 20.
      const [h, m] = start.split(":").map(Number);
      const hh = (x: number) => String(x).padStart(2, "0");
      const from = `${hh(h)}:${hh(m - 10)}`;
      const pause = `["${date} ${hh(h)}:${hh(m - 5)}:00 - ${date} ${start}:00"]`;
      const moved = edit(line(from, end, 1800, pause), { time: moveTo });
      expect(time(moved, "Start")).toBe(moveTo);
      expect(typeof moved === "string" ? moved : moved?.get("Pauses")).toBe(
        `["${date} ${moveTo.slice(0, 3)}05:00 - ${date} ${moveTo.slice(0, 3)}10:00"]`
      );
      expect(time(moved, "End")).toBe(
        `${moveTo.slice(0, 3)}${String(parseInt(end.slice(3), 10) + 20)}`
      );
    });

    it("keeps the first pass when that is what the span fits, or when nothing fits", () => {
      // Ends in the second pass, 25 minutes after a start in the first.
      const [h] = start.split(":").map(Number);
      const hh = (x: number) => String(x).padStart(2, "0");
      const first = line(`${hh(h)}:50`, `${hh(h)}:15`, 1500);
      const moved = edit(first, { time: `${hh(h)}:55` });
      expect(time(moved, "Start")).toBe(`${hh(h)}:55`);
      expect(time(moved, "End")).toBe(`${hh(h)}:20`);
      // A Total corrected by hand fits no reading: read as written, first pass.
      const [y, mo, d] = date.split("-").map(Number);
      const [sh, sm] = start.split(":").map(Number);
      const firstPass = new Date(y, mo - 1, d, sh, sm).getTime() / 1000;
      expect(loggedLines(line(start, end, 1700))[0].start).toBe(firstPass);
      // Start and End both in the repeated hour fit in either pass: the first.
      const both = line(`${hh(h)}:10`, `${hh(h)}:35`, 1500);
      expect(loggedLines(both)[0].start).toBe(new Date(y, mo - 1, d, h, 10).getTime() / 1000);
    });

    const hh = (x: number) => String(x).padStart(2, "0");
    const pauses = (...spans: [string, string][]) =>
      `[${spans.map(([a, b]) => `"${date} ${a}:00 - ${date} ${b}:00"`).join(", ")}]`;

    it("moves a second-pass start within the repeated hour by what the form says, however far", () => {
      // An hour from the top of the repeated hour, in its second pass, to just after it.
      const second = line(`${hh(hour)}:00`, `${hh(hour + 1)}:00`, 3600);
      for (const minute of ["20", "30", "40", "55"]) {
        const moved = edit(second, { time: `${hh(hour)}:${minute}` });
        expect(time(moved, "Start"), minute).toBe(`${hh(hour)}:${minute}`);
        expect(time(moved, "End"), minute).toBe(`${hh(hour + 1)}:${minute}`);
      }
    });

    it("moves a first-pass start earlier within the repeated hour by what the form says, however far", () => {
      // 01:50 in the first pass to 02:30 after the hour: 100 minutes.
      const first = line(`${hh(hour)}:50`, `${hh(hour + 1)}:30`, 6000);
      const moved = edit(first, { time: `${hh(hour)}:10` });
      expect(time(moved, "Start")).toBe(`${hh(hour)}:10`);
      // Forty minutes earlier, in the second pass now: 01:50.
      expect(time(moved, "End")).toBe(`${hh(hour)}:50`);
    });

    it("moves a pause across the fall-back moment with the session", () => {
      // 01:40 in the first pass, paused from 01:55 to 01:05 in the second —
      // ten minutes across the moment the clocks go back — to 02:15: 85 active.
      const across = line(
        `${hh(hour)}:40`,
        `${hh(hour + 1)}:15`,
        5100,
        pauses([`${hh(hour)}:55`, `${hh(hour)}:05`])
      );
      const moved = edit(across, { time: `${hh(hour)}:45` });
      expect(typeof moved === "string" ? moved : moved?.get("Pauses")).toBe(
        pauses([`${hh(hour)}:00`, `${hh(hour)}:10`])
      );
      expect(time(moved, "End")).toBe(`${hh(hour + 1)}:20`);

      // From 00:55, before the repeated hour, to 01:05 in its second pass:
      // a pause of seventy minutes, which only Total can tell.
      const into = line(
        `${hh(hour - 1)}:50`,
        `${hh(hour + 1)}:10`,
        4200,
        pauses([`${hh(hour - 1)}:55`, `${hh(hour)}:05`])
      );
      const later = edit(into, { time: `${hh(hour)}:50` });
      expect(typeof later === "string" ? later : later?.get("Pauses")).toBe(
        pauses([`${hh(hour)}:55`, `${hh(hour + 1)}:05`])
      );
      expect(time(later, "End")).toBe(`${hh(hour + 2)}:10`);
    });

    it("lets Total be out by a second plus a second per pause, as Check does, and no more", () => {
      // The second pass, two pauses: 70 minutes less 10 paused is 3600 s.
      const twoPauses = (total: number) =>
        line(
          `${hh(hour)}:00`,
          `${hh(hour + 1)}:10`,
          total,
          pauses([`${hh(hour)}:10`, `${hh(hour)}:15`], [`${hh(hour)}:20`, `${hh(hour)}:25`])
        );
      const [y, mo, d] = date.split("-").map(Number);
      const firstPass = new Date(y, mo - 1, d, hour, 0).getTime() / 1000;
      // Out by 3 s: still the second pass, so 90 minutes from it end after the hour.
      expect(loggedLines(twoPauses(3603))[0].start).toBe(firstPass + 3600);
      expect(time(edit(twoPauses(3603), { minutes: "90" }), "End")).toBe(`${hh(hour + 1)}:30`);
      // Out by 4 s: no reading fits, so the first pass, an hour earlier.
      expect(loggedLines(twoPauses(3604))[0].start).toBe(firstPass);
      expect(time(edit(twoPauses(3604), { minutes: "90" }), "End")).toBe(`${hh(hour)}:30`);
    });
  }
);
