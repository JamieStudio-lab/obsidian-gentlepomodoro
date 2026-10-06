import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { App, TFile } from "obsidian";
import {
  LOG_FORMAT_NOTICE,
  deriveLogFormatNotice,
  hasOldLogLine,
  offerLogFormatNotice,
  type LogFormatNoticeHost,
} from "../logFormatNotice";
import { CHECK_LOG_NAME, CONVERT_LOG_NAME } from "../GentlePomoSettingTab";
import { NO_LOG_FOLDER_NOTICE } from "../logTools";
import { DEFAULT_SETTINGS, LOG_FORMAT_NOTICE_MS } from "../constants";
import { classifyPluginData, coerceToDefaults } from "../settingsStore";
import type { GentlePomoSettings } from "../types";
import { fakeVault, type FakeVault } from "./fakeVault";
import { callbackBody } from "./sourceText";

/**
 * The one notice after upgrading to 0.6.9: old-format lines left in the log,
 * and where Convert is. Lines are made up; none is copied from a real log.
 */

const V1_FOCUS =
  "- 🍅 Focus | Task:: [[Projects/Garden.md|Plant the tulips]] | ID:: t9k2xq | Start:: 2026-10-01 09:00:00 | End:: 2026-10-01 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";
const V1_REST =
  "- ☕ Rest | Start:: 2026-10-01 09:25:00 | End:: 2026-10-01 09:30:00 | Scheduled:: 300 | Total:: 300 | Type:: short-break";
const V2_FOCUS =
  "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";
const V2_REST =
  "- ☕ Rest [Start:: 2026-10-02 10:25:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]";

const LOG = (date: string) => `Logs/${date}-gentle-pomodoro-log.md`;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

interface Harness {
  host: LogFormatNoticeHost;
  vault: FakeVault;
  settings: GentlePomoSettings;
  /** Every notice, with its duration. */
  notices: { message: string; durationMs: number }[];
  /** The flag as each save found it. */
  saves: boolean[];
  /** The files read, in order. */
  reads: string[];
  /** The flag as each read found it. */
  flagAtRead: boolean[];
  /** The plugin has been unloaded (onunload ran). */
  unloaded: boolean;
}

function harness(
  files: Record<string, string>,
  set: Partial<GentlePomoSettings> = {},
  unreadable: string[] = []
): Harness {
  const vault = fakeVault(files);
  const h: Harness = {
    host: null as unknown as LogFormatNoticeHost,
    vault,
    settings: { ...DEFAULT_SETTINGS, logFolderPath: "Logs", logFormatNoticePending: true, ...set },
    notices: [],
    saves: [],
    reads: [],
    flagAtRead: [],
    unloaded: false,
  };
  const read = vault.cachedRead;
  vault.cachedRead = (file: TFile) => {
    h.reads.push(file.path);
    h.flagAtRead.push(h.settings.logFormatNoticePending);
    return unreadable.includes(file.path) ? Promise.reject(new Error("offloaded")) : read(file);
  };
  h.host = {
    app: { vault } as unknown as App,
    settings: () => h.settings,
    save: () => {
      h.saves.push(h.settings.logFormatNoticePending);
      return Promise.resolve();
    },
    notice: (message, durationMs) => {
      h.notices.push({ message, durationMs });
    },
    unloaded: () => h.unloaded,
  };
  return h;
}

/**
 * What loadSettings makes of a data.json as `saved` left it, the derivation
 * included: null for none at all, undefined for one that cannot be read
 * (loadData's two failures, settingsStore.ts).
 */
function reload(saved: unknown): GentlePomoSettings {
  const read = classifyPluginData(
    saved === undefined ? undefined : (JSON.parse(JSON.stringify(saved)) as unknown)
  );
  const loaded =
    read.kind === "ok"
      ? (coerceToDefaults(
          read.data,
          DEFAULT_SETTINGS as unknown as Record<string, unknown>
        ) as Partial<GentlePomoSettings>)
      : null;
  const derived = deriveLogFormatNotice(loaded);
  const settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
  if (derived !== undefined) settings.logFormatNoticePending = derived;
  return settings;
}

