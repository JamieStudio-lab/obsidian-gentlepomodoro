import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { TFile, TFolder, type App } from "obsidian";
// The recording stubs, by path so `tsc` sees `shown` and `opened` (see tests/settingTab.test.ts).
import { Modal, Notice, type RecordedComponent } from "../__mocks__/obsidian";
import { createLogApi, type DayLog } from "../logApi";
import {
  CSV_COLUMNS,
  EXPORT_BUSY_NOTICE,
  EXPORT_DEFAULT_FOLDER,
  EXPORT_FAILED_NOTICE,
  EXPORT_FOLDER_HIDDEN,
  EXPORT_FOLDER_NOTE,
  EXPORT_FOLDER_TOP_LEVEL,
  EXPORT_NAME_TRIES,
  EXPORTING_NOTICE,
  NO_LOG_FILES_YET,
  checkExportDates,
  checkExportFolder,
  EXPORT_FOLDER_CHARACTERS,
  checkExportForm,
  csvText,
  exportChunks,
  exportFileName,
  exportFolderSetting,
  exportRangeDates,
  exportRecords,
  exportedMessage,
  jsonLinesText,
  logFileDates,
  noSessionsMessage,
  resolveExportFormat,
  type ExportForm,
  type ExportRecord,
} from "../logExport";
import { logFolderProblemNotice } from "../logFolder";
import { resolveLogLink } from "../logManager";
import { LogTools, NO_LOG_FOLDER_NOTICE } from "../logTools";
import type { MomentLike } from "../momentTypes";
import { askExportForm, type ExportFormOptions } from "../sessionModals";
import { DEFAULT_SETTINGS } from "../constants";
import type { GentlePomoSettings } from "../types";
import { fakeVault, linkCache, type FakeVault } from "./fakeVault";

/**
 * Export sessions (0.7.0): the log's sessions as a new CSV or JSON Lines
 * file, read through the read API and never written back. The pure rules
 * (logExport.ts), the flow on a vault whose modify and process reject
 * (LogTools.exportSessions), and the dialog on the recording mock. Lines are
 * made up; none is copied from a real log.
 */

// The real moment, its Arabic locale loaded into the same instance (a locale
// file requires "../moment", so both go through require): a file name's time
// must be written 0-9 whatever the app language.
const require = createRequire(import.meta.url);
const realMoment = require("moment") as ((input?: unknown) => MomentLike) & {
  locale(key?: string): string;
};
require("moment/locale/ar");
realMoment.locale("en");

// Friday 23 October 2026, 15:30:12: the last 30 days are 24 September to today.
const NOW = new Date(2026, 9, 23, 15, 30, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  (globalThis as unknown as { moment: unknown }).moment = realMoment;
  Notice.shown.length = 0;
  Notice.hidden.length = 0;
  Modal.opened = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  realMoment.locale("en");
  delete (globalThis as unknown as { moment?: unknown }).moment;
});

const LOG = (date: string) => `Logs/${date}-gentle-pomodoro-log.md`;

// A 0.7.0 day: a focus, its break, a focus slept through and stopped late on
// another device, a skip; then a 0.6.9 line, which has no tail.
const FOCUS =
  "- 🍅 Focus [Task:: [[Projects/Writing.md|Draft intro #task/research/paper]]] [ID:: abc123] [Start:: 2026-10-23 09:00:00] [End:: 2026-10-23 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0] [Session:: s7k2m9qx4a] [StartedBy:: start] [EndedBy:: time-up] [Planned:: 1500] [Cycle:: 2] [Offset:: -300]";
const REST =
  "- ☕ Rest [Start:: 2026-10-23 09:25:00] [End:: 2026-10-23 09:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break] [Session:: s3n8d1wa5b] [StartedBy:: auto] [EndedBy:: time-up] [Planned:: 300] [Offset:: -300]";
const SLEPT =
  '- 🍅 Focus [Task:: No Task] [Start:: 2026-10-23 13:00:00] [End:: 2026-10-23 14:10:00] [Scheduled:: 1500] [Pauses:: ["2026-10-23 13:10:00 - 2026-10-23 13:50:00"]] [Total:: 1800] [Status:: finished] [Type:: focus] [Overtime:: 300] [Session:: s0p4r8tz6c] [StartedBy:: auto] [EndedBy:: stop] [Planned:: 1500] [Cycle:: 3] [Offset:: 480] [Slept:: 2400] [Device:: Work laptop]';
const SKIPPED =
  "- 🍅 Focus [Task:: [[Projects/Admin.md|Inbox]]] [Start:: 2026-10-23 15:00:00] [End:: 2026-10-23 15:03:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 180] [Status:: cancelled] [Type:: focus] [Overtime:: 0] [Session:: sb1c5e9h7d] [StartedBy:: start] [EndedBy:: skip] [Planned:: 1500] [Offset:: 60]";
const V069 =
  "- 🍅 Focus [Task:: [[Projects/Writing.md|Draft intro #task/research/paper]]] [ID:: abc123] [Start:: 2026-10-23 16:00:00] [End:: 2026-10-23 16:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
// Older days: a line Convert made from a pre-0.6.9 one (no Overtime), a
// version 1 line never converted, and a 0.7.0 line across a clock change.
const CONVERTED =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-20 10:00:00] [End:: 2026-10-20 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus]";
const V1 =
  "- ☕ Rest | Start:: 2026-10-20 10:25:00 | End:: 2026-10-20 10:30:00 | Scheduled:: 300 | Total:: 300";
const CHANGED =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-21 01:30:00] [End:: 2026-10-21 01:55:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0] [Session:: s9q8r7t6v5] [StartedBy:: start] [EndedBy:: time-up] [Planned:: 1500] [Cycle:: 1] [Offset:: -240] [OffsetChange:: -60]";

const FILES = (): Record<string, string> => ({
  "Projects/Writing.md": "- [ ] Draft intro #task/research/paper 🆔 abc123\n",
  "Projects/Admin.md": "- [ ] Inbox\n",
  [LOG("2026-10-20")]: `${CONVERTED}\n${V1}\n`,
  [LOG("2026-10-21")]: `${CHANGED}\n`,
  [LOG("2026-10-23")]:
    `---\ngoal_minutes: 120\n---\n${FOCUS}\n${REST}\n${SLEPT}\n${SKIPPED}\n${V069}\n`,
  // Not a daily log: never read.
  "Logs/Index.md": `${FOCUS}\n`,
});

/** The read API over a fake vault, as main.ts builds it. */
function readApi(vault: FakeVault, settings: () => GentlePomoSettings) {
  const app = { vault, metadataCache: linkCache(vault) } as unknown as App;
  return createLogApi({
    settings,
    read: async (path) => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? vault.cachedRead(file) : null;
    },
    resolveLink: (linktext, sourcePath) => resolveLogLink(app, linktext, sourcePath),
    moment: (ms) => realMoment(ms),
    now: () => Date.now(),
  });
}

/** The days the API gives, for the pure tests. */
async function days(from: string, to: string, files = FILES()): Promise<DayLog[]> {
  const vault = fakeVault(files);
  const settings = { ...DEFAULT_SETTINGS, logFolderPath: "Logs" };
  return readApi(vault, () => settings).getDays(from, to);
}

const LOG_23 = LOG("2026-10-23");

