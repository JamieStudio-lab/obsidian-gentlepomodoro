import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Imported from the mock by path, not through the "obsidian" alias: the alias
// is a vitest resolution rule, so `tsc` would type these against the real
// package (which has no recording stubs). Vitest points the alias at this very
// file, so it is the same module instance the tab constructs.
import {
  ExtraButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  Setting,
  clickEl,
  pressKey,
  stubEl,
  stubFocus,
  stubObsidian,
  stubRequest,
  type ModalContent,
  type RecordedComponent,
  type StubEl,
} from "../__mocks__/obsidian";
import {
  BREAK_END_CUE_NAME,
  CHECK_LOG_NAME,
  CONVERT_LOG_NAME,
  COLUMN_ADD_LABEL,
  COLUMN_LAST_SHOWN_TOOLTIP,
  columnAddedMessage,
  columnMovedMessage,
  columnPresetMessage,
  columnRemovedMessage,
  CUE_MUTED_NOTICE,
  DAY_START_NAME,
  DEVICE_NAME_NAME,
  EXPORT_SESSIONS_NAME,
  QUERY_CODE_SUMMARY,
  QUERY_COLUMNS_NAME,
  QUERY_COPIES,
  QUERY_GROUP_HEADING,
  QUERY_KINDS_NAME,
  QUERY_NO_FOLDER_PREVIEW,
  QUERY_RANGE_NAME,
  QUERY_SKIPPED_NAME,
  QUERY_SORT_NAME,
  deviceNameNote,
  FOCUS_END_CUE_NAME,
  GentlePomoSettingTab,
  LONG_SESSION_NAME,
  OPEN_LOG_NAME,
  REFRESH_NAMES_NAME,
  TASK_SWITCH_NAME,
} from "../GentlePomoSettingTab";
import { DEFAULT_SETTINGS } from "../constants";
import {
  AUTO_START_BREAK_LABEL,
  AUTO_START_FOCUS_LABEL,
  MASTER_SOUND_LABEL,
  MUSIC_SOUND_LABEL,
  MUSIC_VOLUME_LABEL,
  TIMER_VOLUME_LABEL,
  sessionEndSummary,
} from "../sessionEndSummary";
import { VOLUME_OPTIONS } from "../segmentedChoice";
import { SESSION_END_NOTIFICATION_LABEL } from "../sessionEndNotice";
import { TASK_SOURCE_ORDER, TASK_SOURCE_LABELS, TASK_SOURCE_SETTING_NAME } from "../taskScope";
import { DEFAULT_THEME } from "../themes";
import { TimerEngine } from "../TimerEngine";
import type { GentlePomoSettings } from "../types";
import { fakeVault } from "./fakeVault";
import { parseRules, stripComments } from "./cssRules";
import { DEVICE_NAME_KEY } from "../deviceStorage";
import { NO_LOG_FOLDER_NOTICE } from "../logTools";
import {
  QUERY_COLUMNS,
  QUERY_KINDS,
  QUERY_PRESETS,
  QUERY_RANGES,
  QUERY_SORTS,
  formatQueryColumns,
  presetColumns,
  queryCode,
  queryOptions,
  resolveQueryColumns,
  sessionsTable,
  sessionsTableJs,
} from "../logQueries";
import {
  LOG_FOLDER_DESC,
  LOG_FOLDER_NAME,
  folderIgnoringCase,
  logFolderAdoptedMessage,
  logFolderLeftMessage,
  logFolderProblem,
  logFolderProblemNote,
  logFolderProblemNotice,
  logFolderRootMessage,
  resolveLogFolderInput,
} from "../logFolder";

/**
 * The pre-1.13 `display()` path cannot be exercised on a machine running a
 * current Obsidian — it is dead code there by design. These tests are what
 * stands in for that: they render it headlessly and hold it against the
 * declarative definitions, which is the invariant that used to be maintained
 * by hand (and that five separate warnings in the docs asked contributors to
 * remember).
 */

/** A container that collects the Settings constructed into it, in order. */
function container(): { settings: Setting[]; empty: () => void } {
  const el = {
    settings: [] as Setting[],
    empty: () => {
      el.settings.length = 0;
    },
  };
  return el;
}

interface Call {
  method: string;
  args: unknown[];
}

