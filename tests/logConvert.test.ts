import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOG_ANOMALY_KINDS,
  LOG_CONVERSION_KINDS,
  LONG_SESSION_SECONDS,
  addConversionCounts,
  asciiLogFileName,
  convertLogContent,
  countAnomalies,
  describeSeconds,
  emptyConversionCounts,
  logLineCount,
  mergeLogContent,
  scanLogAnomalies,
  unmergeLogContent,
  type LogAnomaly,
  type LogConversionCounts,
} from "../logConvert";
import {
  asciiDigits,
  formatLogLine,
  looksLikeLogLine,
  parseFocusTotalSeconds,
  parseLogLine,
  readLogPauses,
  readLogTime,
  repeatedReading,
} from "../logLine";
import type { MomentLike } from "../momentTypes";

// The real moment; a locale file requires "../moment", so both go through
// require and land in the same instance.
const require = createRequire(import.meta.url);
const moment = require("moment") as ((input?: unknown) => MomentLike) & {
  locale(key?: string): string;
};
const localeDir = resolve(dirname(require.resolve("moment")), "locale");
const LOCALES = readdirSync(localeDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => name.slice(0, -3));
for (const name of LOCALES) require(`moment/locale/${name}`);
moment.locale("en");

afterEach(() => {
  moment.locale("en");
});

const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  moment(new Date(y, mo - 1, d, h, mi, s));

/** Counts with only the named kinds set — the rest must stay 0. */
const counts = (set: Partial<LogConversionCounts>): LogConversionCounts => ({
  ...emptyConversionCounts(),
  ...set,
});

// One made-up line of each shape the real logs hold (no real line is copied
// here), and what it becomes. The census of the real files: 221 / 92 / 46 /
// 46 / 21 / 15 / 3 / 1 lines, in this order.
const SHAPES = [
  {
    shape: "Focus with ID and Type (Jun 2026 on)",
    prefix: "- ",
    keys: ["Task", "ID", "Start", "End", "Scheduled", "Pauses", "Total", "Status", "Type"],
    v1: `- 🍅 Focus | Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]] | ID:: t9k2xq | Start:: 2026-06-15 09:00:00 | End:: 2026-06-15 09:31:00 | Scheduled:: 1500 | Pauses:: ["2026-06-15 09:10:00 - 2026-06-15 09:16:00"] | Total:: 1500 | Status:: finished | Type:: focus`,
    v2: `- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-06-15 09:00:00] [End:: 2026-06-15 09:31:00] [Scheduled:: 1500] [Pauses:: ["2026-06-15 09:10:00 - 2026-06-15 09:16:00"]] [Total:: 1500] [Status:: finished] [Type:: focus]`,
  },
  {
    shape: "Focus with neither ID nor Type (Dec 2025 to Feb 2026)",
    prefix: "- ",
    keys: ["Task", "Start", "End", "Scheduled", "Pauses", "Total", "Status"],
    v1: "- 🍅 Focus | Task:: [[Projects/Garden.md|Water the roses #task/other/garden]] | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished",
    v2: "- 🍅 Focus [Task:: [[Projects/Garden.md|Water the roses #task/other/garden]]] [Start:: 2025-12-23 10:00:00] [End:: 2025-12-23 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished]",
  },
  {
    shape: "Focus with Type and no ID (May 2026 on)",
    prefix: "- ",
    keys: ["Task", "Start", "End", "Scheduled", "Pauses", "Total", "Status", "Type"],
    v1: "- 🍅 Focus | Task:: No Task | Start:: 2026-05-19 12:00:00 | End:: 2026-05-19 12:20:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1200 | Status:: cancelled | Type:: focus",
    v2: "- 🍅 Focus [Task:: No Task] [Start:: 2026-05-19 12:00:00] [End:: 2026-05-19 12:20:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1200] [Status:: cancelled] [Type:: focus]",
  },
  {
    shape: "Rest with Type (May 2026 on)",
    prefix: "- ",
    keys: ["Start", "End", "Scheduled", "Total", "Type"],
    v1: "- ☕ Rest | Start:: 2026-05-25 20:56:00 | End:: 2026-05-25 21:01:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break",
    v2: "- ☕ Rest [Start:: 2026-05-25 20:56:00] [End:: 2026-05-25 21:01:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]",
  },
  {
    shape: "Focus with ID and no Type (Jan to Mar 2026)",
    prefix: "- ",
    keys: ["Task", "ID", "Start", "End", "Scheduled", "Pauses", "Total", "Status"],
    v1: "- 🍅 Focus | Task:: [[Projects/Course.md|Module 3 - Part 2 #task/class/course]] | ID:: bq7m2w | Start:: 2026-01-30 14:00:00 | End:: 2026-01-30 14:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished",
    v2: "- 🍅 Focus [Task:: [[Projects/Course.md|Module 3 - Part 2 #task/class/course]]] [ID:: bq7m2w] [Start:: 2026-01-30 14:00:00] [End:: 2026-01-30 14:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished]",
  },
  {
    shape: "Rest with no Type (Dec 2025 to Feb 2026)",
    prefix: "- ",
    keys: ["Start", "End", "Scheduled", "Total"],
    v1: "- ☕ Rest | Start:: 2025-12-23 15:00:00 | End:: 2025-12-23 15:15:00 | Scheduled:: 900 | Total:: 900",
    v2: "- ☕ Rest [Start:: 2025-12-23 15:00:00] [End:: 2025-12-23 15:15:00] [Scheduled:: 900] [Total:: 900]",
  },
  {
    shape: "Focus behind a done checkbox, the name unlinked (the first test lines)",
    prefix: "- [x] ",
    keys: ["Task", "Start", "End", "Scheduled", "Pauses", "Total", "Status"],
    v1: "- [x] 🍅 Focus | Task:: Sort the seeds /other/garden | Start:: 2025-12-22 12:00:00 | End:: 2025-12-22 12:00:30 | Scheduled:: 1500 | Pauses:: [] | Total:: 30 | Status:: finished",
    v2: "- 🍅 Focus [Task:: Sort the seeds /other/garden] [Start:: 2025-12-22 12:00:00] [End:: 2025-12-22 12:00:30] [Scheduled:: 1500] [Pauses:: []] [Total:: 30] [Status:: finished]",
  },
  {
    shape: "Rest behind an open checkbox (the first test lines)",
    prefix: "- [ ] ",
    keys: ["Start", "End", "Scheduled", "Total"],
    v1: "- [ ] ☕ Rest | Start:: 2025-12-22 22:50:00 | End:: 2025-12-22 22:50:05 | Scheduled:: 300 | Total:: 5",
    v2: "- ☕ Rest [Start:: 2025-12-22 22:50:00] [End:: 2025-12-22 22:50:05] [Scheduled:: 300] [Total:: 5]",
  },
];