describe("deriveLogFormatNotice", () => {
  it("makes no data.json at all look once too: a reinstall, or a damaged one deleted, keeps the old logs", () => {
    // Uninstalling deletes the plugin's folder, data.json in it (app.js
    // 1.13.7), and leaves the vault's logs; and the damaged-file notice says
    // to delete the file. A first install looks once, at a log that has none.
    expect(deriveLogFormatNotice(null)).toBe(true);
    expect(reload(null).logFormatNoticePending).toBe(true);
  });

  it("makes an upgrade — a data.json without the field — look once", () => {
    expect(deriveLogFormatNotice({})).toBe(true);
    expect(reload({ focusMinutes: 30 }).logFormatNoticePending).toBe(true);
  });

  it("leaves a stored value alone, whichever it is", () => {
    expect(deriveLogFormatNotice({ logFormatNoticePending: false })).toBeUndefined();
    expect(deriveLogFormatNotice({ logFormatNoticePending: true })).toBeUndefined();
    expect(reload({ logFormatNoticePending: false }).logFormatNoticePending).toBe(false);
    expect(reload({ logFormatNoticePending: true }).logFormatNoticePending).toBe(true);
  });

  it("makes a damaged data.json look once too", () => {
    expect(reload(undefined).logFormatNoticePending).toBe(true);
    expect(reload([]).logFormatNoticePending).toBe(true);
  });

  it("after a damaged data.json, the run's first ordinary save keeps the look for the next start", async () => {
    // loadSettings saves nothing over a damaged file, but the run's first
    // ordinary save — a setting changed, the long-break counter — writes the
    // whole object, this flag with it. Derived false, that save spent the one
    // notice on a vault whose old lines were never announced.
    const run: GentlePomoSettings = { ...DEFAULT_SETTINGS };
    const derived = deriveLogFormatNotice(null);
    if (derived !== undefined) run.logFormatNoticePending = derived;
    const files = { [LOG("2026-10-01")]: `${V1_FOCUS}\n` };

    // That run the look waits, and so saves nothing over the damaged file
    // either: the folder is the default, which is none.
    expect(DEFAULT_SETTINGS.logFolderPath).toBe("");
    const damaged = harness(files, run);
    expect(await offerLogFormatNotice(damaged.host)).toBe("no-folder");
    expect(damaged.saves).toEqual([]);

    // The user sets the log folder again, which saves the whole object.
    const next = harness(files, reload({ ...damaged.settings, logFolderPath: "Logs" }));
    expect(await offerLogFormatNotice(next.host)).toBe("shown");
    expect(next.notices).toHaveLength(1);
  });

  it("reads a value of the wrong type as none: an upgrade, looking once", () => {
    expect(reload({ logFormatNoticePending: "no" }).logFormatNoticePending).toBe(true);
  });

  it("is false in DEFAULT_SETTINGS, so nothing that falls back to it ever looks", () => {
    expect(DEFAULT_SETTINGS.logFormatNoticePending).toBe(false);
  });
});

describe("hasOldLogLine", () => {
  it("finds a version 1 line, Focus or Rest", () => {
    expect(hasOldLogLine(`${V2_FOCUS}\n${V1_FOCUS}\n`)).toBe(true);
    expect(hasOldLogLine(`${V2_FOCUS}\r\n${V1_REST}\r\n`)).toBe(true);
  });

  it("finds none in a log of version 2 lines, notes and headings", () => {
    expect(
      hasOldLogLine(
        `## Morning\n${V2_FOCUS}\n${V2_REST}\nWrote | Start:: by hand\n- 🍅 Focus later\n`
      )
    ).toBe(false);
    expect(hasOldLogLine("")).toBe(false);
  });

  it("skips the file's properties, as every reader of the log does", () => {
    const content = `---\ngoal_minutes: 120\nquoted:\n  ${V1_FOCUS}\n---\n${V2_FOCUS}\n`;
    expect(hasOldLogLine(content)).toBe(false);
  });
});