function makeTab(overrides: Partial<GentlePomoSettings> = {}, files: Record<string, string> = {}) {
  const calls: Call[] = [];
  const settings: GentlePomoSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const plugin = {
    settings,
    app: {},
    timer: {
      currentTaskName: "No task",
      setTask: () => undefined,
      // The Sounds rows' ▶ / ■ reads and hooks these on every render.
      previewingEdge: () => null,
      setPreviewListener: () => undefined,
      stopPreview: () => undefined,
      updateDuration: (setting: unknown) =>
        calls.push({ method: "updateDuration", args: [setting] }),
    },
    saveSettings: () => {
      calls.push({ method: "saveSettings", args: [] });
      return Promise.resolve();
    },
    setStatusBarVisibility: (v: boolean) => {
      calls.push({ method: "setStatusBarVisibility", args: [v] });
      return Promise.resolve();
    },
    setStatusBarTime: (v: unknown) => {
      calls.push({ method: "setStatusBarTime", args: [v] });
      return Promise.resolve();
    },
    refreshStatusBar: () => calls.push({ method: "refreshStatusBar", args: [] }),
    refreshGoalDisplays: () => calls.push({ method: "refreshGoalDisplays", args: [] }),
    logFolderChanged: () => calls.push({ method: "logFolderChanged", args: [] }),
    logManager: {
      goalChanged: () => calls.push({ method: "goalChanged", args: [] }),
    },
    clearAllMusicPositions: () => calls.push({ method: "clearAllMusicPositions", args: [] }),
    previewSessionEndNotification: () =>
      calls.push({ method: "previewSessionEndNotification", args: [] }),
    checkPomodoroMarkers: () => {
      calls.push({ method: "checkPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    repairPomodoroMarkers: () => {
      calls.push({ method: "repairPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    removeMisplacedPomodoroMarkers: () => {
      calls.push({ method: "removeMisplacedPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    removeAllPomodoroMarkers: () => {
      calls.push({ method: "removeAllPomodoroMarkers", args: [] });
      return Promise.resolve();
    },
    openTodayLog: () => {
      calls.push({ method: "openTodayLog", args: [] });
      return Promise.resolve();
    },
    checkLog: () => {
      calls.push({ method: "checkLog", args: [] });
      return Promise.resolve();
    },
    convertLog: () => {
      calls.push({ method: "convertLog", args: [] });
      return Promise.resolve();
    },
    refreshLogTaskNames: () => {
      calls.push({ method: "refreshLogTaskNames", args: [] });
      return Promise.resolve();
    },
    exportSessions: () => {
      calls.push({ method: "exportSessions", args: [] });
      return Promise.resolve();
    },
    app_workspace: null,
  };
  // The tab reaches app.workspace only through applySettingsToOpenViews. Give
  // it ONE leaf whose view records the call: with an empty leaf list the fan-out
  // is a no-op nobody can observe, so a deleted applySettingsToOpenViews() would
  // be invisible to every assertion below — and that call is the only thing
  // keeping an open gear panel from showing a stale toggle. applySettingsToOpenViews
  // duck-types on `"applySettings" in view`, so this stub is enough.
  // This device's storage (0.7.0, the device name row): Obsidian's own
  // local storage, as 1.8.7 has it, so deviceStorage(app) finds it.
  const local = new Map<string, unknown>();
  (plugin as unknown as { app: unknown }).app = {
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => {
      if (value === null || value === undefined) local.delete(key);
      else local.set(key, value);
    },
    // The log folder row looks folders up as it is typed.
    vault: fakeVault(files),
    workspace: {
      getLeavesOfType: () => [
        { view: { applySettings: () => calls.push({ method: "applySettings", args: [] }) } },
      ],
    },
  };
  const tab = new GentlePomoSettingTab(
    plugin.app as never,
    plugin as unknown as ConstructorParameters<typeof GentlePomoSettingTab>[1]
  );
  const el = container();
  (tab as unknown as { containerEl: unknown }).containerEl = el;
  return { tab, el, calls, settings, local };
}

/** A 1.13 definitions page (0.7.0): the tab's top level is these alone. */
interface DefinitionPage {
  type: string;
  name: string;
  desc: string;
  displayValue?: () => string;
  status?: () => "warning" | null;
  items: { type: string; heading?: string; items: Record<string, unknown>[] }[];
}

function definitionPages(tab: GentlePomoSettingTab): DefinitionPage[] {
  return tab.getSettingDefinitions() as unknown as DefinitionPage[];
}

/**
 * Every group on every page, in order, as display() shows them: a group with
 * no heading on 1.13 (its page says it) is given its page's name back — which
 * is only right while such a group is its page's ONLY one (tested below).
 */
function definitionGroups(tab: GentlePomoSettingTab) {
  return definitionPages(tab).flatMap((page) =>
    page.items.map((group) => ({
      page: page.name,
      heading: group.heading ?? page.name,
      items: group.items,
    }))
  );
}

/** The group with this heading, wherever its page is; throws if there is none. */
function groupNamed(tab: GentlePomoSettingTab, heading: string) {
  const found = definitionGroups(tab).find((g) => g.heading === heading);
  if (!found) throw new Error(`no group headed ${heading}`);
  return found;
}

/** Flatten the 1.13 definitions to (heading, name, desc) in render order. */
function declarativeRows(tab: GentlePomoSettingTab) {
  const out: { heading: string; name: string; desc: string }[] = [];
  for (const g of definitionGroups(tab)) {
    for (const item of g.items) {
      out.push({ heading: g.heading, name: String(item.name), desc: String(item.desc ?? "") });
    }
  }
  return out;
}

/** The same, as the pre-1.13 path actually renders it. */
function imperativeRows(tab: GentlePomoSettingTab, el: { settings: Setting[] }) {
  tab.display();
  const out: { heading: string; name: string; desc: string }[] = [];
  let heading = "";
  for (const setting of el.settings) {
    if (setting.heading) {
      heading = setting.name;
      continue;
    }
    out.push({ heading, name: setting.name, desc: setting.desc });
  }
  return out;
}

/**
 * A source file with its comments removed, for the drift guards.
 *
 * Full-line `//` comments only, deliberately: stripping every `//` would cut a
 * line short at an https URL, and the tab is full of them.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function rowFor(el: { settings: Setting[] }, name: string): Setting {
  const found = el.settings.find((s) => s.name === name && !s.heading);
  if (!found) throw new Error(`no setting row named ${name}`);
  return found;
}

function componentOf(el: { settings: Setting[] }, name: string): RecordedComponent {
  const c = rowFor(el, name).components[0];
  if (!c) throw new Error(`setting ${name} rendered no component`);
  return c;
}

let ctx: ReturnType<typeof makeTab>;
beforeEach(() => {
  ctx = makeTab();
});

describe("the two settings paths cannot drift", () => {
  it("renders exactly the same rows, in the same groups, in the same order", () => {
    expect(imperativeRows(ctx.tab, ctx.el)).toEqual(declarativeRows(ctx.tab));
  });

  it("hands 1.13 a usable definition for every row", () => {
    // The comparison above only looks at names and descriptions, so a mapper
    // that dropped `render` would still line up — and every music link row
    // would render on 1.13 as a label with no box under it.
    const pages = definitionPages(ctx.tab);
    // Every top-level item a page, every page's items groups, none empty.
    expect(pages.length).toBeGreaterThan(0);
    let rows = 0;
    for (const page of pages) {
      expect(page.type, page.name).toBe("page");
      expect(page.items.length, page.name).toBeGreaterThan(0);
      for (const group of page.items) {
        expect(group.type, page.name).toBe("group");
        expect(group.items.length, `${page.name} / ${String(group.heading)}`).toBeGreaterThan(0);
        for (const item of group.items) {
          const kinds = ["control", "render", "action"].filter((k) => item[k] !== undefined);
          expect(kinds, `${page.name} / ${String(item.name)}`).toHaveLength(1);
          rows++;
        }
      }
    }
    expect(rows).toBe(declarativeRows(ctx.tab).length);
  });

  it("keeps the music link rows as render rows, not declared controls", () => {
    // Load-bearing: the link check owns a debounce and a staleness token, and
    // the declarative `validate` hook is awaited inside the control's own
    // per-keystroke handler with no sequencing — a slow answer to an old
    // keystroke would land after a newer one.
    const music = groupNamed(ctx.tab, "Music");
    let seen = 0;
    for (const item of music.items) {
      const name = String(item.name);
      if (!name.startsWith("Music link") && !name.startsWith("Name for link")) continue;
      expect(typeof item.render, name).toBe("function");
      seen++;
    }
    expect(seen).toBe(6);
  });

  it("covers every group heading", () => {
    ctx.tab.display();
    const headings = ctx.el.settings.filter((s) => s.heading).map((s) => s.name);
    // Page by page since 0.7.0 (the Timer page's four, then Status bar …),
    // so Long break and Daily focus goal moved up from where they sat.
    expect(headings).toEqual([
      "Display & behavior",
      "Timer appearance",
      "Long break",
      "Daily focus goal",
      // Desktop only (0.6.8) — phones and tablets have no status bar.
      "Status bar",
      "Audio",
      // 0.6.7: one group per moment, as in the timer panel's gear.
      "When focus ends",
      "When a break ends",
      // Desktop only — the mock's Platform is the desktop app by default.
      "Notifications",
      "Music",
      // 0.6.9: the folder, the log's three choices and its five commands.
      "Daily log",
      // 0.7.0: code to paste, right after the log it reads.
      "Log tables",
      "Task picker",
      "Task integration",
    ]);
  });

  it("gives every row a control, a rendered body or a button", () => {
    ctx.tab.display();
    for (const setting of ctx.el.settings) {
      if (setting.heading) continue;
      // The moment groups' outcome lines are text, not controls — they carry no
      // component by design and identify themselves with their own class. So
      // is the Log tables' code preview (0.7.0).
      if (setting.settingEl.classes.includes("gp-setting-summary")) continue;
      if (setting.settingEl.classes.includes("gp-setting-code")) continue;
      expect(setting.components.length, `${setting.name} rendered nothing`).toBeGreaterThan(0);
    }
  });

  it("clears the container first, so a re-render cannot double every row", () => {
    ctx.tab.display();
    const first = ctx.el.settings.length;
    ctx.tab.display();
    expect(ctx.el.settings).toHaveLength(first);
  });
});

describe("the settings pages (0.7.0, Obsidian 1.13+)", () => {
  const raw = (tab: GentlePomoSettingTab) =>
    definitionPages(tab).map((page) => [page.name, page.items.map((g) => g.heading ?? null)]);

  it("puts every group on a page, in this order, the top level holding pages alone", () => {
    expect(raw(ctx.tab)).toEqual([
      ["Timer", ["Display & behavior", "Timer appearance", "Long break", "Daily focus goal"]],
      // A group named as its page loses the heading: the page's title says it.
      ["Status bar", [null]],
      [
        "Sounds and notifications",
        ["Audio", "When focus ends", "When a break ends", "Notifications"],
      ],
      ["Music", [null]],
      ["Daily log", [null]],
      ["Log tables", [null]],
      ["Tasks", ["Task picker", "Task integration"]],
    ]);
  });

  it("drops a heading only when it is its page's name, on a page of that one group", () => {
    // What definitionGroups relies on to give such a group its heading back,
    // so the two paths can be compared row for row.
    const flat: string[] = [];
    ctx.tab.display();
    for (const s of ctx.el.settings) if (s.heading) flat.push(s.name);
    for (const page of definitionPages(ctx.tab)) {
      for (const group of page.items) {
        if (group.heading !== undefined) {
          expect(group.heading, page.name).not.toBe(page.name);
          continue;
        }
        expect(page.items, page.name).toHaveLength(1);
        // display(), which has no page titles, shows the heading.
        expect(flat, page.name).toContain(page.name);
      }
    }
  });

  it("builds no Status bar page and no Notifications group on a phone or tablet, and says Sounds", () => {
    Platform.isDesktopApp = false;
    try {
      const pages = raw(makeTab().tab);
      expect(pages.map(([name]) => name)).toEqual([
        "Timer",
        "Sounds",
        "Music",
        "Daily log",
        "Log tables",
        "Tasks",
      ]);
      expect(pages[1][1]).toEqual(["Audio", "When focus ends", "When a break ends"]);
    } finally {
      Platform.isDesktopApp = true;
    }
  });

  it("gives every page a short description and names every page once", () => {
    const pages = definitionPages(ctx.tab);
    expect(new Set(pages.map((p) => p.name)).size).toBe(pages.length);
    for (const page of pages) {
      expect(page.desc.length, page.name).toBeGreaterThan(0);
      // A phone shows the row's value beside it: one sentence, no more.
      expect(page.desc.split(/(?<=\.) /), page.name).toHaveLength(1);
    }
  });

  it("works each value out when it is drawn, from the settings as they are then", () => {
    const c = makeTab({ logFolderPath: "Logs", queryColumns: "task" });
    const value = (name: string) =>
      definitionPages(c.tab)
        .find((p) => p.name === name)
        ?.displayValue?.();
    expect(value("Daily log")).toBe("Logs");
    expect(value("Log tables")).toBe("1 column · Last 7 days");
    // Obsidian keeps the definitions it read at load: the same functions must
    // give the new values, never the ones the tab started with.
    const pages = definitionPages(c.tab);
    c.settings.logFolderPath = "Elsewhere";
    c.settings.queryColumns = "task,date";
    c.settings.showMusicPlayer = false;
    c.settings.soundEnabled = false;
    c.settings.showTaskSelector = false;
    c.settings.showInStatusBar = false;
    c.settings.theme = "pixel-city";
    const values = Object.fromEntries(pages.map((p) => [p.name, p.displayValue?.()]));
    expect(values).toEqual({
      Timer: "Pixel city",
      "Status bar": "Off",
      "Sounds and notifications": "Timer sounds off",
      Music: "Off",
      "Daily log": "Elsewhere",
      "Log tables": "2 columns · Last 7 days",
      Tasks: "Picker off",
    });
  });

  it("puts a warning sign on Music for a link that isn't a YouTube link, and on Daily log for a folder it can't list — each for its own", () => {
    const status = (c: ReturnType<typeof makeTab>, name: string) =>
      definitionPages(c.tab)
        .find((p) => p.name === name)
        ?.status?.() ?? null;
    const LOGS = { "Pomodoro_logs/2026-10-23-gentle-pomodoro-log.md": "" };
    const GOOD_LINK = "https://youtu.be/abcdefghijk";
    const ok = makeTab({ musicUrl: GOOD_LINK, logFolderPath: "Pomodoro_logs" }, LOGS);
    expect(status(ok, "Music")).toBeNull();
    expect(status(ok, "Daily log")).toBeNull();
    // A bad link alone: only Music says so.
    const badLink = makeTab(
      { musicUrl2: "https://example.com/song", logFolderPath: "Pomodoro_logs" },
      LOGS
    );
    expect(status(badLink, "Music")).toBe("warning");
    expect(status(badLink, "Daily log")).toBeNull();
    // The folder in other capitals alone (the timer writes there, the
    // commands can't list it): only Daily log says so.
    const badFolder = makeTab({ musicUrl: GOOD_LINK, logFolderPath: "pomodoro_logs" }, LOGS);
    expect(status(badFolder, "Music")).toBeNull();
    expect(status(badFolder, "Daily log")).toBe("warning");
    expect(status(makeTab({ logFolderPath: "/" }), "Daily log")).toBe("warning");
    expect(status(makeTab({ logFolderPath: "" }), "Daily log")).toBeNull();
    // No other page has a sign.
    for (const page of definitionPages(badLink.tab)) {
      if (page.name === "Music" || page.name === "Daily log") continue;
      expect(page.status, page.name).toBeUndefined();
    }
  });

  it("works each warning out when it is drawn, as it does each value", () => {
    // Obsidian keeps the definitions it read at load: a sign worked out then
    // would show the state the plugin loaded with for the whole session.
    const c = makeTab(
      { musicUrl: "https://youtu.be/abcdefghijk", logFolderPath: "Pomodoro_logs" },
      { "Pomodoro_logs/2026-10-23-gentle-pomodoro-log.md": "" }
    );
    const pages = definitionPages(c.tab);
    const status = (name: string) => pages.find((p) => p.name === name)?.status?.() ?? null;
    expect(status("Music")).toBeNull();
    expect(status("Daily log")).toBeNull();
    c.settings.musicUrl3 = "https://example.com/song";
    c.settings.logFolderPath = "pomodoro_logs";
    expect(status("Music")).toBe("warning");
    expect(status("Daily log")).toBe("warning");
  });

  it("hands Obsidian values and warnings that cannot throw, whatever the settings hold", () => {
    // 1.13.7 calls displayValue with no try: one throw takes the whole list
    // down. The definitions must wrap every page's functions, not only the
    // helpers in settingPages.ts that are careful today.
    const c = makeTab();
    for (const key of ["theme", "musicUrl", "logFolderPath", "queryColumns", "taskSource"]) {
      Object.defineProperty(c.settings, key, {
        get() {
          throw new Error(`boom: ${key}`);
        },
      });
    }
    for (const page of definitionPages(c.tab)) {
      expect(() => page.displayValue?.(), page.name).not.toThrow();
      expect(() => page.status?.(), page.name).not.toThrow();
    }
    const value = (name: string) => definitionPages(c.tab).find((p) => p.name === name);
    expect(value("Timer")?.displayValue?.()).toBe("");
    expect(value("Music")?.status?.()).toBeNull();
    expect(value("Daily log")?.status?.()).toBeNull();
    expect(value("Log tables")?.displayValue?.()).toBe("");
  });

  it("never re-renders itself in place: no update() anywhere in the tab", () => {
    // update() re-renders an open page on the SAME Setting objects, clearing
    // only the control column, and every render row here builds outside it
    // too — and it is 1.13-only besides. The page values refresh on Back.
    const source = codeOnly(
      readFileSync(resolve(__dirname, "..", "GentlePomoSettingTab.ts"), "utf8")
    );
    expect(source).not.toMatch(/\.update\(\s*\)/);
  });
});

describe("render rows, built and torn down as a page opens and closes", () => {
  /** Every render row on every page, rendered into a fresh Setting. */
  const renderAll = (tab: GentlePomoSettingTab) =>
    definitionGroups(tab).flatMap((group) =>
      group.items
        .filter((item) => typeof item.render === "function")
        .map((item) => {
          const setting = new Setting();
          const render = item.render as (s: Setting) => (() => void) | void;
          return {
            name: `${group.heading} / ${String(item.name)}`,
            setting,
            teardown: render(setting),
          };
        })
    );

  it("takes out on teardown everything it built outside the control column", () => {
    // Obsidian 1.13 clears only the control column when it re-renders a row
    // in place; anything else a render row added would be there twice.
    const c = makeTab({ logFolderPath: "Logs" });
    const rows = renderAll(c.tab);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      const settingEl = row.setting.settingEl as StubEl;
      const infoEl = row.setting.infoEl as StubEl;
      if (settingEl.children.length + infoEl.children.length === 0) continue;
      expect(typeof row.teardown, row.name).toBe("function");
      if (typeof row.teardown === "function") row.teardown();
      expect(settingEl.children, row.name).toHaveLength(0);
      expect(infoEl.children, row.name).toHaveLength(0);
    }
  });

  it("stops a sound preview when the Sounds page closes, which does not call hide()", () => {
    const c = makeTab();
    const timer = (c.tab as unknown as { plugin: { timer: Record<string, unknown> } }).plugin.timer;
    const seen: string[] = [];
    timer.stopPreview = () => seen.push("stopPreview");
    timer.setPreviewListener = (listener: unknown) =>
      seen.push(listener === null ? "listener off" : "listener on");
    const cues = renderAll(c.tab).filter(
      (row) => row.name.endsWith(FOCUS_END_CUE_NAME) || row.name.endsWith(BREAK_END_CUE_NAME)
    );
    expect(cues).toHaveLength(2);
    expect(seen).toEqual(["listener on", "listener on"]);
    seen.length = 0;
    for (const cue of cues) if (typeof cue.teardown === "function") cue.teardown();
    expect(seen.filter((x) => x === "stopPreview").length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toBe("listener off");
  });

  it("lets go of an outcome line its teardown took out, and only its own", async () => {
    const c = makeTab();
    const summaryRows = () =>
      renderAll(c.tab).filter((row) =>
        (row.setting.settingEl as StubEl).classes.includes("gp-setting-summary")
      );
    const lineOf = (row: { setting: Setting }) => (row.setting.settingEl as StubEl).children[0];
    const [first] = summaryRows();
    const removed = lineOf(first);
    const before = removed.text;
    if (typeof first.teardown === "function") first.teardown();
    await c.tab.setControlValue("autoStartBreak", !c.settings.autoStartBreak);
    // Out of its row, and not written to after it went.
    expect((first.setting.settingEl as StubEl).children).toHaveLength(0);
    expect(removed.text).toBe(before);
    // A late teardown of an old render does not take the newer render's line.
    const [older] = summaryRows();
    const [newer] = summaryRows();
    if (typeof older.teardown === "function") older.teardown();
    await c.tab.setControlValue("autoStartBreak", !c.settings.autoStartBreak);
    expect(lineOf(newer).text).toBe(sessionEndSummary("focus", c.settings));
    await c.tab.setControlValue("autoStartBreak", !c.settings.autoStartBreak);
    expect(lineOf(newer).text).toBe(sessionEndSummary("focus", c.settings));
  });

  it("keeps the answer to a link pasted just before its page closed, for when it opens again", async () => {
    // Back within a moment of pasting: the row's teardown makes it stale, and
    // the answer used to be dropped before it was cached — no verdict, ever.
    const url = "https://youtu.be/abcdefghijk";
    const c = makeTab();
    let answer: (status: number) => void = () => undefined;
    stubRequest.handler = () =>
      new Promise((resolve) => {
        answer = (status) => resolve({ status, json: {} });
      });
    try {
      const rows = renderAll(c.tab);
      const link = rows.find((r) => r.name === "Music / Music link 1");
      if (!link) throw new Error("no link row");
      (link.setting.components[0] as unknown as { change?: (v: string) => void }).change?.(url);
      await flushTab();
      // The page closes while the request is out.
      for (const row of rows) if (typeof row.teardown === "function") row.teardown();
      answer(404);
      await flushTab();
      const cache = (
        c.tab as unknown as { linkProbeCache: Map<string, { result: { status: number } }> }
      ).linkProbeCache;
      expect(cache.get(url)?.result.status).toBe(404);
      // And the row built when it opens again says so, without asking again.
      stubRequest.handler = () => Promise.reject(new Error("asked again"));
      const reopened = renderAll(c.tab).find((r) => r.name === "Music / Music link 1");
      const error = (reopened?.setting.controlEl as StubEl | undefined)?.children.find((x) =>
        x.classes.includes("gp-setting-error")
      );
      expect(error?.text).toMatch(/link/i);
      // Back before the request is even made (in Obsidian, inside the 800 ms
      // debounce; here, while the save it waits for is pending): still asked.
      const c3 = makeTab();
      let asked = 0;
      stubRequest.handler = () => {
        asked++;
        return Promise.resolve({ status: 200, json: { title: "Lofi beats", author_name: "A" } });
      };
      const rows3 = renderAll(c3.tab);
      const link3 = rows3.find((r) => r.name === "Music / Music link 1");
      (link3?.setting.components[0] as unknown as { change?: (v: string) => void }).change?.(url);
      for (const row of rows3) if (typeof row.teardown === "function") row.teardown();
      await flushTab();
      expect(asked).toBe(1);
      const cache3 = (
        c3.tab as unknown as { linkProbeCache: Map<string, { result: { status: number } }> }
      ).linkProbeCache;
      expect(cache3.get(url)?.result.status).toBe(200);
      // Its name is offered to no one: no box was up to offer it in.
      expect(c3.settings.musicName1).toBe("");
      // A link changed while the request was out: nothing kept, nothing painted.
      const c2 = makeTab();
      stubRequest.handler = () =>
        new Promise((resolve) => {
          answer = (status) => resolve({ status, json: {} });
        });
      const rows2 = renderAll(c2.tab);
      const link2 = rows2.find((r) => r.name === "Music / Music link 1");
      (link2?.setting.components[0] as unknown as { change?: (v: string) => void }).change?.(url);
      await flushTab();
      c2.settings.musicUrl = "https://youtu.be/bbbbbbbbbbb";
      answer(404);
      await flushTab();
      const error2 = (link2?.setting.controlEl as StubEl | undefined)?.children.find((x) =>
        x.classes.includes("gp-setting-error")
      );
      expect(error2?.text ?? "").toBe("");
    } finally {
      stubRequest.handler = null;
    }
  });

  it("paints what YouTube said a moment ago when a link's row is built again", () => {
    const url = "https://youtu.be/abcdefghijk";
    const c = makeTab({ musicUrl: url });
    const cache = (c.tab as unknown as { linkProbeCache: Map<string, unknown> }).linkProbeCache;
    const linkRow = () => {
      const row = renderAll(c.tab).find((r) => r.name === "Music / Music link 1");
      if (!row) throw new Error("no link row");
      const error = (row.setting.controlEl as StubEl).children.find((x) =>
        x.classes.includes("gp-setting-error")
      );
      return error?.text ?? "";
    };
    expect(linkRow()).toBe("");
    cache.set(url, { result: { status: 404, name: "" }, at: Date.now() });
    expect(linkRow()).not.toBe("");
    expect(linkRow()).toMatch(/link/i);
    // Too old to stand in for asking: nothing, as the row says nothing it has not asked.
    cache.set(url, { result: { status: 404, name: "" }, at: Date.now() - 10 * 60_000 });
    expect(linkRow()).toBe("");
    // A link YouTube has: nothing either way.
    cache.set(url, { result: { status: 200, name: "Lofi" }, at: 0 });
    expect(linkRow()).toBe("");
  });
});

describe("controls are wired through setControlValue", () => {
  it("seeds each control from the stored value", () => {
    const seeded = makeTab({
      logFolderPath: "logs/pomodoro",
      autoOpenOnStartup: false,
      theme: "frosted-glass",
      longBreakMinutes: 17,
      taskSelectorDays: 14,
    });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Pomodoro logs folder").value).toBe("logs/pomodoro");
    expect(componentOf(seeded.el, "Auto-open on startup").value).toBe(false);
    expect(componentOf(seeded.el, "Theme").value).toBe("frosted-glass");
    expect(componentOf(seeded.el, "Long break duration (minutes)").value).toBe("17");
    // Persisted as a number, rendered as a string option key.
    expect(componentOf(seeded.el, "Task lookahead window").value).toBe("14");
  });

  it("writes a toggle through, side effects and all", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Loop music").change?.(false as never);
    expect(ctx.settings.musicLoop).toBe(false);
  });

  it("routes the status-bar toggle to its own setter rather than the raw field", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Show in status bar").change?.(false as never);
    expect(ctx.calls.map((c) => c.method)).toContain("setStatusBarVisibility");
  });

  it("drops every remembered position when resume is switched off", () => {
    ctx.tab.display();
    componentOf(ctx.el, "Resume where you left off").change?.(false as never);
    expect(ctx.calls.map((c) => c.method)).toContain("clearAllMusicPositions");
    // Unconditional save: clearAllMusicPositions only saves when it had
    // something to clear, so without this the toggle reverts on restart.
    expect(ctx.calls.map((c) => c.method)).toContain("saveSettings");
  });

  it("refuses a number the validation rejects instead of storing NaN", () => {
    ctx.tab.display();
    const before = ctx.settings.longBreakMinutes;
    componentOf(ctx.el, "Long break duration (minutes)").change?.("" as never);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("not a number" as never);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("0" as never);
    expect(ctx.settings.longBreakMinutes).toBe(before);
    componentOf(ctx.el, "Long break duration (minutes)").change?.("25" as never);
    expect(ctx.settings.longBreakMinutes).toBe(25);
  });

  it("puts a new long break length on a long break already on the clock", async () => {
    // The engine decides whether the session on the clock is a long break;
    // the tab only has to tell it, after the save, and only for a value it
    // stored. Before 0.6.8 it never did, so the clock kept the old length
    // while start() logged the new one as Scheduled::.
    await ctx.tab.setControlValue("longBreakMinutes", "0");
    expect(ctx.calls.map((c) => c.method)).not.toContain("updateDuration");

    await ctx.tab.setControlValue("longBreakMinutes", "20");
    expect(ctx.settings.longBreakMinutes).toBe(20);
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.indexOf("saveSettings")).toBeLessThan(methods.indexOf("updateDuration"));
    expect(ctx.calls.find((c) => c.method === "updateDuration")?.args).toEqual([
      "longBreakMinutes",
    ]);
  });

  it("does not persist a blank number box as zero", () => {
    // Both paths commit on every keystroke, so clearing a field to retype it
    // must not write an intermediate value — and Number("") is 0, which for
    // the daily focus goal is the value that DISABLES it. The pre-0.5.8
    // imperative path used parseInt, which rejected a blank box; routing both
    // paths through Number() quietly lost that.
    const seeded = makeTab({ dailyFocusGoalMinutes: 120 });
    seeded.tab.display();
    const goal = componentOf(seeded.el, "Daily focus goal (minutes)");
    goal.change?.("" as never);
    goal.change?.("   " as never);
    expect(seeded.settings.dailyFocusGoalMinutes).toBe(120);
    // A real zero is still how the goal is switched off.
    goal.change?.("0" as never);
    expect(seeded.settings.dailyFocusGoalMinutes).toBe(0);
  });

  it("keeps rejecting a blank box for every other number field", () => {
    const seeded = makeTab({ longBreakMinutes: 15, longBreakEvery: 4, taskSelectorDays: 7 });
    seeded.tab.display();
    for (const [name, expected] of [
      ["Long break duration (minutes)", 15],
      ["Focus sessions before a long break", 4],
    ] as const) {
      componentOf(seeded.el, name).change?.("" as never);
    }
    componentOf(seeded.el, "Task lookahead window").change?.("" as never);
    expect(seeded.settings.longBreakMinutes).toBe(15);
    expect(seeded.settings.longBreakEvery).toBe(4);
    expect(seeded.settings.taskSelectorDays).toBe(7);
  });

  it("offers every lookahead option, in order", () => {
    ctx.tab.display();
    expect(componentOf(ctx.el, "Task lookahead window").options.map((o) => o.value)).toEqual([
      "3",
      "5",
      "7",
      "14",
      "30",
    ]);
  });

  it("offers every registered theme", () => {
    ctx.tab.display();
    // Registry order, written out rather than derived from THEMES: what the
    // picker offers and the order it offers them in are product decisions, and
    // a test that reads them off the same map cannot notice either changing.
    expect(componentOf(ctx.el, "Theme").options).toEqual([
      { value: "classic", label: "Classic" },
      { value: "frosted-glass", label: "Frosted glass" },
      { value: "frosted-glass-2", label: "Frosted glass 2" },
      { value: "pixel-city", label: "Pixel city" },
    ]);
  });

  it("shows the default theme when data.json holds an id this build does not know", () => {
    // The same hole `taskSource` had, for the same reason: coerceToDefaults
    // only drops a stored value whose TYPE disagrees, and a theme id is a
    // string whatever it says. A newer theme synced from another device, or
    // one left behind by a downgrade, therefore reaches the dropdown intact.
    //
    // The view already resolves it — the square falls back to Classic rather
    // than rendering empty — so reading the field raw here made the two
    // disagree: a dropdown showing NO selection at all, beside a timer that is
    // plainly wearing a theme. Asserted through the rendered control, not
    // through getControlValue, because what was wrong was what the user saw.
    const c = makeTab({ theme: "aurora-borealis" as never });
    c.tab.display();
    const component = componentOf(c.el, "Theme");
    expect(component.value).toBe(DEFAULT_THEME);
    // And the fallback has to be one of the options, or the select still shows
    // a blank row — which is the whole failure, one step later.
    expect(component.options.map((o) => o.value)).toContain(DEFAULT_THEME);
  });
});

describe("marker maintenance buttons", () => {
  const rows = [
    ["Check for misplaced pomodoro count markers", "Check", "checkPomodoroMarkers", false],
    ["Repair misplaced pomodoro count markers", "Repair", "repairPomodoroMarkers", false],
    ["Remove misplaced pomodoro count markers", "Remove", "removeMisplacedPomodoroMarkers", true],
    ["Remove all pomodoro count markers", "Remove all", "removeAllPomodoroMarkers", true],
  ] as const;

  for (const [name, label, method, destructive] of rows) {
    it(`renders "${label}" and calls ${method}`, () => {
      ctx.tab.display();
      const c = componentOf(ctx.el, name);
      expect(c.kind).toBe("button");
      expect(c.buttonText).toBe(label);
      c.click?.();
      expect(ctx.calls.map((x) => x.method)).toContain(method);
    });

    it(`${destructive ? "marks" : "does not mark"} "${label}" destructive`, () => {
      // The two that delete counts must read as destructive. This is the one
      // thing the pre-1.13 path does that 1.13's action rows cannot, so it has
      // no counterpart to be checked against.
      ctx.tab.display();
      expect(componentOf(ctx.el, name).destructive).toBe(destructive);
    });
  }
});

describe("music link rows", () => {
  it("renders a text box per slot, seeded from its own setting", () => {
    const seeded = makeTab({ musicUrl: "https://youtu.be/aaaaaaaaaaa", musicUrl3: "" });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Music link 1").value).toBe("https://youtu.be/aaaaaaaaaaa");
    expect(componentOf(seeded.el, "Music link 3").value).toBe("");
  });

  it("renders a name box per slot with its own placeholder", () => {
    const seeded = makeTab({ musicName2: "Rainy" });
    seeded.tab.display();
    expect(componentOf(seeded.el, "Name for link 2").value).toBe("Rainy");
    expect(componentOf(seeded.el, "Name for link 1").placeholder).toBe("Lofi");
  });

  it("only the first link carries the long explanation", () => {
    ctx.tab.display();
    expect(rowFor(ctx.el, "Music link 1").desc).not.toEqual(rowFor(ctx.el, "Music link 2").desc);
    expect(rowFor(ctx.el, "Music link 2").desc).toEqual(rowFor(ctx.el, "Music link 3").desc);
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the end-of-session rows. Four INDEPENDENT switches: two sounds and
// the two auto-start toggles that moved here from the timer panel. Nothing is
// conditional, which is the point — an earlier cut hid each chime while its
// auto-start was on, and a control vanishing because you turned something ON
// reads backwards. Since 0.6.7 they sit in one group per moment rather than
// under Audio.
// ---------------------------------------------------------------------------
describe("the end-of-session switches", () => {
  const names = (el: { settings: Setting[] }) =>
    el.settings.filter((s) => !s.heading).map((s) => s.name);

  const AUDIO_ROWS = [
    MASTER_SOUND_LABEL,
    "Play it when focus time is up",
    AUTO_START_BREAK_LABEL,
    "Play it when break time is up",
    AUTO_START_FOCUS_LABEL,
  ];

  it("shows all four rows whatever the auto-start toggles are set to", () => {
    for (const overrides of [
      { autoStartBreak: false, autoStartFocus: false },
      { autoStartBreak: true, autoStartFocus: false },
      { autoStartBreak: false, autoStartFocus: true },
      { autoStartBreak: true, autoStartFocus: true },
    ]) {
      const c = makeTab(overrides);
      c.tab.display();
      for (const row of AUDIO_ROWS) {
        expect(names(c.el), `${row} with ${JSON.stringify(overrides)}`).toContain(row);
      }
    }
  });

  it("no row description promises the auto-start path always chimes", () => {
    // It no longer does — the chime toggle governs both paths. A stale
    // "Always chimes" here would be the one place the UI lies about behaviour.
    const c = makeTab();
    c.tab.display();
    for (const setting of c.el.settings) {
      expect(setting.desc.toLowerCase(), setting.name).not.toContain("always chimes");
    }
  });

  it("shows an outcome line under each pair, matching what the panel says", () => {
    const c = makeTab({ autoStartBreak: true, focusEndSoundEnabled: false });
    c.tab.display();
    const summaries = c.el.settings
      .filter((s) => s.settingEl.classes.includes("gp-setting-summary"))
      .map((s) => s.settingEl.children.map((child) => child.text).join(""));

    expect(summaries).toHaveLength(2);
    // The exact question this line exists to answer: auto-start on, chime off.
    expect(summaries[0]).toBe(sessionEndSummary("focus", c.settings));
    expect(summaries[0]).toBe("The break starts, with no sound.");
    expect(summaries[1]).toBe(sessionEndSummary("break", c.settings));
  });

  it("rewrites the outcome line when a setting is written, not just on reopen", async () => {
    // Obsidian 1.13.7 reads the definitions once, at load, and refreshDomState()
    // — all it runs after setControlValue — only re-evaluates predicates and
    // does NOT re-render. A description baked in at definition time would sit
    // there contradicting the toggle the user just flipped.
    const c = makeTab();
    c.tab.display();
    const summaryOf = (edge: "focus" | "break") =>
      c.el.settings
        .filter((s) => s.settingEl.classes.includes("gp-setting-summary"))
        [edge === "focus" ? 0 : 1].settingEl.children.map((child) => child.text)
        .join("");

    expect(summaryOf("focus")).toBe("No sound — the timer counts up.");

    await c.tab.setControlValue("autoStartBreak", true);
    expect(summaryOf("focus")).toBe("The break starts, with no sound.");

    await c.tab.setControlValue("focusEndSoundEnabled", true);
    expect(summaryOf("focus")).toBe("A sound, then the break starts.");

    // And the other edge is untouched by either write.
    expect(summaryOf("break")).toBe("No sound — the timer counts up.");
  });

  it("uses the same auto-start labels as the timer panel", () => {
    // These two strings are identical on both surfaces by design, so they are
    // shared rather than typed twice. The panel cannot be imported by a test
    // (it pulls in the whole Obsidian view), so it is read as text — the same
    // route tests/pixelCityArt.test.ts takes for view assertions.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    expect(view).toContain("AUTO_START_BREAK_LABEL");
    expect(view).toContain("AUTO_START_FOCUS_LABEL");
    expect(view).toContain("MASTER_SOUND_LABEL");
    // ...and not a hand-typed copy that could drift from the tab's. Matched as
    // an ARGUMENT (`, "label")`) rather than as a bare substring: the label also
    // appears in prose comments, and a guard that cannot tell code from a
    // comment fails on the next person who explains why the const exists.
    for (const label of [AUTO_START_BREAK_LABEL, AUTO_START_FOCUS_LABEL, MASTER_SOUND_LABEL]) {
      expect(view, `${label} must come from the shared const`).not.toContain(`, "${label}")`);
    }

    const c = makeTab();
    c.tab.display();
    const names = c.el.settings.filter((s) => !s.heading).map((s) => s.name);
    expect(names).toContain(AUTO_START_BREAK_LABEL);
    expect(names).toContain(AUTO_START_FOCUS_LABEL);
    expect(names).toContain(MASTER_SOUND_LABEL);
  });

  it("groups the end of a session by moment, with the panel's headings in its order", () => {
    // 0.6.7: the tab had "Audio" and "Sounds" side by side — two headings for
    // one idea — with the auto-starts under the first and the sound choosers
    // under the second. It now uses the gear's own headings. The panel cannot
    // be imported, so its section() calls are read as text, comments stripped.
    const shared = ["Audio", "When focus ends", "When a break ends", "Notifications"];
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const panelSections = [...view.matchAll(/\bsection\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(panelSections.filter((h) => shared.includes(h))).toEqual(shared);

    const c = makeTab();
    c.tab.display();
    const tabHeadings = c.el.settings.filter((s) => s.heading).map((s) => s.name);
    expect(tabHeadings.filter((h) => shared.includes(h))).toEqual(shared);
    // Adjacent, too: nothing may be filed between the moments and the mutes.
    const at = tabHeadings.indexOf("Audio");
    expect(tabHeadings.slice(at, at + shared.length)).toEqual(shared);
  });

  it("re-arms the panel's row registries BEFORE any row registers", () => {
    // renderSettingsPanel() runs again on every gear-open and empties the
    // container first, so both registries must be cleared at the TOP. A reset
    // placed lower silently drops every row built above it — which shipped for
    // one commit: `sharedPanelRows = []` sat below the Audio section, so
    // "Timer sounds" registered and was immediately wiped, and changing it in
    // this tab left the panel's toggle stale. Read as text; nothing can import
    // the view.
    // Each registry is checked against ITS OWN first registration, not against
    // the first sharedToggle. Checking one common landmark is what let the
    // third instance of this bug through: the re-arm block sat below the two
    // Timing `numberRow` calls but above every `sharedToggle`, so the old
    // assertion passed while `numberPanelRows` was cleared the instant after
    // those two rows had pushed into it — the caret-guarded re-seed they exist
    // for never ran once in 0.6.3.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const registries: Record<string, string> = {
      sharedPanelRows: 'sharedToggle("',
      numberPanelRows: "numberRow(",
      segmentedPanelRows: "segmentedRow(",
      selectPanelRows: "selectRow<",
      conditionalPanelRows: "onlyWhen(",
      endSummaryLines: 'summaryFor("',
    };

    for (const [field, firstCall] of Object.entries(registries)) {
      const armed = view.indexOf(`this.${field} = [];`);
      const registration = view.indexOf(firstCall);
      expect(armed, `${field} must be re-armed`).toBeGreaterThan(-1);
      expect(registration, `no call site found for ${field} (${firstCall})`).toBeGreaterThan(-1);
      expect(armed, `${field} must be re-armed before the first ${firstCall}`).toBeLessThan(
        registration
      );
    }
  });

  it("re-seeds every panel row type, and guards the number inputs on focus", () => {
    // Reset to defaults in a SECOND panel fans out, so the number inputs are
    // genuinely reachable from elsewhere — the old "nothing else can change
    // them" reasoning was wrong. What that note was really protecting is the
    // caret: writing input.value mid-edit rewrites the field under the cursor.
    // Both properties are read off the shipped source; nothing can import the
    // view to exercise it directly.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const sync = view.slice(view.indexOf("private syncSettingsPanel()"));
    const body = sync.slice(0, sync.indexOf("\n  }"));

    for (const registry of [
      "sharedPanelRows",
      "segmentedPanelRows",
      "numberPanelRows",
      "selectPanelRows",
      "conditionalPanelRows",
      "endSummaryLines",
    ]) {
      expect(body, `${registry} must be re-seeded`).toContain(registry);
    }
    // It must never rebuild: renderSettingsPanel empties the container and
    // re-registers every listener, and registerDomEvent releases on unload
    // rather than removal — on a 50ms tick that leaks rows by the second.
    expect(body).not.toContain("renderSettingsPanel(");

    // The caret guard, on the number seed specifically.
    const numberRow = view.slice(view.indexOf("const numberRow = ("));
    expect(numberRow.slice(0, 1600)).toContain("activeDocument.activeElement === input");
  });

  it("writes each row through and fans out to open panels", async () => {
    // setControlValue ends in a silent `default: return;` and `key` is a
    // string, so a missing case is a no-op no compiler can see. All four are
    // dual-surface, so the fan-out is what stops an open gear panel showing a
    // stale toggle — the engine is idle and will not reconcile it.
    for (const key of [
      "focusEndSoundEnabled",
      "breakEndSoundEnabled",
      "autoStartBreak",
      "autoStartFocus",
      "soundEnabled",
      "sessionEndNotification",
    ] as const) {
      const c = makeTab();
      c.settings[key] = false;
      await c.tab.setControlValue(key, true);
      expect(c.settings[key], key).toBe(true);
      expect(
        c.calls.some((call) => call.method === "saveSettings"),
        key
      ).toBe(true);
      // The fan-out itself, now observable. Without it an open gear panel keeps
      // showing the old toggle: the engine is idle, so nothing reconciles it.
      expect(
        c.calls.some((call) => call.method === "applySettings"),
        `${key} must fan out to open views`
      ).toBe(true);
      expect(c.tab.getControlValue(key), key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the mixer on both surfaces. Timer volume, Music sound and Music
// volume were gear-panel-only; the two volumes are also the plugin's first
// dual-surface NON-toggle settings, which is why the panel needed a re-seed
// for segmented rows before these rows could be added at all.
// ---------------------------------------------------------------------------
describe("the audio mixer across the two surfaces", () => {
  const audioGroup = (tab: GentlePomoSettingTab) => {
    const group = groupNamed(tab, "Audio");
    return group as unknown as {
      heading: string;
      items: { name: string; desc?: string; control?: { key?: string } }[];
    };
  };

  it("carries both mutes and neither volume", () => {
    // The split is a decision, not an oversight: a level is something you move
    // WHILE LISTENING, which is a timer-panel gesture, and both volumes have
    // been panel-only since 0.1.2. The mutes are policy and belong here — and,
    // since 0.6.7, nothing else: the end-of-session rows moved to one group
    // per moment.
    expect(audioGroup(ctx.tab).items.map((i) => i.name)).toEqual([
      MASTER_SOUND_LABEL,
      MUSIC_SOUND_LABEL,
    ]);
  });

  it("says where the volumes live, so their absence reads as a decision", () => {
    // Without this the tab is simply missing a control the panel has, which is
    // the complaint that started this work. Both switches point at the panel.
    const items = audioGroup(ctx.tab).items;
    const byKey = (key: string) => items.find((i) => i.control?.key === key);
    expect(byKey("soundEnabled")?.desc).toContain("timer panel");
    expect(byKey("musicSoundEnabled")?.desc).toContain("timer panel");
  });

  it("keeps no volume plumbing behind, on either read or write path", async () => {
    // A getControlValue branch or a setControlValue case for a row that no
    // longer exists is dead code that reads as an intention. Both volumes must
    // fall through to the generic passthrough and be unwritable from here.
    const c = makeTab();
    expect(c.settings.soundVolume).toBe(0.7);
    await c.tab.setControlValue("soundVolume", "low");
    await c.tab.setControlValue("musicVolume", "low");
    expect(c.settings.soundVolume, "the tab must not write soundVolume").toBe(0.7);
    expect(c.settings.musicVolume, "the tab must not write musicVolume").toBe(0.7);
  });

  it("still fans the music mute out to open panels", async () => {
    // It is the one mixer control that IS dual-surface, and the mute only
    // reaches the player through the view's musicVolume() accessor — so the
    // fan-out is what actually silences it, not just what repaints a toggle.
    const c = makeTab();
    await c.tab.setControlValue("musicSoundEnabled", false);
    expect(c.settings.musicSoundEnabled).toBe(false);
    expect(c.calls.some((call) => call.method === "applySettings")).toBe(true);
  });
});

describe("the timer panel's length rows", () => {
  // Read as text, like the segmented rows below: nothing can import the view.
  const numberCalls = (src: string) => {
    const out: string[] = [];
    const opener = /\n([ \t]*)numberRow\(/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(src)) !== null) {
      const rest = src.slice(opener.lastIndex);
      out.push(rest.slice(0, rest.indexOf(`\n${match[1]});`)));
    }
    return out;
  };

  it("tell the engine which setting changed, then fan out to the other panels", () => {
    const calls = numberCalls(
      codeOnly(readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8"))
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const key = /settings\.(\w+) = v;/.exec(call)?.[1];
      expect(key, "each row writes one setting").toBeDefined();
      // The key the engine hears must be the one the row wrote: it is how the
      // engine tells "Break (m)" from a long break's own length.
      const told = call.indexOf(`this.timer.updateDuration("${key}");`);
      expect(told, `${key} must reach the engine by its own name`).toBeGreaterThan(-1);
      // The engine emits only for the session this setting times, so a
      // second open panel's row re-seeds from nothing else.
      const fanOut = call.indexOf("this.plugin.applySettingsToOpenViews();");
      expect(fanOut, `${key} must fan out`).toBeGreaterThan(told);
    }
  });
});

describe("the timer panel's segmented rows re-seed", () => {
  // Nothing can import GentlePomoView, so these read it as text — the same
  // route tests/pixelCityArt.test.ts takes for view assertions.
  const view = () => readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");

  /** The bodies of the two `segmentedRow(...)` CALLS, not its definition. */
  // Indent-aware: the music volume row sits inside an `onlyWhen` block since
  // 0.6.4, so a fixed four-space split silently found only one of the two and
  // the assertions below passed over whichever row had moved.
  const segmentedCalls = (src: string) => {
    const out: string[] = [];
    const opener = /\n([ \t]*)segmentedRow\(/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(src)) !== null) {
      const rest = src.slice(opener.lastIndex);
      out.push(rest.slice(0, rest.indexOf(`\n${match[1]});`)));
    }
    return out;
  };

  it("builds both volume rows from the shared stop list, not a re-typed one", () => {
    const calls = segmentedCalls(view());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain("VOLUME_OPTIONS");
      // A second hand-typed list is the drift: the panel's nearest-stop rule
      // would still light "Mid" for a tab that stored 0.6, so the surfaces
      // would look consistent while holding different numbers.
      expect(call).not.toContain('label: "Low"');
    }
  });

  it("re-reads through the live settings object, not the captured one", () => {
    // loadSettings() replaces the settings object wholesale, and this closure
    // now runs on a tick rather than once — the same rule the extracted modules
    // follow (MusicHost, FocusTotalHost: calls, never captured references).
    for (const call of segmentedCalls(view())) {
      expect(call).toContain("() => this.plugin.settings.");
    }
  });

  it("fans a volume change out to the other open panels", () => {
    // Both volumes are dual-surface now, so a change made here has to reach
    // every other open panel's segmented row. Nothing else can: the engine
    // emits nothing at all while the timer is idle, so there is no tick to
    // converge on. Timer volume shipped without this and two open panels
    // genuinely disagreed.
    for (const call of segmentedCalls(view())) {
      expect(call).toContain("applySettingsToOpenViews()");
    }
  });

  it("re-arms the segmented registry BEFORE the first segmented row", () => {
    // Same rule as sharedPanelRows above, and the same shipped bug: a reset
    // placed lower silently drops every row built above it.
    const src = view();
    const armed = src.indexOf("this.segmentedPanelRows = [];");
    const firstRow = src.indexOf("\n    segmentedRow(");
    expect(armed).toBeGreaterThan(-1);
    expect(firstRow).toBeGreaterThan(-1);
    expect(armed, "segmentedPanelRows must be re-armed before the first segmentedRow").toBeLessThan(
      firstRow
    );
  });

  it("re-seeds the segmented rows from syncSettingsPanel, without rebuilding", () => {
    // The crux. syncSettingsPanel() walking only the toggles is exactly the
    // defect this release already shipped once for toggles: the tab moves the
    // value, the panel keeps the old highlight — and because the highlight IS
    // the control, tapping the button that looks active silently writes the
    // old value back over the change just made.
    //
    // And it must re-SEED, never re-render: renderSettingsPanel() empties the
    // container and re-registers every listener, and registerDomEvent releases
    // on unload rather than on removal, so a rebuild on the 50ms tick leaks
    // twenty detached rows a second.
    const src = view();
    const start = src.indexOf("private syncSettingsPanel()");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toContain("this.segmentedPanelRows");
    expect(body).toContain("seed()");
    expect(body).not.toContain("renderSettingsPanel()");
  });

  it("uses the shared mixer labels rather than re-typing them", () => {
    // Read with comments stripped: a label may legitimately be quoted in prose
    // above the row that uses it, and a guard that cannot tell code from a
    // comment fails on the next person who explains why the const exists.
    const code = view().replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
    for (const label of [TIMER_VOLUME_LABEL, MUSIC_SOUND_LABEL, MUSIC_VOLUME_LABEL]) {
      expect(code, `${label} must come from the shared const`).not.toContain(`"${label}"`);
    }
    const src = view();
    expect(src).toContain("TIMER_VOLUME_LABEL");
    expect(src).toContain("MUSIC_SOUND_LABEL");
    expect(src).toContain("MUSIC_VOLUME_LABEL");
  });
});

describe("Task source (issue #4)", () => {
  it("offers the three sources, in the shared wording, on both paths", () => {
    const c = makeTab();
    c.tab.display();
    // The imperative path renders whatever the definitions declare, so reading
    // it back is how the pre-1.13 dropdown gets checked at all — it is dead
    // code on any Obsidian a contributor is actually running.
    const component = componentOf(c.el, TASK_SOURCE_SETTING_NAME);
    expect(component.kind).toBe("dropdown");
    expect(component.options).toEqual(
      TASK_SOURCE_ORDER.map((source) => ({ value: source, label: TASK_SOURCE_LABELS[source] }))
    );
    expect(component.value).toBe("folder");
  });

  it("sits ABOVE the folder path it governs", () => {
    // Choosing "Current note" is what makes that path irrelevant, so the reader
    // has to meet the decision before the field it decides about.
    const c = makeTab();
    const rows = declarativeRows(c.tab)
      .filter((r) => r.heading === "Task picker")
      .map((r) => r.name);
    expect(rows.indexOf(TASK_SOURCE_SETTING_NAME)).toBeLessThan(rows.indexOf("Tasks folder path"));
  });

  it("keeps the folder path row visible in every source", () => {
    // A control that vanished because you changed a dropdown reads as a fault.
    // 0.6.3 learned this with the chimes and deleted the visibility machinery
    // outright; nothing here may bring it back.
    for (const source of TASK_SOURCE_ORDER) {
      const c = makeTab({ taskSource: source });
      const names = declarativeRows(c.tab).map((r) => r.name);
      expect(names, source).toContain("Tasks folder path");
      expect(names, source).toContain("Task lookahead window");
    }
  });

  it("writes the source through, and fans out to open panels", async () => {
    const c = makeTab();
    await c.tab.setControlValue("taskSource", "current-note");

    expect(c.settings.taskSource).toBe("current-note");
    expect(c.calls.some((call) => call.method === "saveSettings")).toBe(true);
    // Dual-surface: without the fan-out the gear panel's own dropdown stays on
    // the old value, and an open picker never reloads against the new scope.
    expect(c.calls.some((call) => call.method === "applySettings")).toBe(true);
  });

  it("NEVER unlinks the current task when the source changes", async () => {
    // The maintainer's second requirement on issue #4. "Show task picker"
    // right beside it DOES unlink on the way off, so this is a real
    // neighbouring behaviour to be told apart, not a hypothetical.
    for (const source of TASK_SOURCE_ORDER) {
      const c = makeTab();
      const timer = { currentTaskName: "Write docs", setTask: () => calls.push("setTask") };
      const calls: string[] = [];
      (c.tab as unknown as { plugin: { timer: unknown } }).plugin.timer = timer;

      await c.tab.setControlValue("taskSource", source);

      expect(calls, source).toEqual([]);
      expect(timer.currentTaskName, source).toBe("Write docs");
    }
  });

  it("turning the picker off unlinks a linked task, whatever it is called (F36)", async () => {
    // Linked is "has a note": a task can be called "No Task", and the name
    // test this replaced left exactly that one linked. A task whose note was
    // deleted mid-session has no note but is held by name for that session,
    // and hiding the picker — the only control that could clear it with the
    // picker gone — must unlink it too (F28). The engine's own predicate,
    // run on this stand-in's fields.
    const cases: [string | undefined, boolean, string[]][] = [
      ["Projects/A.md", false, ["setTask"]],
      [undefined, true, ["setTask"]],
      [undefined, false, []],
    ];
    for (const [path, held, expected] of cases) {
      const c = makeTab();
      const calls: string[] = [];
      (c.tab as unknown as { plugin: { timer: unknown } }).plugin.timer = {
        currentTaskName: "No Task",
        currentTaskPath: path,
        unlinkAtSessionEnd: held,
        holdsTask: TimerEngine.prototype.holdsTask,
        setTask: () => calls.push("setTask"),
      };
      await c.tab.setControlValue("showTaskSelector", false);
      expect(calls, `${String(path)} held ${String(held)}`).toEqual(expected);
    }
  });

  it("refuses a stored value that is not one of the three", async () => {
    const c = makeTab();
    await c.tab.setControlValue("taskSource", "everything, everywhere");
    expect(c.settings.taskSource).toBe("folder");
  });

  it("reads back a resolved value, so the dropdown always shows a selection", () => {
    // coerceToDefaults only drops a value whose TYPE disagrees, so a
    // hand-edited data.json can hold a string that is not one of the three.
    const c = makeTab({ taskSource: "nonsense" as never });
    expect(c.tab.getControlValue("taskSource")).toBe("folder");
  });
});

describe("Task source — one wording, two surfaces", () => {
  it("takes its name and its options from the shared consts in both places", () => {
    // One control asking one question. The user is told the two screens stay in
    // sync, so a re-typed literal in either is a promise quietly broken —
    // the same guard the auto-start labels carry, for the same reason.
    const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    expect(view).toContain("TASK_SOURCE_SETTING_NAME");
    expect(view).toContain("TASK_SOURCE_LABELS");
    expect(view).toContain("TASK_SOURCE_ORDER");

    // Searched over CODE only. These labels are dropdown option values, so
    // unlike the auto-start ones they have no single argument shape to match —
    // and a bare substring search fails on the next person who explains in a
    // comment why the const exists, which is exactly what it did here.
    const literals = [TASK_SOURCE_SETTING_NAME, ...Object.values(TASK_SOURCE_LABELS)];
    const tab = readFileSync(resolve(__dirname, "..", "GentlePomoSettingTab.ts"), "utf8");
    for (const file of [view, tab]) {
      for (const label of literals) {
        expect(codeOnly(file), `${label} must come from the shared const`).not.toContain(
          `"${label}"`
        );
      }
    }
  });
});

describe("the panel's feature-switch sections", () => {
  const view = () => readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");

  /** The body of an `onlyWhen(predicate, …)` block, keyed by its predicate. */
  const gatedBlocks = (src: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const opener = /\n([ \t]*)onlyWhen\(\n\s*\(\) => settings\.(\w+),/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(src)) !== null) {
      const rest = src.slice(opener.lastIndex);
      out[match[2]] = rest.slice(0, rest.indexOf(`\n${match[1]});`));
    }
    return out;
  };

  it("gates the task-source row on the picker's own switch", () => {
    // Turning "Show task picker" off hides the picker AND unlinks the task,
    // so where that picker looks is then a setting for something absent.
    const block = gatedBlocks(view()).showTaskSelector;
    expect(block, "no onlyWhen block for showTaskSelector").toBeDefined();
    expect(block).toContain('section("Tasks")');
    expect(block).toContain("selectRow<");
  });

  it("gates both music rows on the music player's own switch", () => {
    // With the player off the iframe is destroyed, so a mute and a level here
    // would govern nothing that exists.
    const block = gatedBlocks(view()).showMusicPlayer;
    expect(block, "no onlyWhen block for showMusicPlayer").toBeDefined();
    expect(block).toContain("MUSIC_SOUND_LABEL");
    expect(block).toContain("MUSIC_VOLUME_LABEL");
  });

  it("leaves the timer's own audio rows ungated", () => {
    // Only the two rows belonging to the music player move. "Timer sounds" and
    // "Timer volume" answer to nothing above them and must never disappear.
    const gated = Object.values(gatedBlocks(view())).join("\n");
    expect(gated).not.toContain("MASTER_SOUND_LABEL");
    expect(gated).not.toContain("TIMER_VOLUME_LABEL");
    // Nor may the four end-of-session rows, which have no feature switch at
    // all — 0.6.3 deleted the machinery that hid those and this is not it back.
    expect(gated).not.toContain("AUTO_START_BREAK_LABEL");
    expect(gated).not.toContain("AUTO_START_FOCUS_LABEL");
    expect(gated).not.toContain('sharedToggle("focusEndSoundEnabled"');
    expect(gated).not.toContain('sharedToggle("breakEndSoundEnabled"');
  });

  it("hides by CSS class on the tick, never by re-rendering", () => {
    // renderSettingsPanel() empties the container and re-registers every
    // listener, and registerDomEvent releases on unload rather than removal —
    // rebuilding on a 50ms tick leaks rows by the second. The sync must reach
    // for a class instead. (That it must not call renderSettingsPanel at all is
    // asserted separately, on the whole method.)
    const src = view();
    const sync = src.slice(src.indexOf("private syncSettingsPanel()"));
    const body = sync.slice(0, sync.indexOf("\n  }"));
    expect(body).toContain("conditionalPanelRows");
    expect(body).toContain('toggleClass("gp-hidden"');
  });

  it("keeps both parent switches on a surface the panel cannot hide", () => {
    // A section that hides its own way back is a trap. Both switches live in
    // the settings tab, and so do the rows this hides.
    const c = makeTab();
    c.tab.display();
    const names = c.el.settings.filter((s) => !s.heading).map((s) => s.name);
    expect(names).toContain("Show task picker");
    expect(names).toContain("Show music player");
    expect(names).toContain(TASK_SOURCE_SETTING_NAME);
    expect(names).toContain(MUSIC_SOUND_LABEL);
  });
});

describe("the panel's captions", () => {
  it("keeps only the two end-of-session outcome lines", () => {
    // The master-sound and music-mute captions came out in 0.6.4: the Audio
    // section now shows two matched pairs (mute + level, twice), so the layout
    // makes the scope argument the prose used to. The two lines under the
    // end-of-session pairs STAY — they answer a question the labels genuinely
    // cannot ("does it still play if the break auto-starts?").
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const panel = src.slice(src.indexOf("renderSettingsPanel() {"));
    const captions = panel.match(/gp-settings-hint/g) ?? [];
    expect(captions).toHaveLength(1); // the one summaryFor() builds, used twice
    expect(panel).toContain("sessionEndSummary");
  });
});

describe("the picker's live-reload guard has a trigger for every field it watches", () => {
  // GentlePomoView.applySettings reloads an OPEN task picker when
  // taskSettingsKey() moves. That guard only runs from applySettings, and the
  // engine emits nothing while the timer is idle — which is exactly when
  // someone is sitting in the settings tab. So every field the key names must
  // fan out, or the guard covers a subset of what it claims to. It shipped
  // covering one field of three.
  const watched = (): string[] => {
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const fn = src.slice(src.indexOf("private taskSettingsKey()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // Any read of a settings field, not just the fully-braced `${s.x}` form:
    // the slice is already the function body, so there is nothing else in it
    // for the looser pattern to catch — and a fourth field added as
    // `${s.a}${s.b}` or via a local would otherwise slip past the guard
    // whose whole job is to notice it.
    return [...new Set([...body.matchAll(/\bs\.(\w+)/g)].map((m) => m[1]))];
  };

  it("names three fields, so a fourth cannot be added unnoticed", () => {
    expect(watched().sort()).toEqual(["taskSelectorDays", "taskSource", "tasksPath"]);
  });

  it("fans every one of them out to open views", async () => {
    const sample: Record<string, unknown> = {
      taskSource: "open-notes",
      tasksPath: "projects/active",
      taskSelectorDays: "30",
    };
    for (const key of watched()) {
      const c = makeTab();
      await c.tab.setControlValue(key, sample[key]);
      expect(
        c.calls.some((call) => call.method === "saveSettings"),
        key
      ).toBe(true);
      expect(
        c.calls.some((call) => call.method === "applySettings"),
        `${key} is in taskSettingsKey() but never reaches an open picker`
      ).toBe(true);
    }
  });
});

describe("the panel's Reset to defaults", () => {
  const panel = () => {
    const src = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
    const whole = src.slice(src.indexOf("renderSettingsPanel() {"));
    const split = whole.indexOf(
      'const resetWrap = this.settingsPanel.createDiv("gp-settings-reset")'
    );
    return {
      rows: whole.slice(0, split),
      reset: whole.slice(split, whole.indexOf("\n  }", split)),
    };
  };

  it("restores every setting the panel's own controls write", () => {
    // A one-off list per control is how taskSource came to be the single
    // panel-visible row that ignored the button. Derived from the handlers
    // instead, so the next control added is covered on the day it lands.
    const { rows, reset } = panel();
    // Two ways a panel row writes a setting: directly (`settings.focusMinutes =`)
    // and through the shared-toggle helper, which writes `settings[key]` off a
    // key it was handed. Reading only the first form finds five of eleven.
    const written = new Set([
      ...[...rows.matchAll(/\bsettings\.(\w+) =/g)].map((m) => m[1]),
      ...[...rows.matchAll(/sharedToggle\("(\w+)"/g)].map((m) => m[1]),
    ]);
    expect(written.size, "no panel writers found — the slice is wrong").toBeGreaterThan(9);
    for (const key of written) {
      expect(reset, `Reset to defaults never restores ${key}`).toContain(`settings.${key} =`);
    }
  });
});

// ---------------------------------------------------------------------------
// 0.6.6 — the session-end notification (the follow-up on issue #4). One switch
// for both edges, on both surfaces, desktop only.
// ---------------------------------------------------------------------------
describe("the Notifications switch", () => {
  const view = () => readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8");
  const names = (el: { settings: Setting[] }) => el.settings.map((s) => s.name);

  it("is on the desktop app's settings tab, on both render paths", () => {
    const c = makeTab();
    expect(declarativeRows(c.tab)).toContainEqual(
      expect.objectContaining({ heading: "Notifications", name: SESSION_END_NOTIFICATION_LABEL })
    );
    c.tab.display();
    expect(names(c.el)).toContain(SESSION_END_NOTIFICATION_LABEL);
  });

  it("is not built on the mobile apps, heading included", () => {
    // They have no system notifications; a switch that cannot do anything on
    // the device in your hand is a switch that lies. And an empty heading left
    // behind would be its own small lie.
    Platform.isDesktopApp = false;
    try {
      const c = makeTab();
      const declared = declarativeRows(c.tab);
      expect(declared.map((r) => r.heading)).not.toContain("Notifications");
      c.tab.display();
      expect(names(c.el)).not.toContain("Notifications");
      expect(names(c.el)).not.toContain(SESSION_END_NOTIFICATION_LABEL);
    } finally {
      Platform.isDesktopApp = true;
    }
  });

  it("shows a sample when switched ON, and only then", async () => {
    // The sample is when the operating system asks whether to allow
    // notifications — it should ask now, not at the end of the next session.
    const on = makeTab({ sessionEndNotification: false });
    await on.tab.setControlValue("sessionEndNotification", true);
    expect(on.calls.filter((c) => c.method === "previewSessionEndNotification")).toHaveLength(1);

    const off = makeTab({ sessionEndNotification: true });
    await off.tab.setControlValue("sessionEndNotification", false);
    expect(off.settings.sessionEndNotification).toBe(false);
    expect(off.calls.some((c) => c.method === "previewSessionEndNotification")).toBe(false);
    expect(off.calls.some((c) => c.method === "applySettings")).toBe(true);
  });

  it("is wired to its own key, on both render paths", async () => {
    // A copy-paste from the Audio rows above would still carry the right
    // label and heading while flipping the break chime instead.
    const c = makeTab({ sessionEndNotification: false });
    const item = definitionGroups(c.tab)
      .flatMap((g) => g.items as { name: string; control?: { key?: string } }[])
      .find((i) => i.name === SESSION_END_NOTIFICATION_LABEL);
    expect(item?.control?.key).toBe("sessionEndNotification");

    c.tab.display();
    componentOf(c.el, SESSION_END_NOTIFICATION_LABEL).change?.(true as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.settings.sessionEndNotification).toBe(true);
    expect(c.settings.breakEndSoundEnabled).toBe(DEFAULT_SETTINGS.breakEndSoundEnabled);
    expect(c.calls.filter((call) => call.method === "previewSessionEndNotification")).toHaveLength(
      1
    );
  });

  it("shows ONE sample for a quick off-then-on, and none for an on overtaken by an off", async () => {
    // The sample is decided before the save's await and re-checked after it.
    // Decided after, both writes of an off-then-on pair would read the later
    // value and show two; checked only before, an on overtaken by an off would
    // announce "Notifications are on" with the switch off.
    const slowSaves = (c: ReturnType<typeof makeTab>) => {
      const pending: (() => void)[] = [];
      (c.tab as unknown as { plugin: { saveSettings: () => Promise<void> } }).plugin.saveSettings =
        () => new Promise<void>((resolve) => pending.push(resolve));
      return () => pending.splice(0).forEach((resolve) => resolve());
    };
    const previews = (c: ReturnType<typeof makeTab>) =>
      c.calls.filter((call) => call.method === "previewSessionEndNotification").length;

    const offOn = makeTab({ sessionEndNotification: true });
    const flush1 = slowSaves(offOn);
    const a = offOn.tab.setControlValue("sessionEndNotification", false);
    const b = offOn.tab.setControlValue("sessionEndNotification", true);
    flush1();
    await Promise.all([a, b]);
    expect(previews(offOn)).toBe(1);

    const onOff = makeTab({ sessionEndNotification: false });
    const flush2 = slowSaves(onOff);
    const c1 = onOff.tab.setControlValue("sessionEndNotification", true);
    const c2 = onOff.tab.setControlValue("sessionEndNotification", false);
    flush2();
    await Promise.all([c1, c2]);
    expect(previews(onOff)).toBe(0);
    expect(onOff.settings.sessionEndNotification).toBe(false);
  });

  it("runs the panel's after-change hook, after the save", () => {
    // The panel's sample rides on sharedToggle's optional hook. Nothing else
    // calls it, so a helper that stopped running it would silently drop the
    // sample from the panel — the minute-25 permission prompt it exists for.
    const src = codeOnly(view());
    const helper = src.slice(src.indexOf("const sharedToggle = ("));
    const body = helper.slice(0, helper.indexOf("this.sharedPanelRows.push"));
    const save = body.indexOf("await this.plugin.saveSettings();");
    const hook = body.indexOf("afterChange?.(v);");
    expect(save).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(save);
  });

  it("is off by default, for new installs and upgrades alike", () => {
    expect(DEFAULT_SETTINGS.sessionEndNotification).toBe(false);
  });

  it("uses the shared label in the panel, not a typed copy", () => {
    const src = view();
    expect(src).toContain('sharedToggle("sessionEndNotification", SESSION_END_NOTIFICATION_LABEL');
    expect(src).not.toContain(`, "${SESSION_END_NOTIFICATION_LABEL}"`);
  });

  it("is built, previewed and reset only on the desktop app in the panel", () => {
    // Read as text; nothing can import the view. The row sits inside the
    // platform check, so does its reset — a phone must not switch off a
    // choice made on a computer — and the sample fires only when turned on.
    const src = view();
    const panel = src.slice(src.indexOf("renderSettingsPanel() {"));
    const gate = panel.indexOf("if (Platform.isDesktopApp) {");
    const row = panel.indexOf('sharedToggle("sessionEndNotification"');
    expect(gate, "no platform gate around the panel row").toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(gate);
    expect(panel.slice(gate, row)).not.toContain("\n    }");
    expect(panel.slice(gate, row)).toContain('section("Notifications")');
    expect(panel.slice(row, row + 600)).toContain(
      "if (on && settings.sessionEndNotification) this.plugin.previewSessionEndNotification();"
    );

    const reset = panel.slice(panel.indexOf("const resetWrap"));
    expect(reset).toMatch(
      /if \(Platform\.isDesktopApp\) \{\s*settings\.sessionEndNotification = DEFAULT_SETTINGS\.sessionEndNotification;/
    );
  });
});

// ---------------------------------------------------------------------------
// 0.6.7 — the two sound rows (issue #5). They are render rows, so they own
// their reads and writes; what matters is that a file is checked BEFORE it is
// saved, that the row says why a saved file plays the built-in instead, and
// that ▶ honours the master switch.
// ---------------------------------------------------------------------------
describe("the sound rows", () => {
  type Load = { ok: true; buffer: unknown } | { ok: false; problem: string };

  /** Swap in a timer that records what the rows ask of it. */
  function withTimer(c: ReturnType<typeof makeTab>, load: (path: string) => Promise<Load>) {
    const asked: string[] = [];
    const timer = {
      currentTaskName: "No task",
      setTask: () => undefined,
      previewing: null as string | null,
      listener: null as (() => void) | null,
      previewingEdge: () => timer.previewing,
      setPreviewListener: (l: (() => void) | null) => {
        timer.listener = l;
      },
      stopPreview: () => {
        asked.push("stopPreview");
        timer.previewing = null;
        timer.listener?.();
      },
      wakeAudio: () => asked.push("wakeAudio"),
      loadCustomCue: (path: string) => {
        asked.push(`load:${path}`);
        return load(path);
      },
      previewEndCue: (edge: string) => {
        asked.push(`preview:${edge}`);
        return Promise.resolve(c.settings.soundEnabled ? "played" : "muted");
      },
      releaseUnchosenCues: () => undefined,
    };
    (c.tab as unknown as { plugin: { timer: unknown } }).plugin.timer = timer;
    return asked;
  }

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  const statusOf = (s: Setting) =>
    s.infoEl.children.find((child) => child.classes.includes("gp-setting-note"))?.text;

  /** Click the row's chooser, then pick from the list the way a click would. */
  async function pick(c: ReturnType<typeof makeTab>, rowName: string, choice: unknown) {
    const chooser = rowFor(c.el, rowName).components.find((x) => x.kind === "button");
    chooser?.click?.();
    const modal = FuzzySuggestModal.opened as unknown as { onChooseItem: (x: unknown) => void };
    modal.onChooseItem(choice);
    await flush();
  }

  beforeEach(() => {
    Notice.shown.length = 0;
    FuzzySuggestModal.opened = null;
  });

  it("opens each moment's group, above its switch, as render rows on both paths", () => {
    // First, not under the switch: below it the chooser read as the switch's
    // child and looked inert while it was off, though Stop and Skip always
    // play it. The switch's own name ("Play it when…") leans on this order.
    const c = makeTab();
    const rows = declarativeRows(c.tab);
    const group = (heading: string) => rows.filter((r) => r.heading === heading).map((r) => r.name);
    expect(group("When focus ends").slice(0, 2)).toEqual([
      FOCUS_END_CUE_NAME,
      "Play it when focus time is up",
    ]);
    expect(group("When a break ends").slice(0, 2)).toEqual([
      BREAK_END_CUE_NAME,
      "Play it when break time is up",
    ]);
    const cueItems = definitionGroups(c.tab)
      .flatMap((g) => g.items)
      .filter((item) => item.name === FOCUS_END_CUE_NAME || item.name === BREAK_END_CUE_NAME);
    expect(cueItems).toHaveLength(2);
    // Not 1.13's `file` control: below 1.13 that renders as an empty row, and
    // it could not offer the built-ins anyway.
    for (const item of cueItems) expect(typeof item.render).toBe("function");
  });

  it("describes the switch that sits BELOW it, since the order depends on it", () => {
    const c = makeTab();
    const desc = (name: string) => declarativeRows(c.tab).find((r) => r.name === name)?.desc;
    for (const name of [FOCUS_END_CUE_NAME, BREAK_END_CUE_NAME]) {
      expect(desc(name), name).toContain("switch below");
      expect(desc(name), name).toContain("stop or skip");
      // "under Audio" was true until the rows moved; it would now send the
      // reader to a group that no longer holds the switch.
      expect(desc(name), name).not.toContain("Audio");
    }
  });

  it("draws ▶ and a button naming the stored sound", () => {
    const c = makeTab({ focusEndSound: "drum", breakEndSound: "file:Sounds/Chimes/gong.m4a" });
    withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    c.tab.display();

    const focus = rowFor(c.el, FOCUS_END_CUE_NAME).components;
    expect(focus.map((x) => x.kind)).toEqual(["extraButton", "button"]);
    expect(focus[0].tooltip).toBe("Play");
    expect(focus[1].buttonText).toBe("War drum");
    expect(componentOf(c.el, BREAK_END_CUE_NAME).kind).toBe("extraButton");
    expect(
      rowFor(c.el, BREAK_END_CUE_NAME).components.find((x) => x.kind === "button")?.buttonText
    ).toBe("gong.m4a");
  });

  it("puts the status under the description, leaving the two controls one line", () => {
    // In the control column the wrap that gives a message its own line also
    // pushed the full-width phone button below ▶ (Obsidian's app.css makes a
    // settings button 100% wide under 400px). The music link rows can use that
    // column; these, with two controls, cannot.
    const c = makeTab();
    withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    c.tab.display();
    for (const name of [FOCUS_END_CUE_NAME, BREAK_END_CUE_NAME]) {
      const row = rowFor(c.el, name);
      expect(row.settingEl.classes).not.toContain("gp-setting-with-error");
      expect(row.controlEl.children).toEqual([]);
      expect(statusOf(row)).toBe("");
    }
  });

  it("says why a saved file plays the built-in instead", async () => {
    const c = makeTab({ focusEndSound: "file:Sounds/gone.mp3" });
    withTimer(c, () => Promise.resolve({ ok: false, problem: "missing" }));
    c.tab.display();
    await flush();

    expect(statusOf(rowFor(c.el, FOCUS_END_CUE_NAME))).toBe(
      "Not found on this device. Singing bell plays instead."
    );
    // A built-in has nothing to explain, and reads no file to find that out.
    expect(statusOf(rowFor(c.el, BREAK_END_CUE_NAME))).toBe("");
  });

  it("refuses a file that cannot play WITHOUT saving it, and says why", async () => {
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: false, problem: "too-long" }));
    c.tab.display();
    await flush();
    c.calls.length = 0;

    await pick(c, BREAK_END_CUE_NAME, { kind: "file", path: "long.mp3" });

    expect(c.settings.breakEndSound).toBe("ding");
    expect(c.calls.filter((x) => x.method === "saveSettings")).toHaveLength(0);
    expect(asked).not.toContain("preview:break");
    expect(statusOf(rowFor(c.el, BREAK_END_CUE_NAME))).toBe(
      "Longer than 30 seconds. Pick a shorter sound."
    );
  });

  it("saves a file that plays, names it on the button, and plays it once", async () => {
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    c.tab.display();
    await flush();

    await pick(c, FOCUS_END_CUE_NAME, { kind: "file", path: "Sounds/gong.mp3" });

    expect(c.settings.focusEndSound).toBe("file:Sounds/gong.mp3");
    expect(c.settings.breakEndSound).toBe("ding"); // the other edge is untouched
    expect(
      rowFor(c.el, FOCUS_END_CUE_NAME).components.find((x) => x.kind === "button")?.buttonText
    ).toBe("gong.mp3");
    expect(asked).toContain("preview:focus");
  });

  it("wakes the audio inside the click, before anything is awaited", async () => {
    // iOS lets only a user gesture start WebAudio; after the file read the
    // gesture no longer counts, and the pick would play into a parked context.
    // So the wake must already have happened when the click handler RETURNS —
    // checked before anything is flushed, or a wake one await later would pass.
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    c.tab.display();
    await flush();
    asked.length = 0;

    const chooser = rowFor(c.el, FOCUS_END_CUE_NAME).components.find((x) => x.kind === "button");
    chooser?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (x: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/gong.mp3",
    });
    expect(asked).toEqual(["wakeAudio", "stopPreview", "load:Sounds/gong.mp3"]);
    await flush();
  });

  it("saves a built-in straight away", async () => {
    const c = makeTab();
    const asked = withTimer(c, () => Promise.reject(new Error("no file should be read")));
    c.tab.display();
    await flush();

    await pick(c, BREAK_END_CUE_NAME, { kind: "builtin", id: "bell" });

    expect(c.settings.breakEndSound).toBe("bell");
    expect(asked.filter((a) => a.startsWith("load:"))).toEqual([]);
    expect(asked).toContain("preview:break");
  });

  it("does not lose a pick still reading its file when ▶ is pressed", async () => {
    // ▶ re-checks the status line. Sharing the pick's staleness token, that
    // check silently dropped a pick whose file was still loading.
    const c = makeTab();
    let land: (l: Load) => void = () => {};
    withTimer(
      c,
      () =>
        new Promise<Load>((r) => {
          land = r;
        })
    );
    c.tab.display();
    await flush();

    const chooser = rowFor(c.el, FOCUS_END_CUE_NAME).components.find((x) => x.kind === "button");
    chooser?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (x: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/slow.mp3",
    });
    componentOf(c.el, FOCUS_END_CUE_NAME).click?.(); // ▶ while the read is out
    land({ ok: true, buffer: {} });
    await flush();

    expect(c.settings.focusEndSound).toBe("file:Sounds/slow.mp3");
  });

  it("▶ says the timer sounds are off rather than doing nothing", async () => {
    const c = makeTab({ soundEnabled: false });
    withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    c.tab.display();

    componentOf(c.el, FOCUS_END_CUE_NAME).click?.();
    await flush();
    expect(Notice.shown).toEqual([CUE_MUTED_NOTICE]);
    expect(CUE_MUTED_NOTICE).toBe("Timer sounds are off.");
  });

  it("names the saved sound when a later pick is refused mid-save", async () => {
    // A built-in pick writes the setting and waits on the save; a file picked
    // in that window is refused. The button must name what IS stored.
    const c = makeTab();
    withTimer(c, () => Promise.resolve({ ok: false, problem: "too-long" }));
    let saved: () => void = () => {};
    (c.tab as unknown as { plugin: { saveSettings: () => Promise<void> } }).plugin.saveSettings =
      () =>
        new Promise<void>((r) => {
          saved = r;
        });
    c.tab.display();
    await flush();

    const chooser = () =>
      rowFor(c.el, FOCUS_END_CUE_NAME).components.find((x) => x.kind === "button");
    const choose = (x: unknown) =>
      (FuzzySuggestModal.opened as unknown as { onChooseItem: (y: unknown) => void }).onChooseItem(
        x
      );
    chooser()?.click?.();
    choose({ kind: "builtin", id: "drum" });
    chooser()?.click?.();
    choose({ kind: "file", path: "long.mp3" });
    await flush();
    saved();
    await flush();

    expect(c.settings.focusEndSound).toBe("drum");
    expect(chooser()?.buttonText).toBe("War drum");
  });

  it("keeps a refusal on screen when a ▶ pressed earlier finishes after it", async () => {
    // ▶ waits on the saved file; a pick refused in the meantime owns the line.
    const c = makeTab({ focusEndSound: "file:Sounds/saved.mp3" });
    const asked = withTimer(c, (path) =>
      Promise.resolve(
        path === "big.wav" ? { ok: false, problem: "too-large" } : { ok: true, buffer: {} }
      )
    );
    let finishPreview: () => void = () => {};
    (
      c.tab as unknown as { plugin: { timer: { previewEndCue: () => Promise<string> } } }
    ).plugin.timer.previewEndCue = () => {
      asked.push("preview");
      return new Promise<string>((r) => {
        finishPreview = () => r("played");
      });
    };
    c.tab.display();
    await flush();

    componentOf(c.el, FOCUS_END_CUE_NAME).click?.(); // ▶, still waiting
    rowFor(c.el, FOCUS_END_CUE_NAME)
      .components.find((x) => x.kind === "button")
      ?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (y: unknown) => void }).onChooseItem({
      kind: "file",
      path: "big.wav",
    });
    await flush();
    finishPreview();
    await flush();

    expect(statusOf(rowFor(c.el, FOCUS_END_CUE_NAME))).toBe(
      "Larger than 12 MB. Pick a smaller file."
    );
  });

  it("lets go of the old file once a pick is saved, built-ins included", async () => {
    const c = makeTab({ focusEndSound: "file:Sounds/old.mp3" });
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    (
      c.tab as unknown as { plugin: { timer: Record<string, unknown> } }
    ).plugin.timer.releaseUnchosenCues = () => asked.push(`release:${c.settings.focusEndSound}`);
    c.tab.display();
    await flush();

    await pick(c, FOCUS_END_CUE_NAME, { kind: "builtin", id: "ding" });
    // Released AFTER the setting moved, or the old file would still be "chosen".
    expect(asked).toContain("release:ding");
  });

  it("turns ▶ into ■ while that row's preview plays, and ■ stops it", () => {
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    const timer = (
      c.tab as unknown as {
        plugin: { timer: { previewing: string | null; listener: (() => void) | null } };
      }
    ).plugin.timer;
    c.tab.display();
    const play = () => componentOf(c.el, FOCUS_END_CUE_NAME);
    const other = () => componentOf(c.el, BREAK_END_CUE_NAME);
    expect([play().icon, play().tooltip]).toEqual(["play", "Play"]);

    // The engine reports the focus preview playing.
    timer.previewing = "focus";
    timer.listener?.();
    expect([play().icon, play().tooltip]).toEqual(["square", "Stop"]);
    expect(other().icon).toBe("play"); // only the row that is playing

    play().click?.();
    expect(asked.filter((a) => a === "stopPreview")).toHaveLength(1);
    expect(asked.filter((a) => a.startsWith("preview:"))).toEqual([]);
    expect(play().icon).toBe("play");
  });

  it("stops the playing preview the moment another sound is picked", async () => {
    // Not after the new file is read and checked: that can take a moment,
    // and the old sound played on under the choice that replaced it.
    const c = makeTab();
    const asked = withTimer(c, () => new Promise<Load>(() => {})); // never lands
    c.tab.display();
    await flush();
    asked.length = 0;

    rowFor(c.el, FOCUS_END_CUE_NAME)
      .components.find((x) => x.kind === "button")
      ?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (y: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/slow.mp3",
    });
    expect(asked).toContain("stopPreview");
  });

  it("stops the preview, and lets go of the engine, when the settings close", () => {
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    const timer = (c.tab as unknown as { plugin: { timer: { listener: unknown } } }).plugin.timer;
    c.tab.display();
    expect(timer.listener).not.toBe(null);

    c.tab.hide();
    expect(asked).toContain("stopPreview");
    expect(timer.listener).toBe(null);
  });

  it("stops a playing preview when Timer sounds is switched off", async () => {
    // "Every sound the timer makes" — and the preview is the one that can stop.
    const c = makeTab();
    const asked = withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    await c.tab.setControlValue("soundEnabled", true);
    expect(asked).not.toContain("stopPreview");
    await c.tab.setControlValue("soundEnabled", false);
    expect(asked).toContain("stopPreview");
  });

  it("keeps a refusal when ▶ was pressed WHILE the pick was reading", async () => {
    // Round one covered ▶ pressed before a pick; this is ▶ pressed during
    // one, whose preview lands after the refusal is on screen.
    const c = makeTab({ focusEndSound: "file:Sounds/saved.mp3" });
    let refuse: () => void = () => {};
    const asked = withTimer(c, (path) =>
      path === "long.mp3"
        ? new Promise<Load>((r) => {
            refuse = () => r({ ok: false, problem: "too-long" });
          })
        : Promise.resolve({ ok: true, buffer: {} })
    );
    let finishPreview: () => void = () => {};
    (
      c.tab as unknown as { plugin: { timer: { previewEndCue: () => Promise<string> } } }
    ).plugin.timer.previewEndCue = () => {
      asked.push("preview");
      return new Promise<string>((r) => {
        finishPreview = () => r("played");
      });
    };
    c.tab.display();
    await flush();

    rowFor(c.el, FOCUS_END_CUE_NAME)
      .components.find((x) => x.kind === "button")
      ?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (y: unknown) => void }).onChooseItem({
      kind: "file",
      path: "long.mp3",
    });
    componentOf(c.el, FOCUS_END_CUE_NAME).click?.(); // ▶ while long.mp3 is read
    refuse();
    await flush();
    finishPreview();
    await flush();

    expect(statusOf(rowFor(c.el, FOCUS_END_CUE_NAME))).toBe(
      "Longer than 30 seconds. Pick a shorter sound."
    );
  });

  it("lets go of an overtaken pick's file once it lands", async () => {
    // The engine holds a pick's file until the pick decides; a pick that is
    // overtaken (or whose tab closed) has to say so, or it stays decoded.
    const c = makeTab();
    let land: () => void = () => {};
    const asked = withTimer(
      c,
      () =>
        new Promise<Load>((r) => {
          land = () => r({ ok: true, buffer: {} });
        })
    );
    (
      c.tab as unknown as { plugin: { timer: Record<string, unknown> } }
    ).plugin.timer.releaseUnchosenCues = () => asked.push("release");
    c.tab.display();
    await flush();

    rowFor(c.el, FOCUS_END_CUE_NAME)
      .components.find((x) => x.kind === "button")
      ?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (y: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/slow.wav",
    });
    c.tab.hide();
    asked.length = 0;
    land();
    await flush();
    expect(asked).toEqual(["release"]);
  });

  it("checks a picked file AS a pick, so the engine holds it until the save", async () => {
    const c = makeTab();
    const seen: unknown[][] = [];
    withTimer(c, () => Promise.resolve({ ok: true, buffer: {} }));
    const timer = (c.tab as unknown as { plugin: { timer: Record<string, unknown> } }).plugin.timer;
    timer.loadCustomCue = (...args: unknown[]) => {
      seen.push(args);
      return Promise.resolve({ ok: true, buffer: {} });
    };
    c.tab.display();
    await flush();
    await pick(c, FOCUS_END_CUE_NAME, { kind: "file", path: "Sounds/gong.mp3" });
    expect(seen).toContainEqual(["Sounds/gong.mp3", true]);
  });

  it("drops a pick that lands after its page closed, which runs the teardown and not hide()", async () => {
    const c = makeTab();
    let land: (l: Load) => void = () => {};
    const asked = withTimer(
      c,
      () =>
        new Promise<Load>((r) => {
          land = r;
        })
    );
    const item = groupNamed(c.tab, "When focus ends").items.find(
      (i) => i.name === FOCUS_END_CUE_NAME
    );
    const setting = new Setting();
    const teardown = (item?.render as (s: Setting) => (() => void) | void)(setting);
    await flush();
    setting.components.find((x) => x.kind === "button")?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (x: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/slow.mp3",
    });
    if (typeof teardown === "function") teardown();
    land({ ok: true, buffer: {} });
    await flush();
    expect(c.settings.focusEndSound).toBe("bell");
    expect(asked).not.toContain("preview:focus");
    expect(asked).toContain("stopPreview");
  });

  it("drops a pick that lands after the tab was closed", async () => {
    const c = makeTab();
    let land: (l: Load) => void = () => {};
    withTimer(
      c,
      () =>
        new Promise<Load>((r) => {
          land = r;
        })
    );
    c.tab.display();
    await flush();

    const chooser = rowFor(c.el, FOCUS_END_CUE_NAME).components.find((x) => x.kind === "button");
    chooser?.click?.();
    (FuzzySuggestModal.opened as unknown as { onChooseItem: (x: unknown) => void }).onChooseItem({
      kind: "file",
      path: "Sounds/slow.mp3",
    });
    c.tab.hide();
    land({ ok: true, buffer: {} });
    await flush();

    expect(c.settings.focusEndSound).toBe("bell");
  });
});

describe("the status bar group (0.6.8)", () => {
  const names = (el: { settings: Setting[] }) => el.settings.map((s) => s.name);

  it("holds the three status bar rows, on both render paths", () => {
    const c = makeTab();
    const declared = declarativeRows(c.tab).filter((r) => r.heading === "Status bar");
    expect(declared.map((r) => r.name)).toEqual([
      "Show in status bar",
      "Time in status bar",
      "Show today's total as text",
    ]);
    c.tab.display();
    const all = names(c.el);
    const at = all.indexOf("Status bar");
    expect(all.slice(at, at + 4)).toEqual([
      "Status bar",
      "Show in status bar",
      "Time in status bar",
      "Show today's total as text",
    ]);
  });

  it("is not built on the mobile apps, heading included", () => {
    Platform.isDesktopApp = false;
    try {
      const c = makeTab();
      expect(declarativeRows(c.tab).map((r) => r.heading)).not.toContain("Status bar");
      c.tab.display();
      for (const name of [
        "Status bar",
        "Show in status bar",
        "Time in status bar",
        "Show today's total as text",
      ]) {
        expect(names(c.el)).not.toContain(name);
      }
    } finally {
      Platform.isDesktopApp = true;
    }
  });

  it("offers the four time displays, hidden first", () => {
    ctx.tab.display();
    const component = componentOf(ctx.el, "Time in status bar");
    expect(component.options).toEqual([
      { value: "hidden", label: "Hidden" },
      { value: "minutes", label: "Minutes left" },
      { value: "clock", label: "Clock" },
      { value: "end", label: "End time" },
    ]);
    expect(component.value).toBe("hidden");
  });

  it("shows a stored value it does not know as hidden, not as an empty dropdown", () => {
    const c = makeTab({ statusBarTime: "sundial" });
    expect(c.tab.getControlValue("statusBarTime")).toBe("hidden");
  });

  it("routes the time choice through the plugin, which repaints and keeps the legacy field", async () => {
    await ctx.tab.setControlValue("statusBarTime", "minutes");
    expect(ctx.calls).toContainEqual({ method: "setStatusBarTime", args: ["minutes"] });
  });

  it("repaints the goal ring and the panels' goal line when the daily goal changes", async () => {
    // goalMinutes is in the status bar's repaint key, but the timer emits
    // nothing while idle, so without this the ring kept the old goal.
    await ctx.tab.setControlValue("dailyFocusGoalMinutes", "90");
    expect(ctx.settings.dailyFocusGoalMinutes).toBe(90);
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.indexOf("refreshGoalDisplays")).toBeGreaterThan(methods.indexOf("saveSettings"));
    expect(methods.indexOf("saveSettings")).toBeGreaterThanOrEqual(0);
  });

  it("hands a goal change to today's log file, after saving, and nothing it refuses", async () => {
    // Today's file records the goal as it is set now (0.6.9): without this a
    // goal changed after the day's last session left the old number, and the
    // day read it once it was past. The manager waits out the typing itself.
    await ctx.tab.setControlValue("dailyFocusGoalMinutes", "0");
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.filter((m) => m === "goalChanged")).toHaveLength(1);
    expect(methods.indexOf("goalChanged")).toBeGreaterThan(methods.indexOf("saveSettings"));
    // A value the setting refuses changes nothing, so nothing is written.
    ctx.calls.length = 0;
    await ctx.tab.setControlValue("dailyFocusGoalMinutes", "-5");
    await ctx.tab.setControlValue("dailyFocusGoalMinutes", "soon");
    expect(ctx.calls).toEqual([]);
    // No other setting asks for it.
    await ctx.tab.setControlValue("goalNoticeEnabled", false);
    await ctx.tab.setControlValue("dayStartHour", "4");
    expect(ctx.calls.map((c) => c.method)).not.toContain("goalChanged");
  });

  it("re-reads today's total from a new log folder, after saving", async () => {
    // The total's cache is keyed on the date alone, so it kept serving the old
    // folder's number; and nothing repaints while idle.
    ctx.tab.display();
    componentOf(ctx.el, LOG_FOLDER_NAME).change?.("logs/elsewhere" as never);
    await flushTab();
    expect(ctx.settings.logFolderPath).toBe("logs/elsewhere");
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.indexOf("saveSettings")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("logFolderChanged")).toBeGreaterThan(methods.indexOf("saveSettings"));
  });

  it("repaints the status bar when the total-as-text switch moves", async () => {
    // The timer is silent while idle, which is exactly when someone is in this
    // tab, so without the repaint the bar keeps its old text until a session.
    await ctx.tab.setControlValue("statusBarShowTotal", true);
    expect(ctx.settings.statusBarShowTotal).toBe(true);
    const methods = ctx.calls.map((c) => c.method);
    expect(methods.indexOf("saveSettings")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("refreshStatusBar")).toBeGreaterThan(methods.indexOf("saveSettings"));
  });
});