/** What each line exports as, member by member. */
const RECORDS: ExportRecord[] = [
  {
    date: "2026-10-20",
    kind: "focus",
    type: "focus",
    start: "2026-10-20 10:00:00",
    end: "2026-10-20 10:25:00",
    startIso: null,
    endIso: null,
    task: { name: "No Task", path: null },
    id: null,
    scheduled: 1500,
    planned: null,
    total: 1500,
    // Converted from before 0.6.9: never known.
    overtime: null,
    pauses: [],
    status: "finished",
    sessionId: null,
    startedBy: null,
    endedBy: null,
    cycle: null,
    offset: null,
    endOffset: null,
    slept: null,
    dropped: null,
    device: null,
    logFile: LOG("2026-10-20"),
  },
  {
    date: "2026-10-20",
    kind: "rest",
    // The oldest lines have no Type.
    type: null,
    start: "2026-10-20 10:25:00",
    end: "2026-10-20 10:30:00",
    startIso: null,
    endIso: null,
    task: null,
    id: null,
    scheduled: 300,
    planned: null,
    total: 300,
    overtime: null,
    pauses: [],
    status: null,
    sessionId: null,
    startedBy: null,
    endedBy: null,
    cycle: null,
    offset: null,
    endOffset: null,
    slept: null,
    dropped: null,
    device: null,
    logFile: LOG("2026-10-20"),
  },
  {
    date: "2026-10-21",
    kind: "focus",
    type: "focus",
    start: "2026-10-21 01:30:00",
    end: "2026-10-21 01:55:00",
    // The clocks moved an hour back during it.
    startIso: "2026-10-21T01:30:00-04:00",
    endIso: "2026-10-21T01:55:00-05:00",
    task: { name: "No Task", path: null },
    id: null,
    scheduled: 1500,
    planned: 1500,
    total: 1500,
    overtime: 0,
    pauses: [],
    status: "finished",
    sessionId: "s9q8r7t6v5",
    startedBy: "start",
    endedBy: "time-up",
    cycle: 1,
    offset: -240,
    endOffset: -300,
    slept: 0,
    dropped: 0,
    device: null,
    logFile: LOG("2026-10-21"),
  },
  {
    date: "2026-10-23",
    kind: "focus",
    type: "focus",
    start: "2026-10-23 09:00:00",
    end: "2026-10-23 09:25:00",
    startIso: "2026-10-23T09:00:00-05:00",
    endIso: "2026-10-23T09:25:00-05:00",
    task: { name: "Draft intro #task/research/paper", path: "Projects/Writing.md" },
    id: "abc123",
    scheduled: 1500,
    planned: 1500,
    total: 1500,
    overtime: 0,
    pauses: [],
    status: "finished",
    sessionId: "s7k2m9qx4a",
    startedBy: "start",
    endedBy: "time-up",
    cycle: 2,
    offset: -300,
    endOffset: -300,
    slept: 0,
    dropped: 0,
    device: null,
    logFile: LOG_23,
  },
  {
    date: "2026-10-23",
    kind: "rest",
    type: "short-break",
    start: "2026-10-23 09:25:00",
    end: "2026-10-23 09:30:00",
    startIso: "2026-10-23T09:25:00-05:00",
    endIso: "2026-10-23T09:30:00-05:00",
    task: null,
    id: null,
    scheduled: 300,
    planned: 300,
    total: 300,
    overtime: null,
    pauses: [],
    status: null,
    sessionId: "s3n8d1wa5b",
    startedBy: "auto",
    endedBy: "time-up",
    cycle: null,
    offset: -300,
    endOffset: -300,
    slept: 0,
    dropped: 0,
    device: null,
    logFile: LOG_23,
  },
  {
    date: "2026-10-23",
    kind: "focus",
    type: "focus",
    start: "2026-10-23 13:00:00",
    end: "2026-10-23 14:10:00",
    startIso: "2026-10-23T13:00:00+08:00",
    endIso: "2026-10-23T14:10:00+08:00",
    task: { name: "No Task", path: null },
    id: null,
    scheduled: 1500,
    planned: 1500,
    total: 1800,
    overtime: 300,
    pauses: [{ start: "2026-10-23 13:10:00", end: "2026-10-23 13:50:00" }],
    status: "finished",
    sessionId: "s0p4r8tz6c",
    startedBy: "auto",
    endedBy: "stop",
    cycle: 3,
    offset: 480,
    endOffset: 480,
    slept: 2400,
    dropped: 0,
    device: "Work laptop",
    logFile: LOG_23,
  },
  {
    date: "2026-10-23",
    kind: "focus",
    type: "focus",
    start: "2026-10-23 15:00:00",
    end: "2026-10-23 15:03:00",
    startIso: "2026-10-23T15:00:00+01:00",
    endIso: "2026-10-23T15:03:00+01:00",
    task: { name: "Inbox", path: "Projects/Admin.md" },
    id: null,
    scheduled: 1500,
    planned: 1500,
    total: 180,
    overtime: 0,
    pauses: [],
    status: "cancelled",
    sessionId: "sb1c5e9h7d",
    startedBy: "start",
    endedBy: "skip",
    cycle: null,
    offset: 60,
    endOffset: 60,
    slept: 0,
    dropped: 0,
    device: null,
    logFile: LOG_23,
  },
  {
    date: "2026-10-23",
    kind: "focus",
    type: "focus",
    start: "2026-10-23 16:00:00",
    end: "2026-10-23 16:25:00",
    // 0.6.9: no Session, so every tail member is unknown — slept and dropped
    // too, which are 0 only beside a Session.
    startIso: null,
    endIso: null,
    task: { name: "Draft intro #task/research/paper", path: "Projects/Writing.md" },
    id: "abc123",
    scheduled: 1500,
    planned: null,
    total: 1500,
    overtime: 0,
    pauses: [],
    status: "finished",
    sessionId: null,
    startedBy: null,
    endedBy: null,
    cycle: null,
    offset: null,
    endOffset: null,
    slept: null,
    dropped: null,
    device: null,
    logFile: LOG_23,
  },
];

/* ===== The pure rules ===== */

describe("the dialog's stored choices", () => {
  it("reads the format through an id list, CSV otherwise", () => {
    expect(resolveExportFormat("jsonl")).toBe("jsonl");
    expect(resolveExportFormat("csv")).toBe("csv");
    for (const odd of ["JSONL", "toString", "", null, 3])
      expect(resolveExportFormat(odd)).toBe("csv");
  });

  it("opens on the folder last exported to, else Pomodoro exports", () => {
    expect(EXPORT_DEFAULT_FOLDER).toBe("Pomodoro exports");
    expect(DEFAULT_SETTINGS.exportFolder).toBe("");
    expect(DEFAULT_SETTINGS.exportFormat).toBe("csv");
    expect(exportFolderSetting("")).toBe("Pomodoro exports");
    expect(exportFolderSetting("  ")).toBe("Pomodoro exports");
    expect(exportFolderSetting(7)).toBe("Pomodoro exports");
    expect(exportFolderSetting("Reports/Focus")).toBe("Reports/Focus");
  });
});