describe("offerLogFormatNotice", () => {
  it("after a reinstall over old logs — no data.json — waits for the folder, then says so once", async () => {
    // The folder is the default, none, until the user sets it again.
    const files = { [LOG("2026-10-01")]: `${V1_FOCUS}\n` };
    const start = reload(null);
    expect(start.logFolderPath).toBe("");
    const first = harness(files, start);
    expect(await offerLogFormatNotice(first.host)).toBe("no-folder");
    expect(first.reads).toEqual([]);
    expect(first.saves).toEqual([]);

    const next = harness(files, reload({ ...first.settings, logFolderPath: "Logs" }));
    expect(await offerLogFormatNotice(next.host)).toBe("shown");
    expect(next.notices).toHaveLength(1);
    expect(next.saves).toEqual([false]);
  });

  it("on a first install, looks once at the new log, finds nothing and says nothing", async () => {
    const h = harness(
      { [LOG("2026-10-06")]: `${V2_FOCUS}\n` },
      { ...reload(null), logFolderPath: "Logs" }
    );
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.notices).toEqual([]);
    expect(h.saves).toEqual([false]);
    expect(await offerLogFormatNotice(h.host)).toBe("not-pending");
  });

  it("after an upgrade with old lines: one notice, and the flag cleared and saved", async () => {
    const h = harness({
      [LOG("2026-10-01")]: `${V1_FOCUS}\n${V1_REST}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    expect(await offerLogFormatNotice(h.host)).toBe("shown");
    expect(h.notices).toEqual([{ message: LOG_FORMAT_NOTICE, durationMs: LOG_FORMAT_NOTICE_MS }]);
    expect(h.settings.logFormatNoticePending).toBe(false);
    expect(h.saves).toEqual([false]);
  });

  it("clears the flag only once the look is over, so a start cut short looks again", async () => {
    // Read last day first: a folder's last child comes first (filesInFolder).
    const h = harness({
      [LOG("2026-10-01")]: `${V1_FOCUS}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    await offerLogFormatNotice(h.host);
    expect(h.flagAtRead).toEqual([true, true]);
    expect(h.settings.logFormatNoticePending).toBe(false);
  });

  it("stays up longer than Obsidian's default notice", () => {
    expect(LOG_FORMAT_NOTICE_MS).toBeGreaterThan(5000);
  });

  it("stops at the first old line it finds", async () => {
    const h = harness({
      [LOG("2026-09-29")]: `${V1_FOCUS}\n`,
      [LOG("2026-09-30")]: `${V1_FOCUS}\n`,
      [LOG("2026-10-01")]: `${V1_FOCUS}\n`,
    });
    await offerLogFormatNotice(h.host);
    expect(h.reads).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it("after an upgrade with only new lines: no notice, and the flag cleared and saved", async () => {
    const h = harness({
      [LOG("2026-10-01")]: `${V2_FOCUS}\n${V2_REST}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.reads).toHaveLength(2);
    expect(h.notices).toEqual([]);
    expect(h.settings.logFormatNoticePending).toBe(false);
    expect(h.saves).toEqual([false]);
  });

  it("does not look again at the next start, found or not", async () => {
    for (const content of [`${V1_FOCUS}\n`, `${V2_FOCUS}\n`]) {
      const first = harness({ [LOG("2026-10-01")]: content }, reload({ logFolderPath: "Logs" }));
      expect(first.settings.logFormatNoticePending).toBe(true);
      await offerLogFormatNotice(first.host);

      const second = harness({ [LOG("2026-10-01")]: content }, reload(first.settings));
      expect(await offerLogFormatNotice(second.host)).toBe("not-pending");
      expect(second.reads).toEqual([]);
      expect(second.notices).toEqual([]);
      expect(second.saves).toEqual([]);
    }
  });

  it("with no log folder: reads, says and saves nothing, and looks once a folder is set", async () => {
    const files = { [LOG("2026-10-01")]: `${V1_FOCUS}\n` };
    for (const folder of ["", "  "]) {
      const h = harness(files, { logFolderPath: folder });
      expect(await offerLogFormatNotice(h.host)).toBe("no-folder");
      expect(h.reads).toEqual([]);
      expect(h.notices).toEqual([]);
      expect(h.saves).toEqual([]);
      expect(h.settings.logFormatNoticePending).toBe(true);

      h.settings.logFolderPath = "Logs";
      expect(await offerLogFormatNotice(h.host)).toBe("shown");
      expect(h.notices).toHaveLength(1);
    }
  });

  it("with a stored folder the log's commands cannot list: waits until it is fixed", async () => {
    const files = { [LOG("2026-10-01")]: `${V1_FOCUS}\n` };
    for (const folder of ["logs", "/"]) {
      const h = harness(files, { logFolderPath: folder });
      expect(await offerLogFormatNotice(h.host)).toBe("no-folder");
      expect(h.reads).toEqual([]);
      expect(h.notices).toEqual([]);
      expect(h.saves).toEqual([]);
      expect(h.settings.logFormatNoticePending).toBe(true);

      h.settings.logFolderPath = "Logs";
      expect(await offerLogFormatNotice(h.host)).toBe("shown");
    }
  });

  it("with a folder set that has no log files yet: nothing old, the look is over", async () => {
    const h = harness({ "Notes/a.md": "x" }, { logFolderPath: "Logs" });
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.notices).toEqual([]);
    expect(h.saves).toEqual([false]);
  });

  it("reads only files named like a daily log, as Check log and Convert do", async () => {
    const h = harness({
      "Logs/Index.md": `Quoted from an old day:\n${V1_FOCUS}\n`,
      "Logs/2026-10-01-notes.md": `${V1_FOCUS}\n`,
      [LOG("2026-10-02")]: `${V2_FOCUS}\n`,
    });
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.reads).toEqual([LOG("2026-10-02")]);
  });

  it("finds old lines in a subfolder of the log folder, as Convert does", async () => {
    const h = harness({ "Logs/2025/2025-12-01-gentle-pomodoro-log.md": `${V1_FOCUS}\n` });
    expect(await offerLogFormatNotice(h.host)).toBe("shown");
  });

  it("passes over a file it cannot read, and still finds the old lines in another", async () => {
    const h = harness(
      {
        [LOG("2026-09-30")]: `${V1_FOCUS}\n`,
        [LOG("2026-10-01")]: `${V1_FOCUS}\n`,
      },
      {},
      // The one read first: a folder's last child comes first (filesInFolder).
      [LOG("2026-10-01")]
    );
    expect(await offerLogFormatNotice(h.host)).toBe("shown");
    expect(h.reads).toEqual([LOG("2026-10-01"), LOG("2026-09-30")]);
  });

  it("ends the look when no file can be read, so it never reads them at every start", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n` }, {}, [LOG("2026-10-01")]);
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.notices).toEqual([]);
    expect(h.settings.logFormatNoticePending).toBe(false);
    expect(h.saves).toEqual([false]);
  });

  it("ends the look on an unexpected failure too, and does not throw", async () => {
    const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n` });
    h.vault.cachedRead = () => Promise.resolve(null as unknown as string);
    expect(await offerLogFormatNotice(h.host)).toBe("none");
    expect(h.settings.logFormatNoticePending).toBe(false);
    expect(h.saves).toEqual([false]);
  });

  describe("once the plugin is unloaded mid-look (F19's shape)", () => {
    /** The first read waits until released: a big folder, a phone, iCloud. */
    function slowFirstRead(h: Harness) {
      const read = h.vault.cachedRead;
      let release: (() => void) | null = null;
      let first = true;
      h.vault.cachedRead = (file: TFile) => {
        if (!first) return read(file);
        first = false;
        return new Promise((resolve) => {
          release = () => {
            void read(file).then(resolve);
          };
        });
      };
      return async () => {
        await vi.waitFor(() => {
          expect(release).not.toBeNull();
        });
        return release!;
      };
    }

    it("says nothing and saves nothing: the reloaded plugin looks, and its settings stay", async () => {
      // A disable and enable, or an update, while the look reads. The old
      // instance's save would put its stale settings object over the reloaded
      // one's (focusMinutes 50 back to 25), and its notice would be the second.
      const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n` });
      const released = slowFirstRead(h);
      const look = offerLogFormatNotice(h.host);
      const release = await released();
      h.unloaded = true;
      release();
      expect(await look).toBe("unloaded");
      expect(h.notices).toEqual([]);
      expect(h.saves).toEqual([]);
    });

    it("reads no further file", async () => {
      const h = harness({
        [LOG("2026-09-30")]: `${V2_FOCUS}\n`,
        [LOG("2026-10-01")]: `${V2_FOCUS}\n`,
      });
      const released = slowFirstRead(h);
      const look = offerLogFormatNotice(h.host);
      const release = await released();
      h.unloaded = true;
      release();
      expect(await look).toBe("unloaded");
      expect(h.reads).toHaveLength(1);
      expect(h.saves).toEqual([]);
    });

    it("never starts once unloaded", async () => {
      const h = harness({ [LOG("2026-10-01")]: `${V1_FOCUS}\n` });
      h.unloaded = true;
      expect(await offerLogFormatNotice(h.host)).toBe("unloaded");
      expect(h.reads).toEqual([]);
      expect(h.notices).toEqual([]);
      expect(h.saves).toEqual([]);
    });
  });

  it("writes nothing to the log", async () => {
    const files = { [LOG("2026-10-01")]: `${V1_FOCUS}\n` };
    const h = harness(files);
    await offerLogFormatNotice(h.host);
    expect(h.vault.writes).toEqual([]);
    expect(h.vault.contents).toEqual(files);
  });
});

