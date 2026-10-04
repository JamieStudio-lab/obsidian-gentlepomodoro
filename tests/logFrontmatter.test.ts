import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import {
  LOG_GOAL_KEY,
  frontmatterRowCount,
  logFrontmatter,
  readLogGoal,
  resolveGoalMinutes,
  withLogGoal,
} from "../logFrontmatter";
import { parseFocusTotalSeconds } from "../logLine";
import { insertSessionLine, loggedLines, replaceSessionLine } from "../logEditor";
import {
  convertLogContent,
  logLineCount,
  mergeLogContent,
  scanLogAnomalies,
  unmergeLogContent,
} from "../logConvert";
import { refreshLogContent, refreshTargets, renameLogContent } from "../logRename";
import { LogManager } from "../logManager";
import type GentlePomoPlugin from "../main";
import { memoryStorage } from "./memoryStorage";
import { fakeVault, linkCache } from "./fakeVault";

/**
 * The daily log file's properties (0.6.9): the day's goal, `goal_minutes`,
 * recorded in the file of the day it was — by the timer's own write to TODAY's
 * file, and never on a past day's — and every reader of the log passing over
 * the properties as no part of it. Lines are made up; none is copied from a
 * real log.
 */

const V2 =
  "- 🍅 Focus [Task:: [[Projects/Docs.md|Old name #task/develop/docs]]] [ID:: abc123] [Start:: 2026-10-02 09:00:00] [End:: 2026-10-02 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const V1 =
  "- 🍅 Focus | Task:: [[Projects/Docs.md|Old name #task/develop/docs]] | ID:: abc123 | Start:: 2026-10-02 10:00:00 | End:: 2026-10-02 10:20:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1200 | Status:: finished | Type:: focus";

/**
 * Properties holding, in a block of text, two rows that read as session lines
 * — a pasted example, say. A reader that does not skip the properties counts
 * them (9999 s), converts the second, renames both, flags the first (it ends
 * before it starts), and puts a new line among them (both start at 07:00).
 */
const PROPERTIES = [
  "---",
  "goal_minutes: 120",
  "example: |",
  "  - 🍅 Focus [Task:: [[Projects/Docs.md|Old name]]] [ID:: abc123] [Start:: 2026-10-02 07:00:00] [End:: 2026-10-02 06:00:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 9999] [Status:: finished] [Type:: focus] [Overtime:: 0]",
  "  - 🍅 Focus | Task:: [[Projects/Docs.md|Old name]] | ID:: abc123 | Start:: 2026-10-02 07:00:00 | End:: 2026-10-02 07:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus",
  "---",
].join("\n");
const HEAD = `${PROPERTIES}\n`;
const FILE = `${HEAD}${V2}\n${V1}\n`;

describe("a log file's properties, as Obsidian finds them", () => {
  it("are the rows between an opening '---' line and the next '---' line", () => {
    const content = "---\ngoal_minutes: 120\n---\n- body\n";
    expect(logFrontmatter(content)).toEqual({ eol: "\n", from: 4, to: 22, bodyStart: 26 });
    expect(content.slice(4, 22)).toBe("goal_minutes: 120\n");
    expect(frontmatterRowCount(content)).toBe(3);
  });

  it("can be empty, can end the file, and keep a CRLF file's line ending", () => {
    expect(frontmatterRowCount("---\n---\n- body")).toBe(2);
    expect(frontmatterRowCount("---\na: 1\n---")).toBe(3);
    expect(logFrontmatter("---\r\na: 1\r\n---\r\n- body")?.eol).toBe("\r\n");
    expect(frontmatterRowCount("---\r\na: 1\r\n---\r\n- body")).toBe(3);
  });

  it("are none without a closing line, or after anything else", () => {
    expect(logFrontmatter("---\na: 1\n- body\n")).toBeNull();
    expect(logFrontmatter("- body\n---\na: 1\n---\n")).toBeNull();
    // The opening line is `---` alone.
    expect(logFrontmatter("--- \na: 1\n---\n")).toBeNull();
    expect(frontmatterRowCount("- body\n")).toBe(0);
  });

  it("are found past a byte order mark, which Obsidian's metadata parser drops", () => {
    const content = `﻿---\nexample: |\n  ${V2}\n---\n${V1}\n`;
    expect(logFrontmatter(content)).toMatchObject({ from: 5 });
    expect(frontmatterRowCount(content)).toBe(4);
    // So the row inside is no session: not counted, not converted.
    expect(parseFocusTotalSeconds(content)).toBe(1200);
    expect(loggedLines(content).map((l) => l.index)).toEqual([4]);
    expect(convertLogContent(content).counts.converted).toBe(1);
    expect(convertLogContent(content).content.split("\n").slice(0, 4)).toEqual(
      content.split("\n").slice(0, 4)
    );
  });

  it("close at the first line that starts with '---', as Obsidian's metadata parser does", () => {
    // "a----" holds "---" not at the start of its line; "----" starts with it.
    expect(frontmatterRowCount("---\nnote: a----\n----\nb: 2\n---\n- body\n")).toBe(3);
    // A closing line with a trailing space, or more after it, closes them,
    // and the whole of it is theirs.
    expect(frontmatterRowCount(`---\ntags: [log]\n--- \n${V2}\n`)).toBe(3);
    expect(frontmatterRowCount(`---\ntags: [log]\n---x\r\n${V2}\r\n`)).toBe(3);
    expect(readLogGoal("---\ngoal_minutes: 90\n--- \n")).toBe(90);
    expect(logFrontmatter("---\na: 1\n--- ")).toMatchObject({ to: 9, bodyStart: 13 });
  });
});