describe("every shape of line the logs have held", () => {
  it.each(SHAPES)("$shape: read, and written as version 2", ({ v1, v2, prefix, keys }) => {
    const parsed = parseLogLine(v1);
    expect(parsed).toMatchObject({ format: "v1", prefix, rest: "" });
    expect(parsed?.fields.map((f) => f.key)).toEqual(keys);

    const result = convertLogContent(v1);
    expect(result.content).toBe(v2);
    expect(result.counts).toEqual(counts({ converted: 1, checkbox: prefix.includes("[") ? 1 : 0 }));
    // Same fields, same values, now in the format Dataview reads.
    const back = parseLogLine(v2);
    expect(back?.format).toBe("v2");
    expect(back?.fields.map((f) => [f.key, f.value])).toEqual(
      parsed?.fields.map((f) => [f.key, f.value])
    );
    // Nothing is made up: no ID, Type or Overtime the line did not have.
    expect(back?.fields).toHaveLength(keys.length);
  });

  it("converts a whole file of every shape: same totals, other lines byte for byte", () => {
    const v2Line = formatLogLine({
      mode: "focus",
      taskName: "Weed the beds",
      taskPath: "Projects/Garden.md",
      scheduledDurationMinutes: 25,
      startTime: local(2026, 10, 2, 9, 0),
      endTime: local(2026, 10, 2, 9, 25),
      pauses: [],
      status: "finished",
      overtimeSeconds: 0,
    });
    const lines = ["", ...SHAPES.map((s) => s.v1), "## Notes", "Felt slow after lunch.", v2Line];
    const content = lines.join("\n");
    const result = convertLogContent(content);

    expect(result.content.split("\n")).toEqual([
      "",
      ...SHAPES.map((s) => s.v2),
      "## Notes",
      "Felt slow after lunch.",
      v2Line,
    ]);
    expect(result.counts).toEqual(
      counts({ converted: 8, checkbox: 2, alreadyV2: 1, otherText: 2 })
    );
    expect(result.unrecognised).toEqual([]);
    expect(parseFocusTotalSeconds(result.content)).toBe(parseFocusTotalSeconds(content));
    expect(parseFocusTotalSeconds(content)).toBe(1500 + 1500 + 1500 + 30 + 1500);
  });

  it("changes nothing the second time", () => {
    const content = `${SHAPES.map((s) => s.v1).join("\n")}\n`;
    const once = convertLogContent(content);
    const twice = convertLogContent(once.content);
    expect(twice.content).toBe(once.content);
    expect(twice.counts).toEqual(counts({ alreadyV2: SHAPES.length }));
  });
});

const V1_BASE =
  "- 🍅 Focus | Task:: [[Projects/Garden.md|NAME]] | Start:: 2025-12-24 09:00:00 | End:: 2025-12-24 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished";
const v1Named = (name: string, extra = "") => V1_BASE.replace("NAME", name) + extra;
const taskOf = (content: string) => parseLogLine(content)?.task;

describe("what early versions left in a task name, each counted on its own", () => {
  it("takes out a U+FFFD, left where 🔼 was cut in half", () => {
    const result = convertLogContent(v1Named("Organize files #task/other/organize \uFFFD"));
    expect(taskOf(result.content)?.name).toBe("Organize files #task/other/organize");
    expect(result.counts).toEqual(counts({ converted: 1, fffd: 1 }));
  });

  it("takes out the priority emoji, and only the emoji", () => {
    for (const [name, clean] of [
      ["Code the probe #task/research/probe ⏫", "Code the probe #task/research/probe"],
      ["Read #task/class/x\u00a0🔼", "Read #task/class/x"],
      ["Plan 🔺\uFE0F the week 🔽", "Plan the week"],
      ["Lowest ⏬", "Lowest"],
    ]) {
      const result = convertLogContent(v1Named(name));
      expect(taskOf(result.content)?.name).toBe(clean);
      expect(result.counts).toEqual(counts({ converted: 1, priority: 1 }));
    }
    // 🔥 is not a Tasks priority; a name may mean it.
    const fire = convertLogContent(v1Named("Fix the 🔥 alarm"));
    expect(taskOf(fire.content)?.name).toBe("Fix the 🔥 alarm");
    expect(fire.counts).toEqual(counts({ converted: 1 }));
  });

  it("moves a 🆔 in the name to an ID field right after Task", () => {
    const result = convertLogContent(v1Named("Course 3 #task/class/ux \uFFFD  🆔 w7_yc-zv"));
    const parsed = parseLogLine(result.content);
    expect(parsed?.task?.name).toBe("Course 3 #task/class/ux");
    expect(parsed?.fields.map((f) => f.key).slice(0, 3)).toEqual(["Task", "ID", "Start"]);
    expect(parsed?.values.get("ID")).toBe("w7_yc-zv");
    expect(result.counts).toEqual(counts({ converted: 1, idMoved: 1, fffd: 1 }));
  });

  it("drops a 🆔 the line's own ID already says, and keeps one that contradicts it", () => {
    const withId = (name: string, id: string) =>
      v1Named(name).replace(" | Start::", ` | ID:: ${id} | Start::`);

    // Tasks IDs may hold "_" and "-".
    const same = convertLogContent(withId("Prune 🆔 ab_c-123", "ab_c-123"));
    expect(parseLogLine(same.content)?.task?.name).toBe("Prune");
    expect(parseLogLine(same.content)?.fields.filter((f) => f.key === "ID")).toHaveLength(1);
    expect(same.counts).toEqual(counts({ converted: 1, idMoved: 1 }));

    const other = convertLogContent(withId("Prune 🆔 zzz999", "abc123"));
    expect(parseLogLine(other.content)?.task?.name).toBe("Prune 🆔 zzz999");
    expect(parseLogLine(other.content)?.values.get("ID")).toBe("abc123");
    expect(other.counts).toEqual(counts({ converted: 1 }));

    const two = convertLogContent(v1Named("A 🆔 abc123 B 🆔 def456"));
    expect(parseLogLine(two.content)?.task?.name).toBe("A 🆔 abc123 B 🆔 def456");
    expect(parseLogLine(two.content)?.values.has("ID")).toBe(false);
    expect(two.counts).toEqual(counts({ converted: 1 }));
  });

  it("writes dates in another script's digits as 0-9, and nothing else", () => {
    // How 0.6.8 wrote a line with Obsidian in these languages (F14). A task
    // name in Arabic digits is the user's own text and stays.
    for (const lang of ["ar", "fa", "bn", "ne"]) {
      moment.locale(lang);
      const t = (m: MomentLike) => m.format("YYYY-MM-DD HH:mm:ss");
      const at = (h: number, mi: number) => local(2026, 3, 4, h, mi, 7);
      const pauses = JSON.stringify([`${t(at(9, 10))} - ${t(at(9, 15))}`]);
      const line = `- 🍅 Focus | Task:: [[Projects/Garden.md|Prune ٣ hedges]] | ID:: t9k2xq | Start:: ${t(at(9, 0))} | End:: ${t(at(9, 29))} | Scheduled:: 1500 | Pauses:: ${pauses} | Total:: 1440 | Status:: finished | Type:: focus`;
      expect(line).not.toContain("2026");
      moment.locale("en");

      const result = convertLogContent(line);
      expect(result.content).toBe(
        `- 🍅 Focus [Task:: [[Projects/Garden.md|Prune ٣ hedges]]] [ID:: t9k2xq] [Start:: 2026-03-04 09:00:07] [End:: 2026-03-04 09:29:07] [Scheduled:: 1500] [Pauses:: ["2026-03-04 09:10:07 - 2026-03-04 09:15:07"]] [Total:: 1440] [Status:: finished] [Type:: focus]`
      );
      expect(result.counts).toEqual(counts({ converted: 1, digits: 1 }));
    }
  });

  it("leaves native digits outside the times: they were typed, and a day's total must not move", () => {
    // 0.6.8 wrote Total with String(number); "١٥٠٠" there is a hand edit no
    // reader counts, and turning it into 1500 would add to that day.
    const line = V1_BASE.replace("NAME", "Prune").replace("Total:: 1500", "Total:: ١٥٠٠");
    const result = convertLogContent(line);
    expect(parseLogLine(result.content)?.values.get("Total")).toBe("١٥٠٠");
    expect(parseFocusTotalSeconds(result.content)).toBe(parseFocusTotalSeconds(line));
    expect(result.counts).toEqual(counts({ converted: 1 }));
  });

  it("tidies a name the way 0.6.9 writes one, and says so — but not for spacing alone", () => {
    const tidy = convertLogContent(v1Named("Read [[Some Paper]] [draft] Total:: 7"));
    expect(taskOf(tidy.content)?.name).toBe("Read Some Paper (draft) Total: 7");
    expect(tidy.counts).toEqual(counts({ converted: 1, sanitized: 1 }));

    const spaced = convertLogContent(v1Named("Water   the  roses "));
    expect(taskOf(spaced.content)?.name).toBe("Water the roses");
    expect(spaced.counts).toEqual(counts({ converted: 1 }));
  });

  it("leaves a link that shows its path alone, and keeps a name that empties as its link", () => {
    const bare = convertLogContent(V1_BASE.replace("[[Projects/Garden.md|NAME]]", "[[Garden]]"));
    expect(taskOf(bare.content)).toMatchObject({ raw: "[[Garden]]", path: "Garden" });
    const emptied = convertLogContent(v1Named("⏫"));
    expect(taskOf(emptied.content)).toMatchObject({ raw: "[[Projects/Garden.md]]" });
    expect(emptied.counts).toEqual(counts({ converted: 1, priority: 1 }));
  });

  it("writes an unlinked name that empties as No Task, never an empty Task field", () => {
    const line = V1_BASE.replace("[[Projects/Garden.md|NAME]]", "⏫");
    expect(taskOf(line)).toMatchObject({ raw: "⏫", name: "⏫" });
    expect(taskOf(line)?.path).toBeUndefined();
    const result = convertLogContent(line);
    expect(result.content).toBe(
      "- 🍅 Focus [Task:: No Task] [Start:: 2025-12-24 09:00:00] [End:: 2025-12-24 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished]"
    );
    expect(result.counts).toEqual(counts({ converted: 1, priority: 1 }));
  });
});

