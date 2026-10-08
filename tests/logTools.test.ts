import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import moment from "moment";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { App, TFile } from "obsidian";
// The recording stubs, by path so `tsc` sees `shown` and `opened` (see tests/settingTab.test.ts).
import { Modal, Notice } from "../__mocks__/obsidian";
import {
  LINE_CHANGED_NOTICE,
  LogTools,
  NO_LOG_FILES_NOTICE,
  NO_LOG_FOLDER_NOTICE,
  NO_LOG_TODAY_NOTICE,
  checkLogMessage,
  convertConfirmOptions,
  convertResultMessage,
  type LogCheckSummary,
  type LogToolsHost,
} from "../logTools";
import { emptyConversionCounts, countAnomalies } from "../logConvert";
import { logFolderProblemNotice } from "../logFolder";
import { formFromLine, loggedLines, type LoggedLine, type SessionForm } from "../logEditor";
import type { MomentLike } from "../momentTypes";
import type { ConfirmOptions } from "../confirmModal";
import type { SessionFormAnswer, SessionFormOptions } from "../sessionModals";
import { DEFAULT_SETTINGS } from "../constants";
import type { GentlePomoSettings } from "../types";
import { fakeVault, type FakeVault } from "./fakeVault";

/**
 * The daily log's commands (0.6.9): Open today's log (F56), Check log and
 * Convert old log lines (F1, F44, F64), Add a session and Fix a logged
 * session (C6) — the file reads and writes around the pure rules, which
 * tests/logConvert.test.ts and tests/logEditor.test.ts hold. Lines are made
 * up; none is copied from a real log.
 */

const NOW = new Date(2026, 9, 2, 18, 0, 0);

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  (globalThis as unknown as { moment: unknown }).moment = moment;
});

afterAll(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { moment?: unknown }).moment;
});