const flushTab = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// 0.6.9 — the log folder row checks what is typed (F5, F37, F61).
describe("the log folder row", () => {
  const LOGS = {
    "Pomodoro_logs/2026-10-01-gentle-pomodoro-log.md": "",
    "Notes/a.md": "",
  };
  /** Type `value` into the row, as each keystroke commits. */
  async function type(c: ReturnType<typeof makeTab>, value: string) {
    componentOf(c.el, LOG_FOLDER_NAME).change?.(value as never);
    await flushTab();
  }
  const note = (c: ReturnType<typeof makeTab>) =>
    rowFor(c.el, LOG_FOLDER_NAME).infoEl.children.find((child) =>
      child.classes.includes("gp-setting-note")
    );

  it("says that an empty folder keeps no log, and what the goal then counts", () => {
    expect(LOG_FOLDER_DESC).toMatch(/empty to keep no log/);
    expect(LOG_FOLDER_DESC).toMatch(/counts only the session that is running/);
    const c = makeTab();
    c.tab.display();
    expect(rowFor(c.el, LOG_FOLDER_NAME).desc).toBe(LOG_FOLDER_DESC);
  });

  it("is a render row on both paths: a control row has nowhere to say anything", () => {
    const group = groupNamed(ctx.tab, "Daily log") as unknown as {
      items: Record<string, unknown>[];
    };
    const row = group.items.find((item) => item.name === LOG_FOLDER_NAME);
    expect(typeof row?.render).toBe("function");
  });

  it("stores the folder without the spaces around it", async () => {
    // normalizePath trims slashes, not spaces: " Pomodoro_logs" was a second
    // folder on macOS, and a trailing space failed every write on Windows.
    const c = makeTab({}, LOGS);
    c.tab.display();
    await type(c, "  Logs/Focus ");
    expect(c.settings.logFolderPath).toBe("Logs/Focus");
  });

  it("refuses the vault's top level, keeps what was saved, and says why", async () => {
    // Lines written there could not be listed again: Refresh, renames and
    // Check found nothing.
    const c = makeTab({ logFolderPath: "Pomodoro_logs" }, LOGS);
    c.tab.display();
    for (const value of ["/", " // ", "\\"]) {
      c.calls.length = 0;
      await type(c, value);
      expect(c.settings.logFolderPath).toBe("Pomodoro_logs");
      expect(c.calls.map((call) => call.method)).not.toContain("saveSettings");
      expect(note(c)?.text).toBe(logFolderRootMessage("Pomodoro_logs"));
      expect(note(c)?.classes).not.toContain("gp-setting-note-info");
    }
    // Typing on clears it.
    await type(c, "Pomodoro_logs");
    expect(note(c)?.text).toBe("");
  });

  it("says, when it refuses the top level, which folder is still in use — none after an emptied box (F32)", async () => {
    // Each keystroke saves: select all and Delete stores "" (no log), so a
    // "/" typed next must not read as if the old folder were still used.
    const c = makeTab({ logFolderPath: "Pomodoro_logs" }, LOGS);
    c.tab.display();
    await type(c, "/");
    expect(note(c)?.text).toBe(
      'Pick a folder inside the vault, not its top level. Not saved — logs still go to "Pomodoro_logs".'
    );
    await type(c, "");
    expect(c.settings.logFolderPath).toBe("");
    await type(c, "/");
    expect(c.settings.logFolderPath).toBe("");
    expect(note(c)?.text).toBe(
      "Pick a folder inside the vault, not its top level. Not saved — no log is kept."
    );
    expect(logFolderRootMessage("/")).toBe(
      "Pick a folder inside the vault, not its top level. Not saved — logs still go to the vault's top level."
    );
  });

  it("says as the tab opens that a stored top level or capitalisation can't be listed, and saves nothing (F29)", () => {
    // Saved before 0.6.9 checked the box: the timer writes there, while Check,
    // Convert and today's total look in the folder the setting names.
    const root = makeTab({ logFolderPath: "/" }, LOGS);
    root.tab.display();
    expect(note(root)?.text).toBe(logFolderProblemNote({ kind: "root" }));
    expect(note(root)?.text).toContain("top level");
    const cased = makeTab({ logFolderPath: "pomodoro_logs" }, LOGS);
    cased.tab.display();
    expect(note(cased)?.text).toBe(logFolderProblemNote({ kind: "case", real: "Pomodoro_logs" }));
    expect(note(cased)?.text).toContain('"Pomodoro_logs"');
    for (const c of [root, cased]) {
      expect(note(c)?.classes).not.toContain("gp-setting-note-info");
      expect(c.calls.map((call) => call.method)).not.toContain("saveSettings");
    }
    // A folder that exists as stored says nothing.
    const fine = makeTab({ logFolderPath: "Pomodoro_logs" }, LOGS);
    fine.tab.display();
    expect(note(fine)?.text).toBe("");
  });

  it('says logs stay at the top level when the folder moves away from a stored "/"', async () => {
    // The top level is no folder the walk lists, so it seemed to hold no logs.
    const c = makeTab({ logFolderPath: "/" }, { "2026-10-01-gentle-pomodoro-log.md": "" });
    c.tab.display();
    await type(c, "Logs");
    expect(note(c)?.text).toBe(logFolderLeftMessage("/"));
    expect(note(c)?.text).toContain("at the vault's top level");
  });

  it("takes an existing folder's own capitalisation, and says so", async () => {
    // Writes went to the real folder (the disk ignores case), while today's
    // total, Refresh and renames looked for the typed spelling and found none.
    const c = makeTab({}, LOGS);
    c.tab.display();
    await type(c, "pomodoro_LOGS/");
    expect(c.settings.logFolderPath).toBe("Pomodoro_logs");
    expect(note(c)?.text).toBe(logFolderAdoptedMessage("Pomodoro_logs"));
    expect(note(c)?.classes).toContain("gp-setting-note-info");
  });

  it("keeps what was typed when it is the folder's own spelling, or no folder yet", async () => {
    const c = makeTab({}, LOGS);
    c.tab.display();
    await type(c, "Pomodoro_logs/");
    expect(c.settings.logFolderPath).toBe("Pomodoro_logs/");
    await type(c, "New logs");
    expect(c.settings.logFolderPath).toBe("New logs");
    expect(note(c)?.text).toBe("");
  });

  it("says that logs already kept stay in the folder it moves away from", async () => {
    const c = makeTab({ logFolderPath: "Pomodoro_logs/" }, LOGS);
    c.tab.display();
    await type(c, "Logs");
    expect(note(c)?.text).toBe(logFolderLeftMessage("Pomodoro_logs/"));
    // Back to the same folder, however it is spelt: nothing to say.
    await type(c, "Pomodoro_logs");
    expect(note(c)?.text).toBe("");
  });

  it("says nothing about a folder that held no logs", async () => {
    const c = makeTab({ logFolderPath: "Notes" }, LOGS);
    c.tab.display();
    await type(c, "Logs");
    expect(note(c)?.text).toBe("");
  });

  it("takes a stored folder that exists as stored, spaces and all, as no problem (F29)", () => {
    // Stored values are not trimmed: " Pomodoro_logs" really is a folder on
    // macOS, and the timer writes there, whatever else the trimmed name matches.
    const vault = fakeVault({}, [" Pomodoro_logs", "pomodoro_logs"]);
    expect(logFolderProblem(" Pomodoro_logs", vault)).toBeNull();
    expect(logFolderProblem("POMODORO_LOGS", vault)).toEqual({
      kind: "case",
      real: "pomodoro_logs",
    });
    expect(logFolderProblem("", vault)).toBeNull();
    expect(logFolderProblem(" // ", vault)).toEqual({ kind: "root" });
  });

  it("walks the folders on the way, never the whole vault", () => {
    const vault = fakeVault({ "A/B/c.md": "", "a/x.md": "" });
    expect(folderIgnoringCase(vault.getRoot(), "a/b")?.path).toBe("A/B");
    // An exact name wins at each level, where the file system tells them apart.
    expect(folderIgnoringCase(vault.getRoot(), "a")?.path).toBe("a");
    expect(folderIgnoringCase(vault.getRoot(), "a/c")).toBeNull();
    expect(resolveLogFolderInput("a/b", vault)).toEqual({
      kind: "ok",
      value: "A/B",
      adopted: "A/B",
    });
    expect(vault.getFiles).not.toHaveBeenCalled();
  });
});