describe("convertLogContent keeps the file's own bytes", () => {
  it("keeps CRLF line endings, a missing final line break, and a byte order mark", () => {
    const crlf = `${SHAPES[0].v1}\r\n${SHAPES[3].v1}\r\n`;
    expect(convertLogContent(crlf).content).toBe(`${SHAPES[0].v2}\r\n${SHAPES[3].v2}\r\n`);
    expect(convertLogContent(SHAPES[1].v1).content).toBe(SHAPES[1].v2);
    expect(convertLogContent(`${SHAPES[1].v1}\n`).content).toBe(`${SHAPES[1].v2}\n`);
    expect(convertLogContent(`\uFEFF${SHAPES[3].v1}`).content).toBe(`\uFEFF${SHAPES[3].v2}`);
  });

  it("keeps a block ID and tags at the end of the line, after the fields", () => {
    // Obsidian finds `^id` only at the very end of a line: written inside
    // `[Type:: focus ^abc123]`, every [[log#^abc123]] link to it broke.
    const cases = [
      [`${SHAPES[0].v1} ^abc123`, `${SHAPES[0].v2} ^abc123`],
      [`${SHAPES[5].v1} ^abc123`, `${SHAPES[5].v2} ^abc123`],
      [`${SHAPES[3].v1} #review ^s-2`, `${SHAPES[3].v2} #review ^s-2`],
      [`${SHAPES[1].v1}  #flow`, `${SHAPES[1].v2} #flow`],
    ];
    for (const [v1, v2] of cases) {
      const result = convertLogContent(v1);
      expect(result.content).toBe(v2);
      expect(result.counts).toEqual(counts({ converted: 1 }));
      expect(parseLogLine(v2)?.rest).toBe(parseLogLine(v1)?.rest);
    }
    expect(parseLogLine(cases[0][1])?.values.get("Type")).toBe("focus");
    expect(parseLogLine(cases[1][1])?.values.get("Total")).toBe("900");
    expect(convertLogContent(cases[0][1]).counts).toEqual(counts({ alreadyV2: 1 }));
  });

  it("leaves a line it cannot read, and lists it when it looks like a session", () => {
    const lines = [
      "- 🍅 Focus (by hand) | Task:: A | Total:: 900",
      "- Total:: 1500",
      "Some notes here.",
      SHAPES[3].v1,
    ];
    const result = convertLogContent(lines.join("\n"));
    expect(result.content.split("\n")).toEqual([lines[0], lines[1], lines[2], SHAPES[3].v2]);
    expect(result.unrecognised).toEqual([
      { line: 1, text: lines[0], reason: "unreadable" },
      { line: 2, text: lines[1], reason: "unreadable" },
    ]);
    expect(result.counts).toEqual(counts({ converted: 1, unrecognised: 2, otherText: 1 }));
  });

  it("leaves a line that would not read back the same as version 2", () => {
    // A "]" in a link's path closes the v2 field early, and a value ending in
    // a backslash escapes its closing bracket: every field after would be lost.
    const lines = [
      V1_BASE.replace("Projects/Garden.md", "Projects/Gar]den.md").replace("NAME", "A"),
      V1_BASE.replace("NAME", "B").replace("Status:: finished", "Status:: finished\\"),
    ];
    const result = convertLogContent(lines.join("\n"));
    expect(result.content).toBe(lines.join("\n"));
    expect(result.unrecognised.map((u) => [u.line, u.reason])).toEqual([
      [1, "inexact"],
      [2, "inexact"],
    ]);
    expect(result.counts).toEqual(counts({ unrecognised: 2 }));
  });

  it("lists a CRLF file's left lines without their CR, and keeps the CR in the file", () => {
    // The list is shown to the user; the file is written back as it was.
    const lines = [
      "- 🍅 Focus (by hand) | Task:: A | Total:: 900",
      V1_BASE.replace("Projects/Garden.md", "Projects/Gar]den.md").replace("NAME", "A"),
      SHAPES[3].v1,
    ];
    const result = convertLogContent(`${lines.join("\r\n")}\r\n`);
    expect(result.content).toBe(`${lines[0]}\r\n${lines[1]}\r\n${SHAPES[3].v2}\r\n`);
    expect(result.unrecognised).toEqual([
      { line: 1, text: lines[0], reason: "unreadable" },
      { line: 2, text: lines[1], reason: "inexact" },
    ]);
    expect(result.counts).toEqual(counts({ converted: 1, unrecognised: 2 }));
  });

  it("adds counts across files, every kind", () => {
    // Convert's confirm dialog states these sums, so every kind is set, and
    // set apart, on both sides: a kind skipped or mixed up shows.
    const into: LogConversionCounts = {
      converted: 1,
      checkbox: 2,
      fffd: 3,
      priority: 4,
      idMoved: 5,
      digits: 6,
      sanitized: 7,
      alreadyV2: 8,
      unrecognised: 9,
      otherText: 10,
    };
    const from: LogConversionCounts = {
      converted: 100,
      checkbox: 200,
      fffd: 300,
      priority: 400,
      idMoved: 500,
      digits: 600,
      sanitized: 700,
      alreadyV2: 800,
      unrecognised: 900,
      otherText: 1000,
    };
    expect(Object.keys(from).sort()).toEqual([...LOG_CONVERSION_KINDS].sort());
    addConversionCounts(into, from);
    expect(into).toEqual({
      converted: 101,
      checkbox: 202,
      fffd: 303,
      priority: 404,
      idMoved: 505,
      digits: 606,
      sanitized: 707,
      alreadyV2: 808,
      unrecognised: 909,
      otherText: 1010,
    });
    expect(from.idMoved).toBe(500);
  });
});