let warnings: string[] = [];
beforeEach(() => {
  Notice.shown.length = 0;
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const V1_FOCUS =
  "- 🍅 Focus | Task:: [[Projects/Garden.md|Plant the tulips 🔼 #task/other/garden]] | ID:: t9k2xq | Start:: 2026-10-01 09:00:00 | End:: 2026-10-01 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";
const V1_REST =
  "- ☕ Rest | Start:: 2026-10-01 09:25:00 | End:: 2026-10-01 09:30:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break";
const V2_FOCUS =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const V2_LATER =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 12:00:00] [End:: 2026-10-02 12:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const UNREADABLE = "- 🍅 Focus by hand, about 20 minutes";

const LOG = (date: string) => `Logs/${date}-gentle-pomodoro-log.md`;

/** The dialog's starting values for a line, as fixLine builds them. */
const formFor = (line: LoggedLine): SessionForm => {
  const form = formFromLine(line, (ms) => moment(ms) as unknown as MomentLike);
  if (!form) throw new Error("unreadable line");
  return form;
};

interface Harness {
  tools: LogTools;
  vault: FakeVault;
  settings: GentlePomoSettings;
  asked: ConfirmOptions[];
  answers: boolean[];
  opened: string[];
  created: { path: string; data: string }[];
  renamed: { from: string; to: string }[];
  /** The files moved to the trash, and those whose move to it fails. */
  trashed: string[];
  trashFails: Set<string>;
  /** Runs as a file is asked to go to the trash, before it goes or fails. */
  beforeTrash: ((path: string) => void) | null;
  changed: number;
  forms: SessionFormOptions[];
  formAnswers: SessionFormAnswer[];
  /** The note Obsidian calls active, and the open tabs: what the picker's note scopes read. */
  active: string | null;
  tabs: string[];
  /** Folders that do not exist yet. createFolder makes one; create fails inside one. */
  missing: Set<string>;
  /** createFolder and create, in the order they ran. */
  calls: string[];
}

function harness(
  files: Record<string, string>,
  set: Partial<GentlePomoSettings> = {},
  extra: Partial<LogToolsHost> = {}
): Harness {
  const vault = fakeVault(files);
  const h: Harness = {
    tools: null as unknown as LogTools,
    vault,
    settings: { ...DEFAULT_SETTINGS, logFolderPath: "Logs", ...set },
    asked: [],
    answers: [],
    opened: [],
    created: [],
    renamed: [],
    trashed: [],
    trashFails: new Set(),
    beforeTrash: null,
    changed: 0,
    forms: [],
    formAnswers: [],
    active: null,
    tabs: [],
    missing: new Set(),
    calls: [],
  };
  const app = {
    vault: Object.assign(vault, {
      // A log is written only through Vault.process, which reads and writes in
      // one step: a read then a modify would lose a session the timer appends
      // between the two.
      modify: () => Promise.reject(new Error("write through Vault.process, not modify")),
      create: (path: string, data: string) => {
        const folder = path.slice(0, path.lastIndexOf("/"));
        if (h.missing.has(folder)) {
          return Promise.reject(new Error(`Folder "${folder}" does not exist`));
        }
        h.calls.push(`create ${path}`);
        h.created.push({ path, data });
        return Promise.resolve();
      },
      createFolder: (path: string) => {
        h.calls.push(`createFolder ${path}`);
        h.missing.delete(path);
        return Promise.resolve();
      },
      adapter: { exists: (path: string) => Promise.resolve(!h.missing.has(path)) },
    }),
    fileManager: {
      renameFile: (file: TFile, to: string) => {
        h.renamed.push({ from: file.path, to });
        vault.move(file, to);
        return Promise.resolve();
      },
      trashFile: (file: TFile) => {
        h.beforeTrash?.(file.path);
        if (h.trashFails.has(file.path)) return Promise.reject(new Error("no trash"));
        h.trashed.push(file.path);
        vault.remove(file);
        return Promise.resolve();
      },
    },
    workspace: {
      getLeaf: () => ({
        openFile: (file: TFile) => {
          h.opened.push(file.path);
          return Promise.resolve();
        },
      }),
      getActiveFile: () =>
        h.active === null
          ? null
          : { path: h.active, extension: h.active.slice(h.active.lastIndexOf(".") + 1) },
      iterateRootLeaves: (each: (leaf: { getViewState(): unknown }) => void) => {
        for (const file of h.tabs)
          each({ getViewState: () => ({ type: "markdown", state: { file } }) });
      },
    },
  } as unknown as App;
  h.tools = new LogTools({
    app,
    settings: () => h.settings,
    confirm: (options) => {
      h.asked.push(options);
      return Promise.resolve(h.answers.shift() ?? false);
    },
    duplicateTaskIds: () => Promise.resolve([]),
    logChanged: () => {
      h.changed++;
    },
    askSessionForm: (options) => {
      h.forms.push(options);
      return Promise.resolve(h.formAnswers.shift() ?? null);
    },
    ...extra,
  });
  return h;
}

describe("Open today's log (F56)", () => {
  it("opens today's file", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n` });
    await h.tools.openToday();
    expect(h.opened).toEqual([LOG("2026-10-02")]);
    expect(Notice.shown).toEqual([]);
  });

  it("says so when nothing is logged today, and creates no file", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n` });
    await h.tools.openToday();
    expect(Notice.shown).toEqual([NO_LOG_TODAY_NOTICE]);
    expect(h.opened).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.vault.writes).toEqual([]);
  });

  it("says so when no log is kept at all", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n` }, { logFolderPath: "" });
    await h.tools.openToday();
    expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE]);
    expect(h.opened).toEqual([]);
  });

  it("counts today as 'Day starts at' does", async () => {
    vi.setSystemTime(new Date(2026, 9, 3, 2, 30));
    try {
      const h = harness(
        { [LOG("2026-10-02")]: `${V2_FOCUS}\n`, [LOG("2026-10-03")]: "" },
        { dayStartHour: 4 }
      );
      await h.tools.openToday();
      expect(h.opened).toEqual([LOG("2026-10-02")]);
    } finally {
      vi.setSystemTime(NOW);
    }
  });
});

describe("Check log", () => {
  const files = () => ({
    [LOG("2026-10-01")]: `${V1_FOCUS}\n${V1_REST}\n${UNREADABLE}\n`,
    [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    // Not a daily log: never read, never counted, never written.
    "Logs/Index.md": `${V1_FOCUS}\n`,
  });

  it("counts what Convert would do, and writes nothing", async () => {
    const h = harness(files());
    await h.tools.check();
    expect(h.vault.writes).toEqual([]);
    expect(h.renamed).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(Notice.shown).toEqual([
      'Gentle pomodoro: checked 2 log file(s) and changed nothing. 2 line(s) in 1 file(s) are in the old format; "Convert old log lines" rewrites them. Left as they are: 1 line(s) that can\'t be read. Details are in the developer console.',
    ]);
    // The line it could not read is listed, with its place.
    expect(warnings.join("\n")).toContain(`line 3 (can't be read): ${UNREADABLE}`);
  });

  it("reports what looks wrong, and the 🆔s on task lines it can't tell apart (F2, F64)", async () => {
    const overlap =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:10:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1200] [Status:: finished] [Type:: focus] [Overtime:: 0]";
    const h = harness(
      { [LOG("2026-10-02")]: `${V2_FOCUS}\n${overlap}\n` },
      {},
      { duplicateTaskIds: () => Promise.resolve([{ taskId: "abc123", path: "Projects/A.md" }]) }
    );
    await h.tools.check();
    expect(Notice.shown[0]).toContain(
      "Worth a look: 1 overlapping session(s), 1 task ID(s) on task lines that can't be told apart."
    );
    expect(warnings.join("\n")).toContain(`Check log: "${LOG("2026-10-02")}"\n  line 2: Starts at`);
    expect(warnings.join("\n")).toContain(
      '🆔 abc123 is on more than one task line in "Projects/A.md", and not on exactly one open one'
    );
  });

  it("says so when it fails, and the next press still runs", async () => {
    const h = harness(
      { [LOG("2026-10-02")]: `${V2_FOCUS}\n` },
      {},
      { duplicateTaskIds: () => Promise.reject(new Error("offline")) }
    );
    await h.tools.check();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: couldn't check the log — see the developer console for details.",
    ]);
    await h.tools.check();
    expect(Notice.shown).toHaveLength(2);
  });

  it("says when all is well", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n${V2_LATER}\n` });
    await h.tools.check();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: checked 1 log file(s). Every line is in the current format and nothing looks wrong.",
    ]);
  });

  it("says when there is no folder, or no log in it", async () => {
    await harness(files(), { logFolderPath: "" }).tools.check();
    await harness({ "Logs/Index.md": "" }).tools.check();
    expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE, NO_LOG_FILES_NOTICE]);
  });

  it("counts a file it cannot open, and checks the others", async () => {
    const h = harness({
      [LOG("2026-10-01")]: `${V1_FOCUS}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    const read = h.vault.read;
    h.vault.read = (file) =>
      file.path === LOG("2026-10-02") ? Promise.reject(new Error("offline")) : read(file);
    await h.tools.check();
    expect(Notice.shown).toEqual([
      'Gentle pomodoro: checked 2 log file(s) and changed nothing. 1 line(s) in 1 file(s) are in the old format; "Convert old log lines" rewrites them. Left as they are: 1 file(s) that couldn\'t be opened. Details are in the developer console.',
    ]);
    expect(warnings.join("\n")).toContain(`Could not read "${LOG("2026-10-02")}"`);
  });
});