// 0.6.9 — the log's own group: the folder, three choices and four commands (F56).
describe("the Daily log group", () => {
  it("holds the folder, the log's choices and its commands, in that order", () => {
    const rows = declarativeRows(ctx.tab).filter((r) => r.heading === "Daily log");
    expect(rows.map((r) => r.name)).toEqual([
      LOG_FOLDER_NAME,
      DAY_START_NAME,
      TASK_SWITCH_NAME,
      LONG_SESSION_NAME,
      // 0.7.0: with the choices that decide what a line holds, above the buttons.
      DEVICE_NAME_NAME,
      OPEN_LOG_NAME,
      CHECK_LOG_NAME,
      CONVERT_LOG_NAME,
      REFRESH_NAMES_NAME,
      // 0.7.0: with the log's other one-off buttons.
      EXPORT_SESSIONS_NAME,
    ]);
    // Moved, not copied: the folder was under "Display & behavior".
    expect(declarativeRows(ctx.tab).filter((r) => r.name === LOG_FOLDER_NAME)).toHaveLength(1);
    // Short, as every description in the tab.
    for (const row of rows) {
      expect(row.desc.split(/(?<=\.) /).length, row.name).toBeLessThanOrEqual(2);
    }
  });

  it("does not promise that Convert keeps every value: it tidies task names (F31)", () => {
    const c = makeTab();
    c.tab.display();
    const desc = rowFor(c.el, CONVERT_LOG_NAME).desc;
    expect(desc).not.toMatch(/every value/i);
    expect(desc).toMatch(/keeping every start, end and total/);
  });

  it("is on every device: nothing in it needs the desktop app", () => {
    Platform.isDesktopApp = false;
    try {
      const rows = declarativeRows(makeTab().tab).filter((r) => r.heading === "Daily log");
      expect(rows).toHaveLength(10);
    } finally {
      Platform.isDesktopApp = true;
    }
  });

  it("offers midnight to 6:00 for the day's start, and shows the stored hour", () => {
    const c = makeTab({ dayStartHour: 4 });
    c.tab.display();
    const row = componentOf(c.el, DAY_START_NAME);
    expect(row.options).toEqual([
      { value: "0", label: "Midnight" },
      { value: "1", label: "1:00" },
      { value: "2", label: "2:00" },
      { value: "3", label: "3:00" },
      { value: "4", label: "4:00" },
      { value: "5", label: "5:00" },
      { value: "6", label: "6:00" },
    ]);
    expect(row.value).toBe("4");
    // An hour the row cannot show reads as midnight, not as an empty box.
    const odd = makeTab({ dayStartHour: 9 });
    odd.tab.display();
    expect(componentOf(odd.el, DAY_START_NAME).value).toBe("0");
  });

  it("stores the day's start as a number, and reads today's total again", async () => {
    ctx.tab.display();
    componentOf(ctx.el, DAY_START_NAME).change?.("3" as never);
    await flushTab();
    expect(ctx.settings.dayStartHour).toBe(3);
    // Today may be another file now; the timer is silent while idle.
    expect(ctx.calls.map((x) => x.method)).toEqual(["saveSettings", "logFolderChanged"]);
  });

  it("refuses an hour the row does not offer", async () => {
    await ctx.tab.setControlValue("dayStartHour", "7");
    await ctx.tab.setControlValue("dayStartHour", "");
    expect(ctx.settings.dayStartHour).toBe(0);
    expect(ctx.calls).toEqual([]);
  });

  it("offers the two ways to log a task switch, and stores the choice", async () => {
    const c = makeTab({ taskSwitchLogging: "nonsense" });
    c.tab.display();
    const row = componentOf(c.el, TASK_SWITCH_NAME);
    expect(row.options).toEqual([
      { value: "last-task", label: "Last task gets the whole session" },
      { value: "split", label: "Split at the switch" },
    ]);
    expect(row.value).toBe("last-task");
    row.change?.("split" as never);
    await flushTab();
    expect(c.settings.taskSwitchLogging).toBe("split");
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    // Anything else is stored as what every earlier version did.
    await c.tab.setControlValue("taskSwitchLogging", "per-task");
    expect(c.settings.taskSwitchLogging).toBe("last-task");
  });

  it("offers Off and 2 to 8 hours for the long-session question, and stores a number", async () => {
    const c = makeTab({ longSessionPromptHours: 8 });
    c.tab.display();
    const row = componentOf(c.el, LONG_SESSION_NAME);
    expect(row.options).toEqual([
      { value: "0", label: "Off" },
      { value: "2", label: "2 hours" },
      { value: "4", label: "4 hours" },
      { value: "6", label: "6 hours" },
      { value: "8", label: "8 hours" },
    ]);
    expect(row.value).toBe("8");
    row.change?.("0" as never);
    await flushTab();
    expect(c.settings.longSessionPromptHours).toBe(0);
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    await c.tab.setControlValue("longSessionPromptHours", "5");
    expect(c.settings.longSessionPromptHours).toBe(0);
    const odd = makeTab({ longSessionPromptHours: 5 });
    odd.tab.display();
    expect(componentOf(odd.el, LONG_SESSION_NAME).value).toBe("6");
  });

  it.each([
    [OPEN_LOG_NAME, "Open", "openTodayLog"],
    [CHECK_LOG_NAME, "Check", "checkLog"],
    [CONVERT_LOG_NAME, "Convert", "convertLog"],
    [REFRESH_NAMES_NAME, "Refresh", "refreshLogTaskNames"],
    [EXPORT_SESSIONS_NAME, "Export", "exportSessions"],
  ] as const)('renders "%s" as a button that runs its command', (name, label, method) => {
    ctx.tab.display();
    const button = componentOf(ctx.el, name);
    expect(button.kind).toBe("button");
    expect(button.buttonText).toBe(label);
    expect(button.destructive).toBe(false);
    button.click?.();
    expect(ctx.calls.map((x) => x.method)).toEqual([method]);
  });

  it("runs the same commands from the 1.13 definitions", () => {
    const group = groupNamed(ctx.tab, "Daily log") as unknown as {
      items: { name: string; action?: () => void }[];
    };
    for (const name of [
      OPEN_LOG_NAME,
      CHECK_LOG_NAME,
      CONVERT_LOG_NAME,
      REFRESH_NAMES_NAME,
      EXPORT_SESSIONS_NAME,
    ]) {
      group.items.find((item) => item.name === name)?.action?.();
    }
    expect(ctx.calls.map((x) => x.method)).toEqual([
      "openTodayLog",
      "checkLog",
      "convertLog",
      "refreshLogTaskNames",
      "exportSessions",
    ]);
  });
});