describe("looksLikeLogLine", () => {
  it("takes a marker or one of the log's keys", () => {
    for (const line of ["🍅 Focus great", "x ☕ Rest", "- Overtime:: 3", "Status:: done"]) {
      expect(looksLikeLogLine(line)).toBe(true);
    }
    for (const line of ["## Notes", "Total: 3", "- [ ] Water 🍅 3", "MyTotal:: 3"]) {
      expect(looksLikeLogLine(line)).toBe(false);
    }
  });
});

describe("digits of other scripts", () => {
  it("writes every native digit moment's locales use as 0-9", () => {
    // Every locale moment ships, not only the four Obsidian's own languages
    // reach: a digit table missing one script would leave its dates unread.
    const at = local(2026, 10, 2, 9, 5, 7);
    const english = at.format("YYYY-MM-DD HH:mm:ss");
    let native = 0;
    for (const name of LOCALES) {
      const text = at.clone().locale(name).format("YYYY-MM-DD HH:mm:ss");
      if (text !== english) native++;
      expect([name, asciiDigits(text)]).toEqual([name, english]);
    }
    expect(native).toBeGreaterThanOrEqual(10);
  });

  it("writes every script in its table as 0-9, the ones no moment locale writes too", () => {
    // The table in logLine.ts, held here on its own: the locale loop above
    // reaches only the scripts moment writes, so a script dropped from the
    // table, or a zero mistyped, shows only here.
    const zeros: [string, number][] = [
      ["Arabic-Indic", 0x0660],
      ["Persian", 0x06f0],
      ["NKo", 0x07c0],
      ["Devanagari", 0x0966],
      ["Bengali", 0x09e6],
      ["Gurmukhi", 0x0a66],
      ["Gujarati", 0x0ae6],
      ["Oriya", 0x0b66],
      ["Tamil", 0x0be6],
      ["Telugu", 0x0c66],
      ["Kannada", 0x0ce6],
      ["Malayalam", 0x0d66],
      ["Sinhala", 0x0de6],
      ["Thai", 0x0e50],
      ["Lao", 0x0ed0],
      ["Tibetan", 0x0f20],
      ["Myanmar", 0x1040],
      ["Myanmar Shan", 0x1090],
      ["Khmer", 0x17e0],
      ["Mongolian", 0x1810],
      ["Full width", 0xff10],
    ];
    for (const [script, zero] of zeros) {
      const digits = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(zero + i)).join("");
      expect(digits).toMatch(/^\p{Nd}{10}$/u);
      expect([script, asciiDigits(digits)]).toEqual([script, "0123456789"]);
    }
  });

  it("leaves ASCII and everything that is not a digit", () => {
    expect(asciiDigits("Plan ٣ a-b 2026 x")).toBe("Plan 3 a-b 2026 x");
    expect(asciiDigits("Ⅻ ½ ²")).toBe("Ⅻ ½ ²");
  });

  it("renames a log file named in native digits, and nothing else", () => {
    expect(asciiLogFileName("٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md")).toBe(
      "2026-10-02-gentle-pomodoro-log.md"
    );
    expect(asciiLogFileName("২০২৬-১০-০২-gentle-pomodoro-log.md")).toBe(
      "2026-10-02-gentle-pomodoro-log.md"
    );
    expect(asciiLogFileName("2026-10-02-gentle-pomodoro-log.md")).toBeNull();
    expect(asciiLogFileName("٢٠٢٦-١٠-٠٢ notes.md")).toBeNull();
    expect(asciiLogFileName("٢٠٢٦-١٠-gentle-pomodoro-log.md")).toBeNull();
    // A note of the same length that is not a log keeps its name.
    const notALog = `٢٠٢٦-١٠-٠٢-${"x".repeat(19)}.md`;
    expect(notALog.length).toBe("٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md".length);
    expect(asciiLogFileName(notALog)).toBeNull();
  });
});

describe("readLogTime and readLogPauses", () => {
  it("reads a written time as local seconds, in any digits", () => {
    const seconds = Math.floor(new Date(2026, 9, 2, 10, 0, 5).getTime() / 1000);
    expect(readLogTime("2026-10-02 10:00:05")).toBe(seconds);
    expect(readLogTime("٢٠٢٦-١٠-٠٢ ١٠:٠٠:٠٥")).toBe(seconds);
    // The last second of a day is still one.
    const last = Math.floor(new Date(2026, 9, 2, 23, 59, 59).getTime() / 1000);
    expect(readLogTime("2026-10-02 23:59:59")).toBe(last);
  });

  it("refuses anything that is not exactly one written time", () => {
    // Date would roll a 60th minute or second into the next one, still on the
    // same day, so only the range check stops those; and the anchors stop a
    // time with text around it.
    for (const bad of [
      "2026-02-31 10:00:00",
      "2026-10-02 24:00:00",
      "2026-10-02 10:60:00",
      "2026-10-02 10:75:00",
      "2026-10-02 10:00:60",
      "2026-10-02 10:00:61",
      "2026-10-02T10:00:05",
      "2026-10-02 10:00:05 PM",
      "2026-10-02 10:00:055",
      "On 2026-10-02 10:00:05",
      "12026-10-02 10:00:05",
      "",
    ]) {
      expect([bad, readLogTime(bad)]).toEqual([bad, null]);
    }
  });

  it("reads the Pauses list, or says it cannot", () => {
    const pair = (h: number, m: number) => Math.floor(new Date(2026, 9, 2, h, m).getTime() / 1000);
    expect(readLogPauses('["2026-10-02 10:10:00 - 2026-10-02 10:15:00"]')).toEqual([
      [pair(10, 10), pair(10, 15)],
    ]);
    expect(readLogPauses("[]")).toEqual([]);
    for (const bad of ["", "[", '"x"', "[1]", '["2026-10-02 10:10:00"]']) {
      expect(readLogPauses(bad)).toBeNull();
    }
  });
});

// --- Check -------------------------------------------------------------------

