import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Modal } from "../__mocks__/obsidian";
import { LogManager, taskLinkAfterMove } from "../logManager";
import { loggedTotalSeconds, parseLogLine, logSeconds } from "../logLine";
import { segmentLogs } from "../logSegments";
import { askRecovery } from "../recoveryModal";
import {
  OPEN_SESSION_KEY,
  RECOVERY_DISCARD_LABEL,
  RECOVERY_LOG_LABEL,
  RECOVERY_PLANNED_LABEL,
  RECOVERY_TITLE,
  UNFINISHED_SESSIONS_KEY,
  UNWRITTEN_LINES_KEY,
  readSavedSession,
  readSavedSessions,
  readUnwrittenLines,
  recoveredLongSession,
  recoveredSession,
  recoveryMessage,
  savedSessionEnd,
  worthRecovering,
  type RecoveryAnswer,
  type SavedSession,
} from "../sessionRecovery";
import { TimerEngine } from "../TimerEngine";
import { DEFAULT_SETTINGS, ONE_MINUTE_MS, OPEN_SESSION_SAVE_MS } from "../constants";
import { frontmatterRowCount } from "../logFrontmatter";
import type { LongSessionAnswer, LongSessionQuestion } from "../sessionGaps";
import type GentlePomoPlugin from "../main";
import type { MomentLike } from "../momentTypes";
import { fakeVault, type FakeVault } from "./fakeVault";
import { memoryStorage } from "./memoryStorage";

const require = createRequire(import.meta.url);
const realMoment = require("moment") as (input?: number) => MomentLike;
const at = (ms: number) => realMoment(ms);

/** 2 Oct 2026, local time. */
const t = (h: number, m: number, s = 0) => new Date(2026, 9, 2, h, m, s).getTime();
const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";

const saved = (overrides: Partial<SavedSession> = {}): SavedSession => ({
  mode: "focus",
  taskName: "Write docs",
  taskPath: "Projects/Docs.md",
  taskId: "abc123",
  startMs: t(9, 0),
  pauses: [],
  pauseStartMs: null,
  scheduledMinutes: 25,
  breakType: null,
  segments: [],
  plannedMs: 25 * ONE_MINUTE_MS,
  lastSeenMs: t(9, 24),
  ...overrides,
});

