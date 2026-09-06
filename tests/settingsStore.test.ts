import { describe, it, expect, beforeEach } from "vitest";
import {
  SettingsStore,
  classifyPluginData,
  coerceToDefaults,
  deriveEndChimes,
  type SettingsIo,
} from "../settingsStore";
import { SETTINGS_SAVE_RENOTIFY_MS } from "../constants";
import { DEFAULT_SETTINGS } from "../constants";

class Io implements SettingsIo {
  clock = 1_700_000_000_000;
  /** What loadData() hands back. Obsidian's contract is tri-state. */
  raw: unknown = null;
  readThrows = false;
  writeFails = false;
  writes: unknown[] = [];
  notices: string[] = [];
  warnings: string[] = [];

  read(): Promise<unknown> {
    if (this.readThrows) return Promise.reject(new Error("host rejected"));
    return Promise.resolve(this.raw);
  }
  write(data: unknown): Promise<void> {
    if (this.writeFails) return Promise.reject(new Error("EROFS: read-only file system"));
    this.writes.push(data);
    return Promise.resolve();
  }
  now(): number {
    return this.clock;
  }
  notice(message: string): void {
    this.notices.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
}

describe("classifyPluginData — Plugin.loadData()'s tri-state contract", () => {
  it("reads null as a fresh install, not as damage", () => {
    // readJson returns null only for ENOENT.
    expect(classifyPluginData(null)).toEqual({ kind: "fresh" });
  });

  it("reads undefined as damage", () => {
    // This is the ONLY signal that a file exists and could not be read or
    // parsed — readJson catches, console.errors, and hands back undefined.
    // Nothing rejects, so a try/catch around loadData() learns nothing.
    expect(classifyPluginData(undefined)).toEqual({ kind: "damaged" });
  });

  it("reads an object as settings", () => {
    expect(classifyPluginData({ a: 1 })).toEqual({ kind: "ok", data: { a: 1 } });
  });

  it("treats valid JSON that is not an object as damage", () => {
    // Merging `5` into the defaults would silently yield the defaults, and the
    // file would then be written over as though it had been settings.
    for (const raw of [5, "text", true, []]) {
      expect(classifyPluginData(raw), JSON.stringify(raw)).toEqual({ kind: "damaged" });
    }
  });
});

describe("coerceToDefaults", () => {
  const defaults = {
    tasksPath: "",
    focusMinutes: 25,
    showEndTime: true,
    musicPositions: [] as unknown[],
    lastGoalHitDate: null,
  };

  it("keeps values whose type matches", () => {
    const out = coerceToDefaults(
      { tasksPath: "Projects", focusMinutes: 50, showEndTime: false },
      defaults
    );
    expect(out).toEqual({ tasksPath: "Projects", focusMinutes: 50, showEndTime: false });
  });

  it("drops a field whose type would crash startup", () => {
    // The residual case: valid JSON, valid object, and `.trim()` on it throws
    // inside onload a few lines after the merge.
    expect(coerceToDefaults({ tasksPath: 123 }, defaults)).toEqual({});
    expect(coerceToDefaults({ focusMinutes: "25" }, defaults)).toEqual({});
    expect(coerceToDefaults({ showEndTime: "yes" }, defaults)).toEqual({});
  });

  it("does not accept an object where an array is expected, or the reverse", () => {
    expect(coerceToDefaults({ musicPositions: { 0: "x" } }, defaults)).toEqual({});
    expect(coerceToDefaults({ tasksPath: [] }, defaults)).toEqual({});
  });

  it("drops an explicit null or undefined so the default wins", () => {
    expect(coerceToDefaults({ focusMinutes: null }, defaults)).toEqual({});
    expect(coerceToDefaults({ focusMinutes: undefined }, defaults)).toEqual({});
  });

  it("lets anything through where the default is null", () => {
    // lastGoalHitDate is null until first written and a string afterwards, so
    // the default carries no type to check against.
    expect(coerceToDefaults({ lastGoalHitDate: "2026-08-30" }, defaults)).toEqual({
      lastGoalHitDate: "2026-08-30",
    });
  });

  it("keeps unknown keys, so a downgrade and upgrade is not lossy", () => {
    // A data.json written by a newer version must survive a rollback.
    expect(coerceToDefaults({ tasksPath: "P", futureField: { a: 1 } }, defaults)).toEqual({
      tasksPath: "P",
      futureField: { a: 1 },
    });
  });

  it("accepts every real default unchanged", () => {
    const settings = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    expect(coerceToDefaults({ ...settings }, settings)).toEqual(settings);
  });
});

let io: Io;
let store: SettingsStore;
beforeEach(() => {
  io = new Io();
  store = new SettingsStore(io);
});

describe("reading", () => {
  it("says nothing on a fresh install", async () => {
    io.raw = null;
    expect(await store.read()).toEqual({ kind: "fresh" });
    expect(io.notices).toEqual([]);
  });

  it("tells the user when the file is damaged, and says the file was left alone", async () => {
    io.raw = undefined;
    expect((await store.read()).kind).toBe("damaged");
    expect(io.notices).toHaveLength(1);
    expect(io.notices[0]).toContain("started with the defaults");
    expect(io.notices[0]).toContain("left alone");
  });

  it("survives a host that does reject, rather than taking onload down", async () => {
    io.readThrows = true;
    expect((await store.read()).kind).toBe("damaged");
    expect(io.warnings.length).toBeGreaterThan(0);
  });
});

describe("writing", () => {
  it("reports a failed write", async () => {
    io.writeFails = true;
    expect(await store.save({ a: 1 })).toBe(false);
    expect(io.notices).toHaveLength(1);
    expect(io.notices[0]).toContain("couldn't save");
  });

  it("says nothing when the write lands", async () => {
    expect(await store.save({ a: 1 })).toBe(true);
    expect(io.notices).toEqual([]);
    expect(io.writes).toEqual([{ a: 1 }]);
  });

  it("does not nag once a minute has not passed", async () => {
    // The pre-1.13 settings path commits on every keystroke, so an unwritable
    // vault would otherwise queue one Notice per character typed.
    io.writeFails = true;
    for (let i = 0; i < 30; i++) {
      await store.save({ i });
      io.clock += 1000;
    }
    expect(io.notices).toHaveLength(1);
  });

  it("speaks up again after the rate-limit window", async () => {
    io.writeFails = true;
    await store.save({});
    io.clock += SETTINGS_SAVE_RENOTIFY_MS + 1;
    await store.save({});
    expect(io.notices).toHaveLength(2);
  });

  it("reports again on the next failure after a success", async () => {
    io.writeFails = true;
    await store.save({});
    io.writeFails = false;
    await store.save({});
    io.writeFails = true;
    await store.save({});
    // A failure following a recovery is news, whatever the clock says.
    expect(io.notices).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the two chimes' first-run values.
//
// The rule that matters: NOBODY'S SOUNDS CHANGE ON UPGRADE. Before 0.6.3 the
// auto-start path chimed unconditionally and the overtime path never did, so
// each auto-start toggle exactly describes what that user hears today — which
// is why the chime inherits from it. Only a brand-new install, with no history
// to preserve, gets the designed defaults.
// ---------------------------------------------------------------------------
describe("deriveEndChimes", () => {
  it("a brand-new install gets break-end ON and focus-end OFF", () => {
    // focus->break stays quiet even for new users: that is the edge where a
    // chime would interrupt a session someone may want to keep going with.
    expect(deriveEndChimes({ kind: "fresh" }, null)).toEqual({
      focusEndSoundEnabled: false,
      breakEndSoundEnabled: true,
    });
  });

  it("an upgrading user inherits each chime from the matching auto-start", () => {
    // Auto-start ON today == they hear a cue today, so the chime comes on and
    // they notice no difference. Auto-start OFF == silence today, so it stays
    // off. Either way the switch now works, which it did not before.
    expect(
      deriveEndChimes({ kind: "ok", data: {} }, { autoStartBreak: true, autoStartFocus: false })
    ).toEqual({ focusEndSoundEnabled: true, breakEndSoundEnabled: false });

    expect(
      deriveEndChimes({ kind: "ok", data: {} }, { autoStartBreak: false, autoStartFocus: true })
    ).toEqual({ focusEndSoundEnabled: false, breakEndSoundEnabled: true });
  });

  it("an upgrading user with neither auto-start stays completely silent", () => {
    // The shipped default, and the majority case: exactly as quiet as 0.6.2.
    expect(deriveEndChimes({ kind: "ok", data: {} }, {})).toEqual({
      focusEndSoundEnabled: false,
      breakEndSoundEnabled: false,
    });
  });

  it("a damaged data.json stays silent rather than guessing", () => {
    // An existing user whose file we merely failed to read.
    expect(deriveEndChimes({ kind: "damaged" }, null)).toEqual({
      focusEndSoundEnabled: false,
      breakEndSoundEnabled: false,
    });
  });

  it("never overwrites a choice the user has already made", () => {
    // Each key is derived independently, so a half-written data.json still
    // gets the other half filled in.
    expect(
      deriveEndChimes(
        { kind: "ok", data: {} },
        { focusEndSoundEnabled: true, breakEndSoundEnabled: false, autoStartBreak: false }
      )
    ).toEqual({});

    expect(
      deriveEndChimes(
        { kind: "ok", data: {} },
        { breakEndSoundEnabled: true, autoStartBreak: true }
      )
    ).toEqual({ focusEndSoundEnabled: true });
  });

  it("DEFAULT_SETTINGS keeps BOTH chimes off, because it is the upgrade merge base", () => {
    // If either were true, Object.assign in loadSettings() would hand it to
    // every upgrading user before any derivation runs.
    expect(DEFAULT_SETTINGS.breakEndSoundEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.focusEndSoundEnabled).toBe(false);
  });
});