const focus = (
  start: string,
  end: string,
  total: number,
  opts: { pauses?: string[]; id?: string; name?: string } = {}
) =>
  `- 🍅 Focus [Task:: [[Projects/Garden.md|${opts.name ?? "Weed"}]]]${opts.id ? ` [ID:: ${opts.id}]` : ""} [Start:: ${start}] [End:: ${end}] [Scheduled:: 1500] [Pauses:: ${JSON.stringify(opts.pauses ?? [])}] [Total:: ${String(total)}] [Status:: finished] [Type:: focus] [Overtime:: 0]`;
const rest = (start: string, end: string, total: number) =>
  `- ☕ Rest [Start:: ${start}] [End:: ${end}] [Scheduled:: 300] [Total:: ${String(total)}] [Type:: short-break]`;
const D = "2026-06-15";
const scan = (...contents: string[]) =>
  scanLogAnomalies(contents.map((content, i) => ({ path: `Logs/${String(i)}.md`, content })));
const kinds = (...contents: string[]) =>
  scan(...contents).map((a) => `${a.kind} ${a.path}:${a.line}`);

describe("scanLogAnomalies — Total against the line's own times", () => {
  it("flags a Total the times cannot give", () => {
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:00:20`, 1600))).toEqual(["total Logs/0.md:1"]);
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:25:00`, 1200))).toEqual(["total Logs/0.md:1"]);
  });

  it("allows the second each written time was cut by: 1 s, and 1 s more per pause", () => {
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:25:00`, 1499))).toEqual([]);
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:25:00`, 1498))).toEqual(["total Logs/0.md:1"]);
    const paused = { pauses: [`${D} 09:10:00 - ${D} 09:15:00`] };
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:30:00`, 1498, paused))).toEqual([]);
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:30:00`, 1497, paused))).toEqual([
      "total Logs/0.md:1",
    ]);
  });

  it("flags a negative Total, which a clock stepped back mid-session wrote (F42)", () => {
    const found = scan(focus(`${D} 09:00:00`, `${D} 09:25:00`, -300));
    expect(found.map((a) => a.kind)).toEqual(["total"]);
    expect(found[0].detail).toContain("Total is -300 s");
  });

  it("does not judge Total or length by a Pauses field it cannot read", () => {
    // Read as no pauses, a paused session would be flagged on both counts.
    const unreadable = (line: string) => line.replace("[Pauses:: []]", "[Pauses:: [x]]");
    const lines = [
      unreadable(focus(`${D} 06:00:00`, `${D} 06:30:00`, 1500)),
      unreadable(focus(`${D} 07:00:00`, `${D} 20:00:00`, 1500)),
    ];
    expect(parseLogLine(lines[0])?.values.get("Pauses")).toBe("[x]");
    expect(kinds(lines.join("\n"))).toEqual([]);
  });

  it("does not judge a Total that is not there", () => {
    const noTotal = (line: string) => line.replace(/ \[Total:: [^\]]*\]/, "");
    const lines = [
      noTotal(focus(`${D} 09:00:00`, `${D} 09:25:00`, 1500)),
      noTotal(rest(`${D} 09:25:00`, `${D} 09:30:00`, 300)),
    ];
    for (const line of lines) expect(parseLogLine(line)?.values.has("Total")).toBe(false);
    expect(kinds(lines.join("\n"))).toEqual([]);
    // With no Total, a Rest line's span is all it says of how long it ran.
    expect(kinds(noTotal(rest(`${D} 08:00:00`, `${D} 21:00:00`, 46800)))).toEqual([
      "long Logs/0.md:1",
    ]);
  });

  it("flags a Rest line only when Total is longer than its span", () => {
    // A Rest line writes no pauses: a paused break is shorter, not wrong.
    expect(kinds(rest(`${D} 09:25:00`, `${D} 09:31:00`, 1))).toEqual([]);
    expect(kinds(rest(`${D} 09:25:00`, `${D} 09:30:00`, 301))).toEqual([]);
    expect(kinds(rest(`${D} 09:25:00`, `${D} 09:30:00`, 302))).toEqual(["total Logs/0.md:1"]);
  });
});

describe("scanLogAnomalies — a Start or End it cannot read", () => {
  it("skips the line, Focus or Rest, and checks its neighbours as before", () => {
    const unreadable = [
      focus("soon", `${D} 23:00:00`, 1500),
      focus(`${D} 09:05:00`, "later", 1500),
      rest("soon", `${D} 23:00:00`, 300),
      rest(`${D} 09:05:00`, "later", 300),
    ];
    for (const line of unreadable) {
      expect(parseLogLine(line)).not.toBeNull();
      expect(kinds(line)).toEqual([]);
    }
    const lines = [
      focus(`${D} 09:00:00`, `${D} 10:00:00`, 3600),
      ...unreadable,
      rest(`${D} 09:30:00`, `${D} 09:45:00`, 900),
      focus(`${D} 10:00:00`, `${D} 10:25:00`, 1500),
    ];
    const found = scan(lines.join("\n"));
    expect(found.map((a) => `${a.kind} ${a.path}:${a.line}`)).toEqual(["overlap Logs/0.md:6"]);
    expect(found[0].detail).toContain("Logs/0.md line 1 ");
  });
});

