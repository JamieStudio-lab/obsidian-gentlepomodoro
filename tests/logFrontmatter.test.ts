import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LOG_GOAL_KEY,
  frontmatterRowCount,
  logFrontmatter,
  readLogGoal,
  recordLogGoal,
  resolveGoalMinutes,
  withLogGoal,
  withoutLogGoal,
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
import { LOG_GOAL_WRITE_DELAY_MS } from "../constants";
import { PENDING_GOALS_KEY, UNWRITTEN_LINES_KEY, readPendingGoals } from "../sessionRecovery";
import type { DeviceStorage } from "../deviceStorage";
import type GentlePomoPlugin from "../main";
import { memoryStorage } from "./memoryStorage";
import { fakeVault, linkCache } from "./fakeVault";
import { callbackBody, topLevelStatements } from "./sourceText";

/** The goal changes kept on a device, path → minutes, their times left out. */
function keptMinutes(storage: DeviceStorage): Map<string, number> {
  const kept = readPendingGoals(storage.load(PENDING_GOALS_KEY));
  return new Map([...kept].map(([path, change]) => [path, change.minutes]));
}

/**
 * The daily log file's properties (0.6.9): the day's goal, `goal_minutes`,
 * recorded in the file of the day it was — by the timer's own writes, to
 * TODAY's file, to the day a goal change was made on and to a past day's file
 * it creates, never otherwise to a past day's — and every reader of the log
 * passing over the properties as no part of it. Lines are made up; none is copied from a
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

describe("taking the goal out of a file's text (the goal turned off)", () => {
  it("takes out the block the timer wrote, in either line ending", () => {
    expect(withoutLogGoal(`---\ngoal_minutes: 120\n---\n${V2}\n`)).toBe(`${V2}\n`);
    expect(withoutLogGoal(`---\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n`)).toBe(`${V2}\r\n`);
    // A file that is only the block, as it can be at the end of the file.
    expect(withoutLogGoal("---\ngoal_minutes: 120\n---\n")).toBe("");
    expect(withoutLogGoal("---\ngoal_minutes: 120\n---")).toBe("");
    // And undoes withLogGoal on a file that had no properties, byte for byte.
    for (const body of [`${V2}\n`, `${V2}\r\n${V1}\r\n`, ""]) {
      expect(withoutLogGoal(withLogGoal(body, 120))).toBe(body);
    }
  });

  it("takes out only the goal's own row when the file has other properties", () => {
    expect(withoutLogGoal(`---\ntags: [log]\ngoal_minutes: 90\nnext: 1\n---\n${V2}\n`)).toBe(
      `---\ntags: [log]\nnext: 1\n---\n${V2}\n`
    );
    expect(withoutLogGoal(`---\r\ngoal_minutes: 90\r\ntags: [log]\r\n---\r\n${V2}\r\n`)).toBe(
      `---\r\ntags: [log]\r\n---\r\n${V2}\r\n`
    );
    expect(withoutLogGoal(`---\ntags: [log]\ngoal_minutes: 90\n---\n${V2}\n`)).toBe(
      `---\ntags: [log]\n---\n${V2}\n`
    );
  });

  it("takes out the row however its value is written, a number or not", () => {
    for (const row of [
      'goal_minutes: "120"   # set by the timer',
      "goal_minutes: '90'",
      "goal_minutes: 90.5",
      "goal_minutes: soon",
      "goal_minutes:",
    ]) {
      expect(withoutLogGoal(`---\n${row}\ntags: [log]\n---\n${V2}\n`), row).toBe(
        `---\ntags: [log]\n---\n${V2}\n`
      );
    }
  });

  it("takes out a value that runs on over the rows below it as a whole", () => {
    const shapes = [
      "goal_minutes:\n  - 90",
      "goal_minutes:\n- 90",
      "goal_minutes: >\n  90",
      "goal_minutes: |\n  90\n\n  more",
      "goal_minutes: 90\n  more",
    ];
    for (const shape of shapes) {
      const content = `---\ntags: [log]\n${shape}\nnext: 1\n---\n${V2}\n`;
      expect(withoutLogGoal(content), shape).toBe(`---\ntags: [log]\nnext: 1\n---\n${V2}\n`);
      const crlf = content.replace(/\n/g, "\r\n");
      expect(withoutLogGoal(crlf), shape).toBe(`---\r\ntags: [log]\r\nnext: 1\r\n---\r\n${V2}\r\n`);
    }
  });

  it("takes out every copy of the key, so none is left to read", () => {
    const twice = `---\ngoal_minutes: 90\ntags: [log]\ngoal_minutes: 100\n---\n${V2}\n`;
    expect(withoutLogGoal(twice)).toBe(`---\ntags: [log]\n---\n${V2}\n`);
    expect(readLogGoal(withoutLogGoal(twice))).toBeNull();
    expect(withoutLogGoal(`---\ngoal_minutes: 90\ngoal_minutes: 100\n---\n${V2}\n`)).toBe(
      `${V2}\n`
    );
  });

  it("never touches another key: one indented under another, a comment, the body", () => {
    for (const content of [
      `---\nday:\n  goal_minutes: 60\n---\n${V2}\n`,
      `---\n# goal_minutes: 60\n---\n${V2}\n`,
      `---\ngoal_minutes_old: 60\n---\n${V2}\n`,
      `${V2}\ngoal_minutes: 60\n`,
      `---\ntags: [log]\n---\n${V2}\ngoal_minutes: 60\n`,
    ]) {
      expect(withoutLogGoal(content), content).toBe(content);
    }
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n---\n${V2}\ngoal_minutes: 60\n`)).toBe(
      `${V2}\ngoal_minutes: 60\n`
    );
  });

  it("keeps a block that still holds anything, however little", () => {
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n\n---\n${V2}\n`)).toBe(`---\n\n---\n${V2}\n`);
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n# mine\n---\n${V2}\n`)).toBe(
      `---\n# mine\n---\n${V2}\n`
    );
    // A blank row and an indented comment after a plain value are not its own.
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n\n  # mine\nnext: 1\n---\n`)).toBe(
      `---\n\n  # mine\nnext: 1\n---\n`
    );
  });

  it("keeps an emptied block the timer never writes: a closing line that is not '---' alone", () => {
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n--- \n${V2}\n`)).toBe(`---\n--- \n${V2}\n`);
    expect(withoutLogGoal(`---\ngoal_minutes: 90\n----\n${V2}\n`)).toBe(`---\n----\n${V2}\n`);
    expect(withoutLogGoal(`---\r\ngoal_minutes: 90\r\n---x\r\n${V2}\r\n`)).toBe(
      `---\r\n---x\r\n${V2}\r\n`
    );
  });

  it("keeps an emptied block whose body starts with '---': without it, that row would open properties", () => {
    const content = `---\ngoal_minutes: 90\n---\n---\nnote: x\n---\n${V2}\n`;
    expect(withoutLogGoal(content)).toBe(`---\n---\n---\nnote: x\n---\n${V2}\n`);
    expect(frontmatterRowCount(withoutLogGoal(content))).toBe(2);
  });

  it("changes nothing in a file with no goal_minutes row among its properties, an empty block included", () => {
    for (const content of [
      `${V2}\n`,
      "",
      `---\ntags: [log]\n---\n${V2}\n`,
      `---\n---\n${V2}\n`,
      `---\ngoal_minutes: 90\n${V2}\n`,
    ]) {
      expect(withoutLogGoal(content), content).toBe(content);
    }
  });

  it("leaves a file that starts with a byte order mark alone: another program wrote it", () => {
    const own = `﻿---\ngoal_minutes: 90\n---\n${V2}\n`;
    expect(withoutLogGoal(own)).toBe(own);
    expect(withoutLogGoal(`﻿${V2}\n`)).toBe(`﻿${V2}\n`);
  });
});

describe("recording the goal setting in a file's text", () => {
  const recorded = `---\ntags: [log]\ngoal_minutes: 90\n---\n${V2}\n`;

  it("writes it while the goal is on", () => {
    expect(recordLogGoal(recorded, 120)).toBe(`---\ntags: [log]\ngoal_minutes: 120\n---\n${V2}\n`);
    expect(recordLogGoal(`${V2}\r\n`, 120)).toBe(withLogGoal(`${V2}\r\n`, 120));
    expect(recordLogGoal(recorded, 90)).toBe(recorded);
  });

  it("takes it out while the goal is off, whatever reads as off", () => {
    for (const off of [0, -5, Number.NaN, Infinity]) {
      expect(recordLogGoal(recorded, off), String(off)).toBe(`---\ntags: [log]\n---\n${V2}\n`);
      expect(recordLogGoal(`---\ngoal_minutes: 90\n---\n${V2}\n`, off)).toBe(`${V2}\n`);
      expect(recordLogGoal(`${V2}\n`, off)).toBe(`${V2}\n`);
    }
  });

  it("turned on and off again, leaves a file that records no goal as it was — an empty block and a goal_minutes row with no number apart", () => {
    for (const content of [
      `${V2}\n`,
      `${V2}\r\n`,
      "",
      `---\ntags: [log]\n---\n${V2}\n`,
      `---\r\ntags: [log]\r\n---\r\n${V2}\r\n`,
      `---\n\n---\n${V2}\n`,
      `---\n# mine\n---\n${V2}\n`,
      `---\n--- \n${V2}\n`,
      `---\n---\n---\nnote: x\n---\n${V2}\n`,
      `---\ngoal_minutes: 90\n${V2}\n`,
      `\uFEFF---\n---\n${V2}\n`,
    ]) {
      expect(recordLogGoal(recordLogGoal(content, 120), 0), content).toBe(content);
    }

    // A goal_minutes row holding no number records no goal either. The key is
    // the timer's: the goal is written in its place, and the off write takes
    // the key out, so the row goes whatever it held.
    const noNumber: [string, string][] = [
      [`---\ngoal_minutes:\ntags: [log]\n---\n${V2}\n`, `---\ntags: [log]\n---\n${V2}\n`],
      [`---\ngoal_minutes: soon\n---\n${V2}\n`, `${V2}\n`],
      [`---\ngoal_minutes:\n  - 90\nnext: 1\n---\n${V2}\n`, `---\nnext: 1\n---\n${V2}\n`],
    ];
    for (const [content, back] of noNumber) {
      expect(readLogGoal(content), content).toBeNull();
      expect(recordLogGoal(content, 120), content).toContain("goal_minutes: 120");
      expect(recordLogGoal(recordLogGoal(content, 120), 0), content).toBe(back);
      // The goal off alone takes it out too.
      expect(withoutLogGoal(content), content).toBe(back);
    }
  });

  it("takes out an empty block that was there before the goal went in: it cannot tell it from its own", () => {
    // `---` over `---`, nothing between — which withoutLogGoal alone leaves
    // be — is filled by the goal exactly as a file with no properties is, so
    // no way of taking the goal out can give each its own back. The block the
    // timer writes goes; so does this one, which held nothing.
    for (const eol of ["\n", "\r\n"]) {
      const empty = `---${eol}---${eol}${V2}${eol}`;
      expect(withoutLogGoal(empty)).toBe(empty);
      expect(recordLogGoal(empty, 120)).toBe(recordLogGoal(`${V2}${eol}`, 120));
      expect(recordLogGoal(recordLogGoal(empty, 120), 0)).toBe(`${V2}${eol}`);
    }
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
    settings: { dailyFocusGoalMinutes?: number; dayStartHour?: number } = {},
    storage: DeviceStorage | null = null
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
    const device = storage ? { storage, plannedMs: () => null } : null;
    return { vault, created, appended, onDisk, plugin, lm: new LogManager(plugin, device) };
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

  it("takes a recorded goal out of today's file while it is off, in the write that appends the line", async () => {
    // The day reads as one with no goal once it is past, never the number it
    // had before the goal was turned off.
    const { vault, lm } = setup(
      { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
      { dailyFocusGoalMinutes: 0 }
    );
    await session(lm);
    expect(vault.writes).toEqual([TODAY]);
    expect(vault.contents[TODAY]).toBe(`${V2}\n${LINE}\n`);

    const other = setup(
      { [TODAY]: `---\r\ntags: [log]\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n` },
      { dailyFocusGoalMinutes: 0 }
    );
    await session(other.lm);
    expect(other.vault.contents[TODAY]).toBe(`---\r\ntags: [log]\r\n---\r\n${V2}\r\n${LINE}\r\n`);
  });

  it("never takes a past day's goal out: a session begun before midnight leaves yesterday's as it is", async () => {
    const recorded = `---\ngoal_minutes: 90\n---\n${V2}\n`;
    const { vault, lm } = setup({ [LOG("2026-10-01")]: recorded }, { dailyFocusGoalMinutes: 0 });
    at(1, 23, 40);
    lm.startSession("focus", "No Task", 25);
    at(2, 0, 10);
    await lm.endSession("finished");
    expect(vault.contents[LOG("2026-10-01")].startsWith(`${recorded}- 🍅 Focus`)).toBe(true);
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

  describe("and gives today's file the goal when the setting changes", () => {
    beforeEach(() => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      at(2, 20, 0);
    });

    /** Change the setting as the settings tab does: the value, then the call. */
    function change(plugin: GentlePomoPlugin, lm: LogManager, minutes: number) {
      plugin.settings.dailyFocusGoalMinutes = minutes;
      lm.goalChanged();
    }

    /** Wait out the delay, then for the write it starts. */
    async function settle(lm: LogManager) {
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS);
      await lm.walksSettled();
    }

    it("once the typing stops: one write, of the last value", async () => {
      const { vault, plugin, lm } = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` });
      // Typing 150 over 120, as settings before 1.13 commit it: 1, 15, 150.
      for (const minutes of [1, 15, 150]) {
        change(plugin, lm, minutes);
        vi.advanceTimersByTime(500);
      }
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS - 500 - 1);
      await lm.walksSettled();
      expect(vault.writes).toEqual([]);
      vi.advanceTimersByTime(1);
      await lm.walksSettled();
      expect(vault.writes).toEqual([TODAY]);
      expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 150\n---\n${V2}\n`);
      // Nothing re-read: the total counts the body, which did not move.
      expect(plugin.invalidateFocusTotalCache).not.toHaveBeenCalled();
      // "A moment": long enough for a number typed a digit at a time, short
      // enough that a quit right after it is rare (the changelog's words).
      expect(LOG_GOAL_WRITE_DELAY_MS).toBeGreaterThanOrEqual(1000);
      expect(LOG_GOAL_WRITE_DELAY_MS).toBeLessThanOrEqual(2000);
    });

    it("keeps nothing and sets no timer with no log folder: there is no day's file to write", async () => {
      const storage = memoryStorage();
      const save = vi.spyOn(storage, "save");
      const { plugin, lm } = setup({}, {}, storage);
      plugin.settings.logFolderPath = "";
      change(plugin, lm, 90);
      expect(vi.getTimerCount()).toBe(0);
      expect(save).not.toHaveBeenCalled();
    });

    it("updates only the goal's row, and keeps a CRLF file CRLF", async () => {
      const { vault, plugin, lm } = setup({
        [TODAY]: `---\r\ntags: [log]\r\ngoal_minutes: 120\r\n---\r\n${V2}\r\n`,
      });
      change(plugin, lm, 90);
      await settle(lm);
      expect(vault.contents[TODAY]).toBe(
        `---\r\ntags: [log]\r\ngoal_minutes: 90\r\n---\r\n${V2}\r\n`
      );
    });

    it("adds the goal to today's file that has none", async () => {
      const { vault, plugin, lm } = setup({ [TODAY]: `${V2}\n` }, { dailyFocusGoalMinutes: 0 });
      change(plugin, lm, 60);
      await settle(lm);
      expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 60\n---\n${V2}\n`);
    });

    it("takes the goal out when it is turned off, and the block the timer wrote with it", async () => {
      const { vault, plugin, lm } = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` });
      change(plugin, lm, 0);
      await settle(lm);
      expect(vault.contents[TODAY]).toBe(`${V2}\n`);

      const kept = setup({ [TODAY]: `---\ntags: [log]\ngoal_minutes: 120\n---\n${V2}\n` });
      change(kept.plugin, kept.lm, 0);
      await settle(kept.lm);
      expect(kept.vault.contents[TODAY]).toBe(`---\ntags: [log]\n---\n${V2}\n`);
    });

    it("creates no file for a goal", async () => {
      const { vault, created, appended, plugin, lm } = setup();
      change(plugin, lm, 90);
      await settle(lm);
      expect(created).toEqual([]);
      expect(appended).toEqual([]);
      expect(vault.writes).toEqual([]);
      expect(TODAY in vault.contents).toBe(false);
    });

    it("writes nothing when today's file already says it, however it is written", async () => {
      const head = `---\ngoal_minutes: "120"  # mine\ntags: [log]\n---\n`;
      const { vault, plugin, lm } = setup(
        { [TODAY]: `${head}${V2}\n` },
        { dailyFocusGoalMinutes: 90 }
      );
      change(plugin, lm, 120);
      await settle(lm);
      expect(vault.writes).toEqual([]);

      const off = setup({ [TODAY]: `---\ntags: [log]\n---\n${V2}\n` });
      change(off.plugin, off.lm, 0);
      await settle(off.lm);
      expect(off.vault.writes).toEqual([]);
    });

    it("leaves a file that starts with a byte order mark alone", async () => {
      const own = `﻿---\ngoal_minutes: 90\n---\n${V2}\n`;
      for (const minutes of [120, 0]) {
        const { vault, plugin, lm } = setup({ [TODAY]: own });
        change(plugin, lm, minutes);
        await settle(lm);
        expect(vault.writes, String(minutes)).toEqual([]);
        expect(vault.contents[TODAY]).toBe(own);
      }
    });

    it("changes only the file of the day it was made on, as 'Day starts at' counts it", async () => {
      const recorded = `---\ngoal_minutes: 90\n---\n${V2}\n`;
      const files = {
        [LOG("2026-10-01")]: recorded,
        [TODAY]: recorded,
        [LOG("2026-10-03")]: recorded,
      };
      // At 01:30 on 3 October with a 4:00 start, today is 2 October.
      const { vault, plugin, lm } = setup(files, { dayStartHour: 4 });
      at(3, 1, 30);
      change(plugin, lm, 45);
      await settle(lm);
      expect(vault.writes).toEqual([TODAY]);
      expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 45\n---\n${V2}\n`);
      expect(vault.contents[LOG("2026-10-01")]).toBe(recorded);
      expect(vault.contents[LOG("2026-10-03")]).toBe(recorded);
    });

    it("writes nothing once the day it was made on is over: one in a day's last moment is let go, and the new day's file is not touched", async () => {
      // The maintainer's call: a past day's file is never written from a kept
      // change, as a late write races Obsidian Sync's merge (goalFor).
      const storage = memoryStorage();
      const recorded = `---\ngoal_minutes: 120\n---\n${V2}\n`;
      const NEXT = LOG("2026-10-03");
      const { vault, plugin, lm } = setup({ [TODAY]: recorded, [NEXT]: recorded }, {}, storage);
      vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
      change(plugin, lm, 90);
      await settle(lm);
      expect(new Date().getDate()).toBe(3);
      expect(vault.writes).toEqual([]);
      expect(vault.contents[TODAY]).toBe(recorded);
      expect(vault.contents[NEXT]).toBe(recorded);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("lets a change go when a phone suspends the app and the write runs the next morning: that day keeps its goal", async () => {
      const recorded = `---\ngoal_minutes: 120\n---\n${V2}\n`;
      const { vault, plugin, lm } = setup({ [TODAY]: recorded });
      // The day's last session, written at 10:25: before the change.
      await session(lm);
      at(2, 22, 0);
      change(plugin, lm, 240);
      // Suspended: the timer fires when the app wakes, the day after.
      at(3, 8, 0);
      await settle(lm);
      expect(vault.writes).toEqual([TODAY]);
      expect(readLogGoal(vault.contents[TODAY])).toBe(120);

      // Woken the same day instead, it writes.
      const same = setup({ [TODAY]: recorded });
      await session(same.lm);
      at(2, 22, 0);
      change(same.plugin, same.lm, 240);
      at(2, 23, 30);
      await settle(same.lm);
      expect(readLogGoal(same.vault.contents[TODAY])).toBe(240);
    });

    /** A second device on the same vault: its own settings, and its own storage. */
    function otherDevice(vault: ReturnType<typeof setup>["vault"], minutes: number) {
      const plugin = {
        settings: { logFolderPath: "Logs", dayStartHour: 0, dailyFocusGoalMinutes: minutes },
        app: { vault, metadataCache: linkCache(vault) },
        invalidateFocusTotalCache: vi.fn(),
      } as unknown as GentlePomoPlugin;
      return {
        plugin,
        lm: new LogManager(plugin, { storage: memoryStorage(), plannedMs: () => null }),
      };
    }

    it("never puts a change it kept over a later one another device wrote into that day's file, pulled or not", async () => {
      // 22:00 on the phone: 60, and the phone quits (or locks) within the
      // delay. 23:00 on the laptop: 90, written. 2 October ended with 90.
      const storage = memoryStorage();
      const phone = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` }, {}, storage);
      const laptop = otherDevice(phone.vault, 120);
      at(2, 22, 0);
      change(phone.plugin, phone.lm, 60);
      vi.advanceTimersByTime(1000);
      phone.lm.dispose();
      at(2, 23, 0);
      change(laptop.plugin, laptop.lm, 90);
      await settle(laptop.lm);
      expect(readLogGoal(phone.vault.contents[TODAY])).toBe(90);

      // The phone's next start, the next morning: the later write stays.
      at(3, 8, 0);
      const next = new LogManager(phone.plugin, { storage, plannedMs: () => null });
      await next.writeWaitingGoals();
      expect(readLogGoal(phone.vault.contents[TODAY])).toBe(90);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();

      // The usual order: the phone starts before Sync has pulled the laptop's
      // version, so its own copy still holds 120. It must write nothing
      // there, or Sync would merge its 60 with the laptop's 90 (goalFor).
      const kept = memoryStorage();
      const alone = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` }, {}, kept);
      at(2, 22, 0);
      change(alone.plugin, alone.lm, 60);
      vi.advanceTimersByTime(1000);
      alone.lm.dispose();
      at(3, 8, 0);
      const started = new LogManager(alone.plugin, { storage: kept, plannedMs: () => null });
      await started.writeWaitingGoals();
      expect(alone.vault.writes).toEqual([]);
      expect(kept.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("nor when its own timer fires the next morning, the app having been suspended", async () => {
      const phone = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` });
      const laptop = otherDevice(phone.vault, 120);
      at(2, 22, 0);
      change(phone.plugin, phone.lm, 60);
      at(2, 23, 0);
      change(laptop.plugin, laptop.lm, 90);
      // The laptop's timer, alone: the phone's is still waiting for its wake.
      await laptop.lm.writeWaitingGoals();
      expect(readLogGoal(phone.vault.contents[TODAY])).toBe(90);
      const written = phone.vault.writes.length;
      at(3, 8, 0);
      await settle(phone.lm);
      await laptop.lm.walksSettled();
      expect(phone.vault.writes.length).toBe(written);
      expect(readLogGoal(phone.vault.contents[TODAY])).toBe(90);
    });

    it("lets a kept change for a day that is over go, and writes this device's retried line there as it is, whichever runs first", async () => {
      // An earlier run: a line for 2 October its write failed on, and a goal
      // change made after it, both kept. The next start is on 3 October.
      for (const goalFirst of [false, true]) {
        const storage = memoryStorage();
        at(2, 22, 0);
        storage.save(UNWRITTEN_LINES_KEY, [
          { path: TODAY, folder: "Logs", lines: [LINE], focus: true },
        ]);
        storage.save(PENDING_GOALS_KEY, [{ path: TODAY, minutes: 60, at: Date.now() }]);
        const { vault, lm } = setup(
          { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
          {},
          storage
        );
        at(3, 8, 0);
        if (goalFirst) await lm.writeWaitingGoals();
        await lm.retryUnwrittenLines();
        await lm.writeWaitingGoals();
        expect(vault.contents[TODAY], String(goalFirst)).toBe(
          `---\ngoal_minutes: 120\n---\n${V2}\n${LINE}\n`
        );
        expect(storage.load(PENDING_GOALS_KEY)).toBeNull();
      }
    });

    it("gives a day's file created after that day the goal as it is set then: its only session ran past midnight", async () => {
      // Changed during the session, at 23:50: no file for 2 October yet, so
      // nothing to write then, and the change is let go.
      const { created, plugin, lm } = setup();
      at(2, 23, 40);
      lm.startSession("focus", "No Task", 25);
      at(2, 23, 50);
      change(plugin, lm, 90);
      await settle(lm);
      at(3, 0, 10);
      await lm.endSession("finished");
      expect(created.map((c) => c.path)).toEqual([TODAY]);
      expect(readLogGoal(created[0].data)).toBe(90);

      // Unchanged that day: the setting; with the goal off, none.
      for (const minutes of [120, 0]) {
        const other = setup({}, { dailyFocusGoalMinutes: minutes });
        at(2, 23, 40);
        other.lm.startSession("focus", "No Task", 25);
        at(3, 0, 10);
        await other.lm.endSession("finished");
        expect(other.created.map((c) => c.path)).toEqual([TODAY]);
        expect(readLogGoal(other.created[0].data), String(minutes)).toBe(minutes || null);
      }
    });

    it("gives a day's file created later the setting as it is now, not a change kept for that day", async () => {
      // As every kept change for a day that is over: let go (goalFor). Off
      // either way round, too: an off setting writes no goal, a kept 0 none.
      for (const [kept, setting, goal] of [
        [60, 45, 45],
        [60, 0, null],
        [0, 45, 45],
      ] as const) {
        const storage = memoryStorage();
        at(2, 22, 0);
        storage.save(UNWRITTEN_LINES_KEY, [
          { path: TODAY, folder: "Logs", lines: [LINE], focus: true },
        ]);
        storage.save(PENDING_GOALS_KEY, [{ path: TODAY, minutes: kept, at: Date.now() }]);
        const { created, lm } = setup({}, { dailyFocusGoalMinutes: setting }, storage);
        at(3, 8, 0);
        await lm.retryUnwrittenLines();
        expect(created.map((c) => c.path)).toEqual([TODAY]);
        expect(readLogGoal(created[0].data), `${kept} ${setting}`).toBe(goal);
      }
    });

    it("writes the new day's change and lets the old day's go, when changes on two days wait for one write", async () => {
      const storage = memoryStorage();
      const recorded = `---\ngoal_minutes: 120\n---\n${V2}\n`;
      const NEXT = LOG("2026-10-03");
      const { vault, plugin, lm } = setup({ [TODAY]: recorded, [NEXT]: recorded }, {}, storage);
      vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
      change(plugin, lm, 90);
      vi.setSystemTime(new Date(2026, 9, 3, 0, 0, 0));
      change(plugin, lm, 60);
      expect(keptMinutes(storage)).toEqual(
        new Map([
          [TODAY, 90],
          [NEXT, 60],
        ])
      );
      await settle(lm);
      expect(vault.contents[TODAY]).toBe(recorded);
      expect(readLogGoal(vault.contents[NEXT])).toBe(60);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("waits for a change made while its write runs, and writes that one after", async () => {
      const { vault, plugin, lm } = setup(
        { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
        {},
        memoryStorage()
      );
      let finishRead: (() => void) | null = null;
      const read = vault.read.bind(vault);
      vault.read = (file) =>
        new Promise((resolve) => {
          finishRead = () => {
            void read(file).then(resolve);
          };
        });
      change(plugin, lm, 90);
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS);
      await vi.waitFor(() => {
        expect(finishRead).not.toBeNull();
      });
      vault.read = read;
      change(plugin, lm, 60);
      finishRead!();
      await settle(lm);
      expect(readLogGoal(vault.contents[TODAY])).toBe(60);
    });

    it("keeps a session appended between its read and its write", async () => {
      const { vault, plugin, lm } = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` });
      const read = vault.read.bind(vault);
      vault.read = async (file) => {
        const content = await read(file);
        // The timer's append lands while the goal write is between steps.
        vault.contents[file.path] += `${LINE}\n`;
        return content;
      };
      change(plugin, lm, 90);
      await settle(lm);
      expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 90\n---\n${V2}\n${LINE}\n`);
    });

    it("writes nothing at unload and leaves no timer behind; the next start writes the change, kept on this device", async () => {
      // Esc, then Cmd+Q a second later, or a plugin update: no vault write
      // from a plugin being turned off (F19), and none lost either.
      const storage = memoryStorage();
      const recorded = `---\ngoal_minutes: 120\n---\n${V2}\n`;
      const { vault, plugin, lm } = setup({ [TODAY]: recorded }, {}, storage);
      change(plugin, lm, 90);
      vi.advanceTimersByTime(1000);
      lm.dispose();
      expect(vi.getTimerCount()).toBe(0);
      // And takes none after it.
      change(plugin, lm, 60);
      expect(vi.getTimerCount()).toBe(0);
      await settle(lm);
      expect(vault.writes).toEqual([]);
      expect(keptMinutes(storage)).toEqual(new Map([[TODAY, 90]]));

      // The next start, the same day: it writes the change, and this device
      // lets it go. The setting is 90 there — the 60 came after unload.
      plugin.settings.dailyFocusGoalMinutes = 90;
      at(2, 21, 0);
      const next = new LogManager(plugin, { storage, plannedMs: () => null });
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS * 10);
      await next.walksSettled();
      expect(vault.writes).toEqual([]);
      await next.writeWaitingGoals();
      expect(vault.writes).toEqual([TODAY]);
      expect(vault.contents[TODAY]).toBe(`---\ngoal_minutes: 90\n---\n${V2}\n`);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();

      // The next start the day after: that day keeps its goal, the change is
      // let go — with the goal turned off too, the row stays.
      for (const minutes of [90, 0]) {
        const kept = memoryStorage();
        const later = setup({ [TODAY]: recorded }, {}, kept);
        at(2, 20, 0);
        change(later.plugin, later.lm, minutes);
        later.lm.dispose();
        at(3, 9, 0);
        const started = new LogManager(later.plugin, { storage: kept, plannedMs: () => null });
        await started.writeWaitingGoals();
        expect(later.vault.writes, String(minutes)).toEqual([]);
        expect(later.vault.contents[TODAY]).toBe(recorded);
        expect(kept.load(PENDING_GOALS_KEY)).toBeNull();
      }
    });

    it("keeps a change on this device until it is written, and only that long", async () => {
      const storage = memoryStorage();
      const { plugin, lm } = setup(
        { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
        {},
        storage
      );
      change(plugin, lm, 90);
      expect(keptMinutes(storage)).toEqual(new Map([[TODAY, 90]]));
      await settle(lm);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();

      // A day with no file has nothing to write: let go too, none created.
      const kept = memoryStorage();
      const none = setup({}, {}, kept);
      change(none.plugin, none.lm, 90);
      await settle(none.lm);
      expect(none.vault.writes).toEqual([]);
      expect(none.created).toEqual([]);
      expect(kept.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("writes a kept change for today as the setting is now: it may have moved since, on another device", async () => {
      const storage = memoryStorage();
      storage.save(PENDING_GOALS_KEY, [{ path: TODAY, minutes: 60, at: Date.now() }]);
      const { vault, lm } = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` }, {}, storage);
      await lm.writeWaitingGoals();
      expect(readLogGoal(vault.contents[TODAY])).toBe(120);
      expect(vault.writes).toEqual([]);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("keeps a change whose write failed, for the next start", async () => {
      const storage = memoryStorage();
      const { vault, plugin, lm } = setup(
        { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
        {},
        storage
      );
      const process = vault.process;
      vault.process = () => Promise.reject(new Error("locked"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      change(plugin, lm, 90);
      await settle(lm);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      expect(keptMinutes(storage)).toEqual(new Map([[TODAY, 90]]));

      vault.process = process;
      const next = new LogManager(plugin, { storage, plannedMs: () => null });
      await next.writeWaitingGoals();
      expect(readLogGoal(vault.contents[TODAY])).toBe(90);
      expect(storage.load(PENDING_GOALS_KEY)).toBeNull();
    });

    it("writes nothing after unload, even once its read has started", async () => {
      const storage = memoryStorage();
      const { vault, plugin, lm } = setup(
        { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
        {},
        storage
      );
      let finishRead: (() => void) | null = null;
      const read = vault.read.bind(vault);
      vault.read = (file) =>
        new Promise((resolve) => {
          finishRead = () => {
            void read(file).then(resolve);
          };
        });
      change(plugin, lm, 90);
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS);
      await vi.waitFor(() => {
        expect(finishRead).not.toBeNull();
      });
      lm.dispose();
      finishRead!();
      await lm.walksSettled();
      expect(vault.writes).toEqual([]);
      // Still kept on this device, for the next start (the reloaded plugin).
      expect(keptMinutes(storage)).toEqual(new Map([[TODAY, 90]]));
    });

    it("leaves this device's list alone after unload, even once its write has landed (F19)", async () => {
      // By then the list may be the reloaded plugin's.
      const storage = memoryStorage();
      const { vault, plugin, lm } = setup(
        { [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` },
        {},
        storage
      );
      let finishWrite: (() => void) | null = null;
      const process = vault.process.bind(vault);
      vault.process = (file, fn) =>
        new Promise((resolve) => {
          finishWrite = () => {
            void process(file, fn).then(resolve);
          };
        });
      change(plugin, lm, 90);
      vi.advanceTimersByTime(LOG_GOAL_WRITE_DELAY_MS);
      await vi.waitFor(() => {
        expect(finishWrite).not.toBeNull();
      });
      lm.dispose();
      const save = vi.spyOn(storage, "save");
      finishWrite!();
      await lm.walksSettled();
      expect(readLogGoal(vault.contents[TODAY])).toBe(90);
      expect(save).not.toHaveBeenCalled();
    });

    it("reports a failed write and goes on", async () => {
      const { vault, plugin, lm } = setup({ [TODAY]: `---\ngoal_minutes: 120\n---\n${V2}\n` });
      vault.process = () => Promise.reject(new Error("locked"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      change(plugin, lm, 90);
      await settle(lm);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
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

describe("the goal changes kept on this device (PENDING_GOALS_KEY)", () => {
  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";

  it("read back defensively: only a daily log's path, with minutes that read as a goal or none, and the time it was made at", () => {
    const at = 1_790_000_000_000;
    const raw: unknown = [
      { path: LOG, minutes: 90, at },
      { path: "Logs/2026-10-01-gentle-pomodoro-log.md", minutes: 0, at: 0 },
      { path: "Notes/Ideas.md", minutes: 90, at },
      { path: LOG.replace("02", "03"), minutes: -5, at },
      { path: LOG.replace("02", "04"), minutes: Number.NaN, at },
      { path: LOG.replace("02", "06"), minutes: Infinity, at },
      { path: LOG.replace("02", "05"), minutes: "90", at },
      { path: 5, minutes: 90, at },
      // No time, or none that is one: a later write could not be told apart.
      { path: LOG.replace("02", "07"), minutes: 90 },
      { path: LOG.replace("02", "08"), minutes: 90, at: "1790000000000" },
      { path: LOG.replace("02", "09"), minutes: 90, at: Number.NaN },
      { path: LOG.replace("02", "10"), minutes: 90, at: -1 },
      null,
      "x",
    ];
    // Read as given: a device storage hands back what JSON holds, but the
    // reader takes nothing on trust.
    expect(readPendingGoals(raw)).toEqual(
      new Map([
        [LOG, { minutes: 90, at }],
        ["Logs/2026-10-01-gentle-pomodoro-log.md", { minutes: 0, at: 0 }],
      ])
    );
    expect(readPendingGoals({ [LOG]: 90 })).toEqual(new Map());
    expect(readPendingGoals(null)).toEqual(new Map());
  });

  it("are written at startup, after layout-ready, without holding anything up", () => {
    const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
    // Inside the callback itself: before layout-ready the vault index is not
    // complete, a day's file is not found, and its change is let go.
    // A statement of its own there: not behind a condition, nor put off into
    // a nested timer.
    const ready = callbackBody(main, "this.app.workspace.onLayoutReady(() => {");
    expect(topLevelStatements(ready)).toContain("void this.logManager.writeWaitingGoals();");
    expect(main.match(/\.writeWaitingGoals\(/g)).toHaveLength(1);
  });
});