describe("the days", () => {
  it("finds the first and last day with a log file, in any script's digits", () => {
    expect(
      logFileDates([
        "Logs/2026-10-02-gentle-pomodoro-log.md",
        "Logs/٢٠٢٥-٠٣-٠١-gentle-pomodoro-log.md",
        "Logs/Archive/2026-11-30-gentle-pomodoro-log.md",
        "Logs/2026-13-40-gentle-pomodoro-log.md",
        "Logs/2020-01-01-notes.md",
      ])
    ).toEqual({ earliest: "2025-03-01", latest: "2026-11-30" });
    expect(logFileDates([])).toBeNull();
    expect(logFileDates(["Logs/Index.md"])).toBeNull();
  });

  it("gives each Days choice its dates, today included", () => {
    const span = { earliest: "2025-02-14", latest: "2026-10-20" };
    const at = (range: Parameters<typeof exportRangeDates>[0], today = "2026-10-23") =>
      exportRangeDates(range, today, span);
    expect(at("7")).toEqual({ from: "2026-10-17", to: "2026-10-23" });
    expect(at("30")).toEqual({ from: "2026-09-24", to: "2026-10-23" });
    expect(at("this-month")).toEqual({ from: "2026-10-01", to: "2026-10-23" });
    expect(at("last-month")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(at("this-year")).toEqual({ from: "2026-01-01", to: "2026-10-23" });
    expect(at("all")).toEqual({ from: "2025-02-14", to: "2026-10-23" });
    expect(at("custom")).toBeNull();
    // Across a year, and a leap February.
    expect(at("last-month", "2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(at("last-month", "2028-03-31")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(at("7", "2027-01-03")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });

  it("ends Everything at a log file dated after today, and has none without a file", () => {
    // A device in a zone ahead has written tomorrow's file already.
    expect(
      exportRangeDates("all", "2026-10-23", { earliest: "2026-01-01", latest: "2026-10-24" })
    ).toEqual({ from: "2026-01-01", to: "2026-10-24" });
    expect(exportRangeDates("all", "2026-10-23", null)).toBeNull();
    expect(exportRangeDates("30", "2026-10-23", null)).toEqual({
      from: "2026-09-24",
      to: "2026-10-23",
    });
  });

  it("reads any range in runs the read API takes, each day once", () => {
    expect(exportChunks("2026-10-23", "2026-10-23")).toEqual([
      { from: "2026-10-23", to: "2026-10-23" },
    ]);
    // 400 days is one call; 401 is two.
    expect(exportChunks("2025-09-19", "2026-10-23")).toEqual([
      { from: "2025-09-19", to: "2026-10-23" },
    ]);
    expect(exportChunks("2025-09-18", "2026-10-23")).toEqual([
      { from: "2025-09-18", to: "2026-10-22" },
      { from: "2026-10-23", to: "2026-10-23" },
    ]);
    const chunks = exportChunks("2020-01-01", "2026-10-23");
    expect(chunks[0].from).toBe("2020-01-01");
    expect(chunks[chunks.length - 1].to).toBe("2026-10-23");
    expect(chunks).toHaveLength(7);
    expect(exportChunks("soon", "2026-10-23")).toEqual([]);
  });

  it("takes only real dates, From on or before To", () => {
    expect(checkExportDates("2026-09-24", "2026-10-23")).toBeNull();
    expect(checkExportDates(" 2026-10-23 ", "2026-10-23 ")).toBeNull();
    expect(checkExportDates("2026-02-30", "2026-10-23")).toMatch(/^From must be a date/);
    expect(checkExportDates("2026-9-24", "2026-10-23")).toMatch(/^From must be a date/);
    expect(checkExportDates("2026-09-24", "")).toMatch(/^To must be a date/);
    expect(checkExportDates("2026-10-24", "2026-10-23")).toBe("From must be on or before To.");
    // 0-9 only: a date typed in another script's digits would name the file in them.
    expect(checkExportDates("٢٠٢٦-١٠-٠١", "2026-10-23")).toMatch(/^From must be a date/);
    expect(checkExportDates("2026-10-01", "２０２６-１０-２３")).toMatch(/^To must be a date/);
  });
});

describe("the folder", () => {
  const vault = fakeVault({ "Reports/Focus/old.csv": "", "Notes/todo.md": "" }, [
    "Pomodoro Exports",
    "Reports/Focus",
  ]);
  const check = (input: string) => checkExportFolder(input, vault, ".obsidian");

  it("is trimmed and normalised, and created when missing", () => {
    expect(check("  New exports/2026/ ")).toEqual({ kind: "ok", path: "New exports/2026" });
    expect(check("Reports//Focus/")).toEqual({ kind: "ok", path: "Reports/Focus" });
  });

  it("is an existing folder in the vault's own capitals", () => {
    expect(check("pomodoro exports")).toEqual({ kind: "ok", path: "Pomodoro Exports" });
    // As far as it exists; the rest as typed, to be created.
    expect(check("reports/focus/Weekly")).toEqual({ kind: "ok", path: "Reports/Focus/Weekly" });
    expect(check("REPORTS/new")).toEqual({ kind: "ok", path: "Reports/new" });
    // The vault's tree is walked, never listed.
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("takes the exact name first, where the disk tells capitals apart", () => {
    const both = fakeVault({}, ["Exports", "exports"]);
    expect(checkExportFolder("exports", both)).toEqual({ kind: "ok", path: "exports" });
    expect(checkExportFolder("Exports", both)).toEqual({ kind: "ok", path: "Exports" });
    expect(checkExportFolder("EXPORTS", both)).toEqual({ kind: "ok", path: "Exports" });
  });

  it("refuses a new folder whose name Obsidian would refuse to create, on any device", () => {
    for (const input of [
      "Reviews: Q4",
      "Q4?",
      "a<b",
      "a>b",
      "x|y",
      'say "hi"',
      "stars*",
      "Exports.",
      "Exports /2026",
      "Reports/Focus/Week: 1",
      // Every folder to be made is judged, not only the first.
      "New exports/Week: 1",
      "New exports/2026/Q4?",
    ]) {
      expect(check(input), input).toEqual({ kind: "problem", message: EXPORT_FOLDER_CHARACTERS });
    }
    // A backslash is a slash to normalizePath, so it makes two folders.
    expect(check("Reports\\Weekly")).toEqual({ kind: "ok", path: "Reports/Weekly" });
  });

  it("takes a folder that exists whatever its name, as it is never made again", () => {
    const odd = fakeVault({}, ["Q4? review", "Q4? review/Done."]);
    expect(checkExportFolder("q4? review", odd)).toEqual({ kind: "ok", path: "Q4? review" });
    expect(checkExportFolder("Q4? review/done.", odd)).toEqual({
      kind: "ok",
      path: "Q4? review/Done.",
    });
    // A new folder inside one is still judged.
    expect(checkExportFolder("Q4? review/a:b", odd)).toEqual({
      kind: "problem",
      message: EXPORT_FOLDER_CHARACTERS,
    });
  });

  it("refuses the vault's top level", () => {
    for (const input of ["", "  ", "/", "//"]) {
      expect(check(input)).toEqual({ kind: "problem", message: EXPORT_FOLDER_TOP_LEVEL });
    }
  });

  it("refuses a hidden folder, the config folder among them", () => {
    for (const input of [".obsidian", ".obsidian/plugins", "Notes/.trash", ".exports", "a/../b"]) {
      expect(check(input), input).toEqual({ kind: "problem", message: EXPORT_FOLDER_HIDDEN });
    }
    // A config folder named without a dot is refused by its name.
    expect(checkExportFolder("Config/exports", vault, "Config")).toEqual({
      kind: "problem",
      message: EXPORT_FOLDER_HIDDEN,
    });
    expect(checkExportFolder("Configs", vault, "Config")).toEqual({ kind: "ok", path: "Configs" });
  });

  it("refuses a path a file is in the way of", () => {
    expect(check("Notes/todo.md")).toEqual({
      kind: "problem",
      message: '"Notes/todo.md" is a file. Pick a folder.',
    });
    expect(check("reports/focus/OLD.CSV/x")).toEqual({
      kind: "problem",
      message: '"Reports/Focus/old.csv" is a file. Pick a folder.',
    });
  });

  it("is checked with the dates when Export is pressed", () => {
    const form: ExportForm = {
      range: "30",
      from: "2026-09-24",
      to: "2026-10-23",
      kinds: "all",
      format: "csv",
      folder: "Pomodoro exports",
    };
    const span = { earliest: "2026-01-01", latest: "2026-10-23" };
    expect(checkExportForm(form, span, vault, ".obsidian")).toBeNull();
    expect(checkExportForm({ ...form, to: "x" }, span, vault)).toMatch(/^To must be a date/);
    expect(checkExportForm({ ...form, folder: "/" }, span, vault)).toBe(EXPORT_FOLDER_TOP_LEVEL);
    expect(checkExportForm({ ...form, range: "all" }, null, vault)).toBe(NO_LOG_FILES_YET);
    expect(checkExportForm({ ...form, range: "all" }, span, vault)).toBeNull();
  });
});

describe("the records", () => {
  it("are the read API's sessions as they are, with the day, the times with their offset, and the file", async () => {
    expect(exportRecords(await days("2026-10-19", "2026-10-23"), "all")).toEqual(RECORDS);
  });

  it("keep their members in one order, whatever the API's object holds", async () => {
    const keys = Object.keys(exportRecords(await days("2026-10-23", "2026-10-23"), "all")[0]);
    expect(keys).toEqual([
      "date",
      "kind",
      "type",
      "start",
      "end",
      "startIso",
      "endIso",
      "task",
      "id",
      "scheduled",
      "planned",
      "total",
      "overtime",
      "pauses",
      "status",
      "sessionId",
      "startedBy",
      "endedBy",
      "cycle",
      "offset",
      "endOffset",
      "slept",
      "dropped",
      "device",
      "logFile",
    ]);
  });

  it("are dated by the log day, not by Start's calendar date", async () => {
    // With "Day starts at" 4:00, a break started at 01:30 is the day before's.
    const late =
      "- ☕ Rest [Start:: 2026-10-24 01:30:00] [End:: 2026-10-24 01:35:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]";
    const vault = fakeVault({ [LOG_23]: `${late}\n` });
    const settings = { ...DEFAULT_SETTINGS, logFolderPath: "Logs", dayStartHour: 4 };
    const records = exportRecords(
      await readApi(vault, () => settings).getDays("2026-10-23", "2026-10-24"),
      "all"
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      date: "2026-10-23",
      start: "2026-10-24 01:30:00",
      logFile: LOG_23,
    });
    expect(csvText(records).split("\r\n")[1].split(",")[0]).toBe("2026-10-23");
  });

  it("leave the breaks out for Focus only", async () => {
    const focus = exportRecords(await days("2026-10-19", "2026-10-23"), "focus");
    expect(focus).toEqual(RECORDS.filter((r) => r.kind === "focus"));
    expect(focus).toHaveLength(6);
  });

  it("give no ISO time for an offset no zone has, or a time written in other digits", () => {
    const day = (offset: number, start = "2026-10-23 09:00:00"): DayLog => ({
      date: "2026-10-23",
      path: LOG_23,
      goalMinutes: null,
      focusSeconds: 0,
      sessions: [
        {
          ...{ kind: "rest", type: null, task: null, id: null, start, end: start },
          ...{ scheduled: null, total: null, overtime: null, pauses: [], status: null },
          ...{ sessionId: "s1", startedBy: null, endedBy: null, planned: null, cycle: null },
          ...{ offset, endOffset: offset, slept: 0, dropped: 0, device: null },
        },
      ],
    });
    expect(exportRecords([day(330)], "all")[0].startIso).toBe("2026-10-23T09:00:00+05:30");
    expect(exportRecords([day(0)], "all")[0].startIso).toBe("2026-10-23T09:00:00+00:00");
    expect(exportRecords([day(-570)], "all")[0].startIso).toBe("2026-10-23T09:00:00-09:30");
    expect(exportRecords([day(1080)], "all")[0].startIso).toBe("2026-10-23T09:00:00+18:00");
    expect(exportRecords([day(1081)], "all")[0].startIso).toBeNull();
    expect(exportRecords([day(60, "٢٠٢٦-١٠-٢٣ ٠٩:٠٠:٠٠")], "all")[0].startIso).toBeNull();
    expect(exportRecords([day(60, "2026-02-30 09:00:00")], "all")[0].startIso).toBeNull();
  });
});

/** The CSV rows of RECORDS, as a spreadsheet gets them. */
const CSV_ROWS = [
  "date,kind,type,start,end,startIso,endIso,task,taskPath,id,scheduled,planned,total,overtime,pauseCount,pausedSeconds,status,sessionId,startedBy,endedBy,cycle,offset,endOffset,slept,dropped,device,logFile",
  "2026-10-20,focus,focus,2026-10-20 10:00:00,2026-10-20 10:25:00,,,No Task,,,1500,,1500,,0,0,finished,,,,,,,,,,Logs/2026-10-20-gentle-pomodoro-log.md",
  "2026-10-20,rest,,2026-10-20 10:25:00,2026-10-20 10:30:00,,,,,,300,,300,,,,,,,,,,,,,,Logs/2026-10-20-gentle-pomodoro-log.md",
  "2026-10-21,focus,focus,2026-10-21 01:30:00,2026-10-21 01:55:00,2026-10-21T01:30:00-04:00,2026-10-21T01:55:00-05:00,No Task,,,1500,1500,1500,0,0,0,finished,s9q8r7t6v5,start,time-up,1,-240,-300,0,0,,Logs/2026-10-21-gentle-pomodoro-log.md",
  "2026-10-23,focus,focus,2026-10-23 09:00:00,2026-10-23 09:25:00,2026-10-23T09:00:00-05:00,2026-10-23T09:25:00-05:00,Draft intro #task/research/paper,Projects/Writing.md,abc123,1500,1500,1500,0,0,0,finished,s7k2m9qx4a,start,time-up,2,-300,-300,0,0,,Logs/2026-10-23-gentle-pomodoro-log.md",
  "2026-10-23,rest,short-break,2026-10-23 09:25:00,2026-10-23 09:30:00,2026-10-23T09:25:00-05:00,2026-10-23T09:30:00-05:00,,,,300,300,300,,,,,s3n8d1wa5b,auto,time-up,,-300,-300,0,0,,Logs/2026-10-23-gentle-pomodoro-log.md",
  "2026-10-23,focus,focus,2026-10-23 13:00:00,2026-10-23 14:10:00,2026-10-23T13:00:00+08:00,2026-10-23T14:10:00+08:00,No Task,,,1500,1500,1800,300,1,2400,finished,s0p4r8tz6c,auto,stop,3,480,480,2400,0,Work laptop,Logs/2026-10-23-gentle-pomodoro-log.md",
  "2026-10-23,focus,focus,2026-10-23 15:00:00,2026-10-23 15:03:00,2026-10-23T15:00:00+01:00,2026-10-23T15:03:00+01:00,Inbox,Projects/Admin.md,,1500,1500,180,0,0,0,cancelled,sb1c5e9h7d,start,skip,,60,60,0,0,,Logs/2026-10-23-gentle-pomodoro-log.md",
  "2026-10-23,focus,focus,2026-10-23 16:00:00,2026-10-23 16:25:00,,,Draft intro #task/research/paper,Projects/Writing.md,abc123,1500,,1500,0,0,0,finished,,,,,,,,,,Logs/2026-10-23-gentle-pomodoro-log.md",
];

/** One record with only what a test sets, the rest as an old focus line has it. */
function record(set: Partial<ExportRecord>): ExportRecord {
  return { ...RECORDS[0], ...set };
}

describe("the CSV file", () => {
  it("is UTF-8 with a byte order mark, CRLF, a header row, a cell per column", () => {
    const text = csvText(RECORDS);
    expect(text.startsWith("\uFEFFdate,kind,")).toBe(true);
    expect(text).toBe(`\uFEFF${CSV_ROWS.join("\r\n")}\r\n`);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(CSV_COLUMNS.join(",")).toBe(CSV_ROWS[0]);
    // A header alone when there is nothing, though the export never writes one.
    expect(csvText([])).toBe(`\uFEFF${CSV_ROWS[0]}\r\n`);
  });

  it("quotes a cell holding a comma, a quote or a line break, the quotes doubled", () => {
    const cells = (r: ExportRecord) => csvText([r]).split("\r\n")[1];
    expect(cells(record({ task: { name: 'Read "Dune", again', path: null } }))).toContain(
      ',"Read ""Dune"", again",'
    );
    expect(cells(record({ device: "Desk\nhome" }))).toContain(',"Desk\nhome",');
    expect(cells(record({ device: "Desk\rhome" }))).toContain(',"Desk\rhome",');
  });

  it("writes a text a spreadsheet would run as a formula as text", () => {
    const row = (r: ExportRecord) => csvText([r]).split("\r\n")[1].split(",");
    const at = (column: string) => CSV_COLUMNS.indexOf(column as (typeof CSV_COLUMNS)[number]);
    for (const start of ["=", "+", "-", "@", "\t"]) {
      expect(row(record({ device: `${start}cmd` }))[at("device")]).toBe(`'${start}cmd`);
      expect(row(record({ task: { name: `${start}x`, path: null } }))[at("task")]).toBe(
        `'${start}x`
      );
    }
    // Every text cell: a hand-edited line can put anything anywhere.
    expect(row(record({ id: "-A1" }))[at("id")]).toBe("'-A1");
    expect(row(record({ status: "@SUM" }))[at("status")]).toBe("'@SUM");
    expect(row(record({ task: { name: "x", path: "=Ideas/x.md" } }))[at("taskPath")]).toBe(
      "'=Ideas/x.md"
    );
    // A carriage return first is guarded, then quoted.
    expect(csvText([record({ device: "\rcmd" })])).toContain(`,"'\rcmd",`);
    // Guarded, then quoted: the formula's own comma.
    expect(csvText([record({ device: "=SUM(1,2)" })])).toContain(`,"'=SUM(1,2)",`);
    // Not in the middle, and never a number: an offset west of UTC stays one.
    expect(row(record({ device: "a=b" }))[at("device")]).toBe("a=b");
    expect(row(record({ offset: -300, endOffset: -360 }))[at("offset")]).toBe("-300");
    expect(row(record({ offset: -300, endOffset: -360 }))[at("endOffset")]).toBe("-360");
  });

  it("counts and adds up a focus line's pauses on its own wall clock", () => {
    const row = (r: ExportRecord) => csvText([r]).split("\r\n")[1].split(",");
    const count = CSV_COLUMNS.indexOf("pauseCount");
    const paused = CSV_COLUMNS.indexOf("pausedSeconds");
    const pauses = [
      { start: "2026-10-23 13:10:00", end: "2026-10-23 13:50:00" },
      // Across midnight, and in another script's digits.
      { start: "2026-10-23 23:59:30", end: "٢٠٢٦-١٠-٢٤ ٠٠:٠٠:١٥" },
    ];
    expect(row(record({ pauses }))[count]).toBe("2");
    expect(row(record({ pauses }))[paused]).toBe("2445");
    // Unreadable: nothing worked out.
    expect(row(record({ pauses: null }))[count]).toBe("");
    expect(row(record({ pauses: null }))[paused]).toBe("");
    expect(row(record({ pauses: [{ start: "soon", end: "later" }] }))[paused]).toBe("");
    // Focus only: a break has no pauses to count.
    expect(row(record({ kind: "rest", pauses }))[count]).toBe("");
    expect(row(record({ kind: "rest", pauses }))[paused]).toBe("");
  });

  it("adds up pauses the same on a device in any zone", () => {
    // 01:30 to 03:30 is two hours as written, though in Chicago the clocks
    // jumped an hour that night: the exporting device's zone plays no part.
    const saved = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      const pauses = [{ start: "2027-03-14 01:30:00", end: "2027-03-14 03:30:00" }];
      const paused = CSV_COLUMNS.indexOf("pausedSeconds");
      expect(
        csvText([record({ pauses })])
          .split("\r\n")[1]
          .split(",")[paused]
      ).toBe("7200");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("the JSON Lines file", () => {
  it("is one object per line, LF, a final newline, no mark, null for what is missing", () => {
    const text = jsonLinesText(RECORDS);
    expect(text.startsWith("{")).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    const lines = text.slice(0, -1).split("\n");
    expect(lines).toHaveLength(RECORDS.length);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(RECORDS);
    expect(lines[0]).toContain('"overtime":null');
    expect(jsonLinesText([])).toBe("");
  });

  it("writes the Unicode line and paragraph separators escaped", () => {
    const text = jsonLinesText([record({ device: "a\u2028b\u2029c" })]);
    expect(text).toContain("a\\u2028b\\u2029c");
    expect(text).not.toMatch(/[\u2028\u2029]/);
    expect((JSON.parse(text) as ExportRecord).device).toBe("a\u2028b\u2029c");
  });
});

describe("the file name", () => {
  it("names the range and the time, then a number", () => {
    expect(exportFileName("2026-09-24", "2026-10-23", "153012", "csv", 1)).toBe(
      "gentle-pomodoro-sessions-2026-09-24-to-2026-10-23-153012.csv"
    );
    expect(exportFileName("2026-09-24", "2026-10-23", "153012", "jsonl", 2)).toBe(
      "gentle-pomodoro-sessions-2026-09-24-to-2026-10-23-153012 2.jsonl"
    );
    expect(EXPORT_NAME_TRIES).toBe(99);
  });

  it("says what was exported, and where", () => {
    expect(exportedMessage(1, "a.csv")).toMatch(
      /^Gentle pomodoro: exported 1 session to "a.csv"\./
    );
    expect(exportedMessage(412, "a.csv")).toContain("exported 412 sessions");
    expect(exportedMessage(2, "a.csv")).toContain('Turn on "Show all file types"');
    expect(noSessionsMessage("2026-09-24", "2026-10-23", "focus")).toBe(
      "Gentle pomodoro: no focus sessions from 2026-09-24 to 2026-10-23, so nothing was exported."
    );
    expect(noSessionsMessage("2026-09-24", "2026-10-23", "all")).toContain("no sessions from");
  });
});

/* ===== Exporting, on a vault ===== */

interface Harness {
  tools: LogTools;
  vault: FakeVault;
  settings: GentlePomoSettings;
  /** What the disk holds: the vault's files, and any the index has not caught up with. */
  disk: Map<string, string>;
  /** Paths a sync takes the moment before create writes them: create refuses once. */
  race: Set<string>;
  /** How create fails when it does not refuse a taken path. */
  createError: Error | null;
  /** What the disk holds after create wrote `text`: another writer got there. */
  tamper: ((text: string) => string) | null;
  /** Whether reading the disk keeps a byte order mark, as the desktop adapter does. */
  readKeepsBom: boolean;
  created: string[];
  folders: string[];
  reads: [string, string][];
  saves: number;
  dialogs: ExportFormOptions[];
  /** What the dialog answers, from what it was opened with. */
  answer: (options: ExportFormOptions) => ExportForm | null;
}

function harness(files = FILES(), set: Partial<GentlePomoSettings> = {}): Harness {
  const vault = fakeVault(files);
  const h: Harness = {
    tools: null as unknown as LogTools,
    vault,
    settings: { ...DEFAULT_SETTINGS, logFolderPath: "Logs", ...set },
    disk: new Map(Object.entries(files)),
    race: new Set(),
    createError: null,
    tamper: null,
    readKeepsBom: true,
    created: [],
    folders: [],
    reads: [],
    saves: 0,
    dialogs: [],
    answer: (options) => options.form,
  };
  const onDisk = (path: string) =>
    h.disk.has(path) || vault.getAbstractFileByPath(path) instanceof TFolder;
  const app = {
    vault: Object.assign(vault, {
      configDir: ".obsidian",
      // Export writes no log, and no file but its own new one.
      modify: () => Promise.reject(new Error("export writes through Vault.create only")),
      process: () => Promise.reject(new Error("export writes through Vault.create only")),
      // Obsidian's create (app.js, 1.14): refuses a path the DISK has, writes,
      // then the index has it.
      create: async (path: string, data: string) => {
        if (onDisk(path)) throw new Error("File already exists.");
        if (h.race.delete(path)) {
          h.disk.set(path, "a file a sync put there");
          throw new Error("File already exists.");
        }
        if (h.createError) throw h.createError;
        const folder = path.slice(0, path.lastIndexOf("/"));
        if (!(vault.getAbstractFileByPath(folder) instanceof TFolder)) {
          throw new Error(`ENOENT: no folder "${folder}"`);
        }
        h.created.push(path);
        h.disk.set(path, h.tamper ? h.tamper(data) : data);
        return vault.add(path, data);
      },
      createFolder: (path: string) => {
        h.folders.push(path);
        vault.addFolder(path);
        return Promise.resolve();
      },
      adapter: {
        exists: (path: string) => Promise.resolve(onDisk(path)),
        read: (path: string) => {
          const text = h.disk.get(path);
          if (text === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
          return Promise.resolve(h.readKeepsBom ? text : text.replace(/^\uFEFF/, ""));
        },
      },
    }),
    metadataCache: linkCache(vault),
  } as unknown as App;
  const api = readApi(vault, () => h.settings);
  h.tools = new LogTools({
    app,
    settings: () => h.settings,
    confirm: () => Promise.resolve(false),
    duplicateTaskIds: () => Promise.resolve([]),
    logChanged: () => undefined,
    readDays: (from, to) => {
      h.reads.push([from, to]);
      return api.getDays(from, to);
    },
    saveSettings: () => {
      h.saves++;
      return Promise.resolve();
    },
    askExportForm: (options) => {
      h.dialogs.push(options);
      return Promise.resolve(h.answer(options));
    },
  });
  return h;
}

/** The dialog's answer: its defaults, with `set` typed over them. */
const answering =
  (set: Partial<ExportForm>) =>
  (options: ExportFormOptions): ExportForm => ({ ...options.form, ...set });

const FILE_30 = "Pomodoro exports/gentle-pomodoro-sessions-2026-09-24-to-2026-10-23-153012";

describe("Export sessions", () => {
  it("opens on the last 30 days, focus and breaks, the format and folder last used", async () => {
    const h = harness(FILES(), { exportFormat: "jsonl", exportFolder: "Reports" });
    h.answer = () => null;
    await h.tools.exportSessions();
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0].form).toEqual({
      range: "30",
      from: "2026-09-24",
      to: "2026-10-23",
      kinds: "all",
      format: "jsonl",
      folder: "Reports",
    });
    // Everything runs from the first log file to today.
    expect(h.dialogs[0].datesFor("all")).toEqual({ from: "2026-10-20", to: "2026-10-23" });
    expect(h.dialogs[0].datesFor("custom")).toBeNull();
  });

  it("opens on Pomodoro exports and CSV until an export is written", async () => {
    const h = harness(FILES(), { exportFormat: "xlsx" });
    h.answer = () => null;
    await h.tools.exportSessions();
    expect(h.dialogs[0].form).toMatchObject({ format: "csv", folder: "Pomodoro exports" });
  });

  it("counts today as 'Day starts at' does", async () => {
    vi.setSystemTime(new Date(2026, 9, 24, 2, 30));
    const h = harness(FILES(), { dayStartHour: 4 });
    h.answer = () => null;
    await h.tools.exportSessions();
    expect(h.dialogs[0].form).toMatchObject({ from: "2026-09-24", to: "2026-10-23" });
  });

  it("writes one new CSV file of the range, creating its folder, and changes no log", async () => {
    const h = harness();
    const before = { ...h.vault.contents };
    await h.tools.exportSessions();
    expect(h.folders).toEqual(["Pomodoro exports"]);
    expect(h.created).toEqual([`${FILE_30}.csv`]);
    const records = exportRecords(await days("2026-09-24", "2026-10-23"), "all");
    expect(h.vault.contents[`${FILE_30}.csv`]).toBe(csvText(records));
    expect(h.disk.get(`${FILE_30}.csv`)?.startsWith("\uFEFF")).toBe(true);
    // The log is only read.
    for (const [path, content] of Object.entries(before)) {
      expect(h.vault.contents[path], path).toBe(content);
    }
    expect(h.vault.writes).toEqual([]);
    expect(Notice.shown).toEqual([EXPORTING_NOTICE, exportedMessage(8, `${FILE_30}.csv`)]);
    expect(Notice.hidden).toEqual([EXPORTING_NOTICE]);
  });

  it("remembers the format and the folder, in the vault's spelling, once the file is written", async () => {
    const h = harness({ ...FILES(), "Reports/x.md": "" });
    h.answer = answering({ format: "jsonl", folder: " reports " });
    await h.tools.exportSessions();
    const path = "Reports/gentle-pomodoro-sessions-2026-09-24-to-2026-10-23-153012.jsonl";
    expect(h.created).toEqual([path]);
    // An existing folder: nothing to create.
    expect(h.folders).toEqual([]);
    expect(h.vault.contents[path]).toBe(
      jsonLinesText(exportRecords(await days("2026-09-24", "2026-10-23"), "all"))
    );
    expect(h.settings.exportFormat).toBe("jsonl");
    expect(h.settings.exportFolder).toBe("Reports");
    expect(h.saves).toBe(1);
  });

  it("exports focus only, and a range it chose", async () => {
    const h = harness();
    h.answer = answering({
      range: "custom",
      from: " 2026-10-21 ",
      to: "2026-10-23",
      kinds: "focus",
    });
    await h.tools.exportSessions();
    const path = "Pomodoro exports/gentle-pomodoro-sessions-2026-10-21-to-2026-10-23-153012.csv";
    expect(h.vault.contents[path]).toBe(
      csvText(RECORDS.filter((r) => r.kind === "focus" && r.date >= "2026-10-21"))
    );
    expect(Notice.shown[1]).toBe(exportedMessage(5, path));
  });

  it("writes the time in the name in 0-9 under any language", async () => {
    realMoment.locale("ar");
    const h = harness();
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30}.csv`]);
  });

  it("writes nothing when the range holds no session", async () => {
    const h = harness();
    h.answer = answering({ range: "custom", from: "2026-10-22", to: "2026-10-22" });
    await h.tools.exportSessions();
    expect(h.created).toEqual([]);
    expect(h.folders).toEqual([]);
    expect(h.saves).toBe(0);
    expect(h.settings.exportFolder).toBe("");
    expect(Notice.shown).toEqual([
      EXPORTING_NOTICE,
      noSessionsMessage("2026-10-22", "2026-10-22", "all"),
    ]);
    expect(Notice.hidden).toEqual([EXPORTING_NOTICE]);
    // A folder with no log file yet has none either.
    Notice.shown.length = 0;
    const empty = harness({});
    empty.answer = answering({ range: "custom", from: "2026-10-01", to: "2026-10-23" });
    await empty.tools.exportSessions();
    expect(empty.reads).toEqual([]);
    expect(Notice.shown).toEqual([
      EXPORTING_NOTICE,
      noSessionsMessage("2026-10-01", "2026-10-23", "all"),
    ]);
    // Breaks alone are no focus sessions.
    const breaks = harness({ [LOG("2026-10-23")]: `${REST}\n` });
    breaks.answer = answering({ kinds: "focus" });
    await breaks.tools.exportSessions();
    expect(breaks.created).toEqual([]);
  });

  it("does nothing on Cancel", async () => {
    const h = harness();
    h.answer = () => null;
    await h.tools.exportSessions();
    expect(h.created).toEqual([]);
    expect(h.reads).toEqual([]);
    expect(h.saves).toBe(0);
    expect(Notice.shown).toEqual([]);
  });

  it("says so, and asks nothing, with no log folder or one the vault spells otherwise", async () => {
    const none = harness(FILES(), { logFolderPath: "" });
    await none.tools.exportSessions();
    expect(none.dialogs).toEqual([]);
    expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE]);

    Notice.shown.length = 0;
    const cased = harness(FILES(), { logFolderPath: "logs" });
    await cased.tools.exportSessions();
    expect(cased.dialogs).toEqual([]);
    expect(Notice.shown).toEqual([logFolderProblemNotice("logs", { kind: "case", real: "Logs" })]);
  });

  it("runs one export at a time, its dialog included", async () => {
    const h = harness();
    let answer: (form: ExportForm | null) => void = () => undefined;
    const tools = h.tools as unknown as { host: { askExportForm: unknown } };
    tools.host.askExportForm = (options: ExportFormOptions) =>
      new Promise<ExportForm | null>((resolve) => {
        h.dialogs.push(options);
        answer = resolve;
      });
    const first = h.tools.exportSessions();
    await h.tools.exportSessions();
    expect(h.dialogs).toHaveLength(1);
    expect(Notice.shown).toEqual([EXPORT_BUSY_NOTICE]);
    answer(null);
    await first;
    // Free again once it is over, however it ended.
    const third = h.tools.exportSessions();
    expect(h.dialogs).toHaveLength(2);
    answer(null);
    await third;
    expect(Notice.shown).toEqual([EXPORT_BUSY_NOTICE]);
  });

  it("is free again however an export ended: a failed write, nothing to export, a refused folder", async () => {
    const h = harness();
    const endings: [string, () => void][] = [
      [
        "a create that failed",
        () => {
          h.createError = new Error("EACCES: permission denied");
        },
      ],
      [
        "a range with no session",
        () => {
          h.createError = null;
          h.answer = answering({ range: "custom", from: "2024-01-01", to: "2024-12-31" });
        },
      ],
      [
        "a folder refused after the dialog",
        () => {
          h.answer = answering({ folder: ".obsidian/exports" });
        },
      ],
      [
        "an export that wrote its file",
        () => {
          h.answer = answering({});
        },
      ],
    ];
    for (const [name, set] of endings) {
      set();
      const dialogs = h.dialogs.length;
      Notice.shown.length = 0;
      await h.tools.exportSessions();
      expect(h.dialogs.length, name).toBe(dialogs + 1);
      expect(Notice.shown, name).not.toContain(EXPORT_BUSY_NOTICE);
    }
    expect(h.created).toHaveLength(1);
  });

  it("checks the dialog's values against the vault as it is then", async () => {
    const h = harness();
    h.answer = () => null;
    await h.tools.exportSessions();
    const { check, form } = h.dialogs[0];
    expect(check(form)).toBeNull();
    expect(check({ ...form, folder: ".obsidian/exports" })).toBe(EXPORT_FOLDER_HIDDEN);
    expect(check({ ...form, folder: "" })).toBe(EXPORT_FOLDER_TOP_LEVEL);
    expect(check({ ...form, from: "2026-02-30" })).toMatch(/^From must be a date/);
    // Everything, with log files there, is a range like any other.
    expect(check({ ...form, range: "all" })).toBeNull();
    // A log file written while the dialog is open counts.
    h.vault.add(LOG("2026-10-24"), `${FOCUS}\n`);
    expect(h.dialogs[0].datesFor("all")).toEqual({ from: "2026-10-20", to: "2026-10-24" });
    const empty = harness({});
    empty.answer = () => null;
    await empty.tools.exportSessions();
    const emptyCheck = empty.dialogs[0].check;
    const all = { ...empty.dialogs[0].form, range: "all" as const };
    expect(emptyCheck(all)).toBe(NO_LOG_FILES_YET);
    // The check reads the vault at each call, not as it was when the dialog opened.
    empty.vault.add(LOG("2026-10-24"), `${FOCUS}\n`);
    expect(emptyCheck(all)).toBeNull();
  });

  it("refuses the vault's config folder by the name the vault gives it", async () => {
    const h = harness();
    // Not a dot name, so only the vault's own configDir can say it is the config folder.
    (h.vault as unknown as { configDir: string }).configDir = "Settings";
    h.answer = (options) => ({ ...options.form, folder: "Settings/exports" });
    await h.tools.exportSessions();
    expect(h.dialogs[0].check({ ...h.dialogs[0].form, folder: "Settings" })).toBe(
      EXPORT_FOLDER_HIDDEN
    );
    // Checked again after the dialog, with the same name.
    expect(h.created).toEqual([]);
    expect(Notice.shown).toEqual([`Gentle pomodoro: ${EXPORT_FOLDER_HIDDEN}`]);
  });

  it("says why, and writes nothing, when the folder became a file meanwhile", async () => {
    const h = harness();
    h.answer = (options) => {
      h.vault.add("Pomodoro exports", "");
      return options.form;
    };
    await h.tools.exportSessions();
    expect(h.created).toEqual([]);
    expect(Notice.shown).toEqual(['Gentle pomodoro: "Pomodoro exports" is a file. Pick a folder.']);
  });
});

describe("Export never writes over a file it can see", () => {
  it("numbers the name when the vault has it", async () => {
    const h = harness({ ...FILES(), [`${FILE_30}.csv`]: "mine" });
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30} 2.csv`]);
    expect(h.vault.contents[`${FILE_30}.csv`]).toBe("mine");
  });

  it("numbers the name when the disk has it and the index does not yet", async () => {
    const h = harness();
    h.vault.addFolder("Pomodoro exports");
    h.disk.set(`${FILE_30}.csv`, "synced");
    h.disk.set(`${FILE_30} 2.csv`, "synced too");
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30} 3.csv`]);
    expect(h.disk.get(`${FILE_30}.csv`)).toBe("synced");
  });

  it("numbers the name when the index has a file the disk has lost", async () => {
    const h = harness({ ...FILES(), [`${FILE_30}.csv`]: "mine" });
    h.disk.delete(`${FILE_30}.csv`);
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30} 2.csv`]);
  });

  it("moves on when create refuses a name a sync took a moment before", async () => {
    const h = harness();
    h.race.add(`${FILE_30}.csv`);
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30} 2.csv`]);
    expect(h.disk.get(`${FILE_30}.csv`)).toBe("a file a sync put there");
    expect(Notice.shown[1]).toBe(exportedMessage(8, `${FILE_30} 2.csv`));
  });

  it("tries the 99th name before it gives up", async () => {
    const taken: Record<string, string> = FILES();
    for (let n = 1; n < EXPORT_NAME_TRIES; n++) {
      taken[`${FILE_30}${n > 1 ? ` ${String(n)}` : ""}.csv`] = "taken";
    }
    const h = harness(taken);
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30} 99.csv`]);
  });

  it("gives up, writing nothing, when every name is taken", async () => {
    const taken: Record<string, string> = FILES();
    for (let n = 1; n <= EXPORT_NAME_TRIES; n++) {
      taken[`${FILE_30}${n > 1 ? ` ${String(n)}` : ""}.csv`] = "taken";
    }
    const h = harness(taken);
    await h.tools.exportSessions();
    expect(h.created).toEqual([]);
    expect(h.saves).toBe(0);
    expect(Notice.shown[1]).toBe(
      'Gentle pomodoro: every file name for this export in "Pomodoro exports" is taken, so nothing was exported.'
    );
  });

  it("says it failed when create fails another way", async () => {
    const h = harness();
    h.createError = new Error("EACCES: permission denied");
    await h.tools.exportSessions();
    expect(h.created).toEqual([]);
    expect(h.saves).toBe(0);
    expect(Notice.shown).toEqual([EXPORTING_NOTICE, EXPORT_FAILED_NOTICE]);
    expect(Notice.hidden).toEqual([EXPORTING_NOTICE]);
  });

  it("reads the file back, and says so when it is not what was written", async () => {
    const h = harness();
    h.tamper = (text) => `${text}one more line\r\n`;
    await h.tools.exportSessions();
    expect(h.created).toEqual([`${FILE_30}.csv`]);
    expect(Notice.shown[1]).toBe(
      `Gentle pomodoro: exported 8 sessions to "${FILE_30}.csv", but the file doesn't read back as it was written — a sync or another app may have changed it. Export again to be sure.`
    );
  });

  it("reads the file back alike whether the disk read keeps the byte order mark or not", async () => {
    const h = harness();
    h.readKeepsBom = false;
    await h.tools.exportSessions();
    expect(Notice.shown[1]).toBe(exportedMessage(8, `${FILE_30}.csv`));
  });

  it("says so when the file cannot be read back", async () => {
    const h = harness();
    h.answer = (options) => {
      const read = h.vault as unknown as { adapter: { read: unknown } };
      read.adapter.read = () => Promise.reject(new Error("EIO"));
      return options.form;
    };
    await h.tools.exportSessions();
    expect(Notice.shown[1]).toMatch(/doesn't read back as it was written/);
  });
});

describe("Export reads through the read API", () => {
  /** A log file every 30 days from 2025-01-01, one session each. */
  const spread = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 22; i++) {
      const day = new Date(Date.UTC(2025, 0, 1 + i * 30)).toISOString().slice(0, 10);
      files[LOG(day)] = `${FOCUS.replace(/2026-10-23/g, day)}\n`;
    }
    return files;
  };

  it("in runs of at most 400 days, each day once, and every session in the file", async () => {
    const h = harness(spread());
    h.answer = answering({ range: "all", from: "2025-01-01", to: "2026-10-23" });
    await h.tools.exportSessions();
    const dayAfter = (date: string) =>
      new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(h.reads.length).toBeGreaterThan(1);
    let next = "2025-01-01";
    for (const [from, to] of h.reads) {
      expect(from).toBe(next);
      // At most 400 days: one run of its own.
      expect(exportChunks(from, to)).toHaveLength(1);
      next = dayAfter(to);
    }
    // To the last file, 2026-09-23.
    expect(next).toBe("2026-09-24");
    const path = h.created[0];
    expect(path).toBe(
      "Pomodoro exports/gentle-pomodoro-sessions-2025-01-01-to-2026-10-23-153012.csv"
    );
    expect(h.vault.contents[path].split("\r\n")).toHaveLength(22 + 2);
  });

  it("asks only for the days a log file can be for, however long the range", async () => {
    const h = harness(spread());
    h.answer = answering({ range: "custom", from: "1000-01-01", to: "9999-12-31" });
    await h.tools.exportSessions();
    // 2025-01-01 to the last file, 2026-09-23: 631 days in two runs.
    expect(h.reads).toEqual([
      ["2025-01-01", "2026-02-04"],
      ["2026-02-05", "2026-09-23"],
    ]);
    // The name keeps the range asked for.
    expect(h.created).toEqual([
      "Pomodoro exports/gentle-pomodoro-sessions-1000-01-01-to-9999-12-31-153012.csv",
    ]);
    // Inside the files' span, exactly the range.
    const inside = harness(spread());
    inside.answer = answering({ range: "custom", from: "2025-03-01", to: "2025-03-31" });
    await inside.tools.exportSessions();
    expect(inside.reads).toEqual([["2025-03-01", "2025-03-31"]]);
    const outside = harness(spread());
    outside.answer = answering({ range: "custom", from: "2024-01-01", to: "2024-12-31" });
    await outside.tools.exportSessions();
    expect(outside.reads).toEqual([]);
    expect(Notice.shown).toContain(noSessionsMessage("2024-01-01", "2024-12-31", "all"));
  });
});