describe("scanLogAnomalies — long, backwards and overlapping sessions", () => {
  it("flags more than 12 h of active time, not 12 h of pauses", () => {
    expect(LONG_SESSION_SECONDS).toBe(12 * 3600);
    expect(kinds(focus(`${D} 08:00:00`, `${D} 20:00:00`, 43200))).toEqual([]);
    expect(kinds(focus(`${D} 08:00:00`, `${D} 20:00:01`, 43201))).toEqual(["long Logs/0.md:1"]);
    const overnight = { pauses: [`${D} 20:10:00 - 2026-06-16 09:00:00`] };
    expect(kinds(focus(`${D} 20:00:00`, "2026-06-16 09:15:00", 1500, overnight))).toEqual([]);
    // A break paused overnight: its Total is the time it ran.
    expect(kinds(rest(`${D} 20:00:00`, "2026-06-16 09:00:00", 300))).toEqual([]);
    expect(kinds(rest(`${D} 08:00:00`, `${D} 21:00:00`, 46800))).toEqual(["long Logs/0.md:1"]);
  });

  it("says how long in hours and minutes, of active time", () => {
    const detail = (line: string) => scan(line).map((a) => `${a.kind}: ${a.detail}`);
    expect(detail(focus(`${D} 08:00:00`, `${D} 20:00:01`, 43201))).toEqual([
      "long: Ran 12h 0m of active time.",
    ]);
    expect(detail(rest(`${D} 04:00:00`, `${D} 20:58:59`, 61139))).toEqual([
      "long: Ran 16h 58m of active time.",
    ]);
    // 17h 58m 59s from Start to End, 10 minutes of it paused.
    const paused = { pauses: [`${D} 12:00:00 - ${D} 12:10:00`] };
    expect(detail(focus(`${D} 03:00:00`, `${D} 20:58:59`, 64139, paused))).toEqual([
      "long: Ran 17h 48m of active time.",
    ]);
  });

  it("flags a session that ends before it starts, and nothing else about it", () => {
    const found = scan(focus(`${D} 10:00:00`, `${D} 09:00:00`, 0));
    expect(found.map((a) => a.kind)).toEqual(["endBeforeStart"]);
    expect(found[0].detail).toContain(`${D} 09:00:00`);
  });

  it("does not call a session that ends the second it starts backwards", () => {
    expect(kinds(focus(`${D} 09:00:00`, `${D} 09:00:00`, 0))).toEqual([]);
    expect(kinds(rest(`${D} 09:00:00`, `${D} 09:00:00`, 0))).toEqual([]);
  });

  it("leaves a backwards session out of the overlap check: it is flagged once, as backwards", () => {
    const lines = [
      focus(`${D} 09:00:00`, `${D} 10:00:00`, 3600),
      focus(`${D} 09:30:00`, `${D} 09:00:00`, 0),
    ];
    expect(kinds(lines.join("\n"))).toEqual(["endBeforeStart Logs/0.md:2"]);
  });

  it("checks a session that ends the second it starts like any other", () => {
    // Inside another session it overlaps; where that one ends, or where it
    // starts, it only touches.
    const hour = focus(`${D} 09:00:00`, `${D} 10:00:00`, 3600);
    const at = (time: string) => focus(`${D} ${time}`, `${D} ${time}`, 0);
    expect(kinds([hour, at("09:30:00")].join("\n"))).toEqual(["overlap Logs/0.md:2"]);
    expect(kinds([hour, at("10:00:00")].join("\n"))).toEqual([]);
    expect(kinds([hour, at("09:00:00")].join("\n"))).toEqual([]);
    expect(kinds([at("09:00:00"), hour].join("\n"))).toEqual([]);
  });

  it("of two sessions that start together, flags the one that ends later, in either file order", () => {
    const long = focus(`${D} 09:00:00`, `${D} 10:00:00`, 3600);
    const short = focus(`${D} 09:00:00`, `${D} 09:30:00`, 1800);
    const first = scan([long, short].join("\n"));
    expect(first.map((a) => `${a.kind} ${a.path}:${a.line}`)).toEqual(["overlap Logs/0.md:1"]);
    expect(first[0].detail).toContain("Logs/0.md line 2");
    expect(kinds([short, long].join("\n"))).toEqual(["overlap Logs/0.md:2"]);
  });

  it("checks each session against the one that ends latest, not the one before it", () => {
    const lines = [
      focus(`${D} 09:00:00`, `${D} 12:00:00`, 10800),
      rest(`${D} 09:30:00`, `${D} 09:45:00`, 900),
      focus(`${D} 10:00:00`, `${D} 10:30:00`, 1800),
      focus(`${D} 12:00:00`, `${D} 12:25:00`, 1500),
    ];
    expect(kinds(lines.join("\n"))).toEqual(["overlap Logs/0.md:2", "overlap Logs/0.md:3"]);
  });

  it("flags a session that starts before another has ended, across files", () => {
    const day1 = [focus(`${D} 23:50:00`, "2026-06-16 00:20:00", 1800)].join("\n");
    const day2 = [
      rest("2026-06-16 00:10:00", "2026-06-16 00:15:00", 300),
      focus("2026-06-16 00:20:00", "2026-06-16 00:45:00", 1500),
    ].join("\n");
    const found = scan(day1, day2);
    expect(found.map((a) => `${a.kind} ${a.path}:${a.line}`)).toEqual(["overlap Logs/1.md:1"]);
    expect(found[0].detail).toContain("Logs/0.md line 1");
  });
});

describe("scanLogAnomalies — the hour a fall-back repeats (America/New_York)", () => {
  // On 2026-11-01 New York's clocks go from 02:00 EDT back to 01:00 EST, so a
  // written 01:00-01:59 is two instants, and a line carries no offset to say
  // which. Date reads the first; the timer may have meant the second.
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  const HOUR = 3_600_000;
  /** 2026-11-01 at h:mi on the clock; `pass` 2 is the repeated hour's second pass. */
  const clock = (h: number, mi: number, pass: 1 | 2 = 1) =>
    new Date(2026, 10, 1, h, mi).getTime() + (pass === 2 ? HOUR : 0);
  /** The line the timer writes for that session — Total from the real instants. */
  const timerLine = (start: number, end: number, pauses: [number, number][] = []) =>
    formatLogLine({
      mode: "focus",
      taskName: "Weed",
      taskPath: "Projects/Garden.md",
      scheduledDurationMinutes: 25,
      startTime: moment(start),
      endTime: moment(end),
      pauses: pauses.map(([from, to]) => ({ start: moment(from), end: moment(to) })),
      status: "finished",
    });

  it("runs in that zone, and knows which written times name two instants", () => {
    expect(new Date(clock(1, 30, 2)).getTimezoneOffset()).toBe(300);
    expect(new Date(clock(1, 30, 1)).getTimezoneOffset()).toBe(240);
    const read = (time: string) => readLogTime(`2026-11-01 ${time}`) ?? NaN;
    expect(read("01:30:00") * 1000).toBe(clock(1, 30, 1));
    expect(repeatedReading(read("01:30:00"))).toBe(3600);
    expect(repeatedReading(read("01:59:59"))).toBe(3600);
    for (const time of ["00:59:59", "02:00:00", "02:30:00"]) {
      expect([time, repeatedReading(read(time))]).toEqual([time, 0]);
    }
    expect(repeatedReading(readLogTime(`${D} 01:30:00`) ?? NaN)).toBe(0);
  });

  // Instants are worked out inside each test: the table is built before
  // beforeAll has moved the zone.
  it.each<[string, () => [number, number]]>([
    ["ends in the second pass, before its start reads", () => [clock(1, 40, 1), clock(1, 15, 2)]],
    ["starts before the hour and ends in its second pass", () => [clock(0, 50), clock(1, 20, 2)]],
    ["starts in the second pass and ends after the hour", () => [clock(1, 50, 2), clock(2, 15)]],
    ["starts in the second pass, 11 h 30 m long", () => [clock(1, 30, 2), clock(13, 0)]],
  ])("does not flag a line the timer wrote that %s", (_name, times) => {
    const [start, end] = times();
    const line = timerLine(start, end);
    expect(parseLogLine(line)?.values.get("Total")).toBe(String((end - start) / 1000));
    expect(kinds(line)).toEqual([]);
  });

  it("does not flag a pause that ends in the second pass", () => {
    // 160 minutes from 00:30 EDT to 02:10 EST, 20 of them paused across 02:00 EDT.
    const line = timerLine(clock(0, 30), clock(2, 10), [[clock(1, 50, 1), clock(1, 10, 2)]]);
    expect(parseLogLine(line)?.values.get("Total")).toBe(String(140 * 60));
    expect(kinds(line)).toEqual([]);
  });

  it("does not call a second-pass session an overlap with a first-pass one", () => {
    const lines = [
      timerLine(clock(1, 10, 1), clock(1, 40, 1)),
      timerLine(clock(1, 20, 2), clock(1, 45, 2)),
      timerLine(clock(1, 50, 2), clock(2, 15, 2)),
    ];
    expect(kinds(lines.join("\n"))).toEqual([]);
  });

  it("still flags what no reading of the times can give", () => {
    const N = "2026-11-01";
    // Off by half an hour, not by the hour that repeats.
    expect(kinds(focus(`${N} 01:10:00`, `${N} 01:40:00`, 3600))).toEqual(["total Logs/0.md:1"]);
    // Even its later reading, 01:15 EST, is before 02:30 EST.
    expect(kinds(focus(`${N} 02:30:00`, `${N} 01:15:00`, 0))).toEqual([
      "endBeforeStart Logs/0.md:1",
    ]);
    // 00:45 is before 01:30 in either pass.
    const overlapping = [
      focus(`${N} 00:30:00`, `${N} 01:30:00`, 3600),
      focus(`${N} 00:45:00`, `${N} 01:10:00`, 1500),
    ];
    expect(kinds(overlapping.join("\n"))).toEqual(["overlap Logs/0.md:2"]);
    // A Rest line longer than even its later end allows.
    expect(kinds(rest(`${N} 00:50:00`, `${N} 01:20:00`, 5402))).toEqual(["total Logs/0.md:1"]);
    expect(kinds(rest(`${N} 00:50:00`, `${N} 01:20:00`, 5400))).toEqual([]);
  });
});