describe("the goal a log file records", () => {
  it("is goal_minutes among its properties", () => {
    expect(readLogGoal("---\ngoal_minutes: 120\n---\n")).toBe(120);
    expect(readLogGoal(`---\ntags: [log]\n${LOG_GOAL_KEY}: "90"  # mine\n---\n`)).toBe(90);
    expect(readLogGoal("---\ngoal_minutes: 90.5\n---\n")).toBe(90.5);
  });

  it("is none in a file without properties, without the key, or not a number", () => {
    expect(readLogGoal(`${V2}\n`)).toBeNull();
    expect(readLogGoal("---\ntags: [log]\n---\n")).toBeNull();
    expect(readLogGoal("---\ngoal_minutes: two hours\n---\n")).toBeNull();
    expect(readLogGoal("---\ngoal_minutes:\n---\n")).toBeNull();
    // Indented, it belongs to another key.
    expect(readLogGoal("---\nday:\n  goal_minutes: 60\n---\n")).toBeNull();
    // In the body it is text, not a property.
    expect(readLogGoal(`${V2}\ngoal_minutes: 60\n`)).toBeNull();
  });

  it("reads a setting that is no goal as 0", () => {
    expect(resolveGoalMinutes(120)).toBe(120);
    for (const value of [0, -5, Number.NaN, Infinity, "120", null, undefined]) {
      expect(resolveGoalMinutes(value)).toBe(0);
    }
  });
});