describe("Convert old log lines", () => {
  const ARABIC = "Logs/٢٠٢٦-٠٩-٣٠-gentle-pomodoro-log.md";

  it("asks first, with the dry run's exact counts, and writes nothing on Cancel", async () => {
    const h = harness({
      [LOG("2026-10-01")]: `${V1_FOCUS}\n${V1_REST}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    await h.tools.convert();
    expect(h.asked).toEqual([
      {
        title: "Convert old log lines?",
        body: "2 line(s) in 1 file(s) will be rewritten in the format Dataview reads. Every start, end and total is kept; the tidy-ups below are the only other changes.",
        list: ["1 priority emoji removed from task names"],
        ctaText: "Convert 2 line(s)",
      },
    ]);
    expect(h.vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([]);
  });

  it("rewrites only the files that change, and reports what it did", async () => {
    const h = harness({
      [LOG("2026-10-01")]: `${V1_FOCUS}\n${V1_REST}\n${UNREADABLE}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
      "Logs/Index.md": `${V1_FOCUS}\n`,
    });
    h.answers.push(true);
    await h.tools.convert();
    expect(h.vault.writes).toEqual([LOG("2026-10-01")]);
    const lines = h.vault.contents[LOG("2026-10-01")].split("\n");
    expect(lines[0]).toBe(
      "- 🍅 Focus [Task:: [[Projects/Garden.md|Plant the tulips #task/other/garden]]] [ID:: t9k2xq] [Start:: 2026-10-01 09:00:00] [End:: 2026-10-01 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus]"
    );
    expect(lines[2]).toBe(UNREADABLE);
    expect(h.vault.contents["Logs/Index.md"]).toBe(`${V1_FOCUS}\n`);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 2 line(s) in 1 file(s). Left as they are: 1 line(s) that can't be read — see the developer console.",
    ]);
    expect(h.changed).toBe(1);
  });

  it("changes nothing the second time", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n${V1_REST}\n` });
    h.answers.push(true);
    await h.tools.convert();
    const after = h.vault.contents[LOG("2026-10-01")];
    Notice.shown.length = 0;
    await h.tools.convert();
    expect(h.asked).toHaveLength(1);
    expect(h.vault.writes).toEqual([LOG("2026-10-01")]);
    expect(h.vault.contents[LOG("2026-10-01")]).toBe(after);
    expect(Notice.shown).toEqual(["Gentle pomodoro: no old log lines to convert."]);
  });

  it("renames a file named in other digits when its day has no 0-9 file, and merges it into the one it has (F14, F4)", async () => {
    const OLD_29 = "Logs/٢٠٢٦-٠٩-٢٩-gentle-pomodoro-log.md";
    const h = harness({
      [ARABIC]: `${V2_FOCUS}\n`,
      [OLD_29]: `${V2_FOCUS}\n`,
      [LOG("2026-09-29")]: `${V2_LATER}\n`,
    });
    h.answers.push(true);
    await h.tools.convert();
    expect(h.asked[0]).toMatchObject({
      body: "1 file(s) will be renamed to write their date with 0-9. 1 file(s) named with other digits will be merged into the 0-9 file of the same day, in start order, and then moved to the trash.",
      list: [
        'Merge "٢٠٢٦-٠٩-٢٩-gentle-pomodoro-log.md" into "2026-09-29-gentle-pomodoro-log.md": 1 line(s)',
      ],
      ctaText: "Rename 1 file(s)",
    });
    expect(h.renamed).toEqual([{ from: ARABIC, to: LOG("2026-09-30") }]);
    expect(h.vault.contents[LOG("2026-09-29")]).toBe(`${V2_FOCUS}\n${V2_LATER}\n`);
    expect(h.trashed).toEqual([OLD_29]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 0 line(s) in 0 file(s). Renamed 1 file(s). Merged 1 file(s) (1 line(s)) into the 0-9 file of the same day.",
    ]);
  });

  it("runs one at a time: a second press while the first asks does nothing", async () => {
    let release: ((answer: boolean) => void) | null = null;
    const h = harness(
      { [LOG("2026-10-01")]: `${V1_FOCUS}\n` },
      {},
      {
        confirm: () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      }
    );
    const first = h.tools.convert();
    // The first is now holding its question open.
    await vi.waitFor(() => {
      expect(release).not.toBeNull();
    });
    await h.tools.convert();
    await h.tools.check();
    (release as unknown as (answer: boolean) => void)(true);
    await first;
    expect(h.vault.writes).toEqual([LOG("2026-10-01")]);
    expect(Notice.shown).toHaveLength(1);
  });

  it("converts what the file holds when it writes, so a session added since the dry run is kept", async () => {
    // The dialog can stay open for a while; the timer appends a session meanwhile.
    const h = harness(
      { [LOG("2026-10-02")]: `${V1_FOCUS.replace("2026-10-01", "2026-10-02")}\n` },
      {},
      {
        confirm: () => {
          h.vault.contents[LOG("2026-10-02")] += `${V2_LATER}\n`;
          return Promise.resolve(true);
        },
      }
    );
    await h.tools.convert();
    const lines = h.vault.contents[LOG("2026-10-02")].split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[Task:: ");
    expect(lines[1]).toBe(V2_LATER);
  });

  it("goes on past a file it cannot write, and says how many", async () => {
    // The file that fails is the MIDDLE one, so a file comes after it in
    // whichever order the folder is walked: stopping at the failure would
    // leave that one unconverted.
    const h = harness({
      [LOG("2026-09-29")]: `${V1_FOCUS}\n`,
      [LOG("2026-09-30")]: `${V1_FOCUS}\n`,
      [LOG("2026-10-01")]: `${V1_REST}\n`,
    });
    const process = h.vault.process;
    const tried: string[] = [];
    h.vault.process = (file, fn) => {
      tried.push(file.path);
      return file.path === LOG("2026-09-30")
        ? Promise.reject(new Error("locked"))
        : process(file, fn);
    };
    h.answers.push(true);
    await h.tools.convert();
    expect(tried).toHaveLength(3);
    expect(tried[1]).toBe(LOG("2026-09-30"));
    expect([...h.vault.writes].sort()).toEqual([LOG("2026-09-29"), LOG("2026-10-01")]);
    expect(h.vault.contents[LOG("2026-09-29")]).toContain("- 🍅 Focus [Task:: ");
    expect(h.vault.contents[LOG("2026-10-01")]).toContain("- ☕ Rest [Start:: ");
    expect(h.vault.contents[LOG("2026-09-30")]).toBe(`${V1_FOCUS}\n`);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 2 line(s) in 2 file(s). Left as they are: 1 file(s) that couldn't be written — see the developer console.",
    ]);
  });

  /** A harness whose `unreadable` files fail to read, as an iCloud-evicted file does. */
  const withUnreadable = (files: Record<string, string>, unreadable: string[]) => {
    const h = harness(files);
    const read = h.vault.read;
    h.vault.read = (file) =>
      unreadable.includes(file.path) ? Promise.reject(new Error("evicted")) : read(file);
    return h;
  };

  it("says which files it could not open, before asking and after converting (F9)", async () => {
    const h = withUnreadable(
      { [LOG("2026-09-30")]: `${V1_FOCUS}\n`, [LOG("2026-10-01")]: `${V1_REST}\n` },
      [LOG("2026-09-30")]
    );
    h.answers.push(true);
    await h.tools.convert();
    expect(h.asked[0].body).toContain("1 file(s) that couldn't be opened stay as they are.");
    expect(h.vault.writes).toEqual([LOG("2026-10-01")]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 1 line(s) in 1 file(s). Left as they are: 1 file(s) that couldn't be opened — see the developer console.",
    ]);
  });

  it("never calls a folder clear of old lines when it could not open every file (F9)", async () => {
    const files = { [LOG("2026-09-30")]: `${V1_FOCUS}\n`, [LOG("2026-10-02")]: `${V2_FOCUS}\n` };
    // None opened: nothing was looked at, so nothing can be said about the lines.
    await withUnreadable(files, Object.keys(files)).tools.convert();
    // Some opened, none of them old: said of those files only.
    await withUnreadable(files, [LOG("2026-09-30")]).tools.convert();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: couldn't open any of the 2 log file(s), so nothing was converted — see the developer console.",
      "Gentle pomodoro: no old log lines to convert in the files that could be opened. Left as they are: 1 file(s) that couldn't be opened — see the developer console.",
    ]);
  });

  it("says what it leaves when there is nothing to convert", async () => {
    await harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n${UNREADABLE}\n` }).tools.convert();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: no old log lines to convert. Left as they are: 1 line(s) that can't be read — see the developer console.",
    ]);
  });

  it("renames one of two logs whose dates name the same 0-9 file and merges the other into it, counted right in the dialog (F39, F4)", async () => {
    // Arabic-Indic and Persian digits for one date: neither 0-9 name is on
    // disk during the dry run, yet only one file can take it.
    const PERSIAN = "Logs/۲۰۲۶-۰۹-۳۰-gentle-pomodoro-log.md";
    const h = harness({ [ARABIC]: `${V2_FOCUS}\n`, [PERSIAN]: `${V2_LATER}\n` });
    h.answers.push(true);
    await h.tools.convert();
    expect(h.asked[0]).toMatchObject({
      body: "1 file(s) will be renamed to write their date with 0-9. 1 file(s) named with other digits will be merged into the 0-9 file of the same day, in start order, and then moved to the trash.",
      ctaText: "Rename 1 file(s)",
    });
    expect(h.renamed).toHaveLength(1);
    expect(h.renamed[0].to).toBe(LOG("2026-09-30"));
    expect([ARABIC, PERSIAN]).toContain(h.renamed[0].from);
    const merged = h.renamed[0].from === ARABIC ? PERSIAN : ARABIC;
    expect(h.trashed).toEqual([merged]);
    // Both files' lines in the one file, in start order.
    expect(h.vault.contents[LOG("2026-09-30")]).toBe(`${V2_FOCUS}\n${V2_LATER}\n`);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 0 line(s) in 0 file(s). Renamed 1 file(s). Merged 1 file(s) (1 line(s)) into the 0-9 file of the same day.",
    ]);
  });

  it("asks again before each rename: a 0-9 name taken since the dry run is left alone, not failed (F39)", async () => {
    const h = harness(
      { [ARABIC]: `${V2_FOCUS}\n` },
      {},
      {
        // While the dialog is open, a log for that date appears (a sync, say).
        confirm: () => {
          const lookup = h.vault.getAbstractFileByPath;
          h.vault.getAbstractFileByPath = (path) =>
            path === LOG("2026-09-30") ? ({ path } as TFile) : lookup(path);
          return Promise.resolve(true);
        },
      }
    );
    await h.tools.convert();
    expect(h.renamed).toEqual([]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 0 line(s) in 0 file(s). Left as they are: 1 file name(s) whose 0-9 name is taken — see the developer console.",
    ]);
  });
});