describe("reading a saved session back", () => {
  it("reads what LogManager saves, and refuses what it does not", () => {
    const good = saved({
      pauses: [[t(9, 5), t(9, 6)]],
      segments: [{ taskName: "A", endMs: t(9, 3) }],
    });
    expect(readSavedSession(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const bad of [
      null,
      "x",
      { ...good, mode: "nap" },
      { ...good, startMs: -1 },
      { ...good, lastSeenMs: Number.NaN },
      { ...good, pauses: [[t(9, 6), t(9, 5)]] },
      { ...good, pauses: [[t(9, 5)]] },
      { ...good, segments: [{ taskName: 3, endMs: 1 }] },
      { ...good, breakType: "medium" },
      { ...good, taskPath: 7 },
    ]) {
      expect(readSavedSession(bad)).toBeNull();
    }
    expect(readSavedSessions([good, { nope: true }])).toEqual([good]);
    expect(readSavedSessions("x")).toEqual([]);
  });
});

describe("reading kept lines back", () => {
  it("reads what LogManager keeps, and refuses an entry that is not one", () => {
    // Device storage is input like any other: damaged, an entry holding
    // something that is not a line would be written into the log as text.
    const good = { path: "Logs/a.md", folder: "Logs", lines: ["- a", "- b"], focus: true };
    expect(readUnwrittenLines(JSON.parse(JSON.stringify([good])))).toEqual([good]);
    for (const bad of [
      null,
      "x",
      { ...good, path: 3 },
      { ...good, folder: undefined },
      { ...good, lines: "- a" },
      { ...good, lines: [] },
      { ...good, lines: ["- a", 7] },
      { ...good, lines: [null] },
    ]) {
      expect(readUnwrittenLines([bad])).toEqual([]);
    }
    // One bad entry leaves the good ones; focus is true only when it says so.
    expect(readUnwrittenLines([null, { nope: true }, { ...good, focus: "yes" }])).toEqual([
      { ...good, focus: false },
    ]);
    expect(readUnwrittenLines("x")).toEqual([]);
  });
});

describe("where a recovered session ends", () => {
  it("ends where it was last seen running, or where its open pause began", () => {
    expect(savedSessionEnd(saved())).toBe(t(9, 24));
    expect(savedSessionEnd(saved({ pauseStartMs: t(9, 10), lastSeenMs: t(9, 30) }))).toBe(t(9, 10));
    // Never before it began.
    expect(savedSessionEnd(saved({ lastSeenMs: t(8, 0) }))).toBe(t(9, 0));
  });

  it("is logged finished, its pauses cut at the end, Overtime past the planned length", () => {
    const { session } = recoveredSession(
      saved({
        pauses: [[t(9, 5), t(9, 7)]],
        lastSeenMs: t(9, 40),
        plannedMs: 30 * ONE_MINUTE_MS,
      }),
      at
    );
    expect(session.status).toBe("finished");
    expect(session.endTime.valueOf()).toBe(t(9, 40));
    // 40 minutes less a 2-minute pause: 38 active, 8 past the planned 30 (±5 included).
    expect(session.overtimeSeconds).toBe(8 * 60);
  });

  it("counts Overtime past the scheduled length when the planned one is unknown", () => {
    const { session } = recoveredSession(saved({ plannedMs: null, lastSeenMs: t(9, 30) }), at);
    expect(session.overtimeSeconds).toBe(5 * 60);
  });

  it("gives a break no Overtime, and its break type", () => {
    const { session } = recoveredSession(
      saved({ mode: "break", breakType: "long", lastSeenMs: t(9, 40) }),
      at
    );
    expect(session.overtimeSeconds).toBe(0);
    expect(session.breakType).toBe("long");
  });

  it("is worth offering from exactly a minute of active time, not before (F59)", () => {
    // A minute is the shortest session a line is written for, so a session
    // of exactly a minute must still be offered — or it is dropped unasked.
    expect(worthRecovering(saved({ lastSeenMs: t(9, 0, 59) }), at)).toBe(false);
    expect(worthRecovering(saved({ lastSeenMs: t(9, 1, 0) }), at)).toBe(true);
    // Pauses are not active time.
    expect(
      worthRecovering(saved({ pauses: [[t(9, 0, 10), t(9, 0, 30)]], lastSeenMs: t(9, 1, 10) }), at)
    ).toBe(false);
  });

  it("asks in a sentence the user can answer", () => {
    expect(recoveryMessage("focus", "09:00", 24 * 60)).toBe("Unfinished focus from 09:00 (24m).");
    expect(recoveryMessage("break", "Thu 23:50", 3900)).toBe(
      "Unfinished break from Thu 23:50 (1h 5m)."
    );
    // A long one says how far past its plan it ran, and when the plan ended.
    expect(
      recoveryMessage("focus", "09:00", 6 * 3600 + 50 * 60, {
        overtimeSeconds: 6 * 3600 + 25 * 60,
        plannedEndLabel: "09:35",
      })
    ).toBe("Unfinished focus from 09:00 (6h 50m). It ran 6h 25m past its planned end, 09:35.");
  });
});

describe("Log up to planned end — a long unfinished session (F18)", () => {
  // Started 09:00, paused 09:10–09:20, last seen 16:00: 6 h 50 m of active
  // time against a 25-minute plan, which it reached at 09:35.
  const long = (overrides: Partial<SavedSession> = {}) =>
    saved({ pauses: [[t(9, 10), t(9, 20)]], lastSeenMs: t(16, 0), ...overrides });

  it("is offered for a focus past the long-session threshold and its plan, ending where the plan was reached", () => {
    expect(recoveredLongSession(long(), at, 6)).toEqual({
      activeSeconds: 6 * 3600 + 50 * 60,
      overtimeSeconds: 6 * 3600 + 25 * 60,
      plannedEndAt: t(9, 35),
    });
    // The plan as the clock had it, ±5 included.
    expect(recoveredLongSession(long({ plannedMs: 30 * ONE_MINUTE_MS }), at, 6)).toMatchObject({
      plannedEndAt: t(9, 40),
    });
    // From exactly the threshold.
    expect(recoveredLongSession(long({ lastSeenMs: t(15, 10) }), at, 6)).not.toBeNull();
  });

  it("is not offered below the threshold, with the setting off, for a break, or within the plan", () => {
    expect(recoveredLongSession(long({ lastSeenMs: t(15, 9, 59) }), at, 6)).toBeNull();
    expect(recoveredLongSession(long(), at, 8)).toBeNull();
    expect(recoveredLongSession(long(), at, 0)).toBeNull();
    expect(recoveredLongSession(long({ mode: "break", breakType: "long" }), at, 6)).toBeNull();
    expect(recoveredLongSession(long({ plannedMs: 8 * 3600 * 1000 }), at, 6)).toBeNull();
    // A stored value the setting cannot hold reads as its default, 6 hours.
    expect(recoveredLongSession(long(), at, 5)).not.toBeNull();
  });

  // A split one, with a pause after the planned end: 09:00–09:05 on Plan,
  // then Later until 12:00, paused 11:00–12:00, last seen 17:00 — 6 h 50 m.
  const splitLong = () =>
    long({
      pauses: [
        [t(9, 10), t(9, 20)],
        [t(11, 0), t(12, 0)],
      ],
      lastSeenMs: t(17, 0),
      segments: [
        { taskName: "Plan", taskPath: "Projects/A.md", endMs: t(9, 5) },
        { taskName: "Later", taskPath: "Projects/B.md", endMs: t(12, 0) },
      ],
    });

  it("ends the line there: pauses and segments cut, Overtime 0, Total the planned length", () => {
    const question = recoveredLongSession(splitLong(), at, 6);
    expect(question?.plannedEndAt).toBe(t(9, 35));
    const { session, closed } = recoveredSession(
      splitLong(),
      at,
      question ? { endAt: question.plannedEndAt, overtimeSeconds: 0 } : undefined
    );
    expect(session.endTime.valueOf()).toBe(t(9, 35));
    expect(session.overtimeSeconds).toBe(0);
    // The pause after the planned end is not in it: it would take an hour off
    // a span it is not in.
    expect(session.pauses.map((p) => [p.start.valueOf(), p.end.valueOf()])).toEqual([
      [t(9, 10), t(9, 20)],
    ]);
    expect(loggedTotalSeconds(session)).toBe(25 * 60);
    // The segments are kept for segmentLogs, which cuts the one across the end.
    expect(closed.map((c) => [c.taskName, c.end.valueOf()])).toEqual([
      ["Plan", t(9, 5)],
      ["Later", t(12, 0)],
    ]);
    const written = segmentLogs(session, closed);
    expect(
      written.map((l) => [l.taskName, l.endTime.valueOf(), loggedTotalSeconds(l), l.pauses.length])
    ).toEqual([
      ["Plan", t(9, 5), 5 * 60, 0],
      ["Later", t(9, 35), 20 * 60, 1],
    ]);
  });
});

describe("LogManager keeps the open session on this device (F23)", () => {
  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown; window?: unknown };
    previousMoment = g.moment;
    g.moment = realMoment;
    if (typeof g.window === "undefined") g.window = globalThis;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t(9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  function setup(
    storage = memoryStorage(),
    planned: number | null | (() => number | null) = 25 * ONE_MINUTE_MS
  ) {
    const vault = fakeVault({ [LOG]: "" });
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true) },
      createFolder: () => Promise.resolve(),
    });
    const plugin = {
      settings: { ...DEFAULT_SETTINGS, logFolderPath: "Logs", soundEnabled: false },
      app: { vault },
      invalidateFocusTotalCache: () => undefined,
      saveSettings: () => Promise.resolve(),
      notifySessionEnd: () => undefined,
      duckMusicInOpenViews: () => undefined,
    } as unknown as GentlePomoPlugin;
    const plannedMs = typeof planned === "function" ? planned : () => planned;
    const lm = new LogManager(plugin, { storage, plannedMs });
    (plugin as unknown as { logManager: LogManager }).logManager = lm;
    return { vault, plugin, lm, storage };
  }
  const open = (storage: ReturnType<typeof memoryStorage>) =>
    readSavedSession(storage.load(OPEN_SESSION_KEY));
  // The session lines, past the goal the timer records at the top of today's
  // file (logFrontmatter.ts).
  const lines = (vault: FakeVault) =>
    vault.contents[LOG].split("\n")
      .slice(frontmatterRowCount(vault.contents[LOG]))
      .filter((line) => line.trim() !== "");

  it("saves it at start, pause, resume and task change, as last seen then", () => {
    const { lm, storage } = setup();
    lm.startSession("focus", "Write docs", 25, "Projects/Docs.md", "abc123");
    expect(open(storage)).toMatchObject({
      startMs: t(9, 0),
      lastSeenMs: t(9, 0),
      pauseStartMs: null,
    });

    vi.setSystemTime(t(9, 10));
    lm.pauseSession();
    expect(open(storage)).toMatchObject({ pauseStartMs: t(9, 10), lastSeenMs: t(9, 10) });

    vi.setSystemTime(t(9, 12));
    lm.startSession("focus", "Write docs", 25, "Projects/Docs.md", "abc123");
    expect(open(storage)).toMatchObject({ pauses: [[t(9, 10), t(9, 12)]], pauseStartMs: null });

    vi.setSystemTime(t(9, 13));
    lm.updateTask("Read paper", "Projects/Paper.md");
    expect(open(storage)).toMatchObject({
      taskName: "Read paper",
      taskPath: "Projects/Paper.md",
      lastSeenMs: t(9, 13),
      plannedMs: 25 * ONE_MINUTE_MS,
    });
  });

  it("saves it once a minute while it runs, and not while it is paused", () => {
    const { lm, storage } = setup();
    lm.heartbeat();
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
    lm.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 5));
    lm.heartbeat();
    expect(open(storage)?.lastSeenMs).toBe(t(9, 5));
    lm.pauseSession();
    vi.setSystemTime(t(9, 30));
    lm.heartbeat();
    expect(open(storage)?.lastSeenMs).toBe(t(9, 5));
  });

  it("clears it when the session ends — logged, or under a minute", async () => {
    const { lm, storage } = setup();
    lm.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 25));
    await lm.endSession("finished");
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();

    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    vi.setSystemTime(t(9, 25, 30));
    expect(await lm.endSession("finished")).toBe(false);
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
  });

  it("clears it when the session is thrown away — Reset, or a stray across modes", () => {
    const { lm, storage } = setup();
    lm.startSession("focus", "Write docs", 25);
    lm.discardSession();
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();

    lm.startSession("focus", "Write docs", 25);
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    expect(open(storage)?.mode).toBe("break");
  });

  it("leaves it saved at unload, seen running then, so an update offers it back", () => {
    const { lm, storage } = setup();
    lm.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 24, 30));
    lm.dispose();
    expect(open(storage)?.lastSeenMs).toBe(t(9, 24, 30));
    // Nothing a disposed manager opens is saved: it will never run.
    lm.discardSession();
    lm.startSession("break", "No Task", 5);
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
  });

  it("moves an earlier run's session to the unfinished list before anything can save over it", () => {
    const storage = memoryStorage();
    const first = setup(storage).lm;
    first.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 24));
    first.heartbeat();

    // Obsidian quits without a word, and starts again.
    const { lm } = setup(storage);
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
    expect(lm.unfinishedSessions()).toHaveLength(1);
    lm.startSession("focus", "Next", 25);
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toHaveLength(1);
    expect(lm.unfinishedSessions()[0].taskName).toBe("Write docs");
  });

  it("does not offer a session under a minute: logging it would write nothing (F59)", () => {
    const storage = memoryStorage();
    setup(storage).lm.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 0, 59));
    expect(setup(storage).lm.unfinishedSessions()).toEqual([]);
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
  });

  it("logs it, ended where it was last seen, when the answer is Log it", async () => {
    const storage = memoryStorage();
    const first = setup(storage).lm;
    first.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 40));
    first.heartbeat();
    vi.setSystemTime(t(10, 0));

    const { lm, vault } = setup(storage);
    const asked: SavedSession[] = [];
    await lm.offerUnfinishedSessions((s) => {
      asked.push(s);
      return Promise.resolve("log");
    });
    expect(asked).toHaveLength(1);
    const [line] = lines(vault);
    const parsed = parseLogLine(line);
    expect(parsed?.values.get("Start")).toBe("2026-10-02 09:00:00");
    expect(parsed?.values.get("End")).toBe("2026-10-02 09:40:00");
    expect(parsed?.values.get("Status")).toBe("finished");
    expect(parsed && logSeconds(parsed, "Total")).toBe(40 * 60);
    expect(parsed && logSeconds(parsed, "Overtime")).toBe(15 * 60);
    expect(lm.unfinishedSessions()).toEqual([]);
    expect(storage.load(UNFINISHED_SESSIONS_KEY)).toBeNull();
  });

  it("forgets it on Discard, and keeps it for the next start when the dialog just closes", async () => {
    const storage = memoryStorage();
    storage.save(UNFINISHED_SESSIONS_KEY, [
      saved(),
      saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) }),
    ]);
    const { lm, vault } = setup(storage);
    const answers: RecoveryAnswer[] = ["discard", "later"];
    await lm.offerUnfinishedSessions(() => Promise.resolve(answers.shift() ?? "later"));
    expect(lines(vault)).toEqual([]);
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toEqual([
      saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) }),
    ]);
    // A dialog that cannot open keeps it too.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setup(storage).lm.offerUnfinishedSessions(() => Promise.reject(new Error("no window")));
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toHaveLength(1);
  });

  it("asks one round at a time: a second call while the dialog is open asks nothing", async () => {
    // Two rounds at once would each ask about the same session, and two
    // answers of Log it would write its line twice.
    const storage = memoryStorage();
    storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
    const { lm, vault } = setup(storage);
    const asked: string[] = [];
    const answers: ((answer: RecoveryAnswer) => void)[] = [];
    const ask = (s: SavedSession) => {
      asked.push(s.taskName);
      return new Promise<RecoveryAnswer>((resolve) => answers.push(resolve));
    };

    // The dialog opens before the first await, so a call's question is
    // asked by the time it returns.
    const first = lm.offerUnfinishedSessions(ask);
    const second = lm.offerUnfinishedSessions(ask);
    expect(asked).toEqual(["Write docs"]);
    answers.splice(0).forEach((answer) => answer("later"));
    await Promise.all([first, second]);
    expect(lines(vault)).toEqual([]);

    // The round is over, so the next call is a round of its own.
    const next = lm.offerUnfinishedSessions(ask);
    expect(asked).toEqual(["Write docs", "Write docs"]);
    answers.splice(0).forEach((answer) => answer("log"));
    await next;
    expect(lines(vault)).toHaveLength(1);
    expect(lm.unfinishedSessions()).toEqual([]);
  });

  it("asks about each unfinished session in turn: logging the first still asks about the second", async () => {
    const storage = memoryStorage();
    const unlinked = { taskPath: undefined, taskId: undefined };
    storage.save(UNFINISHED_SESSIONS_KEY, [
      saved({ ...unlinked, startMs: t(8, 0), lastSeenMs: t(8, 30) }),
      saved({ ...unlinked, taskName: "Read paper" }),
    ]);
    const { lm, vault } = setup(storage);
    const asked: string[] = [];
    await lm.offerUnfinishedSessions((s) => {
      asked.push(s.taskName);
      return Promise.resolve("log");
    });
    expect(asked).toEqual(["Write docs", "Read paper"]);
    expect(lines(vault).map((line) => parseLogLine(line)?.task?.name)).toEqual([
      "Write docs",
      "Read paper",
    ]);
    expect(lm.unfinishedSessions()).toEqual([]);
    expect(storage.load(UNFINISHED_SESSIONS_KEY)).toBeNull();
  });

  it("keeps one copy of a session a start finds both open and unfinished", () => {
    // A start moves the open session to the unfinished list, then clears it.
    // A quit between the two, or a storage that refuses the clear (a failed
    // save is only a warning), leaves it in both — and the next start must
    // not add it a second time, or it is offered and logged twice.
    const storage = memoryStorage();
    const first = setup(storage).lm;
    first.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 24));
    first.heartbeat();

    const refusesTheClear = {
      values: storage.values,
      load: (key: string) => storage.load(key),
      save: (key: string, value: unknown) => {
        if (key === OPEN_SESSION_KEY && value === null) return;
        storage.save(key, value);
      },
    };
    setup(refusesTheClear);
    expect(open(storage)).not.toBeNull();
    const { lm } = setup(refusesTheClear);
    expect(lm.unfinishedSessions()).toHaveLength(1);
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toHaveLength(1);
  });

  it("logs a split session's segments, each for its own task", async () => {
    const storage = memoryStorage();
    storage.save(UNFINISHED_SESSIONS_KEY, [
      saved({
        taskName: "B",
        taskPath: "Projects/B.md",
        taskId: undefined,
        segments: [{ taskName: "A", taskPath: "Projects/A.md", endMs: t(9, 10) }],
      }),
    ]);
    const { lm, vault } = setup(storage);
    await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
    expect(lines(vault).map((line) => parseLogLine(line)?.task?.name)).toEqual(["A", "B"]);
  });

  it("saves nothing while no log folder is set: ending it would log nothing", () => {
    // The shipped default. Saved anyway, the next start asked "Log it?" about
    // a session it could only throw away.
    const { lm, plugin, storage } = setup();
    plugin.settings.logFolderPath = "";
    lm.startSession("focus", "Write docs", 25);
    vi.setSystemTime(t(9, 24));
    lm.heartbeat();
    lm.pauseSession();
    lm.dispose();
    expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
    expect(setup(storage).lm.unfinishedSessions()).toEqual([]);
  });

  it("does not ask while no log folder is set, and keeps the sessions for a start with one", async () => {
    const storage = memoryStorage();
    storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
    const noFolder = setup(storage);
    noFolder.plugin.settings.logFolderPath = "";
    const ask = vi.fn(() => Promise.resolve<RecoveryAnswer>("log"));
    await noFolder.lm.offerUnfinishedSessions(ask);
    expect(ask).not.toHaveBeenCalled();
    expect(noFolder.lm.unfinishedSessions()).toEqual([saved()]);
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toEqual([saved()]);

    // A folder is set, and Obsidian starts again: now it is asked, and logged.
    const { lm, vault } = setup(storage);
    await lm.offerUnfinishedSessions(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(lines(vault)).toHaveLength(1);
    expect(storage.load(UNFINISHED_SESSIONS_KEY)).toBeNull();
  });

  it("keeps a session whose Log it lands after the folder was emptied", async () => {
    const storage = memoryStorage();
    storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
    const { lm, plugin, vault } = setup(storage);
    await lm.offerUnfinishedSessions(() => {
      plugin.settings.logFolderPath = "";
      return Promise.resolve("log");
    });
    expect(lines(vault)).toEqual([]);
    expect(lm.unfinishedSessions()).toEqual([saved()]);
    expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toEqual([saved()]);
  });

  it("survives the F23 case end to end: a timer quit 24 minutes in", async () => {
    const storage = memoryStorage();
    const { plugin, lm: first } = setup(storage);
    const timer = new TimerEngine(plugin);
    timer.start();
    vi.setSystemTime(t(9, 24));
    first.heartbeat();
    // Quit: the plugin unloads (main.ts's order), and nothing is logged.
    first.dispose();
    timer.dispose();

    const { lm, vault } = setup(storage);
    await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
    const parsed = parseLogLine(lines(vault)[0]);
    expect(parsed && logSeconds(parsed, "Total")).toBe(24 * 60);
  });

  describe("Log up to planned end (F18)", () => {
    /** 09:00 start, a pause 09:10–09:20, running at 16:00: the engine's own session. */
    function longFocus(storage: ReturnType<typeof memoryStorage>) {
      let timer: TimerEngine | null = null;
      const made = setup(storage, () => timer?.getState().totalMs ?? null);
      const engine = new TimerEngine(made.plugin);
      timer = engine;
      const tickAt = (h: number, m: number) => {
        vi.setSystemTime(t(h, m));
        (engine as unknown as { tick(): void }).tick();
      };
      vi.setSystemTime(t(9, 0));
      engine.start();
      tickAt(9, 10);
      engine.pause();
      vi.setSystemTime(t(9, 20));
      engine.start();
      // A tick every 5 minutes: a longer gap would be a computer asleep (F48).
      for (let m = 20 + 5; m <= 7 * 60; m += 5) tickAt(9 + Math.floor(m / 60), m % 60);
      made.lm.heartbeat();
      return { ...made, engine };
    }

    it("logs exactly the line Stop's End at planned end logs for the same session", async () => {
      // Stopped at 16:00, answering End at planned end.
      const stopped = longFocus(memoryStorage());
      Object.assign(stopped.plugin, {
        askAboutLongSession: () => Promise.resolve<LongSessionAnswer>("planned"),
      });
      await stopped.engine.finish();
      const viaStop = lines(stopped.vault);
      stopped.engine.dispose();

      // The same session, Obsidian killed at 16:00, Log up to planned end at the next start.
      const storage = memoryStorage();
      const crashed = longFocus(storage);
      crashed.engine.dispose();
      const { lm, vault } = setup(storage);
      const offered: (LongSessionQuestion | null)[] = [];
      await lm.offerUnfinishedSessions((_s, question) => {
        offered.push(question);
        return Promise.resolve("planned");
      });

      expect(offered).toEqual([
        {
          activeSeconds: 6 * 3600 + 50 * 60,
          overtimeSeconds: 6 * 3600 + 25 * 60,
          plannedEndAt: t(9, 35),
        },
      ]);
      expect(viaStop).toHaveLength(1);
      expect(lines(vault)).toEqual(viaStop);
      const parsed = parseLogLine(viaStop[0]);
      expect(parsed?.values.get("End")).toBe("2026-10-02 09:35:00");
      expect(parsed && logSeconds(parsed, "Total")).toBe(25 * 60);
      expect(parsed && logSeconds(parsed, "Overtime")).toBe(0);
      expect(lm.unfinishedSessions()).toEqual([]);
    });

    it("Log up to planned end writes a split session's lines cut there, a pause after it dropped (F18)", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [
        saved({
          pauses: [
            [t(9, 10), t(9, 20)],
            [t(11, 0), t(12, 0)],
          ],
          lastSeenMs: t(17, 0),
          segments: [
            { taskName: "Plan", taskPath: "Projects/A.md", endMs: t(9, 5) },
            { taskName: "Later", taskPath: "Projects/B.md", endMs: t(12, 0) },
          ],
        }),
      ]);
      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => Promise.resolve("planned"));

      const written = lines(vault).map((line) => {
        const parsed = parseLogLine(line);
        return [
          parsed?.task?.raw,
          parsed?.values.get("End"),
          parsed?.values.get("Pauses"),
          parsed && logSeconds(parsed, "Total"),
          parsed && logSeconds(parsed, "Overtime"),
        ];
      });
      expect(written).toEqual([
        ["[[Projects/A.md|Plan]]", "2026-10-02 09:05:00", "[]", 5 * 60, 0],
        [
          "[[Projects/B.md|Later]]",
          "2026-10-02 09:35:00",
          '["2026-10-02 09:10:00 - 2026-10-02 09:20:00"]',
          20 * 60,
          0,
        ],
      ]);
      expect(lm.unfinishedSessions()).toEqual([]);
    });

    it("still logs all of it on Log it, and offers no third answer below the threshold or with the setting off", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [
        saved({ lastSeenMs: t(16, 0) }),
        saved({ startMs: t(17, 0), lastSeenMs: t(18, 0) }),
      ]);
      const { lm, vault } = setup(storage);
      const offered: (LongSessionQuestion | null)[] = [];
      await lm.offerUnfinishedSessions((_s, question) => {
        offered.push(question);
        return Promise.resolve("log");
      });
      expect(offered.map((q) => q?.plannedEndAt ?? null)).toEqual([t(9, 25), null]);
      expect(lines(vault).map((line) => parseLogLine(line)?.values.get("End"))).toEqual([
        "2026-10-02 16:00:00",
        "2026-10-02 18:00:00",
      ]);

      const off = memoryStorage();
      off.save(UNFINISHED_SESSIONS_KEY, [saved({ lastSeenMs: t(16, 0) })]);
      const quiet = setup(off);
      quiet.plugin.settings.longSessionPromptHours = 0;
      const asked: (LongSessionQuestion | null)[] = [];
      // "planned" with no question offered is no answer: the session waits.
      await quiet.lm.offerUnfinishedSessions((_s, question) => {
        asked.push(question);
        return Promise.resolve("planned");
      });
      expect(asked).toEqual([null]);
      expect(lines(quiet.vault)).toEqual([]);
      expect(quiet.lm.unfinishedSessions()).toHaveLength(1);
    });
  });

  describe("a task's note that moves or goes before the lines are written (F27)", () => {
    const linked = (vault: FakeVault) => lines(vault).map((line) => parseLogLine(line)?.task?.raw);
    const split = saved({
      segments: [{ taskName: "Plan", taskPath: "Projects/Docs.md", endMs: t(9, 10) }],
    });

    it("logs an unfinished session and its segments under the note's new path", async () => {
      // Answered later, the note renamed, and Log it at the next start: the
      // lines carry the path Obsidian moved the note to, never a dead link.
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [split]);
      const first = setup(storage).lm;
      await first.offerUnfinishedSessions(() => Promise.resolve("later"));
      first.taskNoteMoved("Projects/Docs.md", "Archived/Docs.md");
      first.dispose();

      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      expect(linked(vault)).toEqual([
        "[[Archived/Docs.md|Plan]]",
        "[[Archived/Docs.md|Write docs]]",
      ]);
    });

    it("follows a folder above the note, and the dialog already open logs the new path", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [split]);
      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => {
        lm.taskNoteMoved("Projects", "Done");
        return Promise.resolve("log");
      });
      expect(linked(vault)).toEqual(["[[Done/Docs.md|Plan]]", "[[Done/Docs.md|Write docs]]"]);
    });

    it("logs the name with no link once the note is deleted", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [split]);
      setup(storage).lm.taskNoteDeleted("Projects/Docs.md");
      expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))[0]).toMatchObject({
        taskPath: undefined,
        segments: [{ taskName: "Plan", taskPath: undefined }],
      });
      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      expect(linked(vault)).toEqual(["Plan", "Write docs"]);
    });

    it("leaves the stored list alone when no session's note moved", () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [split]);
      const save = vi.spyOn(storage, "save");
      const { lm } = setup(storage);
      lm.taskNoteMoved("Projects/Other.md", "Archived/Other.md");
      lm.taskNoteDeleted("Projects/Other.md");
      expect(save).not.toHaveBeenCalledWith(UNFINISHED_SESSIONS_KEY, expect.anything());
      expect(save).not.toHaveBeenCalledWith(UNWRITTEN_LINES_KEY, expect.anything());
    });

    const keptLine = (task: string) =>
      `- 🍅 Focus [Task:: ${task}] [ID:: abc123] [Start:: 2026-10-02 09:00:00] ` +
      "[End:: 2026-10-02 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
      "[Status:: finished] [Type:: focus] [Overtime:: 0]";
    const kept = (task: string) => ({
      path: LOG,
      folder: "Logs",
      lines: [keptLine(task)],
      focus: true,
    });

    it("writes a line a write failed on with the note's new path", async () => {
      const storage = memoryStorage();
      storage.save(UNWRITTEN_LINES_KEY, [kept("[[Projects/Docs.md|Write docs]]")]);
      setup(storage).lm.taskNoteMoved("Projects/Docs.md", "Archived/Docs.md");
      expect(readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY))[0].lines).toEqual([
        keptLine("[[Archived/Docs.md|Write docs]]"),
      ]);

      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { lm, vault } = setup(storage);
      expect(await lm.retryUnwrittenLines()).toBe(1);
      expect(lines(vault)).toEqual([keptLine("[[Archived/Docs.md|Write docs]]")]);
    });

    it("leaves a line a write failed on as it is when the note is deleted, as Obsidian leaves the log's", () => {
      const storage = memoryStorage();
      storage.save(UNWRITTEN_LINES_KEY, [kept("[[Projects/Docs.md|Write docs]]")]);
      setup(storage).lm.taskNoteDeleted("Projects/Docs.md");
      expect(readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY))[0].lines).toEqual([
        keptLine("[[Projects/Docs.md|Write docs]]"),
      ]);
    });
  });

  describe("a split session (F36)", () => {
    it("saves the segment a switch closes, with Split at the switch", () => {
      const { lm, plugin, storage } = setup();
      plugin.settings.taskSwitchLogging = "split";
      lm.startSession("focus", "Plan", 25, "Projects/A.md");
      vi.setSystemTime(t(9, 10));
      lm.updateTask("Write docs", "Projects/Docs.md", "abc123");
      expect(open(storage)).toMatchObject({
        taskName: "Write docs",
        segments: [{ taskName: "Plan", taskPath: "Projects/A.md", endMs: t(9, 10) }],
      });
    });

    it("logs one quit part-way as its two lines, each for its own task", async () => {
      // Saved as one segment, a crash after a switch logged the whole
      // session for the last task, though the setting says split.
      const storage = memoryStorage();
      const { lm: first, plugin } = setup(storage);
      plugin.settings.taskSwitchLogging = "split";
      first.startSession("focus", "Plan", 25, "Projects/A.md");
      vi.setSystemTime(t(9, 10));
      first.updateTask("Write docs", "Projects/Docs.md");
      vi.setSystemTime(t(9, 24));
      first.heartbeat();
      first.dispose();

      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      expect(
        lines(vault).map((line) => {
          const parsed = parseLogLine(line);
          return [parsed?.task?.raw, parsed && logSeconds(parsed, "Total")];
        })
      ).toEqual([
        ["[[Projects/A.md|Plan]]", 10 * 60],
        ["[[Projects/Docs.md|Write docs]]", 14 * 60],
      ]);
    });
  });

  describe("a ±5 made while paused (F16)", () => {
    // 27:00 into a 25-minute focus, paused, then +5: the clock shows 3
    // minutes left, and Stop would write Overtime 0. So must Log it.
    function pausedThenPlusFive(storage: ReturnType<typeof memoryStorage>) {
      let timer: TimerEngine | null = null;
      const { plugin, lm } = setup(storage, () => timer?.getState().totalMs ?? null);
      const engine = new TimerEngine(plugin);
      timer = engine;
      const tick = (h: number, m: number) => {
        vi.setSystemTime(t(h, m));
        (engine as unknown as { tick(): void }).tick();
      };
      engine.start();
      for (let m = 5; m <= 25; m += 5) tick(9, m);
      tick(9, 27);
      engine.pause();
      engine.addMinutes(5);
      expect(engine.getState().remainingMs).toBe(3 * ONE_MINUTE_MS);
      vi.setSystemTime(t(9, 40));
      return { engine, lm };
    }
    async function loggedAfterRestart(storage: ReturnType<typeof memoryStorage>) {
      const { lm, vault } = setup(storage);
      await lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      const parsed = parseLogLine(lines(vault)[0]);
      return {
        end: parsed?.values.get("End"),
        total: parsed && logSeconds(parsed, "Total"),
        overtime: parsed && logSeconds(parsed, "Overtime"),
      };
    }
    const expected = { end: "2026-10-02 09:27:00", total: 27 * 60, overtime: 0 };

    it("logs it with no Overtime after a quit", async () => {
      const storage = memoryStorage();
      const { engine, lm } = pausedThenPlusFive(storage);
      // Quit: main.ts's order.
      lm.dispose();
      engine.dispose();
      expect(await loggedAfterRestart(storage)).toEqual(expected);
    });

    it("logs it with no Overtime after a crash, which disposes nothing", async () => {
      const storage = memoryStorage();
      const { engine } = pausedThenPlusFive(storage);
      expect(await loggedAfterRestart(storage)).toEqual(expected);
      engine.dispose();
    });
  });

  describe("after unload (F19)", () => {
    /** Hold the next write to the log until `release` is called. */
    function holdNextWrite(vault: FakeVault) {
      let release: () => void = () => undefined;
      const process = vault.process.bind(vault);
      const spy = vi.spyOn(vault, "process").mockImplementationOnce(async (file, fn) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return process(file, fn);
      });
      return {
        started: () => vi.waitFor(() => expect(spy).toHaveBeenCalled()),
        release: () => release(),
      };
    }

    it("writes nothing for a recovery question answered after unload: the reloaded plugin logs it once", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [
        saved(),
        saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) }),
      ]);
      const old = setup(storage);
      let asked = 0;
      let answerOld: (answer: RecoveryAnswer) => void = () => undefined;
      const oldRound = old.lm.offerUnfinishedSessions(() => {
        asked++;
        return new Promise((resolve) => {
          answerOld = resolve;
        });
      });
      // The plugin reloads with the question open, and asks again.
      old.lm.dispose();
      const reloaded = setup(storage);
      await reloaded.lm.offerUnfinishedSessions(() => Promise.resolve("log"));

      answerOld("log");
      await oldRound;
      expect(lines(old.vault)).toEqual([]);
      expect(lines(reloaded.vault)).toHaveLength(2);
      // Nor does the old round go on to ask about the next session.
      expect(asked).toBe(1);
      expect(storage.load(UNFINISHED_SESSIONS_KEY)).toBeNull();
      // And a disposed manager starts no round at all.
      const ask = vi.fn(() => Promise.resolve<RecoveryAnswer>("log"));
      storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
      const gone = setup(storage).lm;
      gone.dispose();
      await gone.offerUnfinishedSessions(ask);
      expect(ask).not.toHaveBeenCalled();
    });

    it("leaves the stored list to the reloaded plugin when the old question is answered after unload", async () => {
      // A Discard there took the session off the list the reloaded plugin
      // was still asking about, and its Later then lost it.
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
      const old = setup(storage);
      let answerOld: (answer: RecoveryAnswer) => void = () => undefined;
      const oldRound = old.lm.offerUnfinishedSessions(
        () =>
          new Promise((resolve) => {
            answerOld = resolve;
          })
      );
      old.lm.dispose();
      const reloaded = setup(storage);
      answerOld("discard");
      await oldRound;
      await reloaded.lm.offerUnfinishedSessions(() => Promise.resolve("later"));
      expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toEqual([saved()]);
    });

    it("stops asking once unloaded while a Log it is being written", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [
        saved(),
        saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) }),
      ]);
      const { lm, vault } = setup(storage);
      const write = holdNextWrite(vault);
      const ask = vi.fn(() => Promise.resolve<RecoveryAnswer>("log"));
      const round = lm.offerUnfinishedSessions(ask);
      await write.started();
      lm.dispose();
      write.release();
      await round;
      expect(ask).toHaveBeenCalledTimes(1);
      expect(lines(vault)).toHaveLength(1);
    });

    it("ends nothing and logs nothing once disposed: the session stays saved for the next start", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) })]);
      const { lm, vault } = setup(storage);
      lm.startSession("focus", "Write docs", 25);
      vi.setSystemTime(t(9, 25));
      lm.dispose();
      expect(await lm.endSession("finished")).toBe(false);
      await lm.logUnfinished(lm.unfinishedSessions()[0]);
      expect(lines(vault)).toEqual([]);
      expect(open(storage)?.startMs).toBe(t(9, 0));
      expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toHaveLength(1);
    });

    it("does nothing with Stop's long-session answer given after unload: the reloaded plugin offers the session", async () => {
      const storage = memoryStorage();
      const { plugin, lm: first, vault: oldVault } = setup(storage);
      const saveSettings = vi.spyOn(plugin, "saveSettings");
      let answer: (answer: LongSessionAnswer) => void = () => undefined;
      Object.assign(plugin, {
        askAboutLongSession: () =>
          new Promise<LongSessionAnswer>((resolve) => {
            answer = resolve;
          }),
      });
      const timer = new TimerEngine(plugin);
      timer.start();
      vi.setSystemTime(t(16, 0));
      first.heartbeat();
      const stopping = timer.finish();
      // The plugin reloads with the question open: main.ts's order.
      first.dispose();
      timer.dispose();
      const reloaded = setup(storage);

      answer("keep");
      await stopping;
      expect(lines(oldVault)).toEqual([]);
      // No end at all: no next session, no 🍅, no settings written.
      expect(timer.getState().mode).toBe("focus");
      expect(saveSettings).not.toHaveBeenCalled();

      await reloaded.lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      expect(lines(reloaded.vault)).toHaveLength(1);
    });

    it("lets an end whose write was under way at unload clear its own save", async () => {
      // Left saved, the next start offered a session already in the log.
      const storage = memoryStorage();
      const { lm, vault } = setup(storage);
      const write = holdNextWrite(vault);
      lm.startSession("focus", "Write docs", 25);
      vi.setSystemTime(t(9, 25));
      const ending = lm.endSession("finished");
      await write.started();
      lm.dispose();
      expect(open(storage)).not.toBeNull();

      write.release();
      await ending;
      expect(lines(vault)).toHaveLength(1);
      expect(storage.load(OPEN_SESSION_KEY)).toBeNull();
    });

    it("never clears the session a reloaded plugin saved meanwhile", async () => {
      const storage = memoryStorage();
      const { lm, vault } = setup(storage);
      const write = holdNextWrite(vault);
      lm.startSession("focus", "Write docs", 25);
      vi.setSystemTime(t(9, 25));
      const ending = lm.endSession("finished");
      await write.started();
      lm.dispose();
      vi.setSystemTime(t(9, 26));
      setup(storage).lm.startSession("focus", "Next", 25);

      write.release();
      await ending;
      expect(open(storage)?.taskName).toBe("Next");
    });

    it("lets a Log it whose write was under way at unload take its session off the stored list, and only it", async () => {
      const storage = memoryStorage();
      storage.save(UNFINISHED_SESSIONS_KEY, [saved()]);
      const { lm, vault } = setup(storage);
      const write = holdNextWrite(vault);
      const round = lm.offerUnfinishedSessions(() => Promise.resolve("log"));
      await write.started();
      lm.dispose();
      // A reloaded plugin keeps a session of its own in the list meanwhile.
      const other = saved({ startMs: t(8, 0), lastSeenMs: t(8, 30) });
      storage.save(UNFINISHED_SESSIONS_KEY, [saved(), other]);

      write.release();
      await round;
      expect(lines(vault)).toHaveLength(1);
      expect(readSavedSessions(storage.load(UNFINISHED_SESSIONS_KEY))).toEqual([other]);
    });
  });
});