/* ===== 0.7.0: this device's name, and the Log tables ===== */

describe("this device's name", () => {
  it("shows the name this device keeps, and keeps what is typed there — never in data.json", async () => {
    const c = makeTab();
    c.local.set(DEVICE_NAME_KEY, "Work laptop");
    c.tab.display();
    const box = componentOf(c.el, DEVICE_NAME_NAME);
    expect(box.kind).toBe("text");
    expect(box.value).toBe("Work laptop");
    expect(box.placeholder).toBe("Example: Work laptop");
    box.change?.("  Phone  " as never);
    await flushTab();
    expect(c.local.get(DEVICE_NAME_KEY)).toBe("Phone");
    // Nothing of the plugin's settings moved, and nothing was saved.
    expect(c.calls).toEqual([]);
    expect(JSON.stringify(c.settings)).not.toContain("Phone");
    box.change?.("" as never);
    expect(c.local.has(DEVICE_NAME_KEY)).toBe(false);
  });

  it("says under the row how a line will write it, when cleaning changes it", () => {
    const c = makeTab();
    c.tab.display();
    const row = rowFor(c.el, DEVICE_NAME_NAME);
    const note = (row.infoEl as StubEl).children.find((x) => x.classes.includes("gp-setting-note"));
    if (!note) throw new Error("no note");
    expect(note.classes).toContain("gp-setting-note-info");
    expect(note.text).toBe("");
    componentOf(c.el, DEVICE_NAME_NAME).change?.("Desk [home] #2" as never);
    expect(note.text).toBe('Written as "Desk (home) 2".');
    componentOf(c.el, DEVICE_NAME_NAME).change?.("Desk" as never);
    expect(note.text).toBe("");
  });

  it("names the written form only when it differs, and says when nothing is left", () => {
    expect(deviceNameNote("")).toBe("");
    expect(deviceNameNote("  Work laptop  ")).toBe("");
    expect(deviceNameNote("a::b")).toBe('Written as "a:b".');
    expect(deviceNameNote("x".repeat(45))).toBe(`Written as "${"x".repeat(40)}".`);
    expect(deviceNameNote("🍅 # ☕")).toMatch(/no Device is written/);
  });
});