describe("a day's log under two names, merged (F4)", () => {
  // The old file, written by Obsidian in Arabic, Persian, Bengali or Nepali:
  // a version 1 line in that script's digits, then a note.
  const OLD = "Logs/٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md";
  const OLD_LINE =
    "- 🍅 Focus | Task:: No Task | Start:: ٢٠٢٦-١٠-٠٢ ١١:٠٠:٠٠ | End:: ٢٠٢٦-١٠-٠٢ ١١:٢٥:٠٠ | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";
  const OLD_LINE_V2 =
    "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus]";
  const files = () => ({
    [LOG("2026-10-02")]: `${V2_FOCUS}\n${V2_LATER}\n`,
    [OLD]: `${OLD_LINE}\nA note after eleven\n`,
  });
  const MERGED = `${V2_FOCUS}\n${OLD_LINE_V2}\nA note after eleven\n${V2_LATER}\n`;

  it("lists the merge and its lines in Check, and writes nothing", async () => {
    const h = harness(files());
    await h.tools.check();
    expect(h.vault.writes).toEqual([]);
    expect(h.trashed).toEqual([]);
    expect(Notice.shown[0]).toContain(
      "1 file(s) named with other digits can be merged into the 0-9 file of the same day (2 line(s))."
    );
    expect(warnings.join("\n")).toContain(
      'Merge "٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md" into "2026-10-02-gentle-pomodoro-log.md": 2 line(s)'
    );
  });

  it("asks with the merge and its lines, then merges in start order and moves the old file to the trash", async () => {
    const h = harness(files());
    h.answers.push(true);
    await h.tools.convert();
    expect(h.asked[0].list).toEqual([
      "1 line(s) with dates in other digits written with 0-9",
      'Merge "٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md" into "2026-10-02-gentle-pomodoro-log.md": 2 line(s)',
    ]);
    // Converted first, so the lines it brings are version 2 with 0-9 dates.
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(MERGED);
    expect(h.trashed).toEqual([OLD]);
    expect(h.vault.getAbstractFileByPath(OLD)).toBeNull();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 1 line(s) in 1 file(s). Merged 1 file(s) (2 line(s)) into the 0-9 file of the same day.",
    ]);
    expect(h.changed).toBe(1);
  });

  it("asks to merge on its own when there is nothing else to do", async () => {
    const h = harness({
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
      [OLD]: `${OLD_LINE_V2.replace("2026-10-02 11", "٢٠٢٦-١٠-٠٢ ١١")}\n`,
    });
    await h.tools.convert();
    expect(h.asked[0]).toMatchObject({
      body: "1 file(s) named with other digits will be merged into the 0-9 file of the same day, in start order, and then moved to the trash.",
      ctaText: "Merge 1 file(s)",
    });
    expect(h.vault.writes).toEqual([]);
  });

  it("can't merge twice: the old file is gone, and a second Convert finds nothing to do", async () => {
    const h = harness(files());
    h.answers.push(true, true);
    await h.tools.convert();
    Notice.shown.length = 0;
    const writes = h.vault.writes.length;
    await h.tools.convert();
    expect(h.asked).toHaveLength(1);
    expect(h.vault.writes).toHaveLength(writes);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(MERGED);
    expect(Notice.shown).toEqual(["Gentle pomodoro: no old log lines to convert."]);
  });

  it("leaves both files as they were when the merge can't be written, and says so", async () => {
    const h = harness(files());
    const process = h.vault.process;
    h.vault.process = (file, fn) =>
      file.path === LOG("2026-10-02") ? Promise.reject(new Error("locked")) : process(file, fn);
    h.answers.push(true);
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(`${V2_FOCUS}\n${V2_LATER}\n`);
    expect(h.vault.contents[OLD]).toBe(`${OLD_LINE_V2}\nA note after eleven\n`);
    expect(h.trashed).toEqual([]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: converted 1 line(s) in 1 file(s). Left as they are: 1 file(s) that couldn't be merged — see the developer console.",
    ]);
  });

  it("takes the lines back out when the old file can't be moved to the trash, so the next Convert merges them once", async () => {
    const h = harness(files());
    h.trashFails.add(OLD);
    h.answers.push(true, true);
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(`${V2_FOCUS}\n${V2_LATER}\n`);
    expect(h.vault.contents[OLD]).toBe(`${OLD_LINE_V2}\nA note after eleven\n`);
    expect(Notice.shown[0]).toContain("1 file(s) that couldn't be merged");

    h.trashFails.clear();
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(MERGED);
    expect(h.trashed).toEqual([OLD]);
  });

  it("takes back only its own lines when the old file can't be moved to the trash, keeping a session the timer wrote meanwhile", async () => {
    // The timer appends between the merge's write and the failed move: the
    // file is no longer the merge's, so the undo takes the merged lines out
    // of it rather than putting back the file as it was before.
    const h = harness(files());
    h.trashFails.add(OLD);
    const SESSION = V2_LATER.replace(/12:/g, "13:");
    h.beforeTrash = (path) => {
      if (path === OLD) h.vault.contents[LOG("2026-10-02")] += `${SESSION}\n`;
    };
    h.answers.push(true);
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(`${V2_FOCUS}\n${V2_LATER}\n${SESSION}\n`);
    expect(h.vault.contents[OLD]).toBe(`${OLD_LINE_V2}\nA note after eleven\n`);
  });

  it("names in the console the old file's properties, which stay with it in the trash", async () => {
    const h = harness({
      [LOG("2026-10-02")]: `---\ngoal_minutes: 120\n---\n${V2_FOCUS}\n`,
      [OLD]: `---\ngoal_minutes: 90\ntags: [old]\n---\n${OLD_LINE}\n`,
    });
    h.answers.push(true);
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(
      `---\ngoal_minutes: 120\n---\n${V2_FOCUS}\n${OLD_LINE_V2}\n`
    );
    expect(h.trashed).toEqual([OLD]);
    const named = warnings.find((w) => w.includes("stay with it in the trash"));
    expect(named).toContain("---\ngoal_minutes: 90\ntags: [old]\n---");
  });

  it("says so when the old file can be neither trashed nor taken back out", async () => {
    const h = harness(files());
    h.trashFails.add(OLD);
    const process = h.vault.process;
    let targetWrites = 0;
    h.vault.process = (file, fn) => {
      if (file.path === LOG("2026-10-02") && ++targetWrites > 1) {
        return Promise.reject(new Error("locked"));
      }
      return process(file, fn);
    };
    h.answers.push(true);
    await h.tools.convert();
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(MERGED);
    expect(Notice.shown[0]).toContain(
      "1 file(s) merged but not moved to the trash: delete them before converting again, or their lines are merged twice"
    );
  });
});