describe("taskLinkAfterMove (F27)", () => {
  const line = (task: string) =>
    `- 🍅 Focus [Task:: ${task}] [Start:: 2026-10-02 09:00:00] [End:: 2026-10-02 09:25:00] ` +
    "[Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";

  it("changes the path of the link and nothing else", () => {
    expect(taskLinkAfterMove(line("[[A/Docs.md|Write | docs]]"), "A/Docs.md", "B/Docs.md")).toBe(
      line("[[B/Docs.md|Write | docs]]")
    );
    expect(taskLinkAfterMove(line("[[A/Docs.md]]"), "A/Docs.md", "B/Docs.md")).toBe(
      line("[[B/Docs.md]]")
    );
    expect(taskLinkAfterMove(line("[[A/Docs.md|Write]]"), "A", "Archive/A")).toBe(
      line("[[Archive/A/Docs.md|Write]]")
    );
  });

  it("returns any other line as it is", () => {
    const other = line("[[A/Docs.md|Write]]");
    expect(taskLinkAfterMove(other, "A/Doc", "B/Doc")).toBe(other);
    expect(taskLinkAfterMove(line("Write docs"), "Write docs", "B")).toBe(line("Write docs"));
    expect(taskLinkAfterMove("not a log line [[A/Docs.md]]", "A/Docs.md", "B")).toBe(
      "not a log line [[A/Docs.md]]"
    );
  });
});

