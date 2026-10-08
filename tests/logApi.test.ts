import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TFile, type App } from "obsidian";
import { LOG_API_MAX_DAYS, LOG_API_VERSION, createLogApi, type LogApiHost } from "../logApi";
import { LogManager, resolveLogLink } from "../logManager";
import { parseFocusTotalSeconds } from "../logLine";
import type GentlePomoPlugin from "../main";
import type { MomentLike } from "../momentTypes";
import { fakeVault, linkCache } from "./fakeVault";

/**
 * The read-only API for templates (0.6.9): `plugin.api`, which a dataviewjs
 * block reaches as `app.plugins.plugins["gentle-pomo"]?.api`. A day read the
 * way the plugin reads it, counted the way the goal meter counts it, with the
 * goal its own file recorded. Lines are made up; none is copied from a real log.
 */

// The real moment, its Arabic locale loaded into the same instance (a locale
// file requires "../moment", so both go through require).
const require = createRequire(import.meta.url);
const realMoment = require("moment") as ((input?: unknown) => MomentLike) & {
  locale(key?: string): string;
};
require("moment/locale/ar");
realMoment.locale("en");

const LOG = (date: string) => `Logs/${date}-gentle-pomodoro-log.md`;

const FOCUS =
  '- 🍅 Focus [Task:: [[Docs|Write docs #task/develop/docs]]] [ID:: abc123] [Start:: 2026-10-02 09:00:00] [End:: 2026-10-02 09:35:00] [Scheduled:: 1500] [Pauses:: ["2026-10-02 09:10:00 - 2026-10-02 09:20:00"]] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]';
const REST =
  "- ☕ Rest [Start:: 2026-10-02 09:35:00] [End:: 2026-10-02 09:40:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]";
const OLD =
  "- 🍅 Focus | Task:: [[Projects/Gone.md|Read paper]] | Start:: 2026-10-02 10:00:00 | End:: 2026-10-02 10:20:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1200 | Status:: finished | Type:: focus";
const SKIPPED =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:10:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 600] [Status:: cancelled] [Type:: focus] [Overtime:: 0]";
const OLDEST =
  "- [x] ☕ Rest | Start:: 2026-10-02 12:00:00 | End:: 2026-10-02 12:05:00 | Scheduled:: 300 | Total:: 300";

/** Properties with a pasted example that reads as a session line. */
const TRAP = [
  "---",
  "goal_minutes: 90",
  "example: |",
  "  - 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 07:00:00] [End:: 2026-10-02 08:00:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 3600] [Status:: finished] [Type:: focus] [Overtime:: 0]",
  "---",
  "",
].join("\n");

const FILES = {
  "Projects/Docs.md": "- [ ] Write docs #task/develop/docs 🆔 abc123\n",
  [LOG("2026-10-02")]: `${TRAP}${FOCUS}\n${REST}\n${OLD}\n${SKIPPED}\n${OLDEST}\n`,
  [LOG("2026-10-03")]: `${FOCUS.replace(/2026-10-02/g, "2026-10-03")}\n`,
  [LOG("2026-10-04")]:
    `---\ngoal_minutes: 90\n---\n${FOCUS.replace(/2026-10-02/g, "2026-10-04")}\n`,
};

interface Settings {
  logFolderPath: string;
  dayStartHour: number;
  dailyFocusGoalMinutes: number;
}

/** The API over a fake vault, read the way main.ts reads it. */
function setup(files: Record<string, string> = FILES, set: Partial<Settings> = {}) {
  const vault = fakeVault(files);
  const app = { vault, metadataCache: linkCache(vault) } as unknown as App;
  const settings: Settings = {
    logFolderPath: "Logs",
    dayStartHour: 0,
    dailyFocusGoalMinutes: 120,
    ...set,
  };
  const read = vi.spyOn(vault, "read");
  const host: LogApiHost = {
    settings: () => settings,
    read: async (path) => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? vault.cachedRead(file) : null;
    },
    resolveLink: (linktext, sourcePath) => resolveLogLink(app, linktext, sourcePath),
    moment: (ms) => realMoment(ms),
    now: () => Date.now(),
  };
  return { api: createLogApi(host), vault, app, settings, read };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Today is 4 October, at noon.
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  realMoment.locale("en");
});