describe("scanLogAnomalies — one 🆔 under different names", () => {
  it("flags it once, at the first line with another name", () => {
    const lines = [
      focus(`${D} 09:00:00`, `${D} 09:25:00`, 1500, { id: "abc123", name: "Weed the beds" }),
      focus(`${D} 10:00:00`, `${D} 10:25:00`, 1500, { id: "abc123", name: "Water the roses" }),
      focus(`${D} 11:00:00`, `${D} 11:25:00`, 1500, { id: "abc123", name: "Prune" }),
      focus(`${D} 12:00:00`, `${D} 12:25:00`, 1500, { id: "zzz999", name: "Prune" }),
    ];
    const found = scan(lines.join("\n"));
    expect(found.map((a) => `${a.kind} ${a.path}:${a.line}`)).toEqual(["idNames Logs/0.md:2"]);
    expect(found[0].detail).toContain("abc123");
    expect(countAnomalies(found)).toEqual({
      total: 0,
      overlap: 0,
      long: 0,
      endBeforeStart: 0,
      idNames: 1,
    });
  });

  it("does not count tags, the 🍅 count or old leftovers as another name", () => {
    // A rename keeps each line's own tags (history keeps its area), and an
    // early version left the 🆔 in the name.
    const names = [
      "Weed the beds #task/other/garden",
      "Weed the beds #task/design/garden",
      "Weed the beds 🍅 3",
      "Weed  the beds ⏫",
      "Weed the beds \uFFFD",
      "Weed the beds 🆔 ab_c-123",
    ];
    const lines = names.map((name, i) =>
      focus(`${D} 1${String(i)}:00:00`, `${D} 1${String(i)}:25:00`, 1500, { id: "ab_c-123", name })
    );
    expect(kinds(lines.join("\n"))).toEqual([]);
  });

  it("reads a version 1 name as the version 2 name it becomes", () => {
    // Version 1 wrote the name raw; version 2 writes it sanitised. One task
    // whose name holds a link, brackets or "::" is still one name.
    const raw = "Read [[Some Paper]] [draft] Total:: 7";
    const v1 = `- 🍅 Focus | Task:: [[Projects/Garden.md|${raw}]] | ID:: abc123 | Start:: ${D} 09:00:00 | End:: ${D} 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished`;
    const v2 = focus(`${D} 10:00:00`, `${D} 10:25:00`, 1500, {
      id: "abc123",
      name: "Read Some Paper (draft) Total: 7",
    });
    expect(parseLogLine(v1)?.task?.name).toBe(raw);
    expect(parseLogLine(v1)?.values.get("Total")).toBe("1500");
    expect(kinds([v1, v2].join("\n"))).toEqual([]);
    // A name that differs in more than that is still another name.
    const other = focus(`${D} 11:00:00`, `${D} 11:25:00`, 1500, {
      id: "abc123",
      name: "Read Some Paper (final) Total: 7",
    });
    expect(kinds([v1, v2, other].join("\n"))).toEqual(["idNames Logs/0.md:3"]);
  });
});

describe("describeSeconds", () => {
  it("says seconds under a minute, minutes and seconds under an hour, else hours and minutes", () => {
    expect(describeSeconds(0)).toBe("0s");
    expect(describeSeconds(59)).toBe("59s");
    expect(describeSeconds(60)).toBe("1m 0s");
    expect(describeSeconds(725)).toBe("12m 5s");
    expect(describeSeconds(3599)).toBe("59m 59s");
    expect(describeSeconds(3600)).toBe("1h 0m");
    expect(describeSeconds(47100)).toBe("13h 5m");
    expect(describeSeconds(61139)).toBe("16h 58m");
  });
});

describe("countAnomalies", () => {
  it("counts each kind on its own, for Check's Notice", () => {
    const of = (kind: LogAnomaly["kind"], n: number): LogAnomaly[] =>
      Array.from({ length: n }, (_, i) => ({ kind, path: "Logs/0.md", line: i + 1, detail: "" }));
    const found = [
      ...of("idNames", 1),
      ...of("total", 5),
      ...of("long", 3),
      ...of("overlap", 4),
      ...of("endBeforeStart", 2),
    ];
    expect(countAnomalies(found)).toEqual({
      total: 5,
      overlap: 4,
      long: 3,
      endBeforeStart: 2,
      idNames: 1,
    });
    expect(Object.keys(countAnomalies([])).sort()).toEqual([...LOG_ANOMALY_KINDS].sort());
  });
});

describe("scanLogAnomalies — either format, any digits", () => {
  it("finds the same before and after a conversion, in file and line order", () => {
    const old = [
      "- 🍅 Focus | Task:: A | Start:: 2026-01-05 09:00:00 | End:: 2026-01-05 09:00:20 | Scheduled:: 1500 | Pauses:: [] | Total:: 1600 | Status:: finished",
      "- ☕ Rest | Start:: 2026-01-05 09:00:10 | End:: 2026-01-05 10:00:00 | Scheduled:: 300 | Total:: 4000",
      "- 🍅 Focus | Task:: B | Start:: ٢٠٢٦-٠١-٠٥ ١١:٠٠:٠٠ | End:: ٢٠٢٦-٠١-٠٥ ١٠:٠٠:٠٠ | Scheduled:: 1500 | Pauses:: [] | Total:: 0 | Status:: finished",
    ].join("\n");
    const before = scan(old, focus(`${D} 08:00:00`, `${D} 21:00:00`, 46800));
    expect(before.map((a) => `${a.kind} ${a.path}:${a.line}`)).toEqual([
      "total Logs/0.md:1",
      "total Logs/0.md:2",
      "overlap Logs/0.md:2",
      "endBeforeStart Logs/0.md:3",
      "long Logs/1.md:1",
    ]);
    expect(before[3].detail).toContain("٢٠٢٦-٠١-٠٥ ١٠:٠٠:٠٠");
    const after = scan(
      convertLogContent(old).content,
      focus(`${D} 08:00:00`, `${D} 21:00:00`, 46800)
    );
    const where = (list: typeof before) => list.map((a) => [a.kind, a.path, a.line]);
    expect(where(after)).toEqual(where(before));
  });
});

/* ===== One day's log under two names, merged (F4) ===== */