// F29: a folder stored before 0.6.9 checked the box — the top level, or
// another folder's capitalisation. The timer writes to both, so "no log files
// found" would be false; the commands name the problem instead.
describe("a stored log folder the commands cannot list (F29)", () => {
  const ROOT_LOG = "2026-10-02-gentle-pomodoro-log.md";

  it("names the vault's top level in Check and Convert, and still opens today's log there", async () => {
    const h = harness({ [ROOT_LOG]: `${V1_FOCUS}\n` }, { logFolderPath: "/" });
    await h.tools.check();
    await h.tools.convert();
    const notice = logFolderProblemNotice("/", { kind: "root" });
    expect(notice).toContain("top level");
    expect(Notice.shown).toEqual([notice, notice]);
    expect(h.asked).toEqual([]);
    await h.tools.openToday();
    expect(h.opened).toEqual([ROOT_LOG]);
  });

  it("names the vault's own spelling when the folder is stored in other capitals", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V1_FOCUS}\n` }, { logFolderPath: "logs" });
    await h.tools.check();
    await h.tools.convert();
    await h.tools.openToday();
    const notice = logFolderProblemNotice("logs", { kind: "case", real: "Logs" });
    expect(notice).toContain('the vault spells it "Logs"');
    expect(Notice.shown).toEqual([notice, notice, notice]);
    expect(h.opened).toEqual([]);
    expect(h.vault.writes).toEqual([]);
  });

  it("says plainly that nothing is there when the folder exists as stored", async () => {
    // Another capitalisation existing as well changes nothing: the stored one is in use.
    const h = harness({ "Logs/Index.md": "", "logs/notes.md": "" }, { logFolderPath: "logs" });
    await h.tools.check();
    await h.tools.openToday();
    expect(Notice.shown).toEqual([NO_LOG_FILES_NOTICE, NO_LOG_TODAY_NOTICE]);
  });
});

describe("the log tools' wording", () => {
  const summary = (set: Partial<LogCheckSummary>): LogCheckSummary => ({
    files: 3,
    unreadableFiles: 0,
    counts: emptyConversionCounts(),
    convertFiles: 0,
    renames: 0,
    merges: 0,
    mergeLines: 0,
    renamesBlocked: 0,
    anomalies: countAnomalies([]),
    duplicateIds: 0,
    ...set,
  });

  it("names every kind of finding Check counts, and only those found", () => {
    const anomalies = { total: 6, overlap: 1, long: 2, endBeforeStart: 1, idNames: 3 };
    expect(checkLogMessage(summary({ anomalies, renames: 2, unreadableFiles: 1 }))).toBe(
      "Gentle pomodoro: checked 3 log file(s) and changed nothing. 2 file name(s) use other digits and can be renamed. Worth a look: 6 Total(s) that don't match their start, end and pauses, 1 overlapping session(s), 2 session(s) longer than 12 hours, 1 session(s) that end before they start, 3 task ID(s) logged under different names. Left as they are: 1 file(s) that couldn't be opened. Details are in the developer console."
    );
  });

  it("lists each clean-up Convert does, with its count", () => {
    const counts = {
      ...emptyConversionCounts(),
      converted: 9,
      checkbox: 1,
      fffd: 2,
      priority: 3,
      idMoved: 1,
      digits: 4,
      sanitized: 5,
      unrecognised: 2,
    };
    expect(convertConfirmOptions({ counts, convertFiles: 2, renames: 0 })).toEqual({
      title: "Convert old log lines?",
      body: "9 line(s) in 2 file(s) will be rewritten in the format Dataview reads. Every start, end and total is kept; the tidy-ups below are the only other changes. 2 line(s) that can't be read stay as they are.",
      list: [
        "1 checkbox(es) in front of a session removed",
        '2 stray "�" removed from task names',
        "3 priority emoji removed from task names",
        "1 🆔 moved from a task name to the ID field",
        "4 line(s) with dates in other digits written with 0-9",
        '5 task name(s) tidied of brackets or "::"',
      ],
      ctaText: "Convert 9 line(s)",
    });
  });

  it("says what Convert left alone", () => {
    expect(
      convertResultMessage({
        lines: 4,
        files: 2,
        renamed: 0,
        merged: 0,
        mergedLines: 0,
        unrecognised: 0,
        renamesBlocked: 0,
        unreadableFiles: 0,
        failed: 0,
        mergesFailed: 0,
        mergesStuck: 0,
      })
    ).toBe("Gentle pomodoro: converted 4 line(s) in 2 file(s).");
    expect(
      convertResultMessage({
        lines: 4,
        files: 2,
        renamed: 0,
        merged: 0,
        mergedLines: 0,
        unrecognised: 1,
        renamesBlocked: 1,
        unreadableFiles: 2,
        failed: 1,
        mergesFailed: 0,
        mergesStuck: 0,
      })
    ).toBe(
      "Gentle pomodoro: converted 4 line(s) in 2 file(s). Left as they are: 1 line(s) that can't be read, 1 file name(s) whose 0-9 name is taken, 2 file(s) that couldn't be opened, 1 file(s) that couldn't be written — see the developer console."
    );
    expect(
      convertResultMessage({
        lines: 0,
        files: 0,
        renamed: 1,
        merged: 2,
        mergedLines: 7,
        unrecognised: 0,
        renamesBlocked: 0,
        unreadableFiles: 0,
        failed: 0,
        mergesFailed: 1,
        mergesStuck: 1,
      })
    ).toBe(
      "Gentle pomodoro: converted 0 line(s) in 0 file(s). Renamed 1 file(s). Merged 2 file(s) (7 line(s)) into the 0-9 file of the same day. 1 file(s) merged but not moved to the trash: delete them before converting again, or their lines are merged twice — see the developer console. Left as they are: 1 file(s) that couldn't be merged — see the developer console."
    );
  });

  it("promises to keep only what Convert keeps: the tidy-ups listed below the body change task names (F31)", () => {
    // "Every value is kept" sat right above "1 priority emoji removed from
    // task names" — and Convert does rewrite the Task value.
    const tidied = { ...emptyConversionCounts(), converted: 2, priority: 1, idMoved: 1 };
    const asked = convertConfirmOptions({ counts: tidied, convertFiles: 1, renames: 0 });
    expect(asked.list).toHaveLength(2);
    expect(asked.body).not.toMatch(/every value/i);
    expect(asked.body).toContain(
      "Every start, end and total is kept; the tidy-ups below are the only other changes."
    );
    // With nothing tidied, there is no list for the body to point at.
    const plain = { ...emptyConversionCounts(), converted: 2 };
    expect(convertConfirmOptions({ counts: plain, convertFiles: 1, renames: 0 })).toMatchObject({
      body: "2 line(s) in 1 file(s) will be rewritten in the format Dataview reads. Every start, end and total is kept.",
      list: [],
    });
  });
});

describe("Add a session (C6)", () => {
  const filled = (set: Partial<SessionForm>): SessionFormAnswer => ({
    action: "save",
    form: {
      kind: "focus",
      task: null,
      date: "2026-10-02",
      time: "11:00",
      minutes: "30",
      status: "finished",
      ...set,
    },
  });

  it("puts the session at its place in its day's log, through Vault.process", async () => {
    const h = harness({ [LOG("2026-10-02")]: `# Today\n${V2_FOCUS}\n${V2_LATER}\n` });
    h.formAnswers.push(filled({ task: { name: "Write docs", path: "Docs.md", id: "d0c5" } }));
    await h.tools.addSession();
    expect(h.vault.writes).toEqual([LOG("2026-10-02")]);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(
      `# Today\n${V2_FOCUS}\n- 🍅 Focus [Task:: [[Docs.md|Write docs]]] [ID:: d0c5] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:30:00] [Scheduled:: 1800] [Pauses:: []] [Total:: 1800] [Status:: finished] [Type:: focus] [Overtime:: 0]\n${V2_LATER}\n`
    );
    expect(h.changed).toBe(1);
    expect(Notice.shown).toEqual(["Gentle pomodoro: session added to the log for 2026-10-02."]);
  });

  it("creates the day's file when it has none, ending in a line break", async () => {
    const h = harness({});
    h.formAnswers.push(filled({ kind: "short-break", minutes: "5" }));
    await h.tools.addSession();
    expect(h.created).toEqual([
      {
        path: LOG("2026-10-02"),
        data: "- ☕ Rest [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:05:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]\n",
      },
    ]);
  });

  it("makes the log folder first when no session has made it yet", async () => {
    // Typed with a trailing slash, as a folder value from before 0.6.9 can
    // be: the folder asked about and made is the normalized one.
    const h = harness({}, { logFolderPath: "Logs/Focus/" });
    h.missing.add("Logs/Focus");
    h.formAnswers.push(filled({}));
    await h.tools.addSession();
    expect(h.calls).toEqual([
      "createFolder Logs/Focus",
      "create Logs/Focus/2026-10-02-gentle-pomodoro-log.md",
    ]);
    expect(Notice.shown).toEqual(["Gentle pomodoro: session added to the log for 2026-10-02."]);
    expect(h.changed).toBe(1);
  });

  it("says so, writes nothing and does not repaint when the write fails", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n` });
    h.vault.process = () => Promise.reject(new Error("locked"));
    h.formAnswers.push(filled({}));
    await h.tools.addSession();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: couldn't add the session — see the developer console.",
    ]);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(`${V2_FOCUS}\n`);
    expect(h.created).toEqual([]);
    expect(h.changed).toBe(0);
  });

  it("makes no folder that is there already", async () => {
    const h = harness({});
    h.formAnswers.push(filled({}));
    await h.tools.addSession();
    expect(h.calls).toEqual([`create ${LOG("2026-10-02")}`]);
  });

  it("files a session by its start, as 'Day starts at' counts days", async () => {
    const h = harness({ [LOG("2026-10-01")]: "" }, { dayStartHour: 4 });
    h.formAnswers.push(filled({ time: "01:30" }));
    await h.tools.addSession();
    expect(h.vault.writes).toEqual([LOG("2026-10-01")]);
    expect(h.created).toEqual([]);
  });

  it("writes nothing when the dialog is closed", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${V2_FOCUS}\n` });
    await h.tools.addSession();
    expect(h.forms).toHaveLength(1);
    expect(h.vault.writes).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("opens on a focus of the usual length that has just ended, and checks what is typed", async () => {
    const h = harness({}, { focusMinutes: 50 });
    await h.tools.addSession();
    const options = h.forms[0];
    expect(options.form).toMatchObject({ kind: "focus", time: "17:10", minutes: "50" });
    expect(options.canDelete).toBe(false);
    expect(options.check(options.form)).toBeNull();
    expect(options.check({ ...options.form, minutes: "0" })).toMatch(/whole number/);
    expect(options.check({ ...options.form, time: "17:30" })).toMatch(/future/);
  });

  it("asks for a log folder first: with none, there is nowhere to write", async () => {
    const h = harness({}, { logFolderPath: "" });
    await h.tools.addSession();
    expect(h.forms).toEqual([]);
    expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE]);
  });
});