describe("the startup question", () => {
  it("answers log or discard from its buttons, and later from any other way out", async () => {
    const answer = (click: string | null) => {
      const asked = askRecovery({} as never, {
        message: "Unfinished focus from 09:00 (24m).",
        plannedEnd: false,
      });
      const modal = Modal.opened as unknown as {
        titleEl: { text: string };
        contentEl: {
          paragraphs: string[];
          settings: { components: { buttonText?: string; cta?: boolean; click?: () => void }[] }[];
        };
        close: () => void;
      };
      expect(modal.titleEl.text).toBe(RECOVERY_TITLE);
      expect(modal.contentEl.paragraphs).toEqual(["Unfinished focus from 09:00 (24m)."]);
      const buttons = modal.contentEl.settings[0].components;
      expect(buttons.map((b) => b.buttonText)).toEqual([
        RECOVERY_DISCARD_LABEL,
        RECOVERY_LOG_LABEL,
      ]);
      expect(buttons[1].cta).toBe(true);
      if (click === null) modal.close();
      else buttons.find((b) => b.buttonText === click)?.click?.();
      return asked;
    };
    expect(await answer(RECOVERY_LOG_LABEL)).toBe("log");
    expect(await answer(RECOVERY_DISCARD_LABEL)).toBe("discard");
    expect(await answer(null)).toBe("later");
  });

  it("offers Log up to planned end as a third answer for a long session, and no call to action then (F18)", async () => {
    const answer = (click: string | null) => {
      const asked = askRecovery({} as never, { message: "Unfinished focus.", plannedEnd: true });
      const modal = Modal.opened as unknown as {
        contentEl: {
          settings: { components: { buttonText?: string; cta?: boolean; click?: () => void }[] }[];
        };
        close: () => void;
      };
      const buttons = modal.contentEl.settings[0].components;
      expect(buttons.map((b) => b.buttonText)).toEqual([
        RECOVERY_DISCARD_LABEL,
        RECOVERY_PLANNED_LABEL,
        RECOVERY_LOG_LABEL,
      ]);
      // Both ways to log a long session are a choice, as in Stop's question.
      expect(buttons.some((b) => b.cta === true)).toBe(false);
      if (click === null) modal.close();
      else buttons.find((b) => b.buttonText === click)?.click?.();
      return asked;
    };
    expect(RECOVERY_PLANNED_LABEL).toBe("Log up to planned end");
    expect(await answer(RECOVERY_PLANNED_LABEL)).toBe("planned");
    expect(await answer(RECOVERY_LOG_LABEL)).toBe("log");
    expect(await answer(RECOVERY_DISCARD_LABEL)).toBe("discard");
    expect(await answer(null)).toBe("later");
  });

  it("is held in the plugin's open dialogs only while it is open, so unload can close it (F19)", async () => {
    const open = new Set<Modal>();
    const asked = askRecovery(
      {} as never,
      { message: "Unfinished focus from 09:00 (24m).", plannedEnd: false },
      open
    );
    const modal = Modal.opened;
    expect([...open]).toEqual([modal]);
    modal?.close();
    expect(open.size).toBe(0);
    expect(await asked).toBe("later");
  });
});