describe("the notice's words", () => {
  const tab = readFileSync(resolve(__dirname, "..", "GentlePomoSettingTab.ts"), "utf8");

  it("names the two buttons' rows as the settings tab names them", () => {
    expect(LOG_FORMAT_NOTICE).toContain(`"${CONVERT_LOG_NAME}"`);
    expect(LOG_FORMAT_NOTICE).toContain(`"${CHECK_LOG_NAME}"`);
  });

  it("names the group as its heading reads, in the words the other notices use", () => {
    const where = "under Daily log in the plugin's settings";
    expect(LOG_FORMAT_NOTICE).toContain(where);
    expect(NO_LOG_FOLDER_NOTICE).toContain(where);
    expect(tab).toContain('heading: "Daily log",');
  });

  it("starts as the plugin's other notices start", () => {
    expect(LOG_FORMAT_NOTICE.startsWith("Gentle pomodoro: ")).toBe(true);
  });
});

describe("the plugin's wiring", () => {
  // main.ts cannot be imported by a test (it pulls in the whole view), so the
  // lines that connect the look are read as text, comments stripped.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

  it("derives the flag from the load, before the merge, and saves what it derived", () => {
    const load = main.slice(main.indexOf("async loadSettings() {"));
    const derive = load.indexOf("const logFormatNotice = deriveLogFormatNotice(loaded);");
    const merge = load.indexOf(
      "this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});"
    );
    expect(derive).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(derive);
    const apply = load.indexOf(
      "if (logFormatNotice !== undefined) { this.settings.logFormatNoticePending = logFormatNotice; migrated = true; }"
    );
    expect(apply).toBeGreaterThan(merge);
    expect(apply).toBeLessThan(load.indexOf("if (migrated && !loadFailed)"));
  });

  it("looks after layout-ready, without holding anything up", () => {
    const block = callbackBody(main, "this.app.workspace.onLayoutReady(() => {");
    expect(block).toContain(
      "void offerLogFormatNotice({ app: this.app, settings: () => this.settings, save: () => this.saveSettings(), notice: (message, durationMs) => { new Notice(message, durationMs); }, unloaded: () => this.unloaded, });"
    );
    expect(main.match(/offerLogFormatNotice\(/g)).toHaveLength(1);
  });

  it("tells the look of the unload: set in onunload, and nowhere else", () => {
    const unload = main.slice(main.indexOf("override onunload() {"));
    const body = unload.slice(0, unload.indexOf("async activateView()"));
    expect(body).toContain("this.unloaded = true;");
    expect(main.match(/this\.unloaded = /g)).toEqual(["this.unloaded = "]);
    expect(main).toContain("private unloaded = false;");
  });
});