describe("the API object", () => {
  it("is version 1, and frozen: a template cannot swap a member out", () => {
    const { api } = setup();
    expect(api.version).toBe(1);
    expect(LOG_API_VERSION).toBe(1);
    expect(Object.isFrozen(api)).toBe(true);
    expect(() => {
      (api as unknown as { getDay: unknown }).getDay = () => null;
    }).toThrow(TypeError);
  });

  it("reads the settings as they are at each call", () => {
    const { api, settings } = setup();
    expect(api.dailyGoalMinutes()).toBe(120);
    expect(api.dayStartHour()).toBe(0);
    settings.dailyFocusGoalMinutes = 45;
    settings.dayStartHour = 4;
    expect(api.dailyGoalMinutes()).toBe(45);
    expect(api.dayStartHour()).toBe(4);
    // The goal off, or a value the setting cannot hold, is 0; an hour it
    // cannot hold is midnight.
    settings.dailyFocusGoalMinutes = 0;
    expect(api.dailyGoalMinutes()).toBe(0);
    settings.dailyFocusGoalMinutes = Number.NaN;
    expect(api.dailyGoalMinutes()).toBe(0);
    settings.dayStartHour = 9;
    expect(api.dayStartHour()).toBe(0);
  });

  it("gives a day's log path, or null with no folder or no YYYY-MM-DD date", () => {
    expect(setup().api.logPath("2026-10-02")).toBe(LOG("2026-10-02"));
    expect(setup(FILES, { logFolderPath: "Logs/" }).api.logPath("2026-10-09")).toBe(
      LOG("2026-10-09")
    );
    expect(setup(FILES, { logFolderPath: "" }).api.logPath("2026-10-02")).toBeNull();
    const { api } = setup();
    for (const bad of ["2026-10-32", "2026-1-2", "today", "٢٠٢٦-١٠-٠٢", 20261002, null]) {
      expect(api.logPath(bad as string)).toBeNull();
    }
  });
});