describe("Fix a logged session (C6)", () => {
  const FILE = `${V2_FOCUS}\n${V2_LATER}\n`;
  const pick = (h: Harness) => loggedLines(h.vault.contents[LOG("2026-10-02")])[0];

  it("lists a day's sessions, and none for a day with no log", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    expect((await h.tools.sessionsOn("2026-10-02"))?.lines.map((l) => l.text)).toEqual([
      V2_FOCUS,
      V2_LATER,
    ]);
    expect(await h.tools.sessionsOn("2026-09-01")).toBeNull();
  });

  it("rewrites that exact line through Vault.process", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    h.formAnswers.push({ action: "save", form: { ...formFor(line), status: "cancelled" } });
    await h.tools.fixLine("2026-10-02", line);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(
      `${V2_FOCUS.replace("finished", "cancelled")}\n${V2_LATER}\n`
    );
    expect(Notice.shown).toEqual(["Gentle pomodoro: session updated."]);
    expect(h.changed).toBe(1);
  });

  it("refuses, and writes nothing, when the line changed after it was opened", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    h.vault.contents[LOG("2026-10-02")] = FILE.replace("[Total:: 1500]", "[Total:: 1400]");
    const before = h.vault.contents[LOG("2026-10-02")];
    h.formAnswers.push({ action: "save", form: { ...formFor(line), status: "cancelled" } });
    await h.tools.fixLine("2026-10-02", line);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(before);
    expect(Notice.shown).toEqual([LINE_CHANGED_NOTICE]);
    expect(h.changed).toBe(0);
  });

  it("deletes the line only after asking", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    h.formAnswers.push({ action: "delete" }, { action: "delete" });
    await h.tools.fixLine("2026-10-02", line);
    expect(h.asked[0]).toMatchObject({
      title: "Delete this session?",
      body: "10:00 · Focus · 25m · No Task, from the log for 2026-10-02. This can't be undone.",
      destructive: true,
    });
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(FILE);
    h.answers.push(true);
    await h.tools.fixLine("2026-10-02", line);
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(`${V2_LATER}\n`);
    expect(Notice.shown).toEqual(["Gentle pomodoro: session deleted."]);
  });

  it("writes nothing when nothing changed", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    h.formAnswers.push({ action: "save", form: formFor(line) });
    await h.tools.fixLine("2026-10-02", line);
    expect(h.vault.writes).toEqual([]);
    expect(Notice.shown).toEqual(["Gentle pomodoro: nothing changed."]);
  });

  it("opens the dialog on the line's values, with Delete, and checks a move to another day", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    await h.tools.fixLine("2026-10-02", line);
    const options = h.forms[0];
    expect(options.form).toEqual(formFor(line));
    expect(options.canDelete).toBe(true);
    expect(options.check({ ...options.form, date: "2026-10-01" })).toMatch(/another day/);
  });

  it("says so, and opens no dialog, for a line whose start can't be read", async () => {
    const bad = V2_FOCUS.replace("2026-10-02 10:00:00", "today at ten");
    const h = harness({ [LOG("2026-10-02")]: `${bad}\n` });
    await h.tools.fixLine("2026-10-02", pick(h));
    expect(h.forms).toEqual([]);
    expect(h.vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: that line's start time can't be read. Fix it in the file itself.",
    ]);
  });

  it("refuses when the day's log is gone since the line was picked", async () => {
    const h = harness({ [LOG("2026-10-02")]: FILE });
    const line = pick(h);
    await h.tools.fixLine("2026-10-03", line);
    expect(h.forms).toEqual([]);
    expect(Notice.shown).toEqual([LINE_CHANGED_NOTICE]);
  });

  describe("the command", () => {
    beforeEach(() => {
      Modal.opened = null;
    });

    /** The day list fixSession opened: its date box and the list under it. */
    const opened = () => {
      const modal = Modal.opened;
      if (!modal) throw new Error("no list opened");
      const list = modal.contentEl.children[0];
      return { modal, dateBox: modal.contentEl.settings[0].components[0], list };
    };

    it("opens on today's log, lists its sessions, and edits the one picked", async () => {
      const h = harness({ [LOG("2026-10-02")]: FILE, [LOG("2026-10-01")]: `${V1_FOCUS}\n` });
      h.tools.fixSession();
      const { dateBox, list } = opened();
      expect(dateBox.value).toBe("2026-10-02");
      await vi.waitFor(() => {
        expect(list.settings.map((row) => row.name)).toEqual([
          "10:00 · Focus · 25m · No Task",
          "12:00 · Focus · 25m · No Task",
        ]);
      });
      list.settings[1].components[0].click?.();
      await vi.waitFor(() => {
        expect(h.forms).toHaveLength(1);
      });
      expect(h.forms[0].title).toBe("Fix a logged session");
      expect(h.forms[0].form).toEqual(formFor(loggedLines(FILE)[1]));
    });

    it("opens on today as 'Day starts at' counts days", async () => {
      vi.setSystemTime(new Date(2026, 9, 3, 2, 30));
      try {
        const h = harness({ [LOG("2026-10-02")]: FILE }, { dayStartHour: 4 });
        h.tools.fixSession();
        expect(opened().dateBox.value).toBe("2026-10-02");
      } finally {
        vi.setSystemTime(NOW);
      }
    });

    it("asks for a log folder first", () => {
      const h = harness({ [LOG("2026-10-02")]: FILE }, { logFolderPath: "" });
      h.tools.fixSession();
      expect(Modal.opened).toBeNull();
      expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE]);
    });
  });
});