describe("mergeLogContent — a day's file in other digits merged into its 0-9 file (F4)", () => {
  // Made-up v2 lines on 2026-09-30, each named by its start.
  const at = (hhmm: string) =>
    `- 🍅 Focus [Task:: No Task] [Start:: 2026-09-30 ${hhmm}:00] [End:: 2026-09-30 ${hhmm}:30] [Scheduled:: 1500] [Pauses:: []] [Total:: 1800] [Status:: finished] [Type:: focus] [Overtime:: 0]`;
  const startOf = (row: string) => parseLogLine(row)?.values.get("Start")?.slice(11, 16) ?? row;

  it("puts the old file's lines among the 0-9 file's in start order", () => {
    const merged = mergeLogContent(
      `${at("09:00")}\n${at("11:00")}\n`,
      `${at("08:00")}\n${at("10:00")}\n${at("12:00")}\n`
    );
    expect(merged.lines).toBe(3);
    expect(merged.content.split("\n").map(startOf)).toEqual([
      "08:00",
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "",
    ]);
  });

  it("reads a start written in other digits, sorts the old file's own lines, and puts the 0-9 file's line first on a tie", () => {
    const arabic = at("10:00").replace("2026-09-30 10:00:00", "٢٠٢٦-٠٩-٣٠ ١٠:٠٠:٠٠");
    const merged = mergeLogContent(`${at("10:00")}\n`, `${arabic}\n${at("09:00")}\n`);
    expect(merged.content).toBe(`${at("09:00")}\n${at("10:00")}\n${arabic}\n`);
  });

  it("leaves every line of the 0-9 file where it is, in its own order", () => {
    // Out of order already (a session added by hand at the end): it stays so,
    // and a line goes after the last session that started no later.
    const into = `${at("11:00")}\n${at("09:00")}\n`;
    expect(mergeLogContent(into, `${at("10:00")}\n`).content).toBe(
      `${at("11:00")}\n${at("09:00")}\n${at("10:00")}\n`
    );
    expect(mergeLogContent(into, `${at("08:00")}\n`).content).toBe(
      `${at("08:00")}\n${at("11:00")}\n${at("09:00")}\n`
    );
  });

  it("puts a file with no session line it can place, or the 0-9 file's having none, at the end", () => {
    expect(mergeLogContent(`${at("09:00")}\n`, "Notes only\n").content).toBe(
      `${at("09:00")}\nNotes only\n`
    );
    expect(mergeLogContent("# Heading\n", `${at("09:00")}\n`).content).toBe(
      `# Heading\n${at("09:00")}\n`
    );
  });

  it("keeps a line without a Start beside the line it followed in its own file", () => {
    const into = `# Wednesday\n${at("09:00")}\nA note after nine\n${at("11:00")}\n`;
    const from = `## Old file\n${at("12:00")}\n${at("10:00")}\nA note after ten\n- 🍅 Focus by hand, about 20 minutes\n`;
    expect(mergeLogContent(into, from).content.split("\n")).toEqual([
      "# Wednesday",
      at("09:00"),
      "A note after nine",
      at("10:00"),
      "A note after ten",
      "- 🍅 Focus by hand, about 20 minutes",
      at("11:00"),
      // The old file's head goes before its first session line, wherever that goes.
      "## Old file",
      at("12:00"),
      "",
    ]);
  });

  it("never drops or doubles a line, whatever the two files hold", () => {
    // Every mix of session lines, notes and blank rows, in any order within
    // each file: the merge holds each row of both files exactly once; the
    // 0-9 file's rows in their own order; the old file's session lines in
    // Start order, each with the rows that followed it right after it.
    // mulberry32: a seeded generator whose low bits are as random as its high
    // ones (a plain LCG's are not, and gave nothing but notes).
    let seed = 7;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const row = (file: string, k: number) => {
      const kind = next(4);
      if (kind === 0) return `${file} note ${String(k)}`;
      if (kind === 1) return k % 2 === 0 ? "" : `${file} blank-ish ${String(k)}`;
      const minute = String(next(60)).padStart(2, "0");
      return at(`1${String(next(10))}:${minute}`).replace("No Task", `${file}${String(k)}`);
    };
    const mine = (rows: string[], mark: string) =>
      rows.filter((r) => r.startsWith(`${mark} `) || r.includes(`[Task:: ${mark}`));
    const seen = { leads: 0, sessions: 0, followers: 0 };
    for (let round = 0; round < 400; round++) {
      const a = Array.from({ length: next(7) }, (_, k) => row("A", k));
      const b = Array.from({ length: next(7) }, (_, k) => row("B", k));
      const first = b.findIndex((r) => r.startsWith("- "));
      if (first > 0) seen.leads++;
      if (first !== -1 && a.some((r) => r.startsWith("- "))) seen.sessions++;
      if (b.some((r, k) => k > 0 && !r.startsWith("- ") && b[k - 1].startsWith("- "))) {
        seen.followers++;
      }
      const merged = mergeLogContent(
        a.length === 0 ? "" : `${a.join("\n")}\n`,
        b.length === 0 ? "" : `${b.join("\n")}\n`
      ).content;
      const out = merged === "" ? [] : merged.slice(0, -1).split("\n");
      expect([...out].sort()).toEqual([...a, ...b].sort());
      expect(mine(out, "A")).toEqual(mine(a, "A"));
      const sessions = mine(out, "B").filter((r) => r.startsWith("- "));
      expect(sessions.map(startOf)).toEqual(sessions.map(startOf).sort());
      // Each of B's rows that follows a B session line in its file follows it here too.
      b.forEach((r, k) => {
        if (k === 0 || r === "" || r.startsWith("- ") || !b[k - 1].startsWith("- ")) return;
        expect(out[out.indexOf(r) - 1]).toBe(b[k - 1]);
      });
    }
    // The cases that matter came up, many times each.
    expect(Math.min(seen.leads, seen.sessions, seen.followers)).toBeGreaterThan(50);
  });

  it("writes in the 0-9 file's line ending, ending in one, and keeps its byte order mark first", () => {
    const merged = mergeLogContent(`\uFEFF${at("09:00")}\r\n`, `\uFEFF${at("08:00")}\n`);
    expect(merged.content).toBe(`\uFEFF${at("08:00")}\r\n${at("09:00")}\r\n`);
    // A 0-9 file with no line break at its end.
    expect(mergeLogContent(at("09:00"), `${at("10:00")}\n`).content).toBe(
      `${at("09:00")}\n${at("10:00")}\n`
    );
  });

  it("counts the old file's lines that hold something", () => {
    expect(logLineCount(`${at("09:00")}\n\nA note\n`)).toBe(2);
    expect(logLineCount("")).toBe(0);
  });

  it("is taken back out by unmergeLogContent, a line written since kept", () => {
    const into = `${at("09:00")}\r\n${at("11:00")}\r\n`;
    const from = `${at("10:00")}\nA note after ten\n`;
    const merged = mergeLogContent(into, from).content;
    expect(unmergeLogContent(merged, from)).toBe(into);
    expect(unmergeLogContent(`${merged}${at("13:00")}\r\n`, from)).toBe(
      `${into}${at("13:00")}\r\n`
    );
    // A line that went first keeps the file's byte order mark at its start.
    const bom = `\uFEFF${at("09:00")}\n`;
    expect(unmergeLogContent(mergeLogContent(bom, `${at("08:00")}\n`).content, at("08:00"))).toBe(
      bom
    );
  });
});