describe("main.ts wires it", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");
  const onload = main.slice(
    main.indexOf("override async onload()"),
    main.indexOf("private async runMarkerMaintenance")
  );

  it("keeps the manager's state on this device, from before the timer exists", () => {
    const manager = onload.indexOf(
      "this.logManager = new LogManager(this, { storage: deviceStorage(this.app), plannedMs: () => this.timer.getState().totalMs, });"
    );
    expect(manager).toBeGreaterThan(-1);
    expect(manager).toBeLessThan(onload.indexOf("this.timer = new TimerEngine(this);"));
  });

  it("saves a running session once a minute", () => {
    // A recovered session ends where it was last saved, so this is the most a
    // quit or a crash on a computer can lose: a minute, as the spec promises
    // (a phone that suspends the app saves nothing while away, and ends at
    // about when it was left). Each save writes this device's storage, so not
    // much more often either.
    expect(OPEN_SESSION_SAVE_MS).toBeLessThanOrEqual(60_000);
    expect(OPEN_SESSION_SAVE_MS).toBeGreaterThanOrEqual(10_000);
    expect(onload).toContain(
      "this.registerInterval( window.setInterval(() => { this.logManager.heartbeat(); }, OPEN_SESSION_SAVE_MS) );"
    );
  });

  it("offers the third answer exactly when the manager hands it a long session (F18)", () => {
    const offer = main.slice(
      main.indexOf("private offerUnfinishedSessions(): Promise<void> {"),
      main.indexOf("askAboutLongSession(question: LongSessionQuestion)")
    );
    expect(offer).toContain("this.logManager.offerUnfinishedSessions((saved, long) =>");
    expect(offer).toContain("plannedEnd: long !== null,");
    expect(offer).toContain("plannedEndLabel: clockLabel(moment, long.plannedEndAt),");
  });

  it("asks Stop's question and the startup's third answer by one rule, and ends both at one instant (F18)", () => {
    const code = (file: string) => readFileSync(resolve(root, file), "utf8").replace(/\s+/g, " ");
    const engine = code("TimerEngine.ts");
    const manager = code("logManager.ts");
    const recovery = code("sessionRecovery.ts");
    // Who is asked: isLongSession, on both sides.
    expect(engine).toContain("!isLongSession(this.state.mode, active, end.overtimeSeconds, hours)");
    expect(recovery).toContain("!isLongSession(saved.mode, active, overtime, hoursSetting)");
    // Where "planned" ends it: activeReachedAt, then plannedSessionEnd.
    expect(manager).toContain(
      "return activeReachedAt(open.startTime, this.pausesAt(moment(at)), activeSeconds);"
    );
    expect(recovery).toContain(
      "plannedEndAt: activeReachedAt(session.startTime, session.pauses, plannedSeconds(saved)),"
    );
    expect(engine).toContain('if (answer === "planned") end = plannedSessionEnd(question);');
    expect(manager).toContain("await this.logUnfinished(saved, plannedSessionEnd(long));");
    // And no second copy of the walk.
    for (const text of [engine, manager, recovery]) {
      expect(text).not.toContain("let left = Math.max(0, Math.floor(activeSeconds));");
    }
  });

  it("writes kept lines and asks about unfinished sessions once the layout is ready", () => {
    const ready = onload.slice(onload.indexOf("this.app.workspace.onLayoutReady(() => {"));
    expect(ready).toContain("void this.logManager.retryUnwrittenLines();");
    expect(ready).toContain("void this.offerUnfinishedSessions();");
  });

  it("leaves the open session saved at unload: the manager is disposed, never ended", () => {
    const unload = main.slice(
      main.indexOf("override onunload()"),
      main.indexOf("async activateView()")
    );
    expect(unload).toContain("if (this.logManager) this.logManager.dispose();");
    expect(unload).not.toContain("endSession");
    expect(unload).not.toContain("discardSession");
  });
});