describe("recording the goal in a file's text", () => {
  it("puts properties in front of a file that has none, in its own line ending", () => {
    expect(withLogGoal(`${V2}\n`, 120)).toBe(`---\ngoal_minutes: 120\n---\n${V2}\n`);
    expect(withLogGoal(`${V2}\r\n`, 120)).toBe(`---\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n`);
    expect(withLogGoal("", 120)).toBe("---\ngoal_minutes: 120\n---\n");
  });

  it("adds it as the last property of a file that has others", () => {
    expect(withLogGoal(`---\ntags: [log]\n---\n${V2}\n`, 120)).toBe(
      `---\ntags: [log]\ngoal_minutes: 120\n---\n${V2}\n`
    );
    expect(withLogGoal(`---\r\ntags: [log]\r\n---\r\n${V2}\r\n`, 120)).toBe(
      `---\r\ntags: [log]\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n`
    );
    expect(withLogGoal(`---\n---\n${V2}\n`, 120)).toBe(`---\ngoal_minutes: 120\n---\n${V2}\n`);
  });

  it("rewrites only the goal's own row when it differs", () => {
    expect(withLogGoal(`---\ngoal_minutes: 90\ntags: [log]\n---\n${V2}\n`, 120)).toBe(
      `---\ngoal_minutes: 120\ntags: [log]\n---\n${V2}\n`
    );
    expect(withLogGoal(`---\r\ngoal_minutes: 90\r\n---\r\n${V2}\r\n`, 120)).toBe(
      `---\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n`
    );
    expect(withLogGoal("---\ngoal_minutes: soon\n---\n", 120)).toBe(
      "---\ngoal_minutes: 120\n---\n"
    );
  });

  it("changes nothing when the file already records that goal, however it is written", () => {
    const content = `---\ngoal_minutes: "120"   # set by the timer\ntags: [log]\n---\n${V2}\n`;
    expect(withLogGoal(content, 120)).toBe(content);
  });

  it("writes nothing while the goal is off, and leaves a recorded one be", () => {
    expect(withLogGoal(`${V2}\n`, 0)).toBe(`${V2}\n`);
    expect(withLogGoal(`---\ngoal_minutes: 90\n---\n${V2}\n`, 0)).toBe(
      `---\ngoal_minutes: 90\n---\n${V2}\n`
    );
  });

  it("leaves a file that starts with a byte order mark alone: another program wrote it", () => {
    expect(withLogGoal(`﻿${V2}\n`, 120)).toBe(`﻿${V2}\n`);
    const own = `﻿---\ngoal_minutes: 90\n---\n${V2}\n`;
    expect(withLogGoal(own, 120)).toBe(own);
  });

  it("adds the goal to properties whose closing line has a trailing space, never a second block", () => {
    expect(withLogGoal(`---\ntags: [log]\n--- \n${V2}\n`, 120)).toBe(
      `---\ntags: [log]\ngoal_minutes: 120\n--- \n${V2}\n`
    );
    expect(withLogGoal(`---\ngoal_minutes: 90\n----\n${V2}\n`, 120)).toBe(
      `---\ngoal_minutes: 120\n----\n${V2}\n`
    );
  });

  it("puts no block in front of a file whose first row starts with '---' but opens no properties", () => {
    // Unclosed, or not `---` alone: a block in front would end at that row.
    for (const content of [`---\ntags: [log]\n${V2}\n`, `--- \ntags: [log]\n---\n${V2}\n`]) {
      expect(withLogGoal(content, 120)).toBe(content);
    }
  });

  it("rewrites a goal whose value runs on over the rows below it as a whole, never its first row alone", () => {
    // As Properties writes a list, and as a folded or literal block.
    const shapes = [
      "goal_minutes:\n  - 90",
      "goal_minutes:\n- 90",
      "goal_minutes: >\n  90",
      "goal_minutes: |\n  90\n\n  more",
      "goal_minutes: 90\n  more",
    ];
    for (const shape of shapes) {
      const content = `---\ntags: [log]\n${shape}\nnext: 1\n---\n${V2}\n`;
      expect(readLogGoal(content), shape).toBeNull();
      expect(withLogGoal(content, 120), shape).toBe(
        `---\ntags: [log]\ngoal_minutes: 120\nnext: 1\n---\n${V2}\n`
      );
    }
    // A blank row and an indented comment after a plain value end nothing.
    const commented = `---\ngoal_minutes: 90\n\n  # mine\nnext: 1\n---\n`;
    expect(readLogGoal(commented)).toBe(90);
    expect(withLogGoal(commented, 120)).toBe(`---\ngoal_minutes: 120\n\n  # mine\nnext: 1\n---\n`);
  });

  it("never touches the body, even a 'goal_minutes' line in it", () => {
    const body = `${V2}\ngoal_minutes: 60\n`;
    expect(withLogGoal(body, 120)).toBe(`---\ngoal_minutes: 120\n---\n${body}`);
    expect(readLogGoal(withLogGoal(body, 120))).toBe(120);
  });
});