describe("the Log tables group", () => {
  /**
   * The Columns row as drawn: the columns in the table, each row's name and
   * ↑ / ↓ / ✕ in order, and the "Add a column" buttons.
   */
  function columnList(el: { settings: Setting[] }) {
    const row = rowFor(el, QUERY_COLUMNS_NAME);
    const settingEl = row.settingEl as StubEl;
    const find = (cls: string) => {
      const found = settingEl.children.find((x) => x.classes.includes(cls));
      if (!found) throw new Error(`no ${cls}`);
      return found;
    };
    const list = find("gp-column-list");
    const add = find("gp-column-add");
    const chipsEl = add.children.find((x) => x.classes.includes("gp-column-chips"));
    if (!chipsEl) throw new Error("no chips");
    return {
      list,
      add,
      chipsEl,
      status: find("gp-column-status"),
      items: list.children.map((item) => ({
        el: item,
        name: item.children.find((x) => x.tag === "span")?.text ?? "",
        up: item.controls[0] as ExtraButtonComponent,
        down: item.controls[1] as ExtraButtonComponent,
        remove: item.controls[2] as ExtraButtonComponent,
      })),
      chips: chipsEl.children.map((chip) => ({
        el: chip,
        name: chip.children.find((x) => x.classes.includes("gp-column-chip-name"))?.text ?? "",
      })),
    };
  }
  const labels = (ids: readonly string[]) =>
    ids.map((id) => QUERY_COLUMNS.find((c) => c.id === id)?.label);
  const codeEl = (el: { settings: Setting[] }) => {
    const row = el.settings.find((s) => s.settingEl.classes.includes("gp-setting-code"));
    const details = (row?.settingEl as StubEl | undefined)?.children.find(
      (x) => x.tag === "details"
    );
    if (!details) throw new Error("no code row");
    const summaryEl = details.children.find((x) => x.tag === "summary") as StubEl;
    return {
      summary: summaryEl.text,
      summaryEl,
      pre: details.children.find((x) => x.tag === "pre") as StubEl,
    };
  };
  const LOGS = { "Pomodoro_logs/2026-10-23-gentle-pomodoro-log.md": "" };
  const withFolder = (over: Partial<GentlePomoSettings> = {}) =>
    makeTab({ logFolderPath: "Pomodoro_logs", ...over }, LOGS);
  const sessionsCode = (settings: GentlePomoSettings, folder = "Pomodoro_logs") =>
    sessionsTable(queryOptions(settings, folder));

  beforeEach(() => {
    Notice.shown.length = 0;
    Modal.opened = null;
    stubFocus.el = null;
    stubFocus.dropped = 0;
  });

  it("sits right after Daily log, in the order the design has it", () => {
    const rows = declarativeRows(ctx.tab);
    const headings = [...new Set(rows.map((r) => r.heading))];
    expect(headings[headings.indexOf("Daily log") + 1]).toBe(QUERY_GROUP_HEADING);
    expect(rows.filter((r) => r.heading === QUERY_GROUP_HEADING).map((r) => r.name)).toEqual([
      QUERY_COLUMNS_NAME,
      QUERY_RANGE_NAME,
      QUERY_KINDS_NAME,
      QUERY_SKIPPED_NAME,
      QUERY_SORT_NAME,
      "",
      ...QUERY_COPIES.map((c) => c.name),
    ]);
    for (const row of rows.filter((r) => r.heading === QUERY_GROUP_HEADING)) {
      expect(row.desc.split(/(?<=\.) /).length, row.name).toBeLessThanOrEqual(2);
    }
  });

  it("is on every device", () => {
    Platform.isDesktopApp = false;
    try {
      const rows = declarativeRows(makeTab().tab).filter((r) => r.heading === QUERY_GROUP_HEADING);
      expect(rows).toHaveLength(10);
    } finally {
      Platform.isDesktopApp = true;
    }
  });

  it("makes Columns and the code render rows on both paths, and the Copy rows findable by search", () => {
    const group = groupNamed(ctx.tab, QUERY_GROUP_HEADING) as unknown as {
      items: Record<string, unknown>[];
    };
    expect(typeof group.items[0].render).toBe("function");
    expect(typeof group.items[5].render).toBe("function");
    for (const item of group.items.slice(6)) {
      expect(typeof item.action, String(item.name)).toBe("function");
      expect(item.aliases, String(item.name)).toEqual(["dataview", "query", "copy"]);
    }
    // Only the Copy rows carry aliases.
    expect(group.items.slice(0, 6).some((item) => "aliases" in item)).toBe(false);
  });

  const catalogLabelsWithout = (ids: readonly string[]) =>
    QUERY_COLUMNS.filter((x) => !ids.includes(x.id)).map((x) => x.label);

  it("lists the columns in the table and offers the rest to add, Simple and Detailed beside them", () => {
    ctx.tab.display();
    const { list, add, items, chips, chipsEl, status } = columnList(ctx.el);
    expect(items.map((i) => i.name)).toEqual(labels(QUERY_PRESETS.simple));
    // The rest, in catalog order: a column's place among them is nobody's choice.
    expect(chips.map((c) => c.name)).toEqual(catalogLabelsWithout(QUERY_PRESETS.simple));
    for (const chip of chips) {
      expect(chip.el.tag, chip.name).toBe("button");
      expect(chip.el.attrs.type, chip.name).toBe("button");
      expect(chip.el.attrs["aria-label"], chip.name).toBe(`Add ${chip.name}`);
      expect(chip.el.classes).toContain("gp-column-chip");
      expect(chip.el.children.find((x) => x.classes.includes("gp-column-chip-icon"))?.icon).toBe(
        "plus"
      );
    }
    // Named by its visible label, never an aria-label: Obsidian shows any
    // [aria-label] as a tooltip over everything inside it.
    expect(add.attrs.role).toBe("group");
    expect(add.children[0].text).toBe(COLUMN_ADD_LABEL);
    expect(add.attrs["aria-labelledby"]).toBe(add.children[0].attrs.id);
    expect(add.children[0].attrs.id).toMatch(/^gp-column-add-label-\d+$/);
    expect(add.classes).not.toContain("gp-column-add-empty");
    expect(chipsEl.children).toHaveLength(QUERY_COLUMNS.length - QUERY_PRESETS.simple.length);
    expect(list.attrs.role).toBe("list");
    // Only the buttons carry an aria-label, their tooltip and their name.
    const labelled: StubEl[] = [];
    const walk = (el: StubEl) => {
      if (el.attrs["aria-label"] !== undefined) labelled.push(el);
      el.children.forEach(walk);
    };
    walk(rowFor(ctx.el, QUERY_COLUMNS_NAME).settingEl as StubEl);
    for (const el of labelled) {
      expect(
        el.tag === "button" || el.classes.includes("extra-setting-button"),
        el.attrs["aria-label"]
      ).toBe(true);
    }
    // A second render's label has an id of its own.
    ctx.tab.display();
    expect(columnList(ctx.el).add.attrs["aria-labelledby"]).not.toBe(add.attrs["aria-labelledby"]);
    for (const item of items) {
      expect(item.el.attrs.role).toBe("listitem");
      expect([item.up.icon, item.down.icon, item.remove.icon]).toEqual([
        "arrow-up",
        "arrow-down",
        "x",
      ]);
      for (const control of [item.up, item.down, item.remove]) {
        expect(control.extraSettingsEl.attrs.role, item.name).toBe("button");
      }
      expect(item.remove.extraSettingsEl.classes).toContain("gp-column-remove");
    }
    expect(items[0].down.extraSettingsEl.attrs["aria-label"]).toBe("Move Date down");
    expect(items[2].remove.extraSettingsEl.attrs["aria-label"]).toBe("Remove Task");
    // The status line is there from the start, empty.
    expect(status.attrs).toMatchObject({ role: "status", "aria-live": "polite" });
    expect(status.text).toBe("");
    const row = rowFor(ctx.el, QUERY_COLUMNS_NAME);
    expect(row.settingEl.classes).toContain("gp-setting-wide");
    expect(row.components.map((b) => b.buttonText)).toEqual(["Simple", "Detailed"]);
  });

  it("gives every button a role on 1.7 too, whose ExtraButton has none either", () => {
    stubObsidian.extraButton = "1.7";
    try {
      ctx.tab.display();
      for (const item of columnList(ctx.el).items) {
        for (const control of [item.up, item.down, item.remove]) {
          expect(control.extraSettingsEl.attrs.role, item.name).toBe("button");
        }
      }
    } finally {
      stubObsidian.extraButton = "1.13";
    }
  });

  it("draws a stored order of the others in catalog order, writing nothing", () => {
    const c = withFolder({ queryColumns: "-offset,task,-end,date,-device" });
    c.tab.display();
    const { items, chips } = columnList(c.el);
    expect(items.map((i) => i.name)).toEqual(["Task", "Date"]);
    expect(chips.map((x) => x.name)).toEqual(catalogLabelsWithout(["task", "date"]));
    expect(c.calls).toEqual([]);
    expect(c.settings.queryColumns).toBe("-offset,task,-end,date,-device");
  });

  it("the default in data.json is Simple, written as the setting stores it", () => {
    expect(DEFAULT_SETTINGS.queryColumns).toBe(formatQueryColumns(presetColumns("simple")));
  });

  it("adds a column at the end of the table, writes at once, and repaints the code", async () => {
    const c = withFolder();
    c.tab.display();
    const before = columnList(c.el);
    const end = before.chips.find((x) => x.name === "End");
    if (!end) throw new Error("no End");
    clickEl(end.el);
    await flushTab();
    const after = columnList(c.el);
    expect(after.items.map((i) => i.name)).toEqual([...labels(QUERY_PRESETS.simple), "End"]);
    // The rows already there are the same nodes, not rebuilt ones.
    before.items.forEach((item, n) => expect(after.list.children[n]).toBe(item.el));
    expect(after.chips.map((x) => x.name)).toEqual(
      catalogLabelsWithout([...QUERY_PRESETS.simple, "end"])
    );
    expect(c.settings.queryColumns).toBe(
      "date,start,task,minutes,status,end,-planned,-overtime,-pauses,-type,-endedby,-startedby,-cycle,-slept,-dropped,-device,-session,-offset"
    );
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
    expect(codeEl(c.el).pre.text).toContain('AS "End"');
    expect(after.status.text).toBe(columnAddedMessage("End", 6));
  });

  it("takes a column out back among the others, in catalog order, and repaints the code", async () => {
    const c = withFolder();
    c.tab.display();
    const before = columnList(c.el);
    const task = before.items[2];
    expect(task.name).toBe("Task");
    task.remove.click();
    await flushTab();
    const after = columnList(c.el);
    expect(after.items.map((i) => i.name)).toEqual(["Date", "Start", "Minutes", "Status"]);
    for (const n of [0, 1, 3, 4]) expect(after.list.children).toContain(before.items[n].el);
    // Between End and Planned, where the catalog has it — not at the end.
    const names = after.chips.map((x) => x.name);
    expect(names.indexOf("Task")).toBe(names.indexOf("End") + 1);
    expect(names).toEqual(catalogLabelsWithout(["date", "start", "minutes", "status"]));
    expect(c.settings.queryColumns).toBe(
      "date,start,minutes,status,-end,-task,-planned,-overtime,-pauses,-type,-endedby,-startedby,-cycle,-slept,-dropped,-device,-session,-offset"
    );
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
    expect(codeEl(c.el).pre.text).not.toContain('AS "Task"');
    expect(after.status.text).toBe(columnRemovedMessage("Task"));
    // Added again, it goes last: its old place is not kept.
    const again = after.chips.find((x) => x.name === "Task");
    if (!again) throw new Error("no Task button");
    clickEl(again.el);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Date",
      "Start",
      "Minutes",
      "Status",
      "Task",
    ]);
  });

  it("moves focus off a removed row before taking it out: to the next ✕, or the one above", async () => {
    const c = withFolder();
    c.tab.display();
    const { items } = columnList(c.el);
    // The middle row: the ✕ of the row that takes its place.
    stubFocus.el = items[2].remove.extraSettingsEl;
    items[2].remove.click();
    await flushTab();
    expect(stubFocus.el).toBe(items[3].remove.extraSettingsEl);
    // The last row: the ✕ of the row above.
    stubFocus.el = items[4].remove.extraSettingsEl;
    items[4].remove.click();
    await flushTab();
    expect(stubFocus.el).toBe(items[3].remove.extraSettingsEl);
    expect(stubFocus.dropped).toBe(0);
  });

  it("moves focus to the column's own button when the one row left can't be removed", async () => {
    const c = withFolder({ queryColumns: "task,date" });
    c.tab.display();
    const { items } = columnList(c.el);
    stubFocus.el = items[1].remove.extraSettingsEl;
    items[1].remove.click();
    await flushTab();
    const after = columnList(c.el);
    // Task's ✕ is disabled now, and so are its arrows: nothing in the list
    // can take focus, so it goes to the Date button that just appeared.
    expect(after.items[0].remove.disabled).toBe(true);
    expect(stubFocus.el).toBe(after.chips.find((x) => x.name === "Date")?.el);
    expect(stubFocus.dropped).toBe(0);
  });

  it("moves focus off a pressed button before taking it out: to the next, or the one before", async () => {
    const c = withFolder();
    c.tab.display();
    const chip = (name: string) => {
      const found = columnList(c.el).chips.find((x) => x.name === name);
      if (!found) throw new Error(`no ${name}`);
      return found.el;
    };
    stubFocus.el = chip("End");
    const planned = chip("Planned (min)");
    clickEl(chip("End"));
    await flushTab();
    expect(stubFocus.el).toBe(planned);
    // One in the middle, where "the next" and "the one before" differ.
    stubFocus.el = chip("Overtime (min)");
    const pauses = chip("Pauses");
    clickEl(chip("Overtime (min)"));
    await flushTab();
    expect(stubFocus.el).toBe(pauses);
    // The last one: the one before it.
    const last = QUERY_COLUMNS.at(-1)?.label ?? "";
    const beforeLast = QUERY_COLUMNS.at(-2)?.label ?? "";
    stubFocus.el = chip(last);
    const target = chip(beforeLast);
    clickEl(chip(last));
    await flushTab();
    expect(stubFocus.el).toBe(target);
    expect(stubFocus.dropped).toBe(0);
  });

  it("moves focus to the new row's ↑ when the last button is pressed, and hides Add a column", async () => {
    const all = QUERY_COLUMNS.map((x) => x.id);
    const c = withFolder({ queryColumns: [...all.slice(0, -1), `-${all.at(-1) ?? ""}`].join(",") });
    c.tab.display();
    const before = columnList(c.el);
    expect(before.chips).toHaveLength(1);
    const oldLast = before.items.at(-1);
    expect(oldLast?.down.disabled).toBe(true);
    stubFocus.el = before.chips[0].el;
    clickEl(before.chips[0].el);
    await flushTab();
    const after = columnList(c.el);
    const added = after.items.at(-1);
    expect(stubFocus.el).toBe(added?.up.extraSettingsEl);
    expect(added?.up.disabled).toBe(false);
    expect(added?.down.disabled).toBe(true);
    expect(oldLast?.down.disabled).toBe(false);
    expect(after.add.classes).toContain("gp-column-add-empty");
    expect(after.chips).toHaveLength(0);
    expect(stubFocus.dropped).toBe(0);
  });

  it("never lets the last column be taken out", async () => {
    const c = withFolder({ queryColumns: "task" });
    c.tab.display();
    const { items } = columnList(c.el);
    expect(items.map((i) => i.name)).toEqual(["Task"]);
    const task = items[0];
    for (const control of [task.up, task.down, task.remove]) {
      expect(control.disabled).toBe(true);
      expect(control.extraSettingsEl.attrs["aria-disabled"]).toBe("true");
    }
    // Still named for what it does, and to which column, then why it can't.
    expect(task.remove.extraSettingsEl.attrs["aria-label"]).toBe(
      `Remove Task. ${COLUMN_LAST_SHOWN_TOOLTIP}`
    );
    // A click reached anyway writes nothing.
    task.remove.click();
    await flushTab();
    expect(c.settings.queryColumns).toBe("task");
    expect(c.calls).toEqual([]);
    // A second column frees it, and its name comes back.
    const date = columnList(c.el).chips.find((x) => x.name === "Date");
    if (!date) throw new Error("no Date");
    clickEl(date.el);
    await flushTab();
    expect(task.remove.disabled).toBe(false);
    expect(task.remove.extraSettingsEl.attrs["aria-label"]).toBe("Remove Task");
    expect(task.remove.extraSettingsEl.attrs["aria-disabled"]).toBeUndefined();
  });

  it("disables ↑ on the first column and ↓ on the last, and says so with aria-disabled", async () => {
    ctx.tab.display();
    const { items } = columnList(ctx.el);
    const disabledAttr = () =>
      items.map((i) =>
        [i.up, i.down, i.remove].map((x) => x.extraSettingsEl.attrs["aria-disabled"])
      );
    expect(items.map((i) => i.up.disabled)).toEqual(items.map((_i, n) => n === 0));
    expect(items.map((i) => i.down.disabled)).toEqual(items.map((_i, n) => n === items.length - 1));
    // Obsidian dims a clickable icon by [aria-disabled], not by is-disabled.
    expect(disabledAttr()).toEqual(
      items.map((_i, n) => [
        n === 0 ? "true" : undefined,
        n === items.length - 1 ? "true" : undefined,
        undefined,
      ])
    );
    // And it follows a move: Start up to the top, Date down to second.
    items[1].up.click();
    await flushTab();
    expect(items[1].up.extraSettingsEl.attrs["aria-disabled"]).toBe("true");
    expect(items[0].up.extraSettingsEl.attrs["aria-disabled"]).toBeUndefined();
  });

  it("moves a column with ↑ / ↓, the nodes kept, the focus on the pressed arrow", async () => {
    const c = withFolder();
    c.tab.display();
    const { list, items } = columnList(c.el);
    const task = items[2];
    expect(task.name).toBe("Task");
    stubFocus.el = task.up.extraSettingsEl;
    task.up.click();
    await flushTab();
    // Swapped with Start; the setting, the drawn order and the code all agree.
    const order = ["date", "task", "start", "minutes", "status"];
    expect(c.settings.queryColumns.startsWith(`${order.join(",")},-end`)).toBe(true);
    expect(list.children.map((x) => x.children.find((y) => y.tag === "span")?.text)).toEqual(
      labels(
        resolveQueryColumns(c.settings.queryColumns)
          .filter((x) => x.on)
          .map((x) => x.id)
      )
    );
    // The same node, not a rebuilt one, and still focused on its ↑ — never
    // having lost it: the neighbour moved, not the row holding the focus,
    // so no blur and focus again for a screen reader to announce.
    expect(list.children[1]).toBe(task.el);
    expect(stubFocus.el).toBe(task.up.extraSettingsEl);
    expect(stubFocus.dropped).toBe(0);
    expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    expect(columnList(c.el).status.text).toBe(columnMovedMessage("Task", 2, 5));
    // ↑ again: it reaches the top, its ↑ goes off, and focus moves to its ↓.
    task.up.click();
    await flushTab();
    expect(list.children[0]).toBe(task.el);
    expect(task.up.disabled).toBe(true);
    expect(task.up.extraSettingsEl.attrs.tabindex).toBeUndefined();
    expect(stubFocus.el).toBe(task.down.extraSettingsEl);
    // And down to the end: ↓ goes off there, and focus moves to its ↑.
    for (let n = 0; n < items.length - 1; n++) task.down.click();
    await flushTab();
    expect(list.children[items.length - 1]).toBe(task.el);
    expect(task.down.disabled).toBe(true);
    expect(stubFocus.el).toBe(task.up.extraSettingsEl);
    expect(stubFocus.dropped).toBe(0);
    expect(
      resolveQueryColumns(c.settings.queryColumns)
        .filter((x) => x.on)
        .at(-1)
    ).toEqual({
      id: "task",
      on: true,
    });
  });

  it("moves a column past the one above it in the table, whatever a stored value has between", async () => {
    // Stored with hidden columns among the shown ones (as the first 0.7.0
    // build could leave it): ↑ on Task must pass Date at once.
    const c = withFolder({ queryColumns: "date,-start,task,-end,minutes" });
    c.tab.display();
    const { list, items } = columnList(c.el);
    expect(items.map((i) => i.name)).toEqual(["Date", "Task", "Minutes"]);
    items[1].up.click();
    await flushTab();
    expect(list.children.map((x) => x.children.find((y) => y.tag === "span")?.text)).toEqual([
      "Task",
      "Date",
      "Minutes",
    ]);
    expect(
      resolveQueryColumns(c.settings.queryColumns)
        .filter((x) => x.on)
        .map((x) => x.id)
    ).toEqual(["task", "date", "minutes"]);
  });

  it("adds no key handling of its own on 1.13, whose buttons Enter and Space press already", async () => {
    const c = withFolder();
    c.tab.display();
    const { list, items, chips } = columnList(c.el);
    for (const item of items) {
      for (const control of [item.up, item.down, item.remove]) {
        expect(control.extraSettingsEl.listeners.keydown ?? []).toHaveLength(1);
        expect(control.extraSettingsEl.attrs["data-gp-keyboard"]).toBeUndefined();
      }
    }
    // The add buttons are real buttons, which the browser presses on Enter and Space.
    for (const chip of chips) expect(chip.el.listeners.keydown ?? []).toHaveLength(0);
    // One Enter, one move: a handler of the plugin's beside Obsidian's would move twice.
    const task = items[2];
    expect(pressKey(task.up.extraSettingsEl, "Enter")).toBe(true);
    await flushTab();
    expect(list.children[1]).toBe(task.el);
    // And one remove.
    expect(pressKey(items[4].remove.extraSettingsEl, "Enter")).toBe(true);
    await flushTab();
    expect(columnList(c.el).items).toHaveLength(4);
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings", "saveSettings"]);
  });

  describe("on Obsidian 1.7, whose ExtraButton Tab never reaches", () => {
    beforeEach(() => {
      stubObsidian.extraButton = "1.7";
    });
    afterEach(() => {
      stubObsidian.extraButton = "1.13";
    });

    it("gives every button a tabindex, taken off while it is disabled", async () => {
      const c = withFolder({ queryColumns: "task,date" });
      c.tab.display();
      const { items, chips } = columnList(c.el);
      items.forEach((item, n) => {
        expect(item.up.extraSettingsEl.attrs.tabindex, `${item.name} up`).toBe(
          n === 0 ? undefined : "0"
        );
        expect(item.down.extraSettingsEl.attrs.tabindex, `${item.name} down`).toBe(
          n === items.length - 1 ? undefined : "0"
        );
        expect(item.remove.extraSettingsEl.attrs.tabindex, `${item.name} remove`).toBe("0");
        expect(item.remove.extraSettingsEl.attrs["data-gp-keyboard"]).toBe("true");
      });
      for (const chip of chips) expect(chip.el.listeners.keydown ?? []).toHaveLength(0);
      // Down to one: its ✕ leaves the Tab order.
      pressKey(items[1].remove.extraSettingsEl, "Enter");
      await flushTab();
      expect(items[0].remove.extraSettingsEl.attrs.tabindex).toBeUndefined();
      expect(items[0].remove.disabled).toBe(true);
    });

    it("moves a column with Enter and Space, focus kept, and not from a disabled arrow", async () => {
      const c = withFolder();
      c.tab.display();
      const { list, items } = columnList(c.el);
      const task = items[2];
      stubFocus.el = task.up.extraSettingsEl;
      expect(pressKey(task.up.extraSettingsEl, "Enter")).toBe(true);
      await flushTab();
      expect(list.children[1]).toBe(task.el);
      expect(stubFocus.el).toBe(task.up.extraSettingsEl);
      // Space too; at the top the arrow goes off, its tabindex with it, and
      // focus moves to ↓ — which a keyboard can reach.
      expect(pressKey(task.up.extraSettingsEl, " ")).toBe(true);
      await flushTab();
      expect(list.children[0]).toBe(task.el);
      expect(task.up.disabled).toBe(true);
      expect(task.up.extraSettingsEl.attrs.tabindex).toBeUndefined();
      expect(stubFocus.el).toBe(task.down.extraSettingsEl);
      expect(task.down.extraSettingsEl.attrs.tabindex).toBe("0");
      // A disabled arrow reached anyway moves nothing and writes nothing.
      const saves = c.calls.length;
      pressKey(task.up.extraSettingsEl, "Enter");
      await flushTab();
      expect(list.children[0]).toBe(task.el);
      expect(c.calls).toHaveLength(saves);
      // Other keys are left alone.
      expect(pressKey(task.down.extraSettingsEl, "a")).toBe(false);
      // Down again, and ↑ is back in the Tab order.
      pressKey(task.down.extraSettingsEl, "Enter");
      await flushTab();
      expect(list.children[1]).toBe(task.el);
      expect(task.up.extraSettingsEl.attrs.tabindex).toBe("0");
      expect(stubFocus.dropped).toBe(0);
    });

    it("removes a column with Enter and Space, and moves the focus as a click does", async () => {
      const c = withFolder();
      c.tab.display();
      const { items } = columnList(c.el);
      stubFocus.el = items[2].remove.extraSettingsEl;
      expect(pressKey(items[2].remove.extraSettingsEl, "Enter")).toBe(true);
      await flushTab();
      expect(stubFocus.el).toBe(items[3].remove.extraSettingsEl);
      expect(pressKey(items[3].remove.extraSettingsEl, " ")).toBe(true);
      await flushTab();
      expect(columnList(c.el).items.map((i) => i.name)).toEqual(["Date", "Start", "Status"]);
      expect(stubFocus.dropped).toBe(0);
    });
  });

  it("takes a double click on any of a row's buttons or an add button as one press", async () => {
    const c = withFolder();
    c.tab.display();
    const { items, chips } = columnList(c.el);
    // ✕ on Start, then a second click on what slid under the pointer.
    items[1].remove.click(1);
    items[2].remove.click(2);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Date",
      "Task",
      "Minutes",
      "Status",
    ]);
    clickEl(chips[0].el, 1);
    clickEl(chips[1].el, 2);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Date",
      "Task",
      "Minutes",
      "Status",
      "End",
    ]);
    // ↑ on Status: Status moves up, and Minutes, which it swapped with, takes
    // its place under the pointer — the second click lands on Minutes' ↑ and
    // must not move it straight back.
    const before = columnList(c.el).items;
    before[3].up.click(1);
    before[2].up.click(2);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Date",
      "Task",
      "Status",
      "Minutes",
      "End",
    ]);
    // ↓ the same way, and two clicks that are two presses still move twice.
    const now = columnList(c.el).items;
    now[0].down.click(1);
    now[1].down.click(2);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Task",
      "Date",
      "Status",
      "Minutes",
      "End",
    ]);
    const after = columnList(c.el).items;
    after[4].up.click(1);
    after[4].up.click(1);
    await flushTab();
    expect(columnList(c.el).items.map((i) => i.name)).toEqual([
      "Task",
      "Date",
      "End",
      "Status",
      "Minutes",
    ]);
  });

  it.each([
    ["Simple", "simple"],
    ["Detailed", "detailed"],
  ] as const)("%s rewrites the whole list to its preset", async (label, preset) => {
    const c = withFolder({ queryColumns: "offset,-date" });
    c.tab.display();
    const focused = stubEl("", "button");
    stubFocus.el = focused;
    rowFor(c.el, QUERY_COLUMNS_NAME)
      .components.find((b) => b.buttonText === label)
      ?.click?.();
    await flushTab();
    expect(c.settings.queryColumns).toBe(formatQueryColumns(presetColumns(preset)));
    const { items, chips, status } = columnList(c.el);
    expect(items.map((i) => i.name)).toEqual(labels(QUERY_PRESETS[preset]));
    expect(chips.map((x) => x.name)).toEqual(catalogLabelsWithout(QUERY_PRESETS[preset]));
    expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
    expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
    expect(status.text).toBe(columnPresetMessage(preset, QUERY_PRESETS[preset].length));
    // The button pressed keeps the focus.
    expect(stubFocus.el).toBe(focused);
    expect(stubFocus.dropped).toBe(0);
  });

  it("says each change in words a screen reader can read", () => {
    expect(columnMovedMessage("Task", 2, 5)).toBe("Task moved: column 2 of 5.");
    expect(columnAddedMessage("End", 6)).toBe("End added: column 6 of 6.");
    expect(columnRemovedMessage("Task")).toBe("Task removed.");
    expect(columnPresetMessage("simple", 5)).toBe("Simple: 5 columns.");
    expect(columnPresetMessage("detailed", 1)).toBe("Detailed: 1 column.");
  });

  it.each([
    [QUERY_RANGE_NAME, "queryRange", QUERY_RANGES, "week", "month"],
    [QUERY_KINDS_NAME, "queryKinds", QUERY_KINDS, "focus", "all"],
    [QUERY_SORT_NAME, "querySort", QUERY_SORTS, "newest", "oldest"],
  ] as const)(
    "%s offers its choices, shows a value it does not know as the default, and stores what is picked",
    async (name, key, choices, fallback, pick) => {
      const c = withFolder({ [key]: "fortnight" } as Partial<GentlePomoSettings>);
      c.tab.display();
      const row = componentOf(c.el, name);
      expect(row.options).toEqual(choices.map((o) => ({ value: o.value, label: o.label })));
      expect(row.value).toBe(fallback);
      row.change?.(pick as never);
      await flushTab();
      expect(c.settings[key]).toBe(pick);
      expect(c.calls.map((x) => x.method)).toEqual(["saveSettings"]);
      expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
      // A value no row offers is stored as the default, never kept.
      await c.tab.setControlValue(key, "fortnight");
      expect(c.settings[key]).toBe(fallback);
    }
  );

  it("includes skipped focus by default, and the switch repaints the code", async () => {
    const c = withFolder();
    c.tab.display();
    const row = componentOf(c.el, QUERY_SKIPPED_NAME);
    expect(row.value).toBe(true);
    expect(codeEl(c.el).pre.text).not.toContain('"cancelled"');
    row.change?.(false as never);
    await flushTab();
    expect(c.settings.querySkipped).toBe(false);
    expect(codeEl(c.el).pre.text).toContain('s.Status != "cancelled"');
  });

  it("shows the sessions table's code under a closed Show the code, kept in step", async () => {
    const c = withFolder();
    c.tab.display();
    const code = codeEl(c.el);
    expect(code.summary).toBe(QUERY_CODE_SUMMARY);
    // In Obsidian 1.13's Tab order, which walks [tabindex] and not a bare
    // summary (checked in Chromium under 1.13.7's own settings handler).
    expect(code.summaryEl.attrs.tabindex).toBe("0");
    expect(code.pre.classes).toContain("gp-query-code-text");
    expect(code.pre.text).toBe(sessionsCode(c.settings));
    // The day's start changes the code's "today".
    await c.tab.setControlValue("dayStartHour", "4");
    expect(code.pre.text).toContain("date(now).hour < 4");
    expect(code.pre.text).toBe(sessionsCode(c.settings));
  });

  it("says where the code would be when no folder is set, and follows the folder row", async () => {
    const c = makeTab({}, LOGS);
    c.tab.display();
    expect(codeEl(c.el).pre.text).toBe(QUERY_NO_FOLDER_PREVIEW);
    componentOf(c.el, LOG_FOLDER_NAME).change?.("Pomodoro_logs" as never);
    await flushTab();
    expect(codeEl(c.el).pre.text).toBe(sessionsCode(c.settings));
  });

  it("keeps a 1.13 render live when the render before it is torn down after it", async () => {
    const c = withFolder();
    const group = groupNamed(c.tab, QUERY_GROUP_HEADING) as unknown as {
      items: { render?: (s: Setting) => (() => void) | void }[];
    };
    const render = (n: number) => {
      const setting = new Setting();
      const teardown = group.items[n].render?.(setting);
      return { setting, teardown: teardown ?? (() => undefined) };
    };
    const oldCode = render(5);
    const newCode = render(5);
    const oldColumns = render(0);
    const newColumns = render(0);
    oldCode.teardown();
    oldColumns.teardown();
    await c.tab.setControlValue("querySort", "oldest");
    const pre = (newCode.setting.settingEl as StubEl).children[0].children.find(
      (x) => x.tag === "pre"
    );
    expect(pre?.text).toContain("SORT s.Start ASC");
    const list = (newColumns.setting.settingEl as StubEl).children.find((x) =>
      x.classes.includes("gp-column-list")
    );
    // ↓ on Date: the controls are ↑, ↓, ✕.
    (list?.children[0].controls[1] as ExtraButtonComponent).click();
    await flushTab();
    expect(c.settings.queryColumns.startsWith("start,date,")).toBe(true);
    expect(list?.children[1].children.find((x) => x.tag === "span")?.text).toBe("Date");
    // And an add button on it adds to that list.
    const chips = (newColumns.setting.settingEl as StubEl).children
      .find((x) => x.classes.includes("gp-column-add"))
      ?.children.find((x) => x.classes.includes("gp-column-chips"));
    const first = chips?.children[0];
    if (!first) throw new Error("no add button");
    clickEl(first);
    await flushTab();
    expect(list?.children).toHaveLength(6);
    // The old render's nodes went with its teardown.
    expect(
      (oldColumns.setting.settingEl as StubEl).children.some((x) =>
        x.classes.includes("gp-column-list")
      )
    ).toBe(false);
  });

  describe("the Copy buttons", () => {
    let written: string[];
    let answer: Promise<void>;
    let clipboard: { writeText: (text: string) => Promise<void> } | undefined;
    beforeEach(() => {
      written = [];
      answer = Promise.resolve();
      clipboard = {
        writeText: (text: string) => {
          written.push(text);
          return answer;
        },
      };
      vi.stubGlobal("window", {
        navigator: {
          get clipboard() {
            return clipboard;
          },
        },
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const fallbackText = () => {
      const content = (Modal.opened as unknown as { contentEl: ModalContent } | null)?.contentEl;
      return content?.elements.find((x) => x.tag === "textarea");
    };

    it.each(QUERY_COPIES.map((copy) => [copy.name, copy] as const))(
      "%s puts its code on the clipboard inside the click, then says so",
      async (name, copy) => {
        const c = withFolder({ queryRange: "today", dayStartHour: 3 });
        c.tab.display();
        const button = componentOf(c.el, name);
        expect(button.kind).toBe("button");
        expect(button.buttonText).toBe("Copy");
        button.click?.();
        // Before anything is awaited: iOS gives the clipboard only to the gesture.
        expect(written).toEqual([queryCode(copy.kind, queryOptions(c.settings, "Pomodoro_logs"))]);
        expect(Notice.shown).toEqual([]);
        await flushTab();
        expect(Notice.shown).toEqual([copy.copied]);
        expect(Modal.opened).toBeNull();
        // Copying writes nothing of the plugin's.
        expect(c.calls).toEqual([]);
      }
    );

    it("runs the same copy from the 1.13 definitions", () => {
      const c = withFolder();
      const group = groupNamed(c.tab, QUERY_GROUP_HEADING) as unknown as {
        items: { name: string; action?: (el: unknown, i: number) => void }[];
      };
      group.items.find((i) => i.name === QUERY_COPIES[2].name)?.action?.({}, 0);
      expect(written).toEqual([queryCode("totals", queryOptions(c.settings, "Pomodoro_logs"))]);
    });

    it("shows the code selected in a dialog when the clipboard refuses", async () => {
      answer = Promise.reject(new Error("denied"));
      const c = withFolder();
      c.tab.display();
      componentOf(c.el, QUERY_COPIES[0].name).click?.();
      await flushTab();
      expect(Notice.shown).toEqual([]);
      const area = fallbackText();
      expect(area?.value).toBe(sessionsCode(c.settings));
      expect(area?.selected).toBe(true);
      expect(area?.attrs.readonly).toBe("");
      expect(area?.classes).toContain("gp-copy-fallback");
    });

    it("shows the dialog straight away where there is no clipboard", () => {
      clipboard = undefined;
      const c = withFolder();
      c.tab.display();
      componentOf(c.el, QUERY_COPIES[1].name).click?.();
      expect(fallbackText()?.value).toBe(
        sessionsTableJs(queryOptions(c.settings, "Pomodoro_logs"))
      );
    });

    it("copies nothing without a log folder, and says why", async () => {
      const c = makeTab();
      c.tab.display();
      componentOf(c.el, QUERY_COPIES[0].name).click?.();
      await flushTab();
      expect(written).toEqual([]);
      expect(Modal.opened).toBeNull();
      expect(Notice.shown).toEqual([NO_LOG_FOLDER_NOTICE]);
    });

    it("copies nothing for the vault's top level, and says why", async () => {
      const c = makeTab({ logFolderPath: "/" });
      c.tab.display();
      componentOf(c.el, QUERY_COPIES[3].name).click?.();
      await flushTab();
      expect(written).toEqual([]);
      expect(Notice.shown).toEqual([logFolderProblemNotice("/", { kind: "root" })]);
    });

    it("fills in the vault's own spelling of the folder, as Dataview's index needs", () => {
      const c = makeTab({ logFolderPath: " pomodoro_LOGS " }, LOGS);
      c.tab.display();
      componentOf(c.el, QUERY_COPIES[0].name).click?.();
      expect(written[0]).toContain('FROM "Pomodoro_logs"');
      expect(codeEl(c.el).pre.text).toContain('FROM "Pomodoro_logs"');
    });
  });
});

describe("the Log tables group's stylesheet", () => {
  const rules = parseRules(
    stripComments(readFileSync(resolve(__dirname, "..", "styles.css"), "utf8"))
  );
  const bodyOf = (sel: string): string => {
    const found = rules.filter((r) => r.sel === sel && r.context.length === 0);
    expect(found, sel).toHaveLength(1);
    return found[0].body.replace(/\s+/g, " ");
  };

  it("holds the column list and the code to the row's width when a narrow pane stacks the row", () => {
    // Below 400px of settings pane app.css makes a setting row a column with
    // align-items: flex-start, so a child is as wide as its content: the code
    // came out 1488px wide in a 320px pane, and the whole tab scrolled
    // sideways (headless Chrome under 1.13.7's and 1.14.5's app.css).
    for (const sel of [".gp-column-list", ".gp-column-add", ".gp-query-code"]) {
      expect(bodyOf(sel), sel).toMatch(/(^|;)\s*align-self: stretch;/);
      expect(bodyOf(sel), sel).toMatch(/(^|;)\s*max-width: 100%;/);
    }
    // The add buttons wrap, and a long name is cut, never the row.
    expect(bodyOf(".gp-column-chips")).toMatch(/(^|;)\s*flex-wrap: wrap;/);
    expect(bodyOf(".gp-column-chip-name")).toMatch(/(^|;)\s*text-overflow: ellipsis;/);
    // And the code scrolls inside itself instead.
    expect(bodyOf(".gp-query-code-text")).toMatch(/(^|;)\s*overflow: auto;/);
  });

  it("shows the code left to right under a right-to-left app language", () => {
    // Obsidian gives the modal direction: rtl in Arabic, Hebrew and the other
    // right-to-left languages, and the code took it: the fence showed as
    // dataview``` and the first line was cut off at the left (headless
    // Chrome under 1.13.7's app.css). Both the preview and the window to copy
    // by hand are code.
    for (const sel of [".gp-query-code-text", ".gp-copy-fallback"]) {
      expect(bodyOf(sel), sel).toMatch(/(^|;)\s*direction: ltr;/);
      expect(bodyOf(sel), sel).toMatch(/(^|;)\s*text-align: left;/);
    }
  });

  it("rings a focused arrow and Show the code with the plugin's own ring, on every version", () => {
    // Obsidian 1.7 draws no ring on a clickable icon and no version on a
    // summary, so without this a focused one looked like the rest
    // (headless Chromium under 1.7.7's and 1.13.7's app.css).
    const ring = rules.filter(
      (r) =>
        r.context.length === 0 &&
        r.sel.includes(".gp-column-item .extra-setting-button:focus-visible") &&
        r.sel.includes(".gp-column-add .gp-column-chips button.gp-column-chip:focus-visible") &&
        r.sel.includes(".gp-query-code > summary:focus-visible")
    );
    expect(ring).toHaveLength(1);
    const body = ring[0].body.replace(/\s+/g, " ");
    expect(body).toMatch(
      /(^|;)\s*outline: var\(--gp-focus-ring-width\) solid var\(--gp-focus-ring-color\);/
    );
    expect(body).toMatch(/(^|;)\s*outline-offset: var\(--gp-focus-ring-offset\);/);
    // 1.13's grey halo off, so the two versions show one ring.
    expect(body).toMatch(/(^|;)\s*box-shadow: none;/);
  });
  /** (ids, classes, elements) of one selector, enough for the selectors here. */
  const specificity = (selector: string): [number, number, number] => {
    const noPseudoElements = selector.replace(/::[\w-]+/g, " ");
    const ids = (noPseudoElements.match(/#[\w-]+/g) ?? []).length;
    const classes = (noPseudoElements.match(/\.[\w-]+|\[[^\]]*\]|:(?!not\()[\w-]+/g) ?? []).length;
    const elements = (
      noPseudoElements.replace(/\[[^\]]*\]/g, "").match(/(^|[\s>+~(])[a-z][\w-]*/gi) ?? []
    ).length;
    return [ids, classes, elements];
  };
  const above = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

  it("styles the add buttons over app.css's button rules on specificity, never on load order", () => {
    // `.is-tablet button:not(.clickable-icon)` is (0,2,1): a tie would be won
    // only by where the stylesheets load (DESIGN.md's rule).
    expect(specificity(".is-tablet button:not(.clickable-icon)")).toEqual([0, 2, 1]);
    const chipSelectors = rules
      .flatMap((r) => r.sel.split(", "))
      .filter((sel) => /\.gp-column-chip(?![\w-])/.test(sel));
    expect(chipSelectors.length).toBeGreaterThanOrEqual(4);
    for (const sel of chipSelectors) expect(above(specificity(sel), [0, 2, 1]), sel).toBe(true);
  });

  it("takes app.css's button look off the add buttons, and keeps Obsidian's tooltip off them", () => {
    const body = bodyOf(".gp-column-add .gp-column-chips button.gp-column-chip");
    for (const decl of [
      "height: auto;",
      "box-shadow: none;",
      "background-color: transparent;",
      "min-width: 0;",
      "max-width: 100%;",
      "--no-tooltip: true;",
    ]) {
      expect(body, decl).toContain(decl);
    }
  });

  it("gives an add button on a touch screen the arrows' 36px target", () => {
    const minHeight = (sel: string) => /min-height: (\d+)px;/.exec(bodyOf(sel))?.[1];
    expect(minHeight("body.is-mobile .gp-column-item .extra-setting-button")).toBe("36");
    expect(minHeight("body.is-mobile .gp-column-add .gp-column-chips button.gp-column-chip")).toBe(
      "36"
    );
  });

  it("hides Add a column when every column is in the table, by the class the tab writes", () => {
    expect(bodyOf(".gp-column-add.gp-column-add-empty")).toMatch(/(^|;)\s*display: none;/);
    const source = readFileSync(resolve(__dirname, "..", "GentlePomoSettingTab.ts"), "utf8");
    expect(source).toContain('toggleClass("gp-column-add-empty"');
  });

  it("keeps the status line where a screen reader reads it, out of sight", () => {
    const body = bodyOf(".gp-column-status");
    expect(body).toMatch(/(^|;)\s*opacity: 0;/);
    expect(body).toMatch(/(^|;)\s*width: 1px;/);
    expect(body).toMatch(/(^|;)\s*position: absolute;/);
    const all = rules
      .filter((r) => r.sel.includes("gp-column-status"))
      .map((r) => r.body)
      .join(" ");
    expect(all).not.toMatch(/display:\s*none/);
    expect(all).not.toMatch(/visibility:\s*hidden/);
    expect(all).not.toMatch(/clip-path/);
  });

  it("holds the hidden status line to its own row, on 1.7 too", () => {
    expect(bodyOf(".gp-setting-wide")).toMatch(/(^|;)\s*position: relative;/);
  });

  it("shows a disabled column button as one, with the cursor too", () => {
    expect(bodyOf('.gp-column-item .extra-setting-button[aria-disabled="true"]')).toMatch(
      /(^|;)\s*cursor: not-allowed;/
    );
  });
});