describe("the tasks the session dialog offers", () => {
  const NOTES = {
    "Inbox/Today.md": [
      "- [ ] Water the ferns #task/other/garden 🆔 f3rn01",
      "- [ ] Call the plumber #task/other/home ⏳ 2026-10-02",
      "- [x] Sweep the porch #task/other/home ⏳ 2026-10-02",
    ].join("\n"),
    "Projects/Garden.md": [
      "- [ ] Plant the tulips #task/other/garden ⏳ 2026-10-12 🆔 t9k2xq",
      "- [ ] Turn the compost #task/other/garden",
      "- [ ] Prune the roses #task/other/garden ⏳ 2026-10-30",
    ].join("\n"),
  };

  it("lists what the picker lists in a note scope, undated tasks included, by the timer's name", async () => {
    const h = harness(NOTES, { taskSource: "current-note", tasksPath: "Projects" });
    h.active = "Inbox/Today.md";
    expect(await h.tools.taskChoices()).toEqual([
      {
        task: { name: "Call the plumber #task/other/home", path: "Inbox/Today.md", id: undefined },
        label: "Call the plumber",
      },
      {
        // The name keeps its tag: the reviews take a session's area from it.
        task: { name: "Water the ferns #task/other/garden", path: "Inbox/Today.md", id: "f3rn01" },
        label: "Water the ferns",
      },
    ]);
  });

  it("reads the open notes too", async () => {
    const h = harness(NOTES, { taskSource: "open-notes", tasksPath: "Projects" });
    h.tabs = ["Inbox/Today.md"];
    const choices = await h.tools.taskChoices();
    expect(choices.map((c) => c.task.path)).toEqual(["Inbox/Today.md", "Inbox/Today.md"]);
  });

  it("keeps to the folder and the lookahead window in the folder scope, and leaves undated tasks out", async () => {
    const h = harness(NOTES, { taskSource: "folder", tasksPath: "Projects", taskSelectorDays: 14 });
    h.active = "Inbox/Today.md";
    expect(await h.tools.taskChoices()).toEqual([
      {
        task: {
          name: "Plant the tulips #task/other/garden",
          path: "Projects/Garden.md",
          id: "t9k2xq",
        },
        label: "Plant the tulips",
      },
    ]);
  });
});