describe("every reader of the log passes over the file's properties", () => {
  it("today's total counts only the body's sessions", () => {
    expect(parseFocusTotalSeconds(FILE)).toBe(1500 + 1200);
  });

  it("Fix a session lists only the body's lines, at their own rows", () => {
    expect(loggedLines(FILE).map((l) => [l.index, l.text])).toEqual([
      [6, V2],
      [7, V1],
    ]);
  });

  it("Fix a session rewrites its line and keeps the properties byte for byte", () => {
    const [first] = loggedLines(FILE);
    const fixed = replaceSessionLine(FILE, first, "- 🍅 Focus [Task:: Fixed]");
    expect(fixed).toBe(`${HEAD}- 🍅 Focus [Task:: Fixed]\n${V1}\n`);
    const crlf = FILE.replace(/\n/g, "\r\n");
    const [line] = loggedLines(crlf);
    expect(replaceSessionLine(crlf, line, null)).toBe(`${HEAD}${V1}\n`.replace(/\n/g, "\r\n"));
  });

  it("Fix a session never rewrites a property row, even one whose text it is given", () => {
    expect(replaceSessionLine(FILE, { index: 99, text: "goal_minutes: 120" }, "x")).toBeNull();
    expect(replaceSessionLine(FILE, { index: 1, text: "goal_minutes: 120" }, "x")).toBeNull();
  });

  it("Add a session puts the day's earliest session below the properties, never among them", () => {
    const line =
      "- 🍅 Focus [Task:: Early] [Start:: 2026-10-02 06:00:00] [End:: 2026-10-02 06:30:00] [Scheduled:: 1800] [Pauses:: []] [Total:: 1800] [Status:: finished] [Type:: focus] [Overtime:: 0]";
    expect(insertSessionLine(FILE, line)).toBe(`${HEAD}${line}\n${V2}\n${V1}\n`);
    const between = line.replace(/06:/g, "08:");
    expect(insertSessionLine(FILE, between)).toBe(`${HEAD}${between}\n${V2}\n${V1}\n`);
    // A file that is only properties gets the line after them.
    expect(insertSessionLine(HEAD, line)).toBe(`${HEAD}${line}\n`);
  });

  it("Convert rewrites the body and keeps the properties byte for byte", () => {
    const converted = convertLogContent(FILE);
    expect(converted.counts.converted).toBe(1);
    expect(converted.counts.alreadyV2).toBe(1);
    expect(converted.content.startsWith(HEAD)).toBe(true);
    expect(converted.content.split("\n").slice(6)).toEqual([
      V2,
      convertLogContent(`${V1}\n`).content.trimEnd(),
      "",
    ]);
    // And a second run changes nothing.
    expect(convertLogContent(converted.content).content).toBe(converted.content);
    const crlf = FILE.replace(/\n/g, "\r\n");
    expect(convertLogContent(crlf).content.startsWith(HEAD.replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("Check flags nothing in the properties", () => {
    expect(scanLogAnomalies([{ path: "Logs/a.md", content: FILE }])).toEqual([]);
  });

  it("the rename and Refresh walks rename only the body's lines", () => {
    const resolve = (link: string) => (link === "Projects/Docs.md" ? link : null);
    const renamed = renameLogContent(
      FILE,
      "Logs/a.md",
      {
        taskId: "abc123",
        name: "New name #task/develop/docs",
        taskPath: "Projects/Docs.md",
        createdDate: null,
        line: "- [ ] New name #task/develop/docs 🆔 abc123",
        copies: [],
      },
      resolve
    );
    expect(renamed.lines).toBe(2);
    expect(renamed.content.startsWith(HEAD)).toBe(true);

    const notes = {
      resolve,
      lines: () => ["- [ ] New name #task/develop/docs 🆔 abc123"],
    };
    const refreshed = refreshLogContent(FILE, "Logs/a.md", notes);
    expect(refreshed.renamed).toHaveLength(2);
    expect(refreshed.content.startsWith(HEAD)).toBe(true);
    expect(refreshTargets(HEAD, "Logs/a.md", resolve)).toEqual([]);
  });

  describe("a day's log under two names, merged (F4)", () => {
    const into = `${V2}\n`;
    const from = `---\ngoal_minutes: 90\n---\n${V1}\n`;

    it("keeps the 0-9 file's properties on top, and the other's out of the body", () => {
      const merged = mergeLogContent(`---\ngoal_minutes: 120\n---\n${into}`, from);
      expect(merged.content).toBe(`---\ngoal_minutes: 120\n---\n${V2}\n${V1}\n`);
      expect(merged.droppedProperties).toEqual(["---", "goal_minutes: 90", "---"]);
      expect(merged.lines).toBe(1);
    });

    it("takes the other file's properties when the 0-9 file has none", () => {
      const merged = mergeLogContent(into, from);
      expect(merged.content).toBe(`---\ngoal_minutes: 90\n---\n${V2}\n${V1}\n`);
      expect(merged.droppedProperties).toEqual([]);
      // Without the other file's byte order mark: it belongs to the file that goes.
      expect(mergeLogContent(into, `\uFEFF${from}`).content).toBe(merged.content);
    });

    it("puts no properties after the 0-9 file's byte order mark: the head another program wrote stays", () => {
      const merged = mergeLogContent(`\uFEFF${into}`, from);
      expect(merged.content).toBe(`\uFEFF${V2}\n${V1}\n`);
      expect(merged.droppedProperties).toEqual(["---", "goal_minutes: 90", "---"]);
      // Its own properties, past the mark, stay on top with it.
      const own = `\uFEFF---\ngoal_minutes: 120\n---\n${into}`;
      expect(mergeLogContent(own, from).content).toBe(`${own}${V1}\n`);
    });

    it("counts and takes back only the lines, never a property", () => {
      expect(logLineCount(from)).toBe(1);
      const own = `---\ngoal_minutes: 120\n---\n${into}`;
      const merged = mergeLogContent(own, from).content;
      expect(unmergeLogContent(merged, from)).toBe(own);
      // The properties a merge put on top stay: they lose nothing there.
      expect(unmergeLogContent(mergeLogContent(into, from).content, from)).toBe(
        `---\ngoal_minutes: 90\n---\n${into}`
      );
      // The other file's '---' rows are not lines it brought: a rule in the
      // body stays.
      const ruled = `---\ngoal_minutes: 120\n---\n${V2}\n\n---\n`;
      expect(unmergeLogContent(mergeLogContent(ruled, from).content, from)).toBe(ruled);
    });
  });
});

describe("LogManager records today's goal in today's file (real moment)", () => {
  const require = createRequire(import.meta.url);
  const realMoment = require("moment") as unknown;

  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown; window?: unknown };
    previousMoment = g.moment;
    g.moment = realMoment;
    if (typeof g.window === "undefined") g.window = globalThis;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  const at = (d: number, h: number, mi: number) => vi.setSystemTime(new Date(2026, 9, d, h, mi, 0));
  const LOG = (date: string) => `Logs/${date}-gentle-pomodoro-log.md`;
  const TODAY = LOG("2026-10-02");

  function setup(
    files: Record<string, string> = {},
    settings: { dailyFocusGoalMinutes?: number; dayStartHour?: number } = {}
  ) {
    const vault = fakeVault(files);
    const created: { path: string; data: string }[] = [];
    const appended: { path: string; data: string }[] = [];
    const onDisk: Record<string, string> = {};
    Object.assign(vault, {
      adapter: {
        exists: (path: string) => Promise.resolve(path === "Logs" || path in onDisk),
        read: (path: string) => Promise.resolve(onDisk[path]),
        append: (path: string, data: string) => {
          appended.push({ path, data });
          return Promise.resolve();
        },
      },
      create: (path: string, data: string) => {
        if (path in onDisk) return Promise.reject(new Error("File already exists."));
        created.push({ path, data });
        vault.contents[path] = data;
        return Promise.resolve();
      },
      createFolder: vi.fn(),
    });
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour: 0, dailyFocusGoalMinutes: 120, ...settings },
      app: { vault, metadataCache: linkCache(vault) },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    return { vault, created, appended, onDisk, plugin, lm: new LogManager(plugin) };
  }

  /** One 25-minute focus, 10:00 to 10:25 on 2 October. */
  async function session(lm: LogManager) {
    at(2, 10, 0);
    lm.startSession("focus", "No Task", 25);
    at(2, 10, 25);
    await lm.endSession("finished");
  }
  const LINE =
    "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";

  it("starts a new day's file with the day's goal, in the same write as its first line", async () => {
    const { created, lm } = setup();
    await session(lm);
    expect(created).toEqual([{ path: TODAY, data: `---\ngoal_minutes: 120\n---\n${LINE}\n` }]);
  });

  it("adds the goal to today's file that has none, in the write that appends the line", async () => {
    const { vault, lm } = setup({ [TODAY]: `${V2}\n` });
    await session(lm);
    expect(vault.writes).toEqual([TODAY]);
    expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 120\n---\n${V2}\n${LINE}\n`);
  });

  it("leaves the goal row as it is when it already says the setting", async () => {
    const head = `---\ngoal_minutes: "120"  # mine\ntags: [log]\n---\n`;
    const { vault, lm } = setup({ [TODAY]: `${head}${V2}\n` });
    await session(lm);
    expect(vault.contents[TODAY]).toBe(`${head}${V2}\n${LINE}\n`);
  });

  it("updates a goal that differs from the setting, and only its row", async () => {
    const { vault, lm } = setup({ [TODAY]: `---\ntags: [log]\ngoal_minutes: 90\n---\n${V2}\n` });
    await session(lm);
    expect(vault.contents[TODAY]).toBe(
      `---\ntags: [log]\ngoal_minutes: 120\n---\n${V2}\n${LINE}\n`
    );
  });

  it("never sets a past day's goal: a session begun before midnight goes into yesterday's file as it is", async () => {
    const recorded = `---\ngoal_minutes: 90\n---\n${V2}\n`;
    const { vault, lm } = setup({ [TODAY]: recorded, [LOG("2026-10-01")]: `${V2}\n` });
    at(2, 23, 50);
    lm.startSession("focus", "No Task", 25);
    at(3, 0, 20);
    await lm.endSession("finished");
    expect(vault.contents[TODAY].startsWith(recorded)).toBe(true);
    expect(vault.contents[TODAY]).not.toContain("goal_minutes: 120");

    const { vault: other, lm: yesterday } = setup({ [LOG("2026-10-01")]: `${V2}\n` });
    at(1, 23, 40);
    yesterday.startSession("focus", "No Task", 25);
    at(2, 0, 10);
    await yesterday.endSession("finished");
    expect(other.contents[LOG("2026-10-01")].startsWith(`${V2}\n- 🍅 Focus`)).toBe(true);
  });

  it("takes today as 'Day starts at' counts it: at 01:55 with a 4:00 start, today is yesterday's date", async () => {
    const { created, lm } = setup({}, { dayStartHour: 4 });
    at(3, 1, 30);
    lm.startSession("focus", "No Task", 25);
    at(3, 1, 55);
    await lm.endSession("finished");
    expect(created.map((c) => c.path)).toEqual([TODAY]);
    expect(created[0].data.startsWith("---\ngoal_minutes: 120\n---\n- 🍅 Focus")).toBe(true);
  });

  it("writes nothing for the goal while it is off", async () => {
    const { created, lm } = setup({}, { dailyFocusGoalMinutes: 0 });
    await session(lm);
    expect(created).toEqual([{ path: TODAY, data: `${LINE}\n` }]);
  });

  it("keeps a CRLF file CRLF", async () => {
    const { vault, lm } = setup({ [TODAY]: `${V2}\r\n` });
    await session(lm);
    expect(vault.contents[TODAY]).toBe(`---\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n${LINE}\r\n`);
  });

  it("adds no goal through the adapter's append, when the index lags the disk", async () => {
    const { onDisk, appended, created, lm } = setup();
    onDisk[TODAY] = `${V2}\n`;
    await session(lm);
    expect(created).toEqual([]);
    expect(appended).toEqual([{ path: TODAY, data: `${LINE}\n` }]);
  });

  describe("and its readers pass over the properties", () => {
    it("today's total", async () => {
      const { lm } = setup({ [TODAY]: FILE });
      at(2, 12, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(2700);
    });

    it("the timer's own line goes at the end, the properties kept byte for byte", async () => {
      const { vault, lm } = setup({ [TODAY]: FILE });
      await session(lm);
      expect(vault.contents[TODAY]).toBe(`${FILE}${LINE}\n`);
    });

    it("a recovered session's line too (F23)", async () => {
      const storage = memoryStorage();
      const first = setup({ [TODAY]: FILE });
      const device = { storage, plannedMs: () => 25 * 60_000 };
      const before = new LogManager(first.plugin, device);
      at(2, 11, 0);
      before.startSession("focus", "No Task", 25);
      at(2, 11, 30);
      before.heartbeat();
      at(2, 12, 0);
      const after = new LogManager(first.plugin, device);
      await after.offerUnfinishedSessions(() => Promise.resolve("log"));
      const content = first.vault.contents[TODAY];
      expect(content.startsWith(FILE)).toBe(true);
      expect(content.slice(FILE.length)).toMatch(
        /^- 🍅 Focus \[Task:: No Task\] \[Start:: 2026-10-02 11:00:00\] \[End:: 2026-10-02 11:30:00\].*\n$/u
      );
    });

    it("Check log's duplicate 🆔 look", async () => {
      // abc123 is on two open lines of its note, so a log line naming it would
      // be reported; only the properties name it here.
      const { lm } = setup({
        [TODAY]: `${HEAD}- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 08:00:00] [End:: 2026-10-02 08:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]\n`,
        "Projects/Docs.md": "- [ ] Old name 🆔 abc123\n- [ ] Old name again 🆔 abc123\n",
      });
      expect(await lm.findDuplicateTaskIds()).toEqual([]);
      const { lm: named } = setup({
        [TODAY]: `${V2}\n`,
        "Projects/Docs.md": "- [ ] Old name 🆔 abc123\n- [ ] Old name again 🆔 abc123\n",
      });
      expect(await named.findDuplicateTaskIds()).toEqual([
        { taskId: "abc123", path: "Projects/Docs.md" },
      ]);
    });
  });
});