describe("getDay", () => {
  it("reads every session line, in either format, as the plugin does", async () => {
    const day = await setup().api.getDay("2026-10-02");
    expect(day.date).toBe("2026-10-02");
    expect(day.path).toBe(LOG("2026-10-02"));
    expect(day.sessions).toEqual([
      {
        kind: "focus",
        type: "focus",
        task: { name: "Write docs #task/develop/docs", path: "Projects/Docs.md" },
        id: "abc123",
        start: "2026-10-02 09:00:00",
        end: "2026-10-02 09:35:00",
        scheduled: 1500,
        total: 1500,
        overtime: 0,
        pauses: [{ start: "2026-10-02 09:10:00", end: "2026-10-02 09:20:00" }],
        status: "finished",
      },
      {
        kind: "rest",
        type: "short-break",
        task: null,
        id: null,
        start: "2026-10-02 09:35:00",
        end: "2026-10-02 09:40:00",
        scheduled: 300,
        total: 300,
        overtime: null,
        pauses: [],
        status: null,
      },
      {
        kind: "focus",
        type: "focus",
        // The note is gone: the link as written.
        task: { name: "Read paper", path: "Projects/Gone.md" },
        id: null,
        start: "2026-10-02 10:00:00",
        end: "2026-10-02 10:20:00",
        scheduled: 1500,
        total: 1200,
        overtime: null,
        pauses: [],
        status: "finished",
      },
      {
        kind: "focus",
        type: "focus",
        task: { name: "No Task", path: null },
        id: null,
        start: "2026-10-02 11:00:00",
        end: "2026-10-02 11:10:00",
        scheduled: 1500,
        total: 600,
        overtime: 0,
        pauses: [],
        status: "cancelled",
      },
      {
        kind: "rest",
        type: null,
        task: null,
        id: null,
        start: "2026-10-02 12:00:00",
        end: "2026-10-02 12:05:00",
        scheduled: 300,
        total: 300,
        overtime: null,
        pauses: [],
        status: null,
      },
    ]);
  });

  it("passes over the file's properties: a row there that reads as a session is none", async () => {
    const day = await setup().api.getDay("2026-10-02");
    expect(day.sessions.map((s) => s.start)).not.toContain("2026-10-02 07:00:00");
    expect(day.focusSeconds).toBe(1500 + 1200);
  });

  it("counts focusSeconds as the goal meter does: the same function, skipped sessions left out", async () => {
    const { api, vault } = setup();
    const day = await api.getDay("2026-10-02");
    expect(day.focusSeconds).toBe(parseFocusTotalSeconds(vault.contents[LOG("2026-10-02")]));

    // And today's equals what the meter reads for today.
    const { api: todayApi, vault: todayVault } = setup();
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour: 0 },
      app: { vault: todayVault },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    const g = globalThis as unknown as { moment?: unknown };
    const previous = g.moment;
    g.moment = realMoment;
    try {
      const meter = await new LogManager(plugin).getTodayFocusSeconds();
      expect((await todayApi.getDay("2026-10-04")).focusSeconds).toBe(meter);
      expect(meter).toBe(1500);
    } finally {
      g.moment = previous;
    }
  });

  it("gives an earlier day the goal its file recorded, and null when it recorded none", async () => {
    const { api } = setup();
    expect((await api.getDay("2026-10-02")).goalMinutes).toBe(90);
    expect((await api.getDay("2026-10-03")).goalMinutes).toBeNull();
    expect((await api.getDay("2026-09-30")).goalMinutes).toBeNull();
  });

  it("gives today, and any later day, the setting now — whatever today's file says", async () => {
    const { api, settings } = setup();
    expect((await api.getDay("2026-10-04")).goalMinutes).toBe(120);
    expect((await api.getDay("2026-10-05")).goalMinutes).toBe(120);
    settings.dailyFocusGoalMinutes = 0;
    expect((await api.getDay("2026-10-04")).goalMinutes).toBe(0);
  });

  it("takes today as 'Day starts at' counts it", async () => {
    // At 02:00 on the 4th with a 4:00 start, today is the 3rd.
    vi.setSystemTime(new Date(2026, 9, 4, 2, 0, 0));
    const { api } = setup(FILES, { dayStartHour: 4 });
    expect((await api.getDay("2026-10-03")).goalMinutes).toBe(120);
    expect((await api.getDay("2026-10-02")).goalMinutes).toBe(90);
  });

  it("gives a day with no file no path and no sessions", async () => {
    const { api } = setup();
    expect(await api.getDay("2026-09-30")).toEqual({
      date: "2026-09-30",
      path: null,
      goalMinutes: null,
      focusSeconds: 0,
      sessions: [],
    });
    const none = setup(FILES, { logFolderPath: "" }).api;
    expect(await none.getDay("2026-10-02")).toEqual({
      date: "2026-10-02",
      path: null,
      goalMinutes: null,
      focusSeconds: 0,
      sessions: [],
    });
    expect((await none.getDay("2026-10-04")).goalMinutes).toBe(120);
  });

  it("reads a Pauses value it cannot read as null, not as no pauses", async () => {
    const line = FOCUS.replace(/\[Pauses:: [^\]]*\]\]/u, "[Pauses:: lunch]");
    const { api } = setup({ [LOG("2026-10-02")]: `${line}\n` });
    expect((await api.getDay("2026-10-02")).sessions[0].pauses).toBeNull();
  });

  it("reads the day's file 0.6.8 named in the app language's digits too, as the meter does (F4)", async () => {
    realMoment.locale("ar");
    const native = "Logs/٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md";
    const { api } = setup({
      [native]: `${OLD}\n`,
      [LOG("2026-10-02")]: `---\ngoal_minutes: 90\n---\n${SKIPPED}\n${FOCUS}\n`,
    });
    const day = await api.getDay("2026-10-02");
    expect(day.path).toBe(LOG("2026-10-02"));
    expect(day.goalMinutes).toBe(90);
    expect(day.focusSeconds).toBe(1500 + 1200);
    expect(day.sessions.map((s) => s.total)).toEqual([600, 1500, 1200]);
    // Only that file: its path, when it is the one there is.
    const alone = await setup({ [native]: `${OLD}\n` }).api.getDay("2026-10-02");
    expect(alone.path).toBe(native);
  });

  it("rejects a date that is not YYYY-MM-DD, never throwing inside the template", async () => {
    const { api } = setup();
    for (const bad of ["2026-02-30", "2026-1-2", "", "٢٠٢٦-١٠-٠٢", new Date(), undefined]) {
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = api.getDay(bad as string);
      }).not.toThrow();
      await expect(pending).rejects.toThrow(/YYYY-MM-DD/);
    }
    await expect(api.getDay("2026-02-30")).rejects.toThrow(
      'getDay\'s date must be a date written YYYY-MM-DD, like "2026-10-04", not "2026-02-30".'
    );
  });

  it("reads only, through cachedRead, and gives new objects every time", async () => {
    const { api, vault, read } = setup();
    const first = await api.getDay("2026-10-02");
    first.sessions[0].task = { name: "Changed", path: null };
    first.sessions.push(first.sessions[0]);
    first.goalMinutes = 5;
    const again = await api.getDay("2026-10-02");
    expect(again.sessions).toHaveLength(5);
    expect(again.sessions[0].task?.name).toBe("Write docs #task/develop/docs");
    expect(again.goalMinutes).toBe(90);
    expect(vault.writes).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("getDays", () => {
  it("reads each day from one date to the other, both included, in order", async () => {
    const days = await setup().api.getDays("2026-10-01", "2026-10-04");
    expect(days.map((d) => [d.date, d.goalMinutes, d.focusSeconds])).toEqual([
      ["2026-10-01", null, 0],
      ["2026-10-02", 90, 2700],
      ["2026-10-03", null, 1500],
      ["2026-10-04", 120, 1500],
    ]);
    expect((await setup().api.getDays("2026-10-02", "2026-10-02")).map((d) => d.date)).toEqual([
      "2026-10-02",
    ]);
  });

  it("counts calendar days across a month, a year and a night the clocks change", async () => {
    const { api } = setup({});
    const dates = async (from: string, to: string) =>
      (await api.getDays(from, to)).map((d) => d.date);
    expect(await dates("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(await dates("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(await dates("2025-12-31", "2026-01-01")).toEqual(["2025-12-31", "2026-01-01"]);
    expect(await dates("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it(`reads at most ${String(LOG_API_MAX_DAYS)} days, and rejects a range the wrong way round`, async () => {
    const { api } = setup({});
    expect(LOG_API_MAX_DAYS).toBe(400);
    expect(await api.getDays("2025-09-01", "2026-10-05")).toHaveLength(400);
    await expect(api.getDays("2025-09-01", "2026-10-06")).rejects.toThrow(
      "getDays reads at most 400 days; 2025-09-01 to 2026-10-06 is 401."
    );
    await expect(api.getDays("2026-10-04", "2026-10-01")).rejects.toThrow(
      "getDays' from (2026-10-04) is after its to (2026-10-01)."
    );
    await expect(api.getDays("2026-10-01", "soon")).rejects.toThrow(/getDays' to must be/);
  });
});

describe("the plugin's wiring", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");

  it("sets the API in onload, reading files through cachedRead, and removes it at unload", () => {
    const onload = main.slice(main.indexOf("override async onload()"));
    expect(onload).toContain("this.api = createLogApi({");
    expect(onload).toContain(
      "return file instanceof TFile ? this.app.vault.cachedRead(file) : null;"
    );
    expect(onload).toContain(
      "resolveLink: (linktext, sourcePath) => resolveLogLink(this.app, linktext, sourcePath),"
    );
    const onunload = main.slice(main.indexOf("override onunload()"));
    expect(onunload.slice(0, 200)).toContain("this.api = undefined;");
  });
});