/* ===== The dialog ===== */

const FORM: ExportForm = {
  range: "30",
  from: "2026-09-24",
  to: "2026-10-23",
  kinds: "all",
  format: "csv",
  folder: "Pomodoro exports",
};

function openDialog(set: Partial<ExportFormOptions> = {}) {
  let settled = false;
  const options: ExportFormOptions = {
    form: { ...FORM },
    datesFor: (range) =>
      exportRangeDates(range, "2026-10-23", { earliest: "2026-01-05", latest: "2026-10-23" }),
    check: (form) => (form.folder === "/" ? EXPORT_FOLDER_TOP_LEVEL : null),
    ...set,
  };
  const answer = askExportForm({} as App, options).then((value) => {
    settled = true;
    return value;
  });
  const modal = Modal.opened;
  if (!modal) throw new Error("the dialog did not open");
  const rows = modal.contentEl.settings;
  const field = (name: string): RecordedComponent => {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no row ${name}`);
    return row.components[0];
  };
  const button = (text: string): RecordedComponent => {
    const found = rows[rows.length - 1].components.find((c) => c.buttonText === text);
    if (!found) throw new Error(`no button ${text}`);
    return found;
  };
  const problem = () =>
    modal.contentEl.children.find((c) => c.classes.includes("gp-setting-note"))?.text;
  return { options, answer, modal, rows, field, button, problem, settled: () => settled };
}

describe("the Export dialog", () => {
  it("shows its six rows, filled from the form it was given", () => {
    const d = openDialog();
    expect(d.modal.titleEl.text).toBe("Export sessions");
    expect(d.rows.slice(0, 6).map((r) => r.name)).toEqual([
      "Days",
      "From",
      "To",
      "Sessions",
      "Format",
      "Folder",
    ]);
    expect(d.field("Days").value).toBe("30");
    expect(d.field("Days").options.map((o) => o.label)).toEqual([
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last month",
      "This year",
      "Everything",
      "Choose dates",
    ]);
    expect(d.field("From").value).toBe("2026-09-24");
    expect(d.field("To").value).toBe("2026-10-23");
    expect(d.field("Sessions").options.map((o) => o.label)).toEqual([
      "Focus and breaks",
      "Focus only",
    ]);
    expect(d.field("Format").options.map((o) => o.label)).toEqual([
      "CSV (for spreadsheets)",
      "JSON Lines (for scripts)",
    ]);
    expect(d.field("Folder").value).toBe("Pomodoro exports");
    expect(d.rows[5].desc).toBe(EXPORT_FOLDER_NOTE);
    // Not "never replaces": a file a sync drops in at the very moment can be.
    expect(EXPORT_FOLDER_NOTE).not.toMatch(/never/i);
    expect(d.button("Export").cta).toBe(true);
  });

  it("fills From and To with the dates a Days choice stands for", async () => {
    const d = openDialog();
    d.field("Days").change?.("last-month" as never);
    expect(d.field("From").value).toBe("2026-09-01");
    expect(d.field("To").value).toBe("2026-09-30");
    d.field("Days").change?.("all" as never);
    expect(d.field("From").value).toBe("2026-01-05");
    d.button("Export").click?.();
    await expect(d.answer).resolves.toEqual({
      ...FORM,
      range: "all",
      from: "2026-01-05",
      to: "2026-10-23",
    });
  });

  it("switches Days to Choose dates when a date is typed, and keeps the other", async () => {
    const d = openDialog();
    d.field("From").change?.("2026-10-01" as never);
    expect(d.field("Days").value).toBe("custom");
    d.field("To").change?.("2026-10-10" as never);
    // Choose dates keeps the boxes as they are.
    d.field("Days").change?.("custom" as never);
    expect(d.field("From").value).toBe("2026-09-24");
    d.button("Export").click?.();
    await expect(d.answer).resolves.toEqual({
      ...FORM,
      range: "custom",
      from: "2026-10-01",
      to: "2026-10-10",
    });
    expect(d.options.form).toEqual(FORM);
  });

  it("says when there are no log files for Everything", () => {
    const d = openDialog({ datesFor: (range) => exportRangeDates(range, "2026-10-23", null) });
    d.field("Days").change?.("all" as never);
    expect(d.problem()).toBe(NO_LOG_FILES_YET);
    expect(d.field("From").value).toBe("2026-09-24");
    d.field("Days").change?.("7" as never);
    expect(d.problem()).toBe("");
  });

  it("hands back the kind, the format and the folder chosen", async () => {
    const d = openDialog();
    d.field("Sessions").change?.("focus" as never);
    d.field("Format").change?.("jsonl" as never);
    d.field("Folder").change?.("Reports" as never);
    d.button("Export").click?.();
    await expect(d.answer).resolves.toEqual({
      ...FORM,
      kinds: "focus",
      format: "jsonl",
      folder: "Reports",
    });
  });

  it("stays open and says why when the values cannot be exported", async () => {
    const d = openDialog();
    d.field("Folder").change?.("/" as never);
    d.button("Export").click?.();
    await Promise.resolve();
    expect(d.settled()).toBe(false);
    expect(d.problem()).toBe(EXPORT_FOLDER_TOP_LEVEL);
    d.field("Folder").change?.("Reports" as never);
    d.button("Export").click?.();
    await expect(d.answer).resolves.toMatchObject({ folder: "Reports" });
    expect(d.problem()).toBe("");
  });

  it("settles as cancelled on Cancel and on every other way out", async () => {
    const d = openDialog();
    d.button("Cancel").click?.();
    await expect(d.answer).resolves.toBeNull();
    const e = openDialog();
    e.modal.close();
    await expect(e.answer).resolves.toBeNull();
  });
});