describe("a log file's properties (goal_minutes)", () => {
  // The day's goal, recorded at the top of its file by the timer
  // (logFrontmatter.ts). The commands read past it and keep it as it is.
  const HEAD = "---\ngoal_minutes: 90\ntags: [log]\n---\n";

  it("Convert rewrites the old lines and keeps the properties byte for byte", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${HEAD}${V1_FOCUS}\n${V1_REST}\n` });
    h.answers.push(true);
    await h.tools.convert();
    expect(h.asked[0]?.ctaText).toBe("Convert 2 line(s)");
    const content = h.vault.contents[LOG("2026-10-01")];
    expect(content.startsWith(HEAD)).toBe(true);
    expect(content.slice(HEAD.length)).toMatch(/^- 🍅 Focus \[Task:: /u);
  });

  it("Add a session leaves a past day's properties as they are", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${HEAD}${V2_FOCUS.replace(/10-02/g, "10-01")}\n` });
    h.formAnswers.push({
      action: "save",
      form: {
        kind: "focus",
        task: null,
        date: "2026-10-01",
        time: "08:00",
        minutes: "30",
        status: "finished",
      },
    });
    await h.tools.addSession();
    const content = h.vault.contents[LOG("2026-10-01")];
    expect(
      content.startsWith(`${HEAD}- 🍅 Focus [Task:: No Task] [Start:: 2026-10-01 08:00:00]`)
    ).toBe(true);
  });

  it("Fix a session lists and rewrites only the body's lines", async () => {
    const h = harness({ [LOG("2026-10-02")]: `${HEAD}${V2_FOCUS}\n` });
    const day = await h.tools.sessionsOn("2026-10-02");
    expect(day?.lines.map((l) => l.text)).toEqual([V2_FOCUS]);
    if (!day) return;
    expect(await h.tools.rewriteSessionLine(day.file, day.lines[0], null)).toBe("done");
    expect(h.vault.contents[LOG("2026-10-02")]).toBe(HEAD);
  });
});

describe("the plugin's wiring", () => {
  // main.ts and the view cannot be imported by a test (vitest would load the
  // built main.js, and the view needs a DOM), so the lines that matter are
  // read as text, comments stripped and whitespace collapsed.
  const read = (name: string) =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");
  const main = read("main.ts");
  const view = read("GentlePomoView.ts");

  it.each([
    ["open-todays-log", "Open today's log", "await this.openTodayLog();"],
    ["check-log", "Check log", "await this.checkLog();"],
    ["convert-old-log-lines", "Convert old log lines", "await this.convertLog();"],
    ["add-session", "Add a session", "await this.addSession();"],
    ["fix-logged-session", "Fix a logged session", "this.fixSession();"],
    [
      "refresh-logs-by-task-id",
      "Refresh log task names by ID",
      "await this.refreshLogTaskNames();",
    ],
  ])("registers %s", (id, name, call) => {
    const at = main.indexOf(`id: "${id}", name: "${name}",`);
    expect(at, id).toBeGreaterThan(-1);
    const command = main.slice(at, main.indexOf("this.addCommand(", at));
    expect(command).toContain(call);
  });

  it("sends each command to the log tools", () => {
    for (const line of [
      "openTodayLog(): Promise<void> { return this.logTools.openToday(); }",
      "checkLog(): Promise<void> { return this.logTools.check(); }",
      "convertLog(): Promise<void> { return this.logTools.convert(); }",
      "refreshLogTaskNames(): Promise<void> { return this.logManager.refreshLoggedTaskNamesById(); }",
      "addSession(): Promise<void> { return this.logTools.addSession(); }",
      "fixSession(): void { this.logTools.fixSession(); }",
    ]) {
      expect(main).toContain(line);
    }
    // Asks with the real dialog, and repaints today's total after a write.
    expect(main).toContain("confirm: (options) => confirmAction(this.app, options),");
    expect(main).toContain("logChanged: () => { this.logFolderChanged(); },");
  });

  it("opens today's log from the status bar's menu", () => {
    const run = main.slice(main.indexOf("private async runStatusMenuAction("));
    expect(run).toContain('case "log": await this.openTodayLog(); return;');
  });

  it("makes the panel's goal line a button that opens today's log, by click and by key", () => {
    expect(view).toContain(
      'this.goalProgressEl = container.createDiv({ cls: "gp-goal-progress", attr: { role: "button", tabindex: "0", title: "Open today\'s log" }, });'
    );
    expect(view).toContain(
      'this.registerDomEvent(this.goalProgressEl, "click", () => { void this.plugin.openTodayLog(); });'
    );
    expect(view).toContain(
      'this.registerDomEvent(this.goalProgressEl, "keydown", (evt: KeyboardEvent) => { if (evt.key !== "Enter" && evt.key !== " ") return; evt.preventDefault(); void this.plugin.openTodayLog(); });'
    );
  });
});
