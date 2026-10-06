import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TFile } from "obsidian";
import moment from "moment";
import { TimerEngine } from "../TimerEngine";
import { LogManager } from "../logManager";
import { DEFAULT_SETTINGS, NO_TASK_LABEL, TASK_RENAME_DELAY_MS } from "../constants";
import { frontmatterRowCount } from "../logFrontmatter";
import { TASK_LINE_REGEX, normalizeTaskText, parsePomodoroCount } from "../taskLoader";
import { logicalDate, parseLogLine } from "../logLine";
import { liveFocusSecondsToday } from "../focusTotals";
import type { PomoMode, TimerState } from "../types";
import type { LongSessionAnswer, LongSessionQuestion } from "../sessionGaps";
import type { MomentLike } from "../momentTypes";
import { fakeVault, linkCache } from "./fakeVault";
// The mock's Platform, by path so `tsc` sees it is writable (settingTab.test.ts
// explains why this is the module the engine imports under "obsidian").
import { Platform } from "../__mocks__/obsidian";

// TimerEngine uses `window.setInterval` / `window.clearInterval`. In Node those
// live on globalThis, so we just alias window -> globalThis for the test run.
beforeAll(() => {
  if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
  // Some TimerEngine paths read moment(). Stub it minimally if not already present:
  // a fixed "today" for deterministic tests, through the clone/hour/locale/
  // subtract chain logLine.ts's logicalDate takes it by.
  const g = globalThis as unknown as { moment?: unknown };
  if (typeof g.moment === "undefined") {
    g.moment = () => {
      const fixed = {
        format: (_fmt: string) => "2025-05-18",
        clone: () => fixed,
        hour: () => 12,
        locale: () => fixed,
        subtract: () => fixed,
      };
      return fixed;
    };
  }
});

interface LogCall {
  name: string;
  args: unknown[];
}

interface PluginStubOptions {
  focusMinutes?: number;
  breakMinutes?: number;
  longBreakMinutes?: number;
  longBreakEvery?: number;
  sessionsSinceLongBreak?: number;
  sessionCounterDate?: string | null;
  /** Stands in for `app.vault` — a two-method stub, or a whole fakeVault. */
  vault?: object;
  /** How Stop's long-session question is answered (it records the question). */
  longSessionAnswer?: "keep" | "planned" | "cancel";
}

function makePluginStub(opts: PluginStubOptions = {}) {
  const calls: LogCall[] = [];
  const record = (name: string) => {
    return (...args: unknown[]) => {
      calls.push({ name, args });
    };
  };
  // The log's verdict on a session: true is "it counted" (a minute or more of
  // active time). A stub session always counts, so these tests keep exercising
  // the 🍅 and the long-break count; the under-a-minute rule has its own tests
  // with the real LogManager.
  const endSession = async (...args: unknown[]): Promise<boolean> => {
    calls.push({ name: "endSession", args });
    return true;
  };

  const settings = {
    ...DEFAULT_SETTINGS,
    focusMinutes: opts.focusMinutes ?? 25,
    breakMinutes: opts.breakMinutes ?? 5,
    longBreakMinutes: opts.longBreakMinutes ?? 15,
    longBreakEvery: opts.longBreakEvery ?? 4,
    sessionsSinceLongBreak: opts.sessionsSinceLongBreak ?? 0,
    sessionCounterDate: opts.sessionCounterDate ?? null,
    soundEnabled: false, // skip playSound branches in tests
  };

  return {
    calls,
    settings,
    plugin: {
      settings,
      logManager: {
        startSession: record("startSession"),
        pauseSession: record("pauseSession"),
        resumeSession: record("resumeSession"),
        endSession,
        discardSession: record("discardSession"),
        updateTask: record("updateTask"),
        scheduleTaskRename: record("scheduleTaskRename"),
        taskNoteMoved: record("taskNoteMoved"),
        plannedLengthChanged: record("plannedLengthChanged"),
        // No session for the long-session question to read: it never asks.
        openSessionActiveSeconds: () => null,
        openSessionReachedAt: () => null,
        // No start day either, so the long-break count dates a session by
        // now; the lifecycle tests' real LogManager dates it by its start.
        openSessionDay: () => null,
      },
      app: {
        vault: opts.vault ?? {
          getAbstractFileByPath: () => null,
        },
      },
      manifest: { dir: null },
      saveSettings: async () => {},
      notifySessionEnd: record("notifySessionEnd"),
      notifySleepPause: record("notifySleepPause"),
      askAboutLongSession: (...args: unknown[]) => {
        calls.push({ name: "askAboutLongSession", args });
        return Promise.resolve(opts.longSessionAnswer ?? "keep");
      },
    },
  };
}

const ONE_MINUTE_MS = 60_000;

describe("TimerEngine — initial state", () => {
  it("starts in focus mode with full duration and no task", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const state = timer.getState();
    expect(state.mode).toBe("focus");
    expect(state.isRunning).toBe(false);
    expect(state.remainingMs).toBe(25 * ONE_MINUTE_MS);
    expect(state.totalMs).toBe(25 * ONE_MINUTE_MS);
    expect(state.taskName).toBe("No Task");
    expect(state.breakType).toBe(null);
  });
});

describe("TimerEngine — long break after N pomodoros", () => {
  const TODAY = "2025-05-18"; // matches the moment stub in beforeAll

  it("3rd consecutive focus → short break, counter 2 -> 3", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 2,
      sessionCounterDate: TODAY,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.breakType).toBe("short");
    expect(state.totalMs).toBe(5 * ONE_MINUTE_MS);
    expect(stub.settings.sessionsSinceLongBreak).toBe(3);
  });

  it("4th consecutive focus → LONG break, counter 3 -> 4, longer duration", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 3,
      sessionCounterDate: TODAY,
      longBreakMinutes: 15,
      longBreakEvery: 4,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.breakType).toBe("long");
    expect(state.totalMs).toBe(15 * ONE_MINUTE_MS);
    expect(stub.settings.sessionsSinceLongBreak).toBe(4);
  });

  it("5th focus continues the cycle → short break (counter 4 -> 5)", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 4,
      sessionCounterDate: TODAY,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    expect(timer.getState().breakType).toBe("short");
    expect(stub.settings.sessionsSinceLongBreak).toBe(5);
  });

  it("midnight rollover resets the counter (yesterday's date → 0 then increment to 1)", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 3,
      sessionCounterDate: "2025-05-17", // yesterday relative to stubbed today
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    // First session of new day: counter goes 0 -> 1, not 3 -> 4
    expect(stub.settings.sessionsSinceLongBreak).toBe(1);
    expect(timer.getState().breakType).toBe("short");
    expect(stub.settings.sessionCounterDate).toBe(TODAY);
  });

  it.each([
    [0, 1, "short", "2026-10-03"],
    [4, 4, "long", "2026-10-02"],
  ])(
    "with the day starting at %s, a session ending at 01:30 counts as session %s (%s break)",
    async (dayStartHour, counter, breakType, counterDate) => {
      // The counter turns over with the log's day: with "Day starts at" 4:00
      // a session at 01:30 belongs to the day before, like its log line.
      const g = globalThis as unknown as { moment?: unknown };
      const previousMoment = g.moment;
      g.moment = moment;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 3, 1, 30));
      try {
        const stub = makePluginStub({
          sessionsSinceLongBreak: 3,
          sessionCounterDate: "2026-10-02",
        });
        stub.settings.dayStartHour = dayStartHour;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timer = new TimerEngine(stub.plugin as any);

        await timer.finish();

        expect(stub.settings.sessionsSinceLongBreak).toBe(counter);
        expect(timer.getState().breakType).toBe(breakType);
        expect(stub.settings.sessionCounterDate).toBe(counterDate);
      } finally {
        vi.useRealTimers();
        g.moment = previousMoment;
      }
    }
  );

  it("null sessionCounterDate is treated as 'new day' (fresh install)", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 0,
      sessionCounterDate: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    expect(stub.settings.sessionsSinceLongBreak).toBe(1);
    expect(stub.settings.sessionCounterDate).toBe(TODAY);
  });

  it("skipping a focus does NOT advance the counter (cancelled status)", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 2,
      sessionCounterDate: TODAY,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.skip();

    // Counter unchanged: skip() goes through endSession+switchMode, NOT handleFinished
    expect(stub.settings.sessionsSinceLongBreak).toBe(2);
    // Resulting break is always short on skip
    expect(timer.getState().breakType).toBe("short");
  });
});

// reset(), start() and updateDuration() used to treat every break as a short
// one. A long break then reset to the short one's length while still labelled
// "Long break", one that came up paused (Stop always switches paused; Skip
// never leads to a long break) logged the short one's minutes as Scheduled::
// once started, and the panel's "Break (m)" row resized it.
describe("TimerEngine — a long break keeps its own length", () => {
  const TODAY = "2025-05-18"; // matches the moment stub in beforeAll

  // Stop a focus session so its break comes up paused — long on the 4th of the day.
  async function pausedBreak(long: boolean) {
    const stub = makePluginStub({
      breakMinutes: 5,
      longBreakMinutes: 15,
      longBreakEvery: 4,
      sessionsSinceLongBreak: long ? 3 : 1,
      sessionCounterDate: TODAY,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await timer.finish();
    expect(timer.getState().breakType).toBe(long ? "long" : "short");
    expect(timer.getState().isRunning).toBe(false);
    return { stub, timer };
  }

  it("reset during a long break goes back to longBreakMinutes", async () => {
    const { timer } = await pausedBreak(true);
    timer.addMinutes(-3); // so a reset that did nothing would also fail
    timer.reset();

    const s = timer.getState();
    expect(s.breakType).toBe("long");
    expect(s.totalMs).toBe(15 * ONE_MINUTE_MS);
    expect(s.remainingMs).toBe(15 * ONE_MINUTE_MS);
  });

  it("starting a paused long break logs longBreakMinutes as scheduled", async () => {
    const { stub, timer } = await pausedBreak(true);
    // Take the clock off the setting, so logging "whatever is on the clock"
    // cannot pass for logging the long break's length.
    timer.addMinutes(-5);
    stub.calls.length = 0;
    timer.start();
    timer.pause(); // stop the interval

    const started = stub.calls.filter((c) => c.name === "startSession");
    expect(started).toHaveLength(1);
    const [mode, , minutes, , , breakType] = started[0].args;
    expect(mode).toBe("break");
    expect(minutes).toBe(15);
    expect(breakType).toBe("long");
  });

  it("the panel's Break (m) leaves a long break alone; its own setting moves it", async () => {
    const { stub, timer } = await pausedBreak(true);
    stub.settings.breakMinutes = 8;
    timer.updateDuration("breakMinutes");
    expect(timer.getState().totalMs).toBe(15 * ONE_MINUTE_MS);
    expect(timer.getState().remainingMs).toBe(15 * ONE_MINUTE_MS);

    stub.settings.longBreakMinutes = 20;
    timer.updateDuration("longBreakMinutes");
    expect(timer.getState().totalMs).toBe(20 * ONE_MINUTE_MS);
    expect(timer.getState().remainingMs).toBe(20 * ONE_MINUTE_MS);
  });

  it("a short break still resets to, follows and logs breakMinutes", async () => {
    const { stub, timer } = await pausedBreak(false);
    timer.addMinutes(-3);
    timer.reset();
    expect(timer.getState().totalMs).toBe(5 * ONE_MINUTE_MS);
    expect(timer.getState().remainingMs).toBe(5 * ONE_MINUTE_MS);

    stub.settings.longBreakMinutes = 20;
    timer.updateDuration("longBreakMinutes");
    expect(timer.getState().totalMs).toBe(5 * ONE_MINUTE_MS);
    stub.settings.breakMinutes = 8;
    timer.updateDuration("breakMinutes");
    expect(timer.getState().totalMs).toBe(8 * ONE_MINUTE_MS);
    expect(timer.getState().remainingMs).toBe(8 * ONE_MINUTE_MS);

    timer.addMinutes(-2); // the clock off the setting, as above
    stub.calls.length = 0;
    timer.start();
    timer.pause();
    const started = stub.calls.filter((c) => c.name === "startSession");
    expect(started).toHaveLength(1);
    expect(started[0].args[2]).toBe(8);
    expect(started[0].args[5]).toBe("short");
  });
});

describe("TimerEngine — natural completion (auto-start)", () => {
  const TODAY = "2025-05-18"; // matches the moment stub in beforeAll

  // completeNaturally() is private but mirrors the finish() path; reach it via cast.
  const complete = (timer: TimerEngine) =>
    (timer as unknown as { completeNaturally: () => Promise<void> }).completeNaturally();

  it("focus with autoStartBreak → switches to a running break", async () => {
    const stub = makePluginStub({ sessionsSinceLongBreak: 1, sessionCounterDate: TODAY });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await complete(timer);

    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.breakType).toBe("short");
    expect(state.isRunning).toBe(true);
    expect(stub.settings.sessionsSinceLongBreak).toBe(2);
    timer.pause(); // stop the interval started by the auto-started break
  });

  it("Nth focus with autoStartBreak → auto-starts a LONG break", async () => {
    const stub = makePluginStub({
      sessionsSinceLongBreak: 3,
      sessionCounterDate: TODAY,
      longBreakEvery: 4,
      longBreakMinutes: 15,
    });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await complete(timer);

    const state = timer.getState();
    expect(state.breakType).toBe("long");
    expect(state.totalMs).toBe(15 * ONE_MINUTE_MS);
    expect(state.isRunning).toBe(true);
    timer.pause();
  });

  it("break with autoStartFocus → switches to a running focus", async () => {
    const stub = makePluginStub();
    stub.settings.autoStartFocus = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    // Move into a (stopped) break first, then complete it.
    timer.switchMode("break", false);

    await complete(timer);

    const state = timer.getState();
    expect(state.mode).toBe("focus");
    expect(state.isRunning).toBe(true);
    timer.pause();
  });
});

describe("TimerEngine — Stop vs Skip with auto-start on", () => {
  const TODAY = "2025-05-18"; // matches the moment stub in beforeAll

  it("Stop (finish) never auto-starts the next session, even with autoStartBreak on", async () => {
    const stub = makePluginStub({ sessionsSinceLongBreak: 1, sessionCounterDate: TODAY });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.finish();

    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.isRunning).toBe(false); // Stop always pauses the next session
  });

  it("Skip starts the next session when autoStartBreak is on", async () => {
    const stub = makePluginStub();
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.skip();

    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.isRunning).toBe(true); // Skip respects the toggle
    timer.pause(); // stop the interval started by the auto-started break
  });

  it("Skip leaves the next session paused when auto-start is off", async () => {
    const stub = makePluginStub(); // auto-start defaults off
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    await timer.skip();

    expect(timer.getState().isRunning).toBe(false);
  });
});

describe("TimerEngine → LogManager — what each end tells the log (F19, F20, F31)", () => {
  // Status, Type and whether a session is logged at all feed every review, and
  // until 0.6.9 no test read what the engine hands LogManager: a mutant of each
  // call below passed the whole suite (F58).
  const TODAY = "2025-05-18"; // matches the moment stub in beforeAll
  const ends = (calls: LogCall[]) =>
    calls.filter((c) => c.name === "endSession").map((c) => c.args[0]);
  const starts = (calls: LogCall[]) =>
    calls.filter((c) => c.name === "startSession").map((c) => c.args);

  it("Skip forfeits a focus (cancelled) and finishes a break; Stop finishes", async () => {
    // A cancelled focus is left out of the daily goal. Rest lines carry no
    // Status, so the break's "finished" is visible only here.
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.start();
    await timer.skip();
    timer.start();
    await timer.skip();
    timer.start();
    await timer.finish();
    expect(ends(stub.calls)).toEqual(["cancelled", "finished", "finished"]);
  });

  it("an auto-started break opens its own session, once the focus is logged, as a short break", async () => {
    const stub = makePluginStub();
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.start();
    await timer.skip();
    timer.pause(); // stop the interval the auto-started break began

    // The focus is ended before the break opens, or the break's session would
    // be the one the end closed; switchMode drops any stray in between (F21),
    // as a fresh Start does before it opens its own (F15).
    expect(stub.calls.map((c) => c.name)).toEqual([
      "discardSession",
      "startSession",
      "endSession",
      "discardSession",
      "startSession",
      "pauseSession",
    ]);
    expect(starts(stub.calls)[1]).toEqual([
      "break",
      NO_TASK_LABEL,
      5,
      undefined,
      undefined,
      "short",
    ]);
  });

  it("an auto-started long break is logged as long, with the long length", async () => {
    // The crossing's path: handleFinished → switchMode("break", true, true).
    // Only start()'s call had been checked, and the state, never the log's.
    const stub = makePluginStub({
      sessionsSinceLongBreak: 3,
      sessionCounterDate: TODAY,
      longBreakEvery: 4,
      longBreakMinutes: 15,
    });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    await (timer as unknown as { completeNaturally: () => Promise<void> }).completeNaturally();
    timer.pause();
    expect(starts(stub.calls)).toEqual([
      ["break", NO_TASK_LABEL, 15, undefined, undefined, "long"],
    ]);
  });

  it("Stop waits for the log line before it switches mode", async () => {
    // Whether the session counted (a 🍅, a step of the long-break count) is
    // the log's answer, so nothing after it may run before the write lands.
    const stub = makePluginStub();
    const order: string[] = [];
    stub.plugin.logManager.endSession = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push("logged");
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.start();
    timer.pause();
    timer.onChange((state) => order.push(`state:${state.mode}`));
    order.length = 0;
    await timer.finish();
    expect(order).toContain("logged");
    expect(order.indexOf("logged")).toBeLessThan(order.indexOf("state:break"));
  });
});

describe("TimerEngine — dispose", () => {
  beforeEach(() => {
    // getTimerCount() only sees fake timers, and the orphan test below needs
    // the clock to reach a zero crossing.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // dispose() is TERMINAL. Until 0.6.6 this test asserted the opposite — that
  // start() still worked after dispose() — which nothing in the plugin used
  // (onload() constructs a new engine every time), and which was exactly the
  // property that let an in-flight auto-start restart the loop after unload.
  it("is terminal: nothing the engine is asked afterwards arms a timer", () => {
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    expect(vi.getTimerCount()).toBe(2); // the tick and the end-time wake-up
    expect(() => timer.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    // Each of these arms a timer on a live engine. Checked one at a time,
    // because a later call's clearLoop() would hide an earlier call's timer.
    timer.pause();
    timer.start(); // startLoop
    expect(vi.getTimerCount(), "start").toBe(0);
    timer.reset(); // armEndWake — the state still says running
    expect(vi.getTimerCount(), "reset").toBe(0);
    timer.addMinutes(5); // armEndWake
    expect(vi.getTimerCount(), "addMinutes").toBe(0);
    timer.switchMode("break", true); // startLoop, the auto-start path
    expect(vi.getTimerCount(), "switchMode").toBe(0);
  });

  // The hole that made dispose terminal. A zero crossing with auto-start on
  // awaits handleFinished()'s vault writes before switchMode() restarts the
  // loop; unload the plugin inside that window and the continuation used to
  // start an interval nothing would ever clear, which went on logging sessions
  // from a disabled plugin until Obsidian restarted.
  it("an auto-start still in its vault writes at unload does not restart the loop", async () => {
    const stub = makePluginStub({
      focusMinutes: 1,
      breakMinutes: 1,
      sessionCounterDate: "2025-05-18",
    });
    // Both on, so an orphaned loop would chain sessions and show up as extra log writes.
    stub.settings.autoStartBreak = true;
    stub.settings.autoStartFocus = true;
    // Hold the finished session's log write open until the plugin has unloaded.
    let endSessions = 0;
    let finishWrite = () => {};
    stub.plugin.logManager.endSession = () => {
      endSessions++;
      if (endSessions > 1) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        finishWrite = () => resolve(true);
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(60_010);
    expect(endSessions).toBe(1); // crossed zero; now inside the log write
    expect(timer.getState().mode).toBe("focus"); // not switched yet

    timer.dispose(); // the plugin unloads here
    finishWrite();
    // Run the continuation, then give any loop it started five minutes to show itself.
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(endSessions).toBe(1);
    expect(stub.calls.filter((c) => c.name === "notifySessionEnd").map((c) => c.args)).toEqual([
      ["focus", true],
    ]);
    // The session that DID finish is still recorded; only the next one never starts.
    expect(stub.settings.sessionsSinceLongBreak).toBe(1);
  });

  it("is a no-op (no throw) on a fresh, idle engine", () => {
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    expect(() => timer.dispose()).not.toThrow();
  });
});

describe("TimerEngine — setTask", () => {
  it("updates state.taskName and notifies LogManager", () => {
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.setTask("Write docs", "Projects/Docs.md", "abc123");

    expect(timer.getState().taskName).toBe("Write docs");
    expect(timer.currentTaskName).toBe("Write docs");
    expect(timer.currentTaskPath).toBe("Projects/Docs.md");
    expect(timer.currentTaskId).toBe("abc123");
    expect(stub.calls.some((c) => c.name === "updateTask")).toBe(true);
  });
});

describe("TimerEngine — completion unlink", () => {
  const makeVault = (content: string) => {
    const file = new TFile();
    file.path = "Projects/Docs.md";
    return {
      getAbstractFileByPath: () => file,
      read: async () => content,
    };
  };

  it("unlinks a completed 🆔-matched task on finish — CRLF file, asterisk bullet", async () => {
    const stub = makePluginStub({
      vault: makeVault("* [x] Write docs 🆔 abc123 ✅ 2026-08-13\r\n"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.setTask("Write docs", "Projects/Docs.md", "abc123");

    await timer.finish();

    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("keeps the task linked while an open 🆔-matched line exists", async () => {
    const stub = makePluginStub({
      vault: makeVault("- [ ] Write docs 🆔 abc123 ⏳ 2026-08-14\n"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.setTask("Write docs", "Projects/Docs.md", "abc123");

    await timer.finish();

    expect(timer.getState().taskName).toBe("Write docs");
  });
});

describe("TimerEngine — the 🍅 counter on a task with no 🆔", () => {
  // A task with no 🆔 is found by its text, and the counter's own write changes
  // that text: "Write docs" becomes "Write docs 🍅 1". Up to 0.6.8 the timer
  // looked for the text as it was LINKED, so it found the line once and never
  // again — the count stopped one past where it started, the completion unlink
  // stopped seeing the line, and nothing said so.
  const PATH = "Projects/Docs.md";
  const OTHER = "Projects/Other.md";

  function counting(content: string, others: Record<string, string> = {}) {
    const vault = fakeVault({ [PATH]: content, ...others });
    const stub = makePluginStub({ vault });
    stub.settings.incrementPomodoroCountOnFinish = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    return { vault, stub, timer };
  }

  /** Link a line the way the picker does: named by its normalizeTaskText form, matched by its raw text, no ID. */
  function link(timer: TimerEngine, line: string, path = PATH) {
    const match = line.match(TASK_LINE_REGEX);
    if (!match) throw new Error(`not a task line: ${line}`);
    timer.setTask(normalizeTaskText(match[2]), path, undefined, match[2]);
  }

  /** One focus session and the break after it: back to focus, paused. */
  async function focusSession(timer: TimerEngine) {
    expect(timer.getState().mode).toBe("focus");
    await timer.finish();
    await timer.finish();
  }

  it.each([
    ["no marker yet", "- [ ] Write docs ⏳ 2026-10-01", "- [ ] Write docs 🍅 2 ⏳ 2026-10-01"],
    [
      "an existing 🍅 3",
      "- [ ] Write docs 🍅 3 ⏳ 2026-10-01",
      "- [ ] Write docs 🍅 5 ⏳ 2026-10-01",
    ],
    [
      "a ≤0.5.0 marker after the fields",
      "- [ ] Write docs ⏳ 2026-10-01 🍅 3",
      "- [ ] Write docs 🍅 5 ⏳ 2026-10-01",
    ],
    [
      "a 0.1.0 dated marker",
      "- [ ] Write docs 🍅 3 (2025-05-18) ⏳ 2026-10-01",
      "- [ ] Write docs 🍅 5 ⏳ 2026-10-01",
    ],
    [
      "a tag after the fields",
      "- [ ] Write docs ⏳ 2026-10-01 #task/research/docs",
      "- [ ] Write docs 🍅 2 ⏳ 2026-10-01 #task/research/docs",
    ],
    ["no Tasks fields", "* [ ] Write docs", "* [ ] Write docs 🍅 2"],
  ])("counts every session, not only the first — %s", async (_label, line, after) => {
    const { vault, timer } = counting(`${line}\nNext line\n`);
    link(timer, line);

    await focusSession(timer);
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(`${after}\nNext line\n`);
  });

  it("still unlinks a task ticked during the session, after counting it", async () => {
    // handleFinished counts FIRST and checks for completion second, on purpose,
    // so a task finished mid-session still gets its 🍅. The count's own write
    // used to hide the line from that check, so the task stayed linked.
    const { vault, timer } = counting("- [ ] Write docs ⏳ 2026-10-01\n");
    link(timer, "- [ ] Write docs ⏳ 2026-10-01");
    vault.contents[PATH] = "- [x] Write docs ⏳ 2026-10-01 ✅ 2026-10-01\n";

    await timer.finish();

    expect(vault.contents[PATH]).toBe("- [x] Write docs 🍅 1 ⏳ 2026-10-01 ✅ 2026-10-01\n");
    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("unlinks it when it is ticked later, sessions after it was linked", async () => {
    const { vault, timer } = counting("- [ ] Write docs ⏳ 2026-10-01\n");
    link(timer, "- [ ] Write docs ⏳ 2026-10-01");
    await focusSession(timer);
    await focusSession(timer);

    vault.contents[PATH] = "- [x] Write docs 🍅 2 ⏳ 2026-10-01 ✅ 2026-10-02\n";
    const file = vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error("fixture note missing");
    await timer.onFileModify(file);

    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("counts the open line, not a ticked copy with the same text above it", async () => {
    // A recurring task leaves its done copies behind with the same text, and
    // with the Tasks setting "next recurrence appears on the line below" they
    // sit ABOVE the open one. The first match in file order was the done copy,
    // and now that the count follows its line, every session would land there.
    const done = "- [x] Stretch 🍅 1 🔁 every day ⏳ 2026-09-30 ✅ 2026-09-30";
    const open = "- [ ] Stretch 🍅 1 🔁 every day ⏳ 2026-10-01";
    const { vault, timer } = counting(`${done}\n${open}\n`);
    link(timer, open);

    await focusSession(timer);
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(`${done}\n- [ ] Stretch 🍅 3 🔁 every day ⏳ 2026-10-01\n`);
  });

  it("with no open line, counts the first done one — the order it always used", async () => {
    const first = "- [x] Write docs ⏳ 2026-09-30 ✅ 2026-09-30";
    const second = "- [x] Write docs ⏳ 2026-10-01 ✅ 2026-10-01";
    const { vault, timer } = counting(`${first}\n${second}\n`);
    link(timer, "- [ ] Write docs ⏳ 2026-10-01");

    await timer.finish();

    expect(vault.contents[PATH]).toBe(
      `- [x] Write docs 🍅 1 ⏳ 2026-09-30 ✅ 2026-09-30\n${second}\n`
    );
  });

  it("finds a task with a 🆔 by the ID, whatever its text now says", async () => {
    const { vault, timer } = counting(
      "- [ ] Other task\n- [ ] Renamed docs 🍅 4 🆔 abc123 ⏳ 2026-10-01\n"
    );
    timer.setTask("Write docs", PATH, "abc123");

    await focusSession(timer);
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(
      "- [ ] Other task\n- [ ] Renamed docs 🍅 6 🆔 abc123 ⏳ 2026-10-01\n"
    );
  });

  it("does not follow a write that failed, so the next session still finds the line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { vault, timer } = counting("- [ ] Write docs ⏳ 2026-10-01\n");
    link(timer, "- [ ] Write docs ⏳ 2026-10-01");
    const write = vault.process;
    vault.process = (_file, fn) => {
      fn(vault.contents[PATH]); // the edit is worked out, then the write fails
      return Promise.reject(new Error("disk full"));
    };
    await focusSession(timer);
    vault.process = write;

    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 1 ⏳ 2026-10-01\n");
    warn.mockRestore();
  });

  it("never counts on a different task that only differs by a 🍅 typed into it", async () => {
    // Write safety: a `🍅 2` the user typed mid-description is their text, not
    // the counter. Matching "with the marker ignored" would call these two
    // lines the same task and rewrite the first one.
    const typed = "- [ ] Buy 🍅 2 kg ⏳ 2026-10-01";
    const mine = "- [ ] Buy kg ⏳ 2026-10-01";
    const { vault, timer } = counting(`${typed}\n${mine}\n`);
    link(timer, mine);

    await focusSession(timer);
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(`${typed}\n- [ ] Buy kg 🍅 2 ⏳ 2026-10-01\n`);
  });

  it.each([
    ["no 🆔", "- [ ] Buy 🍅 2 kg ⏳ 2026-10-01", undefined, "- [ ] Buy 🍅 2 kg 🍅 2 ⏳ 2026-10-01"],
    [
      "a note in brackets after it",
      "- [ ] Buy 🍅 2 (big ones) ⏳ 2026-10-01",
      undefined,
      "- [ ] Buy 🍅 2 (big ones) 🍅 2 ⏳ 2026-10-01",
    ],
    [
      "a 🆔",
      "- [ ] Buy 🍅 2 kg 🆔 abc123 ⏳ 2026-10-01",
      "abc123",
      "- [ ] Buy 🍅 2 kg 🍅 2 🆔 abc123 ⏳ 2026-10-01",
    ],
  ])(
    "counts beside a 🍅 typed into the linked task and never rewrites it — %s",
    async (_label, line, id, after) => {
      // The counter took the first `🍅 N` on the line as its own, so the first
      // session turned "Buy 🍅 2 kg" into "Buy kg 🍅 3": the user's text lost
      // its 🍅 2 and the count started from their number.
      const { vault, timer } = counting(`${line}\n`);
      if (id) timer.setTask("Buy 🍅 2 kg", PATH, id);
      else link(timer, line);

      await focusSession(timer);
      await focusSession(timer);

      expect(vault.contents[PATH]).toBe(`${after}\n`);
    }
  );

  it.each([
    [
      "ticked, with the tag moved in front of the dates",
      "- [ ] Write docs ⏳ 2026-10-01 #task/research/docs",
      "- [x] Write docs 🍅 1 #task/research/docs ⏳ 2026-10-01 ✅ 2026-10-02",
    ],
    [
      "ticked, with its tag moved in front of its ⛔",
      "- [ ] Write docs ⏳ 2026-10-01 ⛔ abc123 #work",
      "- [x] Write docs 🍅 1 #work ⛔ abc123 ⏳ 2026-10-01 ✅ 2026-10-02",
    ],
    [
      "ticked, with its tag moved in front of its 🏁",
      "- [ ] Write docs ⏳ 2026-10-01 🏁 delete #work",
      "- [x] Write docs 🍅 1 #work 🏁 delete ⏳ 2026-10-01 ✅ 2026-10-02",
    ],
    [
      "ticked, with 🗓️ written back as 📅",
      "- [ ] Write docs 🗓️ 2026-10-01",
      "- [x] Write docs 🍅 1 📅 2026-10-01 ✅ 2026-10-02",
    ],
  ])("still unlinks a task the Tasks plugin rewrote — %s", async (_label, line, rewritten) => {
    // Tasks rewrites the whole line when it ticks it: tags among the fields
    // move in front of them, ⛔ and the date emoji come back in its own order
    // and form. Compared as normalizeTaskText left them, the task the timer
    // linked no longer matched its own line, so it was never unlinked.
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    expect(timer.getState().taskName).not.toBe(NO_TASK_LABEL);

    vault.contents[PATH] = `${rewritten}\n`;
    const file = vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error("fixture note missing");
    await timer.onFileModify(file);

    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("keeps counting a recurring task after the Tasks plugin rewrote its line", async () => {
    const line = "- [ ] Stretch 🔁 every day ⏳ 2026-10-01 #health";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    expect(vault.contents[PATH]).toBe("- [ ] Stretch 🍅 1 🔁 every day ⏳ 2026-10-01 #health\n");

    vault.contents[PATH] = "- [ ] Stretch 🍅 1 #health 🔁 every day ⏳ 2026-10-01\n";
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Stretch #health 🍅 2 🔁 every day ⏳ 2026-10-01\n");
  });

  it("counts the session's own task when another is linked while the note is read", async () => {
    // Obsidian's `process` reads the file before it calls back. A picker click
    // in that gap used to send this session's 🍅 to the newly linked task, and
    // that task's text then stopped being followed, so it was never counted.
    const { vault, timer } = counting("- [ ] Task A\n- [ ] Task B\n");
    link(timer, "- [ ] Task A");
    const write = vault.process;
    vault.process = async (file, fn) => {
      await Promise.resolve();
      link(timer, "- [ ] Task B"); // clicked while the note is being read
      return write(file, fn);
    };
    await timer.finish();
    vault.process = write;
    await timer.finish();

    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Task A 🍅 1\n- [ ] Task B 🍅 1\n");
  });

  it("never unlinks a task linked while the old task's note was being read", async () => {
    // The old note holds a done line with the new task's text.
    const { vault, timer } = counting("- [x] Task A\n- [x] Task B\n", {
      [OTHER]: "- [ ] Task B\n",
    });
    link(timer, "- [ ] Task A");
    const read = vault.read;
    vault.read = async (file) => {
      const content = await read(file);
      link(timer, "- [ ] Task B", OTHER);
      return content;
    };
    const file = vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error("fixture note missing");
    await timer.onFileModify(file);
    vault.read = read;

    expect(timer.getState().taskName).toBe("Task B");
    expect(timer.currentTaskPath).toBe(OTHER);
  });

  it.each([
    ["another task is linked", (timer: TimerEngine) => link(timer, "- [ ] Task B")],
    ["the task is unlinked", (timer: TimerEngine) => timer.setTask(NO_TASK_LABEL)],
  ])(
    "counts the session's own task when, while its log line is written, %s",
    async (_label, change) => {
      // The session's link is taken when it ends. Logging it reads and writes
      // the vault first, and a task picked in that time — at the zero crossing,
      // when people choose what is next — got the 🍅 the log gave the old one.
      const { vault, stub, timer } = counting("- [ ] Task A\n- [ ] Task B\n");
      link(timer, "- [ ] Task A");
      stub.plugin.logManager.endSession = async () => {
        await Promise.resolve();
        change(timer);
        return true;
      };

      await timer.finish();

      expect(vault.contents[PATH]).toBe("- [ ] Task A 🍅 1\n- [ ] Task B\n");
    }
  );

  it("keeps following the line when the same task is linked again from an old list", async () => {
    // A picker opened before a count still offers the line as it was; picking
    // the linked task again used to hand the engine that old text, and the
    // counting stopped as it did before 0.6.9.
    const line = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);

    link(timer, line); // the stale row, clicked
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 2 ⏳ 2026-10-01\n");
  });

  it("keeps counting when the same task is picked again while its session is being logged", async () => {
    // The pick hands the engine the line as the list read it, count and all;
    // the session's own count then moves the line on.
    const line = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, stub, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    const endSession = stub.plugin.logManager.endSession;
    stub.plugin.logManager.endSession = async () => {
      await Promise.resolve();
      timer.setTask("Write docs 🍅 1", PATH, undefined, "Write docs 🍅 1 ⏳ 2026-10-01");
      return true;
    };
    await focusSession(timer);
    stub.plugin.logManager.endSession = endSession;

    await focusSession(timer);
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 4 ⏳ 2026-10-01\n");
  });

  it("finds the line again after its count was removed and it was picked again", async () => {
    const line = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    vault.contents[PATH] = `${line}\n`; // Remove all, or by hand
    link(timer, line);
    await focusSession(timer);
    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 1 ⏳ 2026-10-01\n");

    vault.contents[PATH] = "- [x] Write docs 🍅 1 ⏳ 2026-10-01 ✅ 2026-10-02\n";
    const file = vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error("fixture note missing");
    await timer.onFileModify(file);
    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("keeps counting when a row from a list opened sessions ago is picked", async () => {
    const line = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    const row = "Write docs 🍅 1 ⏳ 2026-10-01"; // the list is opened now…
    await focusSession(timer); // …and stays open through another count
    timer.setTask("Write docs 🍅 1", PATH, undefined, row);

    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 3 ⏳ 2026-10-01\n");
  });

  describe("a recurring task whose done copy matches the timer's text exactly", () => {
    // Once the timer's text is a count behind the open line, an old done copy
    // (which kept the count it had when it was ticked) can match it exactly.
    const OPEN = "- [ ] Stretch 🍅 1 🔁 every day ⏳ 2026-10-02";
    const DONE = "- [x] Stretch 🍅 1 🔁 every day ⏳ 2026-10-01 ✅ 2026-10-01";

    it("counts the open task, not the done copy, after a count from another device", async () => {
      const { vault, timer } = counting(`${OPEN}\n${DONE}\n`);
      link(timer, OPEN);
      timer.start();
      vault.contents[PATH] = `- [ ] Stretch 🍅 2 🔁 every day ⏳ 2026-10-02\n${DONE}\n`;

      await timer.finish();

      expect(vault.contents[PATH]).toBe(`- [ ] Stretch 🍅 3 🔁 every day ⏳ 2026-10-02\n${DONE}\n`);
      expect(timer.getState().taskName).not.toBe(NO_TASK_LABEL);
    });

    it.each([
      ["picked again from a list opened before a count", "pick"],
      ["its count removed by hand", "remove"],
    ])("stays linked while it is open — %s", async (_label, how) => {
      const { vault, timer } = counting(`${OPEN}\n${DONE}\n`);
      link(timer, OPEN);
      await focusSession(timer);
      if (how === "pick") link(timer, OPEN);
      else vault.contents[PATH] = `- [ ] Stretch 🔁 every day ⏳ 2026-10-02\n${DONE}\n`;

      const file = vault.getAbstractFileByPath(PATH);
      if (!file) throw new Error("fixture note missing");
      await timer.onFileModify(file);
      await focusSession(timer);

      expect(timer.getState().taskName).not.toBe(NO_TASK_LABEL);
      expect(vault.contents[PATH].split("\n")[1]).toBe(DONE);
      expect(parsePomodoroCount(vault.contents[PATH].split("\n")[0])).toBe(how === "pick" ? 3 : 1);
    });
  });

  it("keeps counting after the counter split glued text and an old row is picked again", async () => {
    // Writing into "fix🔥" adds a space ("fix 🍅 1 🔥") that taking the marker
    // out cannot take back, so the count-free key leaves spaces out.
    const line = "- [ ] Urgent fix🔥 ⏳ 2026-10-01";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    link(timer, line);

    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Urgent fix 🍅 2 🔥 ⏳ 2026-10-01\n");
  });

  it("counts the task picked, not another with the same name picked before it", async () => {
    // The names match (the date is cut out of both); the lines do not.
    const a = "- [ ] Submit report 📅 2026-10-01 to Alice";
    const b = "- [ ] Submit report 📅 2026-10-08 to Alice";
    const { vault, timer } = counting(`${a}\n${b}\n`);
    link(timer, a);
    link(timer, b);

    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(`${a}\n- [ ] Submit report 🍅 1 📅 2026-10-08 to Alice\n`);
  });

  it("keeps counting a recurrence with a comma after Tasks moved the tag in front of it", async () => {
    const line = "- [ ] Gym 🔁 every week on Monday, Friday 📅 2026-10-05 #health";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);

    vault.contents[PATH] = "- [ ] Gym 🍅 1 #health 🔁 every week on Monday, Friday 📅 2026-10-09\n";
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe(
      "- [ ] Gym #health 🍅 2 🔁 every week on Monday, Friday 📅 2026-10-09\n"
    );
  });

  it.each([
    ["⛔", "- [ ] Fix ⛔ login page ⏳ 2026-10-01", "- [ ] Fix ⛔ signup page ⏳ 2026-10-01"],
    ["🏁", "- [ ] Release 🏁 alpha build", "- [ ] Release 🏁 beta build"],
    ["❌", "- [ ] Refund ❌ 2026-09-30 order", "- [ ] Refund ❌ 2026-10-02 order"],
  ])(
    "never mistakes a task for another whose text differs only in what follows a %s",
    async (_label, other, mine) => {
      // Only a field at the END of the line is a field; inside the words it is
      // the task's text, and it tells two tasks apart.
      const { vault, timer } = counting(`${other}\n${mine}\n`);
      link(timer, mine);

      await focusSession(timer);

      expect(vault.contents[PATH].split("\n")[0]).toBe(other);
      expect(parsePomodoroCount(vault.contents[PATH].split("\n")[1])).toBe(1);
    }
  );

  it("forgets the old line when another task is linked", async () => {
    const { vault, timer } = counting("- [ ] Task A\n- [ ] Task B\n");
    link(timer, "- [ ] Task A");
    await focusSession(timer);
    link(timer, "- [ ] Task B");
    await focusSession(timer);

    expect(vault.contents[PATH]).toBe("- [ ] Task A 🍅 1\n- [ ] Task B 🍅 1\n");
  });

  it.each([
    [
      "another task in the same note",
      "- [ ] Task B",
      PATH,
      "- [ ] Task A 🍅 1\n- [ ] Task B 🍅 1\n",
      "- [ ] Task A\n",
    ],
    [
      "the same text in another note",
      "- [ ] Task A",
      OTHER,
      "- [ ] Task A 🍅 1\n- [ ] Task B\n",
      "- [ ] Task A 🍅 1\n",
    ],
  ])(
    "does not hand its line's text to a link made while the count was writing — %s",
    async (_label, next, nextPath, expected, expectedOther) => {
      const { vault, timer } = counting("- [ ] Task A\n- [ ] Task B\n", {
        [OTHER]: "- [ ] Task A\n",
      });
      link(timer, "- [ ] Task A");
      const write = vault.process;
      vault.process = async (file, fn) => {
        const written = await write(file, fn);
        link(timer, next, nextPath); // a picker row clicked while finish() awaits
        return written;
      };
      await timer.finish();
      vault.process = write;
      await timer.finish();

      await focusSession(timer);

      expect(vault.contents[PATH]).toBe(expected);
      expect(vault.contents[OTHER]).toBe(expectedOther);
    }
  );

  it("the picker ticks and pins the line by the text the engine matches", () => {
    // Read as code — nothing can import the view. Keyed on the linked name, the
    // row's tick and the out-of-scope "Linked task" pin lost the line at the
    // first count, exactly as the engine did.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const view = readFileSync(resolve(root, "GentlePomoView.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");

    expect(view).toContain(
      "{ path: linkedPath, lineText: this.timer.currentTaskLineText, taskId: this.timer.currentTaskId, }"
    );
    expect(view).toContain("if (this.isLinkedRow(task)) {");
    expect(view).toContain("if (task.path !== this.timer.currentTaskPath) return false;");
    expect(view).toContain("if (id) return task.taskId === id;");
    expect(view).toContain(
      "return taskLineKey(task.text) === taskLineKey(this.timer.currentTaskLineText);"
    );
    expect(view).not.toMatch(/cleanText(?::| ===) this\.timer\.currentTaskName\b/);
  });

  it("keeps the name it was linked by — the log and the button do not take the count", async () => {
    // The linked name is also the `Task:: [[path|name]]` alias in the daily log,
    // which reviews group by. Following the line must not rename the task.
    const line = "- [ ] Write docs #task/research/docs ⏳ 2026-10-01";
    const { stub, timer } = counting(`${line}\n`);
    link(timer, line);
    await focusSession(timer);
    timer.start();
    timer.pause();

    const name = "Write docs #task/research/docs";
    const started = stub.calls.filter((c) => c.name === "startSession");
    expect(started).toHaveLength(1);
    expect(started[0].args[1]).toBe(name);
    expect(stub.calls.filter((c) => c.name === "updateTask").map((c) => c.args[0])).toEqual([name]);
    expect(timer.currentTaskName).toBe(name);
    expect(timer.getState().taskName).toBe(name);
  });
});

describe("TimerEngine — the 🍅 counter on a task with a 🆔", () => {
  // A task with a 🆔 has its name read again from its line — when its note
  // changes, and when a session's log line is written — so that a rename
  // reaches the daily log: the timer takes the new name, and every past log
  // line with that ID is rewritten to it. The counter's `🍅 N` is on that line
  // too, so up to 0.6.8 every count was a "rename": each session's line took
  // the count, and each count rewrote every line the task ever had, in every
  // daily log, to the new number.
  const PATH = "Projects/Docs.md";
  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const OLD_LOG = "Logs/2026-09-30-gentle-pomodoro-log.md";
  const oldLine = (name: string) =>
    `- 🍅 Focus | Task:: [[${PATH}|${name}]] | ID:: abc123 | Start:: 2026-09-30 09:00:00 | ` +
    "End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | " +
    "Status:: finished | Type:: focus\n";

  /** The `Task:: [[path|name]]` names in a log, in order. */
  const names = (log: string) =>
    [...log.matchAll(/Task:: \[\[[^|\]]+\|([^\]]+)\]\]/g)].map((m) => m[1]);

  let previousMoment: unknown;
  beforeEach(() => {
    // LogManager stamps and names its files with the real moment; the date is
    // pinned so the log's file name is known.
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = moment;
    // setTimeout too: a rename reaches past log lines TASK_RENAME_DELAY_MS
    // after the last edit, and `edit` below lets that time pass.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  /**
   * A timer writing a real daily log, with Obsidian's "modify" event wired the
   * way main.ts wires it: fired on every write, handed to the timer and not
   * awaited. `settle` lets the events fired so far land.
   */
  function logging(line: string, pastName = "Write docs") {
    const vault = fakeVault({
      [PATH]: `${line}\n`,
      [LOG]: "",
      [OLD_LOG]: oldLine(pastName),
    });
    const stub = makePluginStub({ vault });
    stub.settings.incrementPomodoroCountOnFinish = true;
    stub.settings.logFolderPath = "Logs";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = stub.plugin as any;
    plugin.invalidateFocusTotalCache = () => {};
    plugin.app.metadataCache = linkCache(vault);
    plugin.logManager = new LogManager(plugin);
    const timer = new TimerEngine(plugin);

    const events: Promise<void>[] = [];
    const fire = (file: TFile) => {
      events.push(timer.onFileModify(file));
    };
    const { process, modify } = vault;
    vault.process = (file, fn) => {
      const written = process(file, fn);
      fire(file);
      return written;
    };
    vault.modify = (file, data) => {
      const written = modify(file, data);
      fire(file);
      return written;
    };
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true) },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        vault.writes.push(file.path);
        fire(file);
        return Promise.resolve();
      },
    });
    const settle = async () => {
      while (events.length > 0) await events.shift();
    };
    const note = vault.getAbstractFileByPath(PATH) as TFile;
    /** The user (or sync) changes the task's line, and stops typing. */
    const edit = async (next: string) => {
      await vault.process(note, () => `${next}\n`);
      await settle();
      await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
      await plugin.logManager.walksSettled();
      await settle();
    };
    /** One focus session, logged and counted, then the break (not started, so not logged). */
    const session = async () => {
      timer.start();
      // A whole session's time: one under a minute is neither logged nor counted.
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();
      await timer.finish();
      await settle();
    };
    /** An edit with no pause after it: the next save comes before the delay is up. */
    const type = async (next: string) => {
      await vault.process(note, () => `${next}\n`);
      await settle();
    };
    return { vault, timer, settle, edit, type, session, note, plugin };
  }

  it("writes each session's line under the name the task was linked by", async () => {
    const { vault, timer, session } = logging("- [ ] Write docs 🆔 abc123 ⏳ 2026-10-01");
    timer.setTask("Write docs", PATH, "abc123");

    await session();
    await session();
    await session();

    expect(vault.contents[PATH]).toBe("- [ ] Write docs 🍅 3 🆔 abc123 ⏳ 2026-10-01\n");
    expect(names(vault.contents[LOG])).toEqual(["Write docs", "Write docs", "Write docs"]);
    expect(timer.currentTaskName).toBe("Write docs");
    expect(timer.getState().taskName).toBe("Write docs");
  });

  it("never rewrites a past log line for a count", async () => {
    const { vault, timer, session } = logging("- [ ] Write docs 🆔 abc123 ⏳ 2026-10-01");
    timer.setTask("Write docs", PATH, "abc123");

    await session();
    await session();

    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write docs"));
    expect(vault.writes.filter((path) => path === OLD_LOG)).toEqual([]);
  });

  it("keeps a name linked with a count in it, as the picker links it", async () => {
    const { vault, timer, session } = logging(
      "- [ ] Write docs 🍅 4 🆔 abc123 ⏳ 2026-10-01",
      "Write docs 🍅 4"
    );
    timer.setTask("Write docs 🍅 4", PATH, "abc123");

    await session();
    await session();

    expect(names(vault.contents[LOG])).toEqual(["Write docs 🍅 4", "Write docs 🍅 4"]);
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write docs 🍅 4"));
    expect(timer.currentTaskName).toBe("Write docs 🍅 4");
  });

  it("follows a count made elsewhere with the text the picker matches, not the name", async () => {
    // Another device's count arriving by sync, or a hand edit. The picker ticks
    // and pins the linked line by this text, so it has to move with the line.
    const { vault, timer, edit } = logging("- [ ] Write docs 🍅 2 🆔 abc123", "Write docs 🍅 2");
    timer.setTask("Write docs 🍅 2", PATH, "abc123");

    await edit("- [ ] Write docs 🍅 3 🆔 abc123");

    expect(timer.currentTaskName).toBe("Write docs 🍅 2");
    expect(timer.currentTaskLineText).toBe("Write docs 🍅 3 🆔 abc123");
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write docs 🍅 2"));
  });

  it("does not take the count being removed as a rename either", async () => {
    // "Remove all 🍅 markers", or a hand edit.
    const { vault, timer, edit } = logging("- [ ] Write docs 🍅 2 🆔 abc123", "Write docs 🍅 2");
    timer.setTask("Write docs 🍅 2", PATH, "abc123");

    await edit("- [ ] Write docs 🆔 abc123");

    expect(timer.currentTaskName).toBe("Write docs 🍅 2");
    expect(timer.currentTaskLineText).toBe("Write docs 🆔 abc123");
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write docs 🍅 2"));
  });

  it("still takes a real rename into the log, past lines included", async () => {
    const { vault, timer, edit, session } = logging("- [ ] Write docs 🆔 abc123 ⏳ 2026-10-01");
    timer.setTask("Write docs", PATH, "abc123");
    await session();

    // The task is renamed; the count stays on its line, so the new name
    // carries it — the name the picker would link it by now.
    await edit("- [ ] Write the docs 🍅 1 🆔 abc123 ⏳ 2026-10-01");
    await session();

    const renamed = "Write the docs 🍅 1";
    expect(timer.currentTaskName).toBe(renamed);
    expect(names(vault.contents[LOG])).toEqual([renamed, renamed]);
    expect(vault.contents[OLD_LOG]).toBe(oldLine(renamed));
  });

  it("takes a change to a 🍅 typed into the description as a rename", async () => {
    // Only a marker in the counter's place is the count; `Buy 🍅 2 kg` is text.
    const { vault, timer, edit } = logging("- [ ] Buy 🍅 2 kg 🆔 abc123", "Buy 🍅 2 kg");
    timer.setTask("Buy 🍅 2 kg", PATH, "abc123");

    await edit("- [ ] Buy kg 🆔 abc123");

    expect(timer.currentTaskName).toBe("Buy kg");
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Buy kg"));
  });

  it.each([
    [
      "two counter markers, folded into one",
      "- [ ] Write docs 🍅 2 🍅 4 🆔 abc123 ⏳ 2026-10-01",
      "Write docs 🍅 2 🍅 4",
      "- [ ] Write docs 🍅 3 🆔 abc123 ⏳ 2026-10-01",
    ],
    [
      "a count 0.6.8 wrote after a 📆 date, moved in front of it",
      "- [ ] Write docs 📆 2026-10-05 🍅 3 🆔 abc123",
      "Write docs 📆 2026-10-05 🍅 3",
      "- [ ] Write docs 🍅 4 📆 2026-10-05 🆔 abc123",
    ],
  ])("takes no count as a rename — %s", async (_label, line, name, after) => {
    // The counter folds a line's counter markers into one and writes in front
    // of ⌛ 📆 🗓; the rename rule has to put both back the way they were.
    const { vault, timer, session } = logging(line, name);
    timer.setTask(name, PATH, "abc123");

    await session();

    expect(vault.contents[PATH]).toBe(`${after}\n`);
    expect(timer.currentTaskName).toBe(name);
    expect(names(vault.contents[LOG])).toEqual([name]);
    expect(vault.contents[OLD_LOG]).toBe(oldLine(name));
  });

  it("does not hand the line it read to a task linked while it was reading", async () => {
    const { vault, timer, note } = logging("- [ ] Write the docs 🆔 abc123");
    timer.setTask("Write docs", PATH, "abc123");
    const read = vault.read;
    vault.read = async (file) => {
      vault.read = read;
      const text = await read(file);
      timer.setTask("Other task", "Projects/Other.md", "zzz999"); // a picker row clicked meanwhile
      return text;
    };

    await timer.onFileModify(note);

    expect(timer.currentTaskName).toBe("Other task");
    expect(timer.currentTaskId).toBe("zzz999");
    expect(timer.currentTaskLineText).toBe("Other task");
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write docs"));
  });
});

describe("TimerEngine — which task a 🆔 or a note names (0.6.9)", () => {
  // Built on the same harness as the 🆔 counter: a real LogManager writing a
  // real daily log, the "modify" event wired as main.ts wires it.
  const PATH = "Projects/Docs.md";
  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const OLD_LOG = "Logs/2026-09-30-gentle-pomodoro-log.md";
  const oldLine = (name: string, path = PATH, id = "abc123") =>
    `- 🍅 Focus | Task:: [[${path}|${name}]] | ID:: ${id} | Start:: 2026-09-30 09:00:00 | ` +
    "End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | " +
    "Status:: finished | Type:: focus\n";
  /** Each logged line's Task value and ID, in order. */
  const tasks = (log: string) =>
    log
      .split("\n")
      .map((line) => parseLogLine(line))
      .filter((parsed) => parsed !== null)
      .map((parsed) => ({ task: parsed.task?.raw, id: parsed.values.get("ID") }));

  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = moment;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  function harness(files: Record<string, string>) {
    const vault = fakeVault({ [LOG]: "", ...files });
    const stub = makePluginStub({ vault });
    stub.settings.incrementPomodoroCountOnFinish = true;
    stub.settings.logFolderPath = "Logs";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = stub.plugin as any;
    plugin.invalidateFocusTotalCache = () => {};
    plugin.app.metadataCache = linkCache(vault);
    plugin.logManager = new LogManager(plugin);
    const timer = new TimerEngine(plugin);
    const events: Promise<void>[] = [];
    const { process } = vault;
    vault.process = (file, fn) => {
      const written = process(file, fn);
      events.push(timer.onFileModify(file));
      return written;
    };
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true) },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        vault.writes.push(file.path);
        return Promise.resolve();
      },
    });
    const settle = async () => {
      while (events.length > 0) await events.shift();
    };
    /** Rewrite a note, and let the rename delay pass. */
    const edit = async (path: string, content: string) => {
      await vault.process(vault.getAbstractFileByPath(path) as TFile, () => content);
      await settle();
      await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
      await plugin.logManager.walksSettled();
    };
    const session = async () => {
      timer.start();
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();
    };
    return { vault, timer, stub, plugin, settle, edit, session };
  }

  describe("a 🆔 on more than one line (F2)", () => {
    const COPIES =
      "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-08-26\n- [ ] Update codebook to V7.5 🆔 qfd97u\n";

    it("logs and counts the copy that was linked, not the done one above it", async () => {
      const { vault, timer, edit, session } = harness({ [PATH]: COPIES });
      timer.setTask("Update codebook to V7.5", PATH, "qfd97u", "Update codebook to V7.5 🆔 qfd97u");

      await edit(PATH, `${COPIES}- [ ] Something new\n`);
      expect(timer.currentTaskName).toBe("Update codebook to V7.5");
      // A count made elsewhere is no rename, and the text the timer holds
      // follows the copy it is linked to — not the copy above it.
      const counted = COPIES.replace("V7.5 🆔", "V7.5 🍅 2 🆔");
      await edit(PATH, counted);
      expect(timer.currentTaskName).toBe("Update codebook to V7.5");
      expect(timer.currentTaskLineText).toBe("Update codebook to V7.5 🍅 2 🆔 qfd97u");
      await session();

      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${PATH}|Update codebook to V7.5]]`, id: "qfd97u" },
      ]);
      expect(vault.contents[PATH].split("\n").slice(0, 2)).toEqual([
        "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-08-26",
        "- [ ] Update codebook to V7.5 🍅 3 🆔 qfd97u",
      ]);
    });

    it("keeps the linked name, and rewrites no history, when it cannot tell the copies apart", async () => {
      const { vault, timer, stub, edit } = harness({
        [PATH]: "- [ ] Draft outline 🆔 q\n- [ ] Draft outline 🆔 q\n",
        [OLD_LOG]: oldLine("Draft outline", PATH, "q"),
      });
      timer.setTask("Draft outline", PATH, "q", "Draft outline 🆔 q");

      await edit(PATH, "- [ ] Draft outline 🆔 q\n- [ ] Intro outline 🆔 q\n");
      await edit(PATH, "- [ ] RW outline 🆔 q\n- [ ] Intro outline 🆔 q\n");

      expect(timer.currentTaskName).toBe("Draft outline");
      expect(vault.contents[OLD_LOG]).toBe(oldLine("Draft outline", PATH, "q"));
      expect(stub.calls.filter((c) => c.name === "scheduleTaskRename")).toEqual([]);
    });

    it("follows a rename of the one open copy, counts it, and leaves the ticked copy's history", async () => {
      // Copied forward: the old copy ticked, the new one open, one 🆔. The
      // rename matches neither copy's text, so it was never followed, and
      // the 🍅 went nowhere (2026-10-04: the one open copy is the task).
      const { vault, timer, edit, session } = harness({
        [PATH]: COPIES,
        [OLD_LOG]:
          oldLine("Update codebook to V7.4", PATH, "qfd97u") +
          oldLine("Update codebook to V7.5", PATH, "qfd97u"),
      });
      timer.setTask("Update codebook to V7.5", PATH, "qfd97u", "Update codebook to V7.5 🆔 qfd97u");

      await edit(PATH, COPIES.replace("V7.5 🆔", "V7.5 final 🆔"));
      await session();

      expect(timer.currentTaskName).toBe("Update codebook to V7.5 final");
      expect(vault.contents[OLD_LOG]).toBe(
        oldLine("Update codebook to V7.4", PATH, "qfd97u") +
          oldLine("Update codebook to V7.5 final", PATH, "qfd97u")
      );
      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${PATH}|Update codebook to V7.5 final]]`, id: "qfd97u" },
      ]);
      expect(vault.contents[PATH].split("\n").slice(0, 2)).toEqual([
        "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-08-26",
        "- [ ] Update codebook to V7.5 final 🍅 1 🆔 qfd97u",
      ]);
    });

    it("stays with the new open copy when the copy it was linked to is ticked, and leaves the ticked copy's history (2026-10-04)", async () => {
      // Copied forward: the old copy ticked, the new one open and edited. The
      // timer's key still names the ticked copy; up to then it took it, and
      // unlinked — the new copy's sessions went unlinked and uncounted.
      const { vault, timer, edit, session } = harness({
        [PATH]: "- [ ] Update codebook to V7.4 🆔 qfd97u\n",
        [OLD_LOG]: oldLine("Update codebook to V7.4", PATH, "qfd97u"),
      });
      timer.setTask("Update codebook to V7.4", PATH, "qfd97u", "Update codebook to V7.4 🆔 qfd97u");

      await edit(
        PATH,
        "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-10-02\n- [ ] Update codebook to V7.5 🆔 qfd97u\n"
      );
      expect(timer.getState().taskName).toBe("Update codebook to V7.5");
      expect(timer.currentTaskId).toBe("qfd97u");
      await session();

      // The ticked copy's past session keeps its name; the new one is logged
      // and counted on the open copy.
      expect(vault.contents[OLD_LOG]).toBe(oldLine("Update codebook to V7.4", PATH, "qfd97u"));
      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${PATH}|Update codebook to V7.5]]`, id: "qfd97u" },
      ]);
      expect(vault.contents[PATH].split("\n").slice(0, 2)).toEqual([
        "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-10-02",
        "- [ ] Update codebook to V7.5 🍅 1 🆔 qfd97u",
      ]);
      expect(timer.getState().taskName).toBe("Update codebook to V7.5");
    });

    it("unlinks the copy it was linked to once that is ticked, when no other copy is open", async () => {
      const { timer, edit } = harness({
        [PATH]:
          "- [ ] Update codebook to V7.4 🆔 qfd97u\n- [x] Update codebook to V7.3 🆔 qfd97u\n",
      });
      timer.setTask("Update codebook to V7.4", PATH, "qfd97u", "Update codebook to V7.4 🆔 qfd97u");

      await edit(
        PATH,
        "- [x] Update codebook to V7.4 🆔 qfd97u ✅ 2026-10-02\n- [x] Update codebook to V7.3 🆔 qfd97u\n"
      );

      expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
    });

    it("stays linked when its copy is ticked and an open copy keeps the same text", async () => {
      const { timer, edit } = harness({ [PATH]: "- [ ] Water plants 🆔 w1\n" });
      timer.setTask("Water plants", PATH, "w1", "Water plants 🆔 w1");

      await edit(PATH, "- [x] Water plants 🆔 w1 ✅ 2026-10-02\n- [ ] Water plants 🆔 w1\n");

      expect(timer.getState().taskName).toBe("Water plants");
    });
  });

  it("adopts a 🆔 the line gains after it was linked, for the open session too (C3)", async () => {
    const { vault, timer, edit } = harness({ [PATH]: "- [ ] Write docs ⏳ 2026-10-02\n" });
    timer.setTask("Write docs", PATH, undefined, "Write docs ⏳ 2026-10-02");
    timer.start();

    // Tasks' Edit Task gives the task an ID when it becomes a dependency.
    await edit(PATH, "- [ ] Write docs 🆔 abc123 ⏳ 2026-10-02\n");
    expect(timer.currentTaskId).toBe("abc123");
    expect(timer.currentTaskName).toBe("Write docs");
    vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
    await timer.finish();

    expect(tasks(vault.contents[LOG])).toEqual([{ task: `[[${PATH}|Write docs]]`, id: "abc123" }]);
    // And a rename after it is followed, as for any task with a 🆔.
    await edit(PATH, "- [ ] Write the docs 🍅 1 🆔 abc123 ⏳ 2026-10-02\n");
    expect(tasks(vault.contents[LOG])).toEqual([
      { task: `[[${PATH}|Write the docs 🍅 1]]`, id: "abc123" },
    ]);
  });

  it("takes an adopted 🆔 as the same task: a split session stays one line (C3)", async () => {
    // With split logging, a task with a new 🆔 would otherwise look like a
    // switch, and the session would be logged as two lines for one task.
    const { vault, timer, stub, edit } = harness({ [PATH]: "- [ ] Write docs ⏳ 2026-10-02\n" });
    stub.settings.taskSwitchLogging = "split";
    timer.setTask("Write docs", PATH, undefined, "Write docs ⏳ 2026-10-02");
    timer.start();
    vi.setSystemTime(Date.now() + 5 * ONE_MINUTE_MS);

    await edit(PATH, "- [ ] Write docs 🆔 abc123 ⏳ 2026-10-02\n");
    expect(timer.currentTaskId).toBe("abc123");
    vi.setSystemTime(Date.now() + 20 * ONE_MINUTE_MS);
    await timer.finish();

    expect(tasks(vault.contents[LOG])).toEqual([{ task: `[[${PATH}|Write docs]]`, id: "abc123" }]);
  });

  it("adopts only the linked line's 🆔, never another task's in the same note (C3)", async () => {
    // Taking the first 🆔 in the note would log this task's sessions under
    // the task above it — and rename that task's history.
    const OTHER = "- [ ] Review the outline 🆔 zzz999\n";
    const { vault, timer, edit } = harness({
      [PATH]: `${OTHER}- [ ] Write docs ⏳ 2026-10-02\n`,
    });
    timer.setTask("Write docs", PATH, undefined, "Write docs ⏳ 2026-10-02");
    timer.start();

    await edit(PATH, `${OTHER}- [ ] Write docs ⏳ 2026-10-02\n- [ ] Something new\n`);
    expect(timer.currentTaskId).toBeUndefined();
    await edit(PATH, `${OTHER}- [ ] Write docs 🆔 abc123 ⏳ 2026-10-02\n- [ ] Something new\n`);
    expect(timer.currentTaskId).toBe("abc123");
    expect(timer.currentTaskName).toBe("Write docs");
    vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
    await timer.finish();

    expect(tasks(vault.contents[LOG])).toEqual([{ task: `[[${PATH}|Write docs]]`, id: "abc123" }]);
  });

  it("adopts nothing into a task linked while the note was being read (C3)", async () => {
    const { vault, timer } = harness({
      [PATH]: "- [ ] Write docs 🆔 abc123 ⏳ 2026-10-02\n- [ ] Review the plan\n",
    });
    timer.setTask("Write docs", PATH, undefined, "Write docs ⏳ 2026-10-02");
    const read = vault.read;
    vault.read = async (file) => {
      vault.read = read;
      const text = await read(file);
      timer.setTask("Review the plan", PATH); // a picker row clicked meanwhile
      return text;
    };

    await timer.onFileModify(vault.getAbstractFileByPath(PATH) as TFile);

    expect(timer.currentTaskName).toBe("Review the plan");
    expect(timer.currentTaskId).toBeUndefined();
    expect(timer.currentTaskLineText).toBe("Review the plan");
    expect(timer.currentTaskPath).toBe(PATH);
  });

  it("writes a rename into history once the typing stops, never a half-typed name (F26)", async () => {
    const { vault, timer, plugin, settle } = harness({
      [PATH]: "- [ ] Write chapter 🆔 abc123\n",
      [OLD_LOG]: oldLine("Write chapter"),
    });
    timer.setTask("Write chapter", PATH, "abc123", "Write chapter 🆔 abc123");
    const note = vault.getAbstractFileByPath(PATH) as TFile;
    const save = async (line: string) => {
      await vault.process(note, () => line);
      await settle();
      await vi.advanceTimersByTimeAsync(2000); // Obsidian saves every 2 s while typing
    };

    await save("- [ ] Write chapter 3 dr 🆔 abc123\n");
    expect(timer.currentTaskName).toBe("Write chapter 3 dr"); // the timer at once
    await save("- [ ] Write chapter 3 draft 🆔 abc123\n");
    expect(vault.writes.filter((path) => path === OLD_LOG)).toEqual([]);
    await vi.advanceTimersByTimeAsync(TASK_RENAME_DELAY_MS);
    await plugin.logManager.walksSettled();

    expect(vault.writes.filter((path) => path === OLD_LOG)).toEqual([OLD_LOG]);
    expect(vault.contents[OLD_LOG]).toBe(oldLine("Write chapter 3 draft"));
  });

  it("leaves the sessions from before the task was created out of a rename (F12)", async () => {
    // The 🆔 was reused by a task made later: the older session is another task's.
    const { vault, timer, edit } = harness({
      [PATH]: "- [ ] Write docs 🆔 abc123 ➕ 2026-10-01\n",
      [OLD_LOG]: oldLine("Reorganize the codebook"),
      "Logs/2026-10-01-gentle-pomodoro-log.md": oldLine("Write docs").replace(
        /2026-09-30/g,
        "2026-10-01"
      ),
    });
    timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123 ➕ 2026-10-01");

    await edit(PATH, "- [ ] Write the docs 🆔 abc123 ➕ 2026-10-01\n");

    expect(vault.contents[OLD_LOG]).toBe(oldLine("Reorganize the codebook"));
    expect(vault.contents["Logs/2026-10-01-gentle-pomodoro-log.md"]).toBe(
      oldLine("Write the docs").replace(/2026-09-30/g, "2026-10-01")
    );
  });

  it("still checks for a ticked task when the 🆔 lookup cannot read the note (F41)", async () => {
    const { vault, timer } = harness({ [PATH]: "- [ ] Write docs 🆔 abc123\n" });
    timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123");
    vault.contents[PATH] = "- [x] Write docs 🆔 abc123 ✅ 2026-10-02\n";
    const read = vault.read;
    vault.read = (file) => {
      vault.read = read;
      return Promise.reject(new Error("ENOENT"));
    };

    await timer.onFileModify(vault.getAbstractFileByPath(PATH) as TFile);

    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  describe("a note renamed, moved or deleted (C1)", () => {
    const ARCHIVED = "Projects/Archived/Docs.md";

    it("follows the note when it moves, mid-session: the log, the 🍅 and later edits", async () => {
      const { vault, timer, edit, settle } = harness({
        [ARCHIVED]: "- [ ] Write docs 🆔 abc123\n",
        [OLD_LOG]: oldLine("Write docs", ARCHIVED),
      });
      timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123");
      timer.start();

      timer.onFileRename(vault.getAbstractFileByPath(ARCHIVED) as TFile, PATH);
      expect(timer.currentTaskPath).toBe(ARCHIVED);
      expect(timer.getState().taskPath).toBe(ARCHIVED);
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();

      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${ARCHIVED}|Write docs]]`, id: "abc123" },
      ]);
      expect(vault.contents[ARCHIVED]).toBe("- [ ] Write docs 🍅 1 🆔 abc123\n");
      await edit(ARCHIVED, "- [ ] Write the docs 🍅 1 🆔 abc123\n");
      expect(timer.currentTaskName).toBe("Write the docs 🍅 1");
      expect(vault.contents[OLD_LOG]).toBe(oldLine("Write the docs 🍅 1", ARCHIVED));
    });

    it("follows a folder above the note, and ignores other moves", () => {
      const { vault, timer } = harness({ "Archive/Docs.md": "" });
      timer.setTask("Write docs", PATH, "abc123");
      const listener = vi.fn();
      timer.onChange(listener);
      listener.mockClear();

      timer.onFileRename(vault.getAbstractFileByPath("Archive/Docs.md") as TFile, "Projects/Doc");
      expect(timer.currentTaskPath).toBe(PATH);
      expect(listener).not.toHaveBeenCalled();

      timer.onFileRename(vault.getAbstractFileByPath("Archive") as TFile, "Projects");
      expect(timer.currentTaskPath).toBe("Archive/Docs.md");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    // A deleted note's session keeps its link as it was — what 0.6.8 wrote,
    // and what Obsidian leaves in the log's older lines of that task. Reviews
    // count only linked sessions and take the area from the link's alias: the
    // bare name 0.6.9 first wrote dropped that session to "No Task".
    /** The note goes from the vault, and Obsidian's delete event reaches the timer. */
    const deleteFromVault = (
      vault: ReturnType<typeof harness>["vault"],
      timer: TimerEngine,
      deleted: string,
      notes: string[] = [PATH]
    ) => {
      const item = vault.getAbstractFileByPath(deleted);
      for (const path of notes) vault.remove(vault.getAbstractFileByPath(path) as TFile);
      timer.onFileDelete(item as NonNullable<typeof item>);
    };
    const taskField = (log: string) => log.split("\n").filter((line) => line.includes("[Task:: "));

    it("keeps the open session's link as it was when the note is deleted, and writes nothing into it", async () => {
      const { vault, timer, settle } = harness({ [PATH]: "- [ ] Write docs 🆔 abc123\n" });
      timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123");
      timer.start();

      timer.onFileDelete(Object.assign(new TFile(), { path: "Projects/Doc" }));
      expect(timer.currentTaskPath).toBe(PATH);
      deleteFromVault(vault, timer, PATH);
      // The timer lets go of the note, and holds the task by name (F28).
      expect(timer.currentTaskPath).toBeUndefined();
      expect(timer.getState().taskPath).toBeUndefined();
      expect(timer.currentTaskName).toBe("Write docs");
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();

      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${PATH}|Write docs]]`, id: "abc123" },
      ]);
      expect(taskField(vault.contents[LOG])[0]).toContain(`[Task:: [[${PATH}|Write docs]]]`);
      // No 🍅 and no unlink check reached for the missing note.
      expect(PATH in vault.contents).toBe(false);
      expect(vault.writes).not.toContain(PATH);
      expect(timer.currentTaskName).toBe(NO_TASK_LABEL);
      expect(timer.holdsTask()).toBe(false);
    });

    it.each([
      ["after the switch closed its segment", true],
      ["before the switch, while its segment was still going", false],
    ])(
      "with Split at the switch, keeps a deleted note's link in the segment it closed — %s",
      async (_label, afterSwitch) => {
        const OTHER = "Projects/Review.md";
        const { vault, timer, stub, settle } = harness({
          [PATH]: "- [ ] Write docs 🆔 abc123\n",
          [OTHER]: "- [ ] Review 🆔 rev456\n",
        });
        stub.settings.taskSwitchLogging = "split";
        timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123");
        timer.start();
        vi.setSystemTime(Date.now() + 10 * ONE_MINUTE_MS);
        if (!afterSwitch) deleteFromVault(vault, timer, PATH);
        timer.setTask("Review", OTHER, "rev456", "Review 🆔 rev456");
        if (afterSwitch) deleteFromVault(vault, timer, PATH);
        vi.setSystemTime(Date.now() + 15 * ONE_MINUTE_MS);
        await timer.finish();
        await settle();

        expect(tasks(vault.contents[LOG])).toEqual([
          { task: `[[${PATH}|Write docs]]`, id: "abc123" },
          { task: `[[${OTHER}|Review]]`, id: "rev456" },
        ]);
        expect(taskField(vault.contents[LOG])[0]).toContain(`[Task:: [[${PATH}|Write docs]]]`);
        expect(PATH in vault.contents).toBe(false);
        // The task picked after it stays linked, and got the 🍅.
        expect(timer.currentTaskPath).toBe(OTHER);
        expect(vault.contents[OTHER]).toBe("- [ ] Review 🍅 1 🆔 rev456\n");
      }
    );

    it("keeps the link when a folder above the note is deleted, and lets go of the task when the session ends", async () => {
      const NOTE = "Projects/Area/Docs.md";
      const { vault, timer, settle } = harness({ [NOTE]: "- [ ] Write docs 🆔 abc123\n" });
      timer.setTask("Write docs", NOTE, "abc123", "Write docs 🆔 abc123");
      timer.start();

      deleteFromVault(vault, timer, "Projects", [NOTE]);
      expect(timer.currentTaskPath).toBeUndefined();
      expect(timer.holdsTask()).toBe(true);
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();

      expect(tasks(vault.contents[LOG])).toEqual([
        { task: `[[${NOTE}|Write docs]]`, id: "abc123" },
      ]);
      expect(taskField(vault.contents[LOG])[0]).toContain(`[Task:: [[${NOTE}|Write docs]]]`);
      expect(NOTE in vault.contents).toBe(false);
      expect(timer.currentTaskName).toBe(NO_TASK_LABEL);
      expect(timer.holdsTask()).toBe(false);
    });

    it("a task picked after the note was deleted stays linked when that session ends (F28)", async () => {
      const OTHER = "Projects/Review.md";
      const { vault, timer, settle } = harness({
        [PATH]: "- [ ] Write docs 🆔 abc123\n",
        [OTHER]: "- [ ] Review 🆔 rev456\n",
      });
      timer.setTask("Write docs", PATH, "abc123", "Write docs 🆔 abc123");
      timer.start();
      timer.onFileDelete(vault.getAbstractFileByPath(PATH) as TFile);
      expect(timer.holdsTask()).toBe(true);
      timer.setTask("Review", OTHER, "rev456", "Review 🆔 rev456");
      vi.setSystemTime(Date.now() + 25 * ONE_MINUTE_MS);
      await timer.finish();
      await settle();

      expect(tasks(vault.contents[LOG])).toEqual([{ task: `[[${OTHER}|Review]]`, id: "rev456" }]);
      expect(timer.currentTaskName).toBe("Review");
      expect(timer.currentTaskPath).toBe(OTHER);
      expect(vault.contents[OTHER]).toBe("- [ ] Review 🍅 1 🆔 rev456\n");
    });

    it("is wired to the vault's rename and delete events, and drops waiting renames on unload", () => {
      // Read as code: main.ts cannot be imported here (it pulls in the view).
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const main = readFileSync(resolve(root, "main.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\s+/g, " ");
      expect(main).toContain(
        'this.registerEvent( this.app.vault.on("rename", (file, oldPath) => { this.timer.onFileRename(file, oldPath); }) );'
      );
      expect(main).toContain(
        'this.registerEvent( this.app.vault.on("delete", (file) => { this.timer.onFileDelete(file); }) );'
      );
      expect(main).toContain("if (this.logManager) this.logManager.dispose();");
    });
  });
});

describe("TimerEngine — listeners", () => {
  it("calls a newly-subscribed listener with the current state immediately", () => {
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const received: TimerState[] = [];
    timer.onChange((s) => received.push(s));

    expect(received).toHaveLength(1);
    expect(received[0].mode).toBe("focus");
  });

  it("emits on setTask and stops emitting after offChange", () => {
    const stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const received: TimerState[] = [];
    const listener = (s: TimerState) => received.push(s);
    timer.onChange(listener);
    received.length = 0;

    timer.setTask("Foo");
    expect(received).toHaveLength(1);

    timer.offChange(listener);
    timer.setTask("Bar");
    expect(received).toHaveLength(1); // unchanged
  });
});

describe("TimerEngine — start / pause / reset", () => {
  let stub: ReturnType<typeof makePluginStub>;
  let timer: TimerEngine;

  beforeEach(() => {
    stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    timer = new TimerEngine(stub.plugin as any);
  });

  it("start sets isRunning=true and logs a session start", () => {
    timer.start();
    expect(timer.getState().isRunning).toBe(true);
    expect(stub.calls.some((c) => c.name === "startSession")).toBe(true);
    timer.pause(); // stop the interval so the test doesn't leave it running
  });

  it("pause sets isRunning=false and logs a pause", () => {
    timer.start();
    stub.calls.length = 0;
    timer.pause();
    expect(timer.getState().isRunning).toBe(false);
    expect(stub.calls.some((c) => c.name === "pauseSession")).toBe(true);
  });

  it("reset restores remainingMs to totalMs without changing mode", () => {
    timer.start();
    // simulate consumption by mutating internal state via addMinutes(-5)? Not allowed.
    // Instead: call reset on a non-fresh engine
    timer.pause();
    // Pretend we've decremented remainingMs by reducing total via updateDuration:
    // Actually simplest: call addMinutes(-5) then reset
    timer.addMinutes(-5);
    timer.reset();
    const s = timer.getState();
    expect(s.remainingMs).toBe(s.totalMs);
    expect(s.mode).toBe("focus");
  });
});

describe("TimerEngine — session counter (the status bar menu's guard)", () => {
  let stub: ReturnType<typeof makePluginStub>;
  let timer: TimerEngine;

  beforeEach(() => {
    stub = makePluginStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    timer = new TimerEngine(stub.plugin as any);
  });

  it("moves when a session starts to end and again when the next begins, by Stop or by Skip", async () => {
    const first = timer.session;
    timer.start();
    const ending = timer.finish();
    // Already moved, before any vault write lands: a menu clicked in that
    // window must not act on the session that is ending.
    expect(timer.session).toBe(first + 1);
    await ending;
    expect(timer.session).toBe(first + 2);
    await timer.skip();
    expect(timer.session).toBe(first + 4);
  });

  it("moves at the auto-start crossing on the frozen 00:00 emit, before the writes", () => {
    vi.useFakeTimers();
    try {
      stub.settings.autoStartBreak = true;
      const seen: number[] = [];
      timer.onChange(() => seen.push(timer.session));
      const first = timer.session;
      timer.start();
      vi.advanceTimersByTime(25 * ONE_MINUTE_MS + 100);
      // The emit that freezes 00:00 already carries the moved session.
      expect(seen).toContain(first + 1);
    } finally {
      timer.pause();
      vi.useRealTimers();
    }
  });

  it("moves between two sessions of the same mode", () => {
    const first = timer.session;
    timer.switchMode("break", true);
    timer.switchMode("focus", true);
    timer.switchMode("focus", true);
    expect(timer.session).toBe(first + 3);
    timer.pause();
  });

  it("stays put for anything that keeps the same session", () => {
    const first = timer.session;
    timer.start();
    timer.pause();
    timer.addMinutes(5);
    timer.start();
    timer.pause();
    expect(timer.session).toBe(first);
  });

  it("moves on a Reset that throws a session away, not on one of a timer never started", () => {
    // 0.6.9: Reset discards the session on the clock (F7), so a menu opened
    // for it must not act on whatever follows.
    vi.useFakeTimers();
    try {
      const first = timer.session;
      timer.reset();
      expect(timer.session).toBe(first);
      timer.start();
      vi.advanceTimersByTime(ONE_MINUTE_MS);
      timer.reset(); // running
      expect(timer.session).toBe(first + 1);
      vi.advanceTimersByTime(ONE_MINUTE_MS);
      timer.pause();
      timer.reset(); // paused part-way
      expect(timer.session).toBe(first + 2);
    } finally {
      timer.pause();
      vi.useRealTimers();
    }
  });
});

describe("TimerEngine — one end at a time", () => {
  // finish(), skip() and the auto-start crossing all await vault writes before
  // the next session exists. A second end arriving in that window — the
  // panel's Stop, a palette command, the status bar menu — used to log the
  // session twice, bump the task's count twice, move the long-break counter
  // twice and throw the new session away.
  function heldEndSession() {
    const stub = makePluginStub({ sessionCounterDate: "2025-05-18", sessionsSinceLongBreak: 0 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let ends = 0;
    stub.plugin.logManager.endSession = async () => {
      ends++;
      await held;
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    return { stub, timer, release: () => release(), ends: () => ends };
  }

  it("ignores Finish & next while a Finish is still writing", async () => {
    const { stub, timer, release, ends } = heldEndSession();
    timer.start();
    const first = timer.finish();
    const second = timer.finish();
    release();
    await Promise.all([first, second]);
    expect(ends()).toBe(1);
    expect(stub.settings.sessionsSinceLongBreak).toBe(1);
    expect(timer.getState().mode).toBe("break");
  });

  it("ignores Skip while a Finish is still writing, and Finish while a Skip is", async () => {
    const a = heldEndSession();
    a.timer.start();
    const finish = a.timer.finish();
    const skip = a.timer.skip();
    a.release();
    await Promise.all([finish, skip]);
    expect(a.ends()).toBe(1);
    expect(a.timer.getState().mode).toBe("break");

    const b = heldEndSession();
    b.timer.start();
    const skip2 = b.timer.skip();
    const finish2 = b.timer.finish();
    b.release();
    await Promise.all([skip2, finish2]);
    expect(b.ends()).toBe(1);
    expect(b.timer.getState().mode).toBe("break");
  });

  it("ignores a Stop while the auto-start crossing is still writing", async () => {
    vi.useFakeTimers();
    const { stub, timer, release, ends } = heldEndSession();
    try {
      stub.settings.autoStartBreak = true;
      timer.start();
      vi.advanceTimersByTime(25 * ONE_MINUTE_MS + 100);
      expect(ends()).toBe(1);
      const stop = timer.finish();
      release();
      await stop;
      await vi.runOnlyPendingTimersAsync();
      expect(ends()).toBe(1);
      // The auto-started break survives the ignored Stop.
      expect(timer.getState().mode).toBe("break");
      expect(timer.getState().isRunning).toBe(true);
      expect(stub.settings.sessionsSinceLongBreak).toBe(1);
    } finally {
      timer.pause();
      vi.useRealTimers();
    }
  });

  it("lets the next end through once the first is done", async () => {
    const { timer, release, ends } = heldEndSession();
    release();
    timer.start();
    await timer.finish();
    await timer.skip();
    expect(ends()).toBe(2);
    expect(timer.getState().mode).toBe("focus");
  });

  it("lets the next end through even when the first one throws", async () => {
    const stub = makePluginStub();
    let calls = 0;
    stub.plugin.logManager.endSession = async () => {
      calls++;
      if (calls === 1) throw new Error("disk full");
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    timer.start();
    await expect(timer.finish()).rejects.toThrow("disk full");
    await timer.finish();
    expect(calls).toBe(2);
    expect(timer.getState().mode).toBe("break");
  });
});

describe("TimerEngine — addMinutes clamping", () => {
  it("adds time to both totalMs and remainingMs", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.addMinutes(5);
    const s = timer.getState();
    expect(s.totalMs).toBe(30 * ONE_MINUTE_MS);
    expect(s.remainingMs).toBe(30 * ONE_MINUTE_MS);
  });

  it("clamps total to a 1-minute minimum when subtracting too much", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.addMinutes(-1000);
    const s = timer.getState();
    expect(s.totalMs).toBe(ONE_MINUTE_MS);
  });
});

describe("TimerEngine — updateDuration", () => {
  it("updates totalMs and remainingMs when on a fresh, matching mode", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    stub.settings.focusMinutes = 40;
    timer.updateDuration("focusMinutes");
    const s = timer.getState();
    expect(s.totalMs).toBe(40 * ONE_MINUTE_MS);
    expect(s.remainingMs).toBe(40 * ONE_MINUTE_MS);
  });

  it("does NOT affect remainingMs of a different mode", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const before = timer.getState();
    stub.settings.breakMinutes = 10;
    timer.updateDuration("breakMinutes");
    const after = timer.getState();
    expect(after.totalMs).toBe(before.totalMs); // still focus mode
    expect(after.remainingMs).toBe(before.remainingMs);
  });

  it.each([
    ["running", false],
    ["paused part-way", true],
  ])(
    "leaves a session already under way (%s) as it is; the next one takes the new length",
    async (_label, paused) => {
      // 0.6.9 (F17). It used to move the total alone: the meter, the ring and
      // the sky jumped by the difference while the session still ran out at
      // its old time and logged its old Scheduled.
      vi.useFakeTimers();
      try {
        const stub = makePluginStub({ focusMinutes: 25, sessionCounterDate: "2025-05-18" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timer = new TimerEngine(stub.plugin as any);
        timer.start();
        vi.advanceTimersByTime(10 * ONE_MINUTE_MS);
        if (paused) timer.pause();
        const before = timer.getState();

        let emitted = 0;
        timer.onChange(() => emitted++);
        emitted = 0; // onChange replays the current state once on subscribe
        stub.settings.focusMinutes = 50;
        timer.updateDuration("focusMinutes");

        expect(timer.getState().totalMs).toBe(25 * ONE_MINUTE_MS);
        expect(timer.getState().remainingMs).toBe(before.remainingMs);
        expect(emitted).toBe(0);

        await timer.finish(); // → a break, paused
        await timer.finish(); // → the next focus
        expect(timer.getState().mode).toBe("focus");
        expect(timer.getState().totalMs).toBe(50 * ONE_MINUTE_MS);
        expect(timer.getState().remainingMs).toBe(50 * ONE_MINUTE_MS);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 0.6.3 — the opt-in end-of-session chime (GitHub issue #5)
//
// The silence at the zero crossing is DELIBERATE (flow protection), so every
// test here is really about one of two things: the chime only speaks when it
// was asked to, and it never costs us a cue that rang before 0.6.3.
// ---------------------------------------------------------------------------
describe("TimerEngine — opt-in end-of-session chime", () => {
  // Record what the engine DECIDED to play, honouring the same master gate the
  // real playSound() applies at its first statement. Mirroring that gate is the
  // point: a cue `soundEnabled` blocks is not audible, and a test that counted
  // it would be blind to the stamp-an-intent bug the flag exists to avoid.
  const recordCues = (timer: TimerEngine, settings: { soundEnabled: boolean }) => {
    const played: string[] = [];
    (timer as unknown as { playSound: (f: string) => Promise<void> }).playSound = async (
      file: string
    ) => {
      if (settings.soundEnabled) played.push(file);
    };
    return played;
  };

  const BELL = "singing_bell_short.mp3";
  const DING = "ding-sound.mp3";
  // start() plays this on every fresh FOCUS start, so it heads the expected
  // sequence of any focus test. Asserting the whole audible sequence rather
  // than filtering it out means a cue landing in the wrong place is visible.
  const DRUM = "war-drum_short.mp3";

  beforeEach(() => {
    // Fakes setInterval AND Date.now, which the 50ms tick reads to find the
    // crossing — both have to move together or the loop never sees zero.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("chimes when a break runs out with the chime on — and changes nothing else", () => {
    const stub = makePluginStub({ breakMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.breakEndSoundEnabled = true;
    stub.settings.autoStartFocus = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.switchMode("break");
    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toEqual([DING]);
    // The flow guarantee: the chime ANNOUNCES the end, it does not end
    // anything. Overtime must be byte-identical to the pre-0.6.3 fall-through.
    const state = timer.getState();
    expect(state.mode).toBe("break");
    expect(state.isRunning).toBe(true);
    expect(state.remainingMs).toBeLessThan(0);
    expect(stub.calls.filter((c) => c.name === "endSession")).toHaveLength(0);
    timer.pause();
  });

  it("stays silent when focus runs out with the chime off — the shipped default", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    expect(stub.settings.focusEndSoundEnabled).toBe(false); // locks the default
    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toEqual([DRUM]); // the start cue only — nothing at the end
    expect(timer.getState().remainingMs).toBeLessThan(0);
    timer.pause();
  });

  it("plays the bell (not the ding) when focus is the session that ended", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toEqual([DRUM, BELL]);
    timer.pause();
  });

  it("chimes exactly ONCE, not on every tick of overtime", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    vi.advanceTimersByTime(30_000); // a further 600 ticks, all with prev <= 0

    expect(played).toEqual([DRUM, BELL]);
    timer.pause();
  });

  it("Stop in overtime does NOT ring a second time after the chime", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL]);

    await timer.finish();
    expect(played).toEqual([DRUM, BELL]); // still one bell — no double cue
  });

  it("Stop BEFORE the clock runs out still rings, as it always has", async () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(5_000);
    await timer.finish();

    expect(played).toEqual([DRUM, BELL]);
  });

  it("Skip in overtime does not double up, but Skip before zero still rings", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    await timer.skip(); // in overtime → the chime already rang
    expect(played).toEqual([DRUM, BELL]);

    timer.switchMode("focus");
    timer.start();
    vi.advanceTimersByTime(5_000);
    await timer.skip(); // before zero → rings normally
    expect(played).toEqual([DRUM, BELL, DRUM, BELL]);
    timer.pause();
  });

  // -- The three ways an "already chimed" flag silences a Stop that used to ring.
  //    Each of these went red before the fix and is the reason it exists.

  it("HOLE C: a chime the master switch muted must not silence a later Stop", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = false; // master off: the crossing is inaudible
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([]); // nothing was heard

    stub.settings.soundEnabled = true; // user turns sound back on
    await timer.finish();

    // Stop has rung since 0.2.1; a flag recording INTENT rather than an audible
    // event would leave this empty.
    expect(played).toEqual([BELL]);
  });

  it("HOLE A: Reset puts time back, so a second crossing's Stop still rings", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL]);

    // Visible in overtime, and clears the flag. A running Reset begins a fresh
    // session (0.6.9), so it plays the drum as any fresh focus start does.
    timer.reset();
    stub.settings.focusEndSoundEnabled = false; // second crossing is silent
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL, DRUM]);

    await timer.finish();
    expect(played).toEqual([DRUM, BELL, DRUM, BELL]); // silent without the reset() clear
  });

  it("HOLE B: +5 puts time back, so a second crossing's Stop still rings", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL]);

    timer.addMinutes(1); // the +N button is reachable in overtime
    stub.settings.focusEndSoundEnabled = false;
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL]);

    await timer.finish();
    expect(played).toEqual([DRUM, BELL, BELL]); // silent without the addMinutes() clear
  });

  it("auto-start chimes when asked to, and still advances", async () => {
    const stub = makePluginStub({ focusMinutes: 1, sessionCounterDate: "2025-05-18" });
    stub.settings.soundEnabled = true;
    stub.settings.autoStartBreak = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(played).toEqual([DRUM, BELL]);
    expect(timer.getState().mode).toBe("break");
    timer.pause();
  });

  it("auto-start can advance SILENTLY — the state 0.6.2 could not express", async () => {
    // Before 0.6.3 the auto-start path chimed unconditionally, so the two
    // settings encoded only three states and "start the next session quietly"
    // was unreachable. Making the chime govern both paths is what removed the
    // dependency between the toggles — and this is the state it bought.
    const stub = makePluginStub({ focusMinutes: 1, sessionCounterDate: "2025-05-18" });
    stub.settings.soundEnabled = true;
    stub.settings.autoStartBreak = true;
    stub.settings.focusEndSoundEnabled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(played).toEqual([DRUM]); // the start cue only — the handover is quiet
    expect(timer.getState().mode).toBe("break"); // but it DID advance
    timer.pause();
  });

  it("Stop just before zero does not cue twice — the tick outlives its awaits", async () => {
    // finish() awaits four vault round trips before switchMode() replaces the
    // state, and the 50ms loop used to keep running through all of them: the
    // Stop cued, the clock then crossed zero mid-await, and the crossing cued
    // AGAIN. Harmless before 0.6.3 when the crossing was silent; a real double
    // cue once the chime exists. clearLoop() as finish()'s first statement.
    const stub = makePluginStub({ focusMinutes: 1, sessionCounterDate: "2025-05-18" });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // Annotated rather than inferred: TypeScript cannot see that the executor
    // runs synchronously, so it narrows the binding back to `null`.
    const gate: { release: () => void } = { release: () => {} };
    stub.plugin.logManager.endSession = () =>
      new Promise<boolean>((resolve) => {
        gate.release = () => resolve(true);
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(59_500); // 500ms left
    const finished = timer.finish(); // cues, then blocks on the log write
    vi.advanceTimersByTime(2_000); // the clock sails past zero while it waits
    gate.release();
    await finished;

    expect(played).toEqual([DRUM, BELL]); // not [DRUM, BELL, BELL]
    timer.pause();
  });

  it("a backward clock jump re-arms the chime instead of silencing the next Stop", async () => {
    // The tick writes remainingMs like reset() and addMinutes() do, so it needs
    // their clear: an NTP correction or a laptop resume that steps the clock
    // BACK is arithmetically the same as adding time. Without it the flag stays
    // set across the jump, and a Stop after the next crossing goes silent —
    // where 0.6.2 always rang.
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.start();
    vi.advanceTimersByTime(61_000); // crossing: chimes, flag set, overtime
    expect(played).toEqual([DRUM, BELL]);

    // Step the clock backward by pushing the target out, then tick once.
    const withTarget = timer as unknown as { targetTime: number };
    withTarget.targetTime += 10 * 60_000;
    vi.advanceTimersByTime(100);

    expect(timer.getState().remainingMs).toBeGreaterThan(0);
    stub.settings.focusEndSoundEnabled = false; // second crossing is silent
    withTarget.targetTime = Date.now() - 1_000;
    vi.advanceTimersByTime(100);

    await timer.finish();
    expect(played).toEqual([DRUM, BELL, BELL]); // the Stop still rings
  });

  it("an inaudible cue (volume 0) neither rings nor claims to have rung", () => {
    // Only reachable from a hand-edited data.json, but a stamped flag for a
    // cue nobody heard would silence the following Stop, and playSound would
    // still dip the lofi music for the length of the clip.
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.soundVolume = 0;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(61_000);

    expect((timer as unknown as { endCueSounded: boolean }).endCueSounded).toBe(false);
    timer.pause();
  });

  it("each edge reads its own chime setting, not the other's", async () => {
    // A break ending must consult breakEndSoundEnabled even while the FOCUS
    // chime is off, or the two edges collapse into one control.
    const stub = makePluginStub({ breakMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = false;
    stub.settings.breakEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordCues(timer, stub.settings);

    timer.switchMode("break");
    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toEqual([DING]);
    timer.pause();
  });
});

// ---------------------------------------------------------------------------
// 0.6.6 — the opt-in system notification (the follow-up on GitHub issue #4)
//
// The engine only ASKS: it tells the plugin, once per crossing, which session
// ended and whether the next one started. Whether anything is posted is the
// plugin's setting and the notifier's job (tests/sessionEndNotice.test.ts).
// These tests hold the engine's half — the moment, the arguments, and that
// the flow guarantee at the crossing is untouched.
// ---------------------------------------------------------------------------
describe("TimerEngine — session-end notification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const notified = (calls: LogCall[]) =>
    calls.filter((c) => c.name === "notifySessionEnd").map((c) => c.args);

  it("asks once when focus runs out into overtime, and changes nothing else", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(61_000);
    vi.advanceTimersByTime(30_000); // 600 more ticks of overtime, all prev <= 0

    expect(notified(stub.calls)).toEqual([["focus", false]]);
    // The flow guarantee holds: overtime, still running, nothing logged.
    const state = timer.getState();
    expect(state.mode).toBe("focus");
    expect(state.isRunning).toBe(true);
    expect(state.remainingMs).toBeLessThan(0);
    expect(stub.calls.filter((c) => c.name === "endSession")).toHaveLength(0);
    timer.pause();
  });

  it("does not depend on any sound setting — it exists for people who mute", () => {
    const stub = makePluginStub({ breakMinutes: 1 });
    stub.settings.soundEnabled = false;
    stub.settings.breakEndSoundEnabled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.switchMode("break");
    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(notified(stub.calls)).toEqual([["break", false]]);
    timer.pause();
  });

  it("names the session that ENDED when the next one starts on its own", async () => {
    // completeNaturally() switches the mode, so the call must read it first.
    const stub = makePluginStub({ focusMinutes: 1, sessionCounterDate: "2025-05-18" });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(notified(stub.calls)).toEqual([["focus", true]]);
    expect(timer.getState().mode).toBe("break");
    timer.pause();
  });

  it("stays quiet for Stop and Skip — a button press needs no reminder", async () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(5_000);
    await timer.finish();
    timer.start();
    vi.advanceTimersByTime(5_000);
    await timer.skip();

    expect(notified(stub.calls)).toEqual([]);
  });

  it("does not ask again when Stop ends the overtime it already announced", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(61_000);
    await timer.finish();

    expect(notified(stub.calls)).toEqual([["focus", false]]);
  });
});

describe("TimerEngine — session-end notification: edges and repeats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const notified = (calls: LogCall[]) =>
    calls.filter((c) => c.name === "notifySessionEnd").map((c) => c.args);

  it("each edge reads its OWN auto-start: a break ending with only auto-start-focus on", async () => {
    // The crossing that matters: what starts when a BREAK ends is focus, so
    // the break edge is governed by autoStartFocus. Reading autoStartBreak
    // here would tell the user the timer is counting when focus had started.
    const stub = makePluginStub({ breakMinutes: 1, sessionCounterDate: "2025-05-18" });
    stub.settings.autoStartFocus = true;
    stub.settings.autoStartBreak = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.switchMode("break");
    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(notified(stub.calls)).toEqual([["break", true]]);
    expect(timer.getState().mode).toBe("focus");
    timer.pause();
  });

  it("…and a focus ending with only auto-start-focus on says nothing started", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.autoStartFocus = true;
    stub.settings.autoStartBreak = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(notified(stub.calls)).toEqual([["focus", false]]);
    expect(timer.getState().mode).toBe("focus");
    timer.pause();
  });

  it("still asks when the chime DOES ring — it is not a stand-in for the sound", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played: string[] = [];
    (timer as unknown as { playSound: (f: string) => Promise<void> }).playSound = async (f) => {
      played.push(f);
    };

    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toContain("singing_bell_short.mp3");
    expect(notified(stub.calls)).toEqual([["focus", false]]);
    timer.pause();
  });

  it("asks again for a SECOND crossing after +5 in overtime — time was put back", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(70_000); // 10s into overtime
    timer.addMinutes(5); // back to 4m50s on the clock
    vi.advanceTimersByTime(5 * 60_000);

    expect(notified(stub.calls)).toEqual([
      ["focus", false],
      ["focus", false],
    ]);
    timer.pause();
  });

  it("does not ask again for a pause and resume in overtime, nor for Skip", async () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(61_000);
    timer.pause();
    vi.advanceTimersByTime(10_000);
    timer.start();
    vi.advanceTimersByTime(30_000);
    await timer.skip();

    expect(notified(stub.calls)).toEqual([["focus", false]]);
  });
});

// ---------------------------------------------------------------------------
// 0.6.6 — the end-time wake-up. A covered Obsidian window is a hidden page,
// and five minutes after a page goes hidden Chromium wakes a repeating timer
// at most once a minute (unless audio is playing — and this feature is for
// people who keep it off). These tests kill the 50ms tick outright, which is
// the limit of that throttling, and check the crossing still lands on time.
// ---------------------------------------------------------------------------
describe("TimerEngine — end-time wake-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A tick that never fires: the worst case of intensive throttling.
    vi.spyOn(globalThis, "setInterval").mockImplementation((() => 0) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const notified = (calls: LogCall[]) =>
    calls.filter((c) => c.name === "notifySessionEnd").map((c) => c.args);

  it("crosses zero on time with no tick at all", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(59_000);
    expect(notified(stub.calls)).toEqual([]);
    vi.advanceTimersByTime(1_010);
    expect(notified(stub.calls)).toEqual([["focus", false]]);
    expect(timer.getState().remainingMs).toBeLessThanOrEqual(0);
    timer.pause();
  });

  it("moves with +5: the old end time wakes nothing, the new one crosses", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(30_000);
    timer.addMinutes(5); // the end moves to 5m30s from now
    vi.advanceTimersByTime(60_000);
    expect(notified(stub.calls)).toEqual([]);
    vi.advanceTimersByTime(4 * 60_000 + 30_010);
    expect(notified(stub.calls)).toEqual([["focus", false]]);
    timer.pause();
  });

  it("moves with Reset: a fresh minute from the press, not from the start", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    vi.advanceTimersByTime(30_000);
    timer.reset();
    vi.advanceTimersByTime(59_000);
    expect(notified(stub.calls)).toEqual([]);
    vi.advanceTimersByTime(1_010);
    expect(notified(stub.calls)).toEqual([["focus", false]]);
    timer.pause();
  });

  it("is cancelled by pause, and re-armed by resume", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    timer.pause();
    vi.advanceTimersByTime(10 * 60_000);
    expect(notified(stub.calls)).toEqual([]);

    // Paused straight after the start because pause() keeps the last TICKED
    // time, and this suite has no tick — a click only happens with the window
    // visible, where the tick is fresh.
    timer.start();
    vi.advanceTimersByTime(59_000);
    expect(notified(stub.calls)).toEqual([]);
    vi.advanceTimersByTime(1_010);
    expect(notified(stub.calls)).toEqual([["focus", false]]);
    timer.pause();
  });

  it("arms again for the session an auto-start begins", async () => {
    const stub = makePluginStub({
      focusMinutes: 1,
      breakMinutes: 1,
      sessionCounterDate: "2025-05-18",
    });
    stub.settings.autoStartBreak = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    await vi.advanceTimersByTimeAsync(60_010);
    expect(timer.getState().mode).toBe("break");
    await vi.advanceTimersByTimeAsync(60_010);

    expect(notified(stub.calls)).toEqual([
      ["focus", true],
      ["break", false],
    ]);
    timer.pause();
  });

  it("leaves nothing pending after dispose", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    timer.start();
    timer.dispose();
    vi.advanceTimersByTime(2 * 60_000);
    expect(notified(stub.calls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 0.6.7 — which sound marks each end (issue #5). The recorder captures BOTH
// arguments: the bundled sound and the user's file preferred over it. What
// happens when the file cannot play is audioCue.test.ts's job, against the
// real playSound; here the question is only which choice each moment reads.
// ---------------------------------------------------------------------------
describe("TimerEngine — the chosen end sounds", () => {
  const BELL = "singing_bell_short.mp3";
  const DING = "ding-sound.mp3";
  const DRUM = "war-drum_short.mp3";
  const GONG = "Sounds/gong.mp3";

  const recordChoices = (timer: TimerEngine) => {
    const played: [string, string | null][] = [];
    (timer as unknown as { playSound: (f: string, p?: string | null) => Promise<null> }).playSound =
      async (f, p = null) => {
        played.push([f, p]);
        return null;
      };
    return played;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rings the focus choice when FOCUS runs out — read from the ending mode", () => {
    const stub = makePluginStub({ focusMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.focusEndSoundEnabled = true;
    stub.settings.focusEndSound = `file:${GONG}`;
    stub.settings.breakEndSound = "drum";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordChoices(timer);

    timer.start();
    vi.advanceTimersByTime(61_000);

    expect(played).toEqual([
      [DRUM, null], // the start drum is not choosable, whatever the end sounds are
      [BELL, GONG],
    ]);
    timer.pause();
  });

  it("rings the break choice when a break runs out and focus auto-starts", async () => {
    const stub = makePluginStub({ breakMinutes: 1 });
    stub.settings.soundEnabled = true;
    stub.settings.breakEndSoundEnabled = true;
    stub.settings.autoStartFocus = true;
    stub.settings.focusEndSound = "ding";
    stub.settings.breakEndSound = `file:${GONG}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordChoices(timer);

    timer.switchMode("break");
    timer.start();
    await vi.advanceTimersByTimeAsync(61_000);

    // The cue belongs to the break that ENDED, though the focus session it
    // auto-started is already running by the time anything is awaited.
    expect(played[0]).toEqual([DING, GONG]);
    expect(timer.getState().mode).toBe("focus");
    timer.pause();
  });

  it("uses the break choice when you stop a LONG break too", async () => {
    const stub = makePluginStub({ longBreakMinutes: 15 });
    stub.settings.soundEnabled = true;
    // Unlike both defaults and unlike the focus choice, so reading the wrong
    // setting for a long break cannot pass by coincidence.
    stub.settings.breakEndSound = "drum";
    stub.settings.focusEndSound = `file:${GONG}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordChoices(timer);

    timer.switchMode("break", false, true);
    expect(timer.getState().breakType).toBe("long");
    timer.start();
    vi.advanceTimersByTime(60_000);
    await timer.finish();

    expect(played).toEqual([[DRUM, null]]);
  });

  it("uses the focus choice when you skip focus, and the defaults change nothing", async () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    stub.settings.soundEnabled = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);
    const played = recordChoices(timer);

    timer.start();
    vi.advanceTimersByTime(60_000);
    await timer.skip();

    expect(played).toEqual([
      [DRUM, null],
      [BELL, null], // today's sound, on the default settings
    ]);
  });
});

// ---------------------------------------------------------------------------
// 0.6.9 — what reaches the daily log, with the real LogManager on fake time.
//
// Every rule here was a line in the maintainer's real logs before 0.6.9: a
// Reset that kept the old Start, a mis-click logged as a session, a crossing
// seen on waking a laptop logged as a night of focus, a task ticked while paused
// logged as "No Task".
// ---------------------------------------------------------------------------
describe("TimerEngine + LogManager — the session lifecycle", () => {
  const PATH = "Projects/Docs.md";
  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const NEXT_LOG = "Logs/2026-10-03-gentle-pomodoro-log.md";
  const DRUM = "war-drum_short.mp3";

  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = moment;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  /** Fake time to a wall-clock instant on 2 Oct (or `day`), without running the tick. */
  const at = (h: number, m: number, s = 0, day = 2) =>
    vi.setSystemTime(new Date(2026, 9, day, h, m, s));
  const minutes = (n: number) => vi.advanceTimersByTime(n * ONE_MINUTE_MS);

  /** A timer writing a real daily log for a task note, the 🍅 counter on. */
  function lifecycle(taskLine = "- [ ] Write docs 🆔 abc123\n") {
    const vault = fakeVault({ [PATH]: taskLine, [LOG]: "" });
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true), append: vi.fn() },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        return Promise.resolve();
      },
      create: (path: string, data: string) => {
        vault.contents[path] = data;
        return Promise.resolve();
      },
      createFolder: () => Promise.resolve(),
    });
    const stub = makePluginStub({ vault, longBreakEvery: 4 });
    stub.settings.logFolderPath = "Logs";
    stub.settings.incrementPomodoroCountOnFinish = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = stub.plugin as any;
    plugin.invalidateFocusTotalCache = () => {};
    const lm = new LogManager(plugin);
    plugin.logManager = lm;
    const timer = new TimerEngine(plugin);
    const played: string[] = [];
    (timer as unknown as { playSound: (f: string) => Promise<null> }).playSound = (f) => {
      played.push(f);
      return Promise.resolve(null);
    };
    // The session lines, past the goal the timer records at the top of
    // today's file (logFrontmatter.ts).
    const lines = (path = LOG) => {
      const content = vault.contents[path] ?? "";
      return content.split("\n").slice(frontmatterRowCount(content)).filter(Boolean);
    };
    const field = (line: string, key: string) => parseLogLine(line)?.values.get(key);
    const note = vault.getAbstractFileByPath(PATH) as TFile;
    /** The user changes the task's line; Obsidian's modify event reaches the timer. */
    const edit = async (next: string) => {
      await vault.process(note, () => next);
      await timer.onFileModify(note);
    };
    return { vault, stub, plugin, lm, timer, played, lines, field, edit };
  }

  /** Answer Stop's long-session question with `answer`; what was asked is returned. */
  function asking(
    t: ReturnType<typeof lifecycle>,
    answer: LongSessionAnswer | Promise<LongSessionAnswer>
  ) {
    const asked: LongSessionQuestion[] = [];
    t.plugin.askAboutLongSession = (question: LongSessionQuestion) => {
      asked.push(question);
      return Promise.resolve(answer);
    };
    return asked;
  }

  describe("Reset throws the session away (F7)", () => {
    it("running: no line, and a fresh session begins at that instant, drum and all", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(10);
      const session = t.timer.session;
      t.timer.reset();

      expect(t.lines()).toEqual([]);
      expect(t.played).toEqual([DRUM, DRUM]);
      expect(t.timer.getState()).toMatchObject({
        isRunning: true,
        remainingMs: 25 * ONE_MINUTE_MS,
      });
      expect(t.timer.session).toBe(session + 1);

      minutes(25); // runs into overtime at 09:35
      await t.timer.finish();

      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Start")).toBe("2026-10-02 09:10:00");
      expect(t.field(line, "End")).toBe("2026-10-02 09:35:00");
      expect(t.field(line, "Pauses")).toBe("[]");
      expect(t.field(line, "Total")).toBe("1500");
      // One session, one 🍅, one step of the count.
      expect(t.vault.contents[PATH]).toBe("- [ ] Write docs 🍅 1 🆔 abc123\n");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(1);
    });

    it("paused: back to full and stopped, nothing open — a later Start is a new session", async () => {
      const t = lifecycle();
      at(10, 0);
      t.timer.start();
      minutes(10);
      t.timer.pause();
      t.timer.reset();

      expect(t.timer.getState()).toMatchObject({
        isRunning: false,
        remainingMs: 25 * ONE_MINUTE_MS,
        totalMs: 25 * ONE_MINUTE_MS,
      });
      expect(t.lm.openSessionDay()).toBeNull();
      expect(t.lines()).toEqual([]);

      at(14, 0);
      t.timer.start();
      minutes(25);
      await t.timer.finish();

      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Start")).toBe("2026-10-02 14:00:00");
      expect(t.field(line, "Pauses")).toBe("[]");
      expect(t.field(line, "Total")).toBe("1500");
      expect(t.played.filter((f) => f === DRUM)).toHaveLength(2);
    });

    it("Start and Pause in one instant, then Reset: the log's session goes too", async () => {
      // A double-click: the clock still shows full length, so the engine sees
      // no session under way — but the log opened one at the Start, with a
      // pause running. Only Reset's unconditional discard keeps the next
      // Start from resuming it, old Start and hours-long pause included.
      const t = lifecycle();
      at(10, 0);
      t.timer.start();
      t.timer.pause();
      expect(t.timer.getState()).toMatchObject({
        isRunning: false,
        remainingMs: 25 * ONE_MINUTE_MS,
      });
      expect(t.lm.openSessionDay()).toBe("2026-10-02");

      t.timer.reset();
      expect(t.lm.openSessionDay()).toBeNull();

      at(14, 0);
      t.timer.start();
      minutes(25);
      await t.timer.finish();

      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Start")).toBe("2026-10-02 14:00:00");
      expect(t.field(line, "Pauses")).toBe("[]");
      expect(t.field(line, "Total")).toBe("1500");
    });

    it("running break: a fresh break begins, and no drum — the drum is focus's", async () => {
      const t = lifecycle();
      t.timer.switchMode("break", true);
      minutes(2);
      t.timer.reset();

      expect(t.played).toEqual([]);
      expect(t.lines()).toEqual([]);
      expect(t.timer.getState()).toMatchObject({
        mode: "break",
        isRunning: true,
        remainingMs: 5 * ONE_MINUTE_MS,
      });
    });

    it("leaves no 🍅, no long-break step, and nothing for a Skip to log", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(20);
      t.timer.pause();
      t.timer.reset();
      await t.timer.skip();

      expect(t.lines()).toEqual([]);
      expect(t.vault.contents[PATH]).toBe("- [ ] Write docs 🆔 abc123\n");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(0);
    });
  });

  describe("under a minute is not a session (F59)", () => {
    it.each([
      ["Stop", (timer: TimerEngine) => timer.finish()],
      ["Skip", (timer: TimerEngine) => timer.skip()],
    ])("%s at 59 s: no line, no 🍅, no step — and a short break", async (_label, end) => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      // The 4th session of the day would earn the long break.
      t.stub.settings.sessionsSinceLongBreak = 3;
      t.stub.settings.sessionCounterDate = "2026-10-02";
      t.timer.start();
      vi.advanceTimersByTime(59_000);
      await end(t.timer);

      expect(t.lines()).toEqual([]);
      expect(t.vault.contents[PATH]).toBe("- [ ] Write docs 🆔 abc123\n");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(3);
      expect(t.timer.getState()).toMatchObject({ mode: "break", breakType: "short" });
    });

    it("a short break, too, when the count already stands on a long one", async () => {
      // The 4th session earned its long break; a mis-click after it earns none.
      const t = lifecycle();
      t.stub.settings.sessionsSinceLongBreak = 4;
      t.stub.settings.sessionCounterDate = "2026-10-02";
      t.timer.start();
      vi.advanceTimersByTime(10_000);
      await t.timer.finish();
      expect(t.timer.getState().breakType).toBe("short");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(4);
    });

    it("at a full minute it is one: logged, counted, and the 4th earns the long break", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.stub.settings.sessionsSinceLongBreak = 3;
      t.stub.settings.sessionCounterDate = "2026-10-02";
      t.timer.start();
      vi.advanceTimersByTime(60_000);
      await t.timer.finish();

      expect(t.lines()).toHaveLength(1);
      expect(t.field(t.lines()[0], "Total")).toBe("60");
      expect(t.vault.contents[PATH]).toBe("- [ ] Write docs 🍅 1 🆔 abc123\n");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(4);
      expect(t.timer.getState().breakType).toBe("long");
    });

    it("counts active time: an hour on the clock with 59 s of it running is not a session", async () => {
      const t = lifecycle();
      t.timer.start();
      vi.advanceTimersByTime(30_000);
      t.timer.pause();
      minutes(60);
      t.timer.start();
      vi.advanceTimersByTime(29_000);
      await t.timer.finish();
      expect(t.lines()).toEqual([]);
    });

    it("a break under a minute leaves no Rest line", async () => {
      const t = lifecycle();
      t.timer.switchMode("break", false);
      t.timer.start();
      vi.advanceTimersByTime(20_000);
      await t.timer.skip();
      expect(t.lines()).toEqual([]);
      expect(t.timer.getState().mode).toBe("focus");
    });

    it("the zero crossing takes the log's word too: not counted, no step, still auto-starts", async () => {
      // A crossing under a minute takes pauses cut to the second, so it is
      // driven here by the log's verdict rather than by contrived instants.
      const stub = makePluginStub({ sessionsSinceLongBreak: 3, sessionCounterDate: "2025-05-18" });
      stub.settings.autoStartBreak = true;
      stub.plugin.logManager.endSession = () => Promise.resolve(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timer = new TimerEngine(stub.plugin as any);
      await (
        timer as unknown as { completeNaturally: (at: number) => Promise<void> }
      ).completeNaturally(Date.now());
      expect(stub.settings.sessionsSinceLongBreak).toBe(3);
      expect(timer.getState()).toMatchObject({
        mode: "break",
        breakType: "short",
        isRunning: true,
      });
    });
  });

  describe("the end of a session", () => {
    it.each([
      ["a laptop that slept with its lid closed (F11)", true],
      ["a phone that held the app in the background", false],
    ])(
      "an auto-start crossing seen late ends the session at its planned end: %s (F3)",
      async (_label, desktop) => {
        // On the desktop a gap this long is a sleep, which pauses a session —
        // but not one whose next session starts by itself (F11): a sleep
        // through the planned end ends it there, as on a phone.
        Platform.isDesktopApp = desktop;
        const t = lifecycle();
        t.stub.settings.autoStartBreak = true;
        at(22, 0);
        t.timer.start();
        minutes(10);
        at(6, 0, 0, 3); // the lid opens, or the phone wakes the app: no timer ran in between
        try {
          vi.advanceTimersByTime(100);
          await vi.advanceTimersByTimeAsync(0);
        } finally {
          Platform.isDesktopApp = true;
        }

        const [line] = t.lines();
        expect(t.lines()).toHaveLength(1);
        expect(t.field(line, "Start")).toBe("2026-10-02 22:00:00");
        expect(t.field(line, "End")).toBe("2026-10-02 22:25:00");
        expect(t.field(line, "Total")).toBe("1500");
        expect(t.field(line, "Overtime")).toBe("0");
        expect(t.field(line, "Status")).toBe("finished");
        // The next session starts now, filed under the day it starts.
        expect(t.timer.getState()).toMatchObject({ mode: "break", isRunning: true });
        expect(t.lm.openSessionDay()).toBe("2026-10-03");
        minutes(2);
        await t.timer.skip();
        expect(t.field(t.lines(NEXT_LOG)[0], "Start")).toBe("2026-10-03 06:00:00");
      }
    );

    it.each([
      ["Stop before zero", 20, null, "1200", "0"],
      ["Stop 5 minutes past zero", 30, null, "1800", "300"],
      ["Stop paused 3 minutes past zero, 12 minutes later", 28, 12, "1680", "180"],
    ])("%s: Total %s, Overtime %s", async (_label, run, pausedFor, total, overtime) => {
      const t = lifecycle();
      t.timer.start();
      minutes(run as number);
      if (pausedFor !== null) {
        t.timer.pause();
        minutes(pausedFor);
      }
      await t.timer.finish();
      const [line] = t.lines();
      expect(t.field(line, "Total")).toBe(total);
      expect(t.field(line, "Overtime")).toBe(overtime);
      expect(t.field(line, "Scheduled")).toBe("1500");
    });

    // A covered window wakes the tick at most once a minute, so the last tick
    // can be well behind the press. Every case above advances whole 50 ms
    // ticks, where the last tick lands on the press and a stale read agrees
    // with a live one — here no timer runs between 09:10 and the press, so
    // overtime read off the last tick would say 0 beside a 35-minute Total.
    it.each([
      ["Stop", (timer: TimerEngine) => timer.finish()],
      ["Skip", (timer: TimerEngine) => timer.skip()],
    ])("%s reads overtime off the press, not the last tick", async (_label, end) => {
      const t = lifecycle();
      t.timer.start();
      minutes(10); // the last tick: 09:10
      at(9, 35); // 10 minutes past the planned end, no timer has run since
      await end(t.timer);
      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 09:35:00");
      expect(t.field(line, "Total")).toBe("2100");
      expect(t.field(line, "Overtime")).toBe("600");
    });

    it("measures overtime from the planned end as +5 moved it, and on a Skip too", async () => {
      const t = lifecycle();
      t.timer.start();
      minutes(10);
      t.timer.addMinutes(5); // planned end 09:30
      minutes(23); // 09:33
      await t.timer.skip();
      const [line] = t.lines();
      expect(t.field(line, "Status")).toBe("cancelled");
      expect(t.field(line, "Total")).toBe("1980");
      expect(t.field(line, "Overtime")).toBe("180");
    });
  });

  describe("a task ticked while its session is open (F6)", () => {
    it("paused: stays linked, logged and counted, and unlinks once logged", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(24);
      t.timer.pause();
      await t.edit("- [x] Write docs 🆔 abc123 ✅ 2026-10-02\n");

      expect(t.timer.getState().taskPath).toBe(PATH);
      expect(t.timer.currentTaskName).toBe("Write docs");

      await t.timer.finish();
      const [line] = t.lines();
      expect(t.field(line, "Task")).toBe(`[[${PATH}|Write docs]]`);
      expect(t.field(line, "ID")).toBe("abc123");
      expect(t.vault.contents[PATH]).toBe("- [x] Write docs 🍅 1 🆔 abc123 ✅ 2026-10-02\n");
      expect(t.timer.getState().taskPath).toBeUndefined();
    });

    it("paused, then Skip: logged under the task, and Skip runs the unlink it held back", async () => {
      // The guard in onFileModify holds the unlink while the session is
      // paused, so Skip's own check is the only thing left to unlink it.
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(10);
      t.timer.pause();
      await t.edit("- [x] Write docs 🆔 abc123 ✅ 2026-10-02\n");
      expect(t.timer.getState().taskPath).toBe(PATH);

      await t.timer.skip();
      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Task")).toBe(`[[${PATH}|Write docs]]`);
      expect(t.field(line, "ID")).toBe("abc123");
      expect(t.field(line, "Status")).toBe("cancelled");
      expect(t.timer.getState()).toMatchObject({ mode: "break", taskPath: undefined });
      expect(t.timer.currentTaskName).toBe(NO_TASK_LABEL);
    });

    it("paused, then Reset: the unlink it held back runs", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(10);
      t.timer.pause();
      await t.edit("- [x] Write docs 🆔 abc123\n");
      expect(t.timer.getState().taskPath).toBe(PATH);

      t.timer.reset();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.timer.getState().taskPath).toBeUndefined();
    });

    it("running, then Reset: the unlink runs too, so the fresh session is not the done task's (F12)", async () => {
      // Reset of a running session starts a fresh one at once, and the guard
      // in onFileModify holds the unlink for that one's whole length too —
      // so without the check here it was logged to the done task, and 🍅'd
      // its done line.
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(10);
      await t.edit("- [x] Write docs 🆔 abc123 ✅ 2026-10-02\n");
      expect(t.timer.getState().taskPath).toBe(PATH);

      t.timer.reset();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.timer.getState()).toMatchObject({ isRunning: true, taskPath: undefined });
      expect(t.timer.currentTaskName).toBe(NO_TASK_LABEL);

      minutes(25);
      await t.timer.finish();
      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Task")).toBe(NO_TASK_LABEL);
      expect(t.field(line, "ID")).toBeUndefined();
      expect(t.field(line, "Total")).toBe("1500");
      expect(t.vault.contents[PATH]).toBe("- [x] Write docs 🆔 abc123 ✅ 2026-10-02\n");
    });

    it("with no session open, it still unlinks at once", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      await t.edit("- [x] Write docs 🆔 abc123\n");
      expect(t.timer.getState().taskPath).toBeUndefined();
    });
  });

  // Kept on after its note was deleted, the task was given every later
  // session — logged by name and ID — while the panel and the status bar
  // showed no task, and with the picker hidden nothing could clear it.
  describe("a task whose note is deleted (F28)", () => {
    /** The note goes from the vault, and Obsidian's delete event reaches the timer. */
    const deleteNote = (t: ReturnType<typeof lifecycle>) => {
      const note = t.vault.getAbstractFileByPath(PATH) as TFile;
      t.vault.remove(note);
      t.timer.onFileDelete(note);
    };

    it("with no session under way, is unlinked at once", async () => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      deleteNote(t);
      expect(t.timer.currentTaskName).toBe(NO_TASK_LABEL);
      expect(t.timer.getState().taskName).toBe(NO_TASK_LABEL);
      expect(t.timer.holdsTask()).toBe(false);

      t.timer.start();
      minutes(25);
      await t.timer.finish();
      expect(t.field(t.lines()[0], "Task")).toBe(NO_TASK_LABEL);
      expect(t.field(t.lines()[0], "ID")).toBeUndefined();
    });

    it.each([
      ["Stop", 1, (t: ReturnType<typeof lifecycle>) => t.timer.finish()],
      ["Skip", 1, (t: ReturnType<typeof lifecycle>) => t.timer.skip()],
      [
        "the auto-start crossing",
        1,
        async (t: ReturnType<typeof lifecycle>) => {
          t.stub.settings.autoStartBreak = true;
          minutes(15);
          await vi.advanceTimersByTimeAsync(0);
        },
      ],
      ["Reset", 0, (t: ReturnType<typeof lifecycle>) => t.timer.reset()],
    ])(
      "mid-session: that session keeps its link as it was, and the task goes when it ends — %s",
      async (_label, logged, end) => {
        const t = lifecycle();
        t.timer.setTask("Write docs", PATH, "abc123");
        t.timer.start();
        minutes(10);
        deleteNote(t);
        expect(t.timer.currentTaskName).toBe("Write docs");
        expect(t.timer.getState().taskPath).toBeUndefined();
        expect(t.timer.holdsTask()).toBe(true);

        await end(t);
        expect(t.timer.currentTaskName).toBe(NO_TASK_LABEL);
        expect(t.timer.getState().taskName).toBe(NO_TASK_LABEL);
        expect(t.timer.holdsTask()).toBe(false);
        expect(t.lines()).toHaveLength(logged);
        if (logged === 1) {
          expect(t.field(t.lines()[0], "Task")).toBe(`[[${PATH}|Write docs]]`);
          expect(t.field(t.lines()[0], "ID")).toBe("abc123");
        }
        // Nothing wrote into the note that is gone (the 🍅 counter is on).
        expect(PATH in t.vault.contents).toBe(false);
      }
    );

    it.each([
      ["after a Stop", false],
      ["after a running Reset, whose fresh session begins at once", true],
    ])("the next focus is logged with no task, %s", async (_label, viaReset) => {
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(10);
      deleteNote(t);
      if (viaReset) {
        t.timer.reset();
      } else {
        await t.timer.finish(); // the focus, under its name
        await t.timer.skip(); // the break, never started
        t.timer.start();
      }
      minutes(25);
      await t.timer.finish();

      const line = t.lines()[viaReset ? 0 : 1];
      expect(t.lines()).toHaveLength(viaReset ? 1 : 2);
      expect(t.field(line, "Task")).toBe(NO_TASK_LABEL);
      expect(t.field(line, "ID")).toBeUndefined();
    });
  });

  describe("nothing moves while a session is ending (F21)", () => {
    /** Stop a session paused at 09:20, held at the long-break count's save. */
    async function heldStop(t: ReturnType<typeof lifecycle>) {
      let reached = () => {};
      const atSave = new Promise<void>((r) => {
        reached = r;
      });
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      t.plugin.saveSettings = () => {
        reached();
        return held;
      };
      const stop = t.timer.finish();
      await atSave;
      return { stop, release };
    }

    it("a Start in the window does nothing, and the break is logged as a break", async () => {
      const t = lifecycle();
      t.timer.start();
      minutes(20);
      t.timer.pause();
      const { stop, release } = await heldStop(t);
      expect(t.lines()).toHaveLength(1); // the focus line is already written

      t.timer.start();
      expect(t.timer.getState().isRunning).toBe(false);
      expect(t.lm.openSessionDay()).toBeNull();

      release();
      await stop;
      expect(t.timer.getState()).toMatchObject({ mode: "break", isRunning: false });

      at(9, 21);
      t.timer.start();
      minutes(5);
      await t.timer.skip();

      const lines = t.lines();
      expect(lines).toHaveLength(2);
      expect(parseLogLine(lines[1])?.kind).toBe("rest");
      expect(t.field(lines[1], "Start")).toBe("2026-10-02 09:21:00");
      expect(t.field(lines[1], "Total")).toBe("300");
    });

    it("Pause, Reset, ±5 and a length change in the window change nothing", async () => {
      const t = lifecycle();
      t.timer.start();
      minutes(20);
      const { stop, release } = await heldStop(t); // Stop while running
      const before = t.timer.getState();

      t.timer.pause();
      t.timer.reset();
      t.timer.addMinutes(5);
      t.stub.settings.focusMinutes = 40;
      t.timer.updateDuration("focusMinutes");

      expect(t.timer.getState()).toEqual(before);
      release();
      await stop;
    });

    it("a task note deleted in the window is unlinked at once: the ending line already has it (F28)", async () => {
      // This end has run its unlink check already; held for a later one, the
      // task would go on to the break, and from there to the next focus.
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      minutes(20);
      const { stop, release } = await heldStop(t);
      t.timer.onFileDelete(t.vault.getAbstractFileByPath(PATH) as TFile);
      expect(t.timer.currentTaskName).toBe(NO_TASK_LABEL);

      release();
      await stop;
      expect(t.timer.getState()).toMatchObject({ mode: "break", taskName: NO_TASK_LABEL });
      expect(t.timer.holdsTask()).toBe(false);
      expect(t.field(t.lines()[0], "Task")).toBe(`[[${PATH}|Write docs]]`);
    });

    it("a length change while a fresh session is ending waits for the session it is for", async () => {
      // Stop on a timer never started counts nothing, so nothing is saved: the
      // window is held at the completion check's read of the task's note.
      const t = lifecycle();
      t.timer.setTask("Write docs", PATH, "abc123");
      let reached = () => {};
      const atRead = new Promise<void>((r) => {
        reached = r;
      });
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const read = t.vault.read;
      t.vault.read = async (file) => {
        reached();
        await held;
        return read(file);
      };
      const stop = t.timer.finish();
      await atRead;
      const before = t.timer.getState();
      t.stub.settings.focusMinutes = 40;
      t.timer.updateDuration("focusMinutes");
      expect(t.timer.getState()).toEqual(before);
      release();
      await stop;
    });

    it("a mode change drops a stray session the log still holds open", () => {
      const t = lifecycle();
      t.lm.startSession("focus", "No Task", 25); // a stray from 09:00
      t.timer.switchMode("focus", false);
      at(10, 0);
      t.timer.start();
      expect(t.lm.openSessionDay()).toBe("2026-10-02");
      minutes(25);
      return t.timer.finish().then(() => {
        expect(t.field(t.lines()[0], "Start")).toBe("2026-10-02 10:00:00");
      });
    });
  });

  it("a failed read of the task's note keeps the linked name and still ends the session (F22)", async () => {
    const t = lifecycle();
    t.timer.setTask("Write docs", PATH, "abc123");
    t.timer.start();
    minutes(25);
    t.vault.read = () => Promise.reject(new Error("File system operation timed out."));
    await t.timer.finish();

    const [line] = t.lines();
    expect(t.field(line, "Task")).toBe(`[[${PATH}|Write docs]]`);
    expect(t.timer.getState()).toMatchObject({ mode: "break", isRunning: false });
    expect(t.lm.openSessionDay()).toBeNull();
  });

  it("a task called 'No Task' is a task: logged as a link, counted and unlinked (F36)", async () => {
    const t = lifecycle("- [ ] No Task 🆔 abc123\n");
    t.timer.setTask("No Task", PATH, "abc123");
    expect(t.timer.getState().taskPath).toBe(PATH);
    t.timer.start();
    minutes(25);
    await t.timer.finish();
    expect(t.field(t.lines()[0], "Task")).toBe(`[[${PATH}|No Task]]`);
    expect(t.vault.contents[PATH]).toBe("- [ ] No Task 🍅 1 🆔 abc123\n");
    // Still linked into the break: the panel reads "linked" off the state.
    expect(t.timer.getState()).toMatchObject({ mode: "break", taskPath: PATH });

    await t.edit("- [x] No Task 🍅 1 🆔 abc123\n");
    expect(t.timer.getState().taskPath).toBeUndefined();
  });

  describe("a session running past midnight (F8)", () => {
    const liveToday = (t: ReturnType<typeof lifecycle>) =>
      liveFocusSecondsToday(
        t.timer.getState(),
        t.lm.openSessionDay(),
        logicalDate(moment() as unknown as MomentLike, t.stub.settings.dayStartHour)
      );

    // The clock is walked past midnight tick by tick: a jump of this size is
    // a sleep on the desktop, which pauses the session (F48).
    it("counts toward the day it started, the day its line is filed under", () => {
      const t = lifecycle();
      at(23, 50);
      t.timer.start();
      minutes(9);
      expect(liveToday(t)).toBe(540);
      minutes(15); // 00:14
      expect(t.timer.getState().isRunning).toBe(true);
      expect(liveToday(t)).toBe(0);
    });

    it("with the day starting at 4:00, 00:14 is still the day it started", () => {
      const t = lifecycle();
      t.stub.settings.dayStartHour = 4;
      at(23, 50);
      t.timer.start();
      minutes(24); // 00:14
      expect(liveToday(t)).toBe(1440);
    });

    // The long-break count turns over with the day the line is filed under —
    // the session's START. Dated by its end, the 4th focus of the day ran past
    // the turn and restarted the count at 1: a short break, its line in the
    // day before's file.
    it.each([
      ["23:50 to 00:15", 0, 23, 50, 2],
      ["03:50 to 04:15 with the day starting at 4:00", 4, 3, 50, 3],
    ])(
      "the long-break count takes the day a session started, as its line does: %s (F24)",
      async (_label, dayStartHour, h, m, day) => {
        const t = lifecycle();
        t.stub.settings.dayStartHour = dayStartHour as number;
        t.stub.settings.sessionsSinceLongBreak = 3;
        t.stub.settings.sessionCounterDate = "2026-10-02";
        at(h as number, m as number, 0, day as number);
        t.timer.start();
        minutes(25);
        await t.timer.finish();

        expect(t.lines()).toHaveLength(1); // filed under 2 October
        expect(t.stub.settings.sessionsSinceLongBreak).toBe(4);
        expect(t.stub.settings.sessionCounterDate).toBe("2026-10-02");
        expect(t.timer.getState().breakType).toBe("long");
      }
    );
  });

  describe("a computer asleep with the timer running (F48)", () => {
    const slept = (t: ReturnType<typeof lifecycle>) =>
      t.stub.calls.filter((c) => c.name === "notifySleepPause").map((c) => c.args[0]);

    it("pauses as it stood at the last tick, logs the gap as a pause, and says so", async () => {
      const t = lifecycle();
      at(22, 0);
      t.timer.start();
      minutes(10); // the last tick: 22:10
      at(6, 0, 0, 3); // the lid opens
      vi.advanceTimersByTime(50);

      expect(t.timer.getState()).toMatchObject({
        mode: "focus",
        isRunning: false,
        remainingMs: 15 * ONE_MINUTE_MS,
      });
      expect(slept(t)).toEqual([(7 * 60 + 50) * ONE_MINUTE_MS + 50]);

      t.timer.start();
      minutes(15); // runs out at 06:15
      await t.timer.finish();
      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Start")).toBe("2026-10-02 22:00:00");
      expect(t.field(line, "End")).toBe("2026-10-03 06:15:00");
      expect(t.field(line, "Pauses")).toBe(
        JSON.stringify(["2026-10-02 22:10:00 - 2026-10-03 06:00:00"])
      );
      expect(t.field(line, "Total")).toBe("1500");
      expect(t.field(line, "Overtime")).toBe("0");
    });

    // The decision: auto-start after a sleep ends the session at its planned
    // time (F11). Each edge reads the auto-start of the session that FOLLOWS.
    it.each([
      ["a focus with auto-start break on", "focus", true, false, "break"],
      ["a break with auto-start focus on", "break", false, true, "focus"],
    ])(
      "a sleep through the planned end of %s ends it there and starts the next on waking, saying nothing of sleep (F11)",
      async (_label, mode, autoStartBreak, autoStartFocus, next) => {
        const t = lifecycle();
        t.stub.settings.autoStartBreak = autoStartBreak as boolean;
        t.stub.settings.autoStartFocus = autoStartFocus as boolean;
        at(22, 0);
        t.timer.switchMode(mode as PomoMode, true);
        minutes(2); // the lid closes at 22:02
        at(6, 0, 0, 3);
        vi.advanceTimersByTime(100);
        await vi.advanceTimersByTimeAsync(0);

        const plannedEnd = mode === "focus" ? "2026-10-02 22:25:00" : "2026-10-02 22:05:00";
        const [line] = t.lines();
        expect(t.lines()).toHaveLength(1);
        expect(parseLogLine(line)?.kind).toBe(mode === "focus" ? "focus" : "rest");
        expect(t.field(line, "End")).toBe(plannedEnd);
        // No pause and no overtime: the whole planned length, nothing more.
        expect(t.field(line, "Total")).toBe(mode === "focus" ? "1500" : "300");
        expect(slept(t)).toEqual([]);
        expect(t.timer.getState()).toMatchObject({ mode: next, isRunning: true });
        expect(t.lm.openSessionDay()).toBe("2026-10-03");
      }
    );

    it.each([
      ["auto-start is off", false, false, 6, 0, 3],
      ["only the other edge's auto-start is on", false, true, 6, 0, 3],
      ["the lid opens before the planned end", true, false, 22, 20, 2],
    ])("pauses when %s", async (_label, autoStartBreak, autoStartFocus, h, m, day) => {
      const t = lifecycle();
      t.stub.settings.autoStartBreak = autoStartBreak as boolean;
      t.stub.settings.autoStartFocus = autoStartFocus as boolean;
      at(22, 0);
      t.timer.start();
      minutes(2); // the last tick: 22:02
      at(h as number, m as number, 0, day as number);
      vi.advanceTimersByTime(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(t.timer.getState()).toMatchObject({
        mode: "focus",
        isRunning: false,
        remainingMs: 23 * ONE_MINUTE_MS,
      });
      expect(t.lines()).toEqual([]);
      expect(slept(t)).toHaveLength(1);
      expect(t.stub.calls.some((c) => c.name === "notifySessionEnd")).toBe(false);
    });

    it("pauses a session already in overtime, auto-start turned on since: the sleep was not through its end", async () => {
      const t = lifecycle();
      at(22, 0);
      t.timer.start();
      minutes(30); // into overtime at 22:25, auto-start off then
      t.stub.settings.autoStartBreak = true;
      at(6, 0, 0, 3);
      vi.advanceTimersByTime(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(t.timer.getState()).toMatchObject({
        mode: "focus",
        isRunning: false,
        remainingMs: -5 * ONE_MINUTE_MS,
      });
      expect(t.lines()).toEqual([]);
      expect(slept(t)).toHaveLength(1);
    });

    // The end wake-up runs the same tick, so the same check. Without the
    // interval, the tick runs only when the test calls it.
    it.each([
      ["after a tick at 09:10, it pauses as it stood then", true],
      ["with no tick at all, the session never began: it is thrown away (F15)", false],
    ])("takes the end wake-up's path too: %s", (_label, ticked) => {
      let tick = () => {};
      vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
        tick = fn;
        return 0;
      }) as never);
      try {
        const t = lifecycle();
        t.timer.start(); // 09:00, the end wake-up armed for 09:25
        if (ticked) {
          at(9, 10);
          tick();
        }
        at(17, 0);
        vi.advanceTimersByTime(25 * ONE_MINUTE_MS + 10); // it fires at 17:25
        expect(t.timer.getState()).toMatchObject({
          isRunning: false,
          remainingMs: (ticked ? 15 : 25) * ONE_MINUTE_MS,
        });
        expect(t.lm.openSessionDay()).toBe(ticked ? "2026-10-02" : null);
        expect(slept(t)).toHaveLength(1);
        expect(t.stub.calls.some((c) => c.name === "notifySessionEnd")).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    });

    // F15: a session the lid closed on before its first tick. Paused from its
    // own start it looked never started, and the next Start — drum and all —
    // resumed it: Start 17:30 the day before, a night's pause, filed under
    // yesterday, so today's meter never counted it. Thrown away whatever the
    // next session's auto-start says: there is no planned end to keep.
    it.each([
      ["auto-start break off", false],
      ["auto-start break on", true],
    ])(
      "throws away an auto-started session slept through before its first tick; the next Start is fresh (%s, F15)",
      async (_label, autoStartBreak) => {
        const t = lifecycle();
        t.stub.settings.autoStartFocus = true;
        t.stub.settings.autoStartBreak = autoStartBreak;
        at(17, 25);
        t.timer.switchMode("break", true);
        minutes(5); // the break crosses at 17:30
        await vi.advanceTimersByTimeAsync(0); // the focus auto-starts, untouched by any tick
        expect(t.timer.getState()).toMatchObject({ mode: "focus", isRunning: true });

        at(6, 0, 0, 3); // the lid closed at 17:30 and opens now
        vi.advanceTimersByTime(50);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.timer.getState()).toMatchObject({
          mode: "focus",
          isRunning: false,
          remainingMs: 25 * ONE_MINUTE_MS,
          totalMs: 25 * ONE_MINUTE_MS,
        });
        expect(t.lm.openSessionDay()).toBeNull();
        expect(slept(t)).toHaveLength(1);

        t.timer.start();
        expect(t.played).toContain(DRUM);
        minutes(25);
        await vi.advanceTimersByTimeAsync(0); // with auto-start break on, the crossing ends it
        await t.timer.finish();

        expect(t.lines().map((l) => parseLogLine(l)?.kind)).toEqual(["rest"]);
        const [line] = t.lines(NEXT_LOG);
        expect(t.lines(NEXT_LOG)).toHaveLength(1);
        expect(t.field(line, "Start")).toBe("2026-10-03 06:00:00");
        expect(t.field(line, "Pauses")).toBe("[]");
        expect(t.field(line, "Total")).toBe("1500");
      }
    );

    it("a Start and Pause inside one tick, then a Start: a fresh session, not the paused one resumed (F15)", async () => {
      const t = lifecycle();
      at(10, 0);
      t.timer.start();
      t.timer.pause(); // the clock still shows full length
      at(14, 0);
      t.timer.start();
      minutes(25);
      await t.timer.finish();

      const [line] = t.lines();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(line, "Start")).toBe("2026-10-02 14:00:00");
      expect(t.field(line, "Pauses")).toBe("[]");
      expect(t.field(line, "Total")).toBe("1500");
    });

    it("leaves a phone or tablet alone: the session runs on through the gap", () => {
      Platform.isDesktopApp = false;
      try {
        const t = lifecycle();
        at(22, 0);
        t.timer.start();
        minutes(10);
        at(6, 0, 0, 3);
        vi.advanceTimersByTime(50);
        expect(t.timer.getState().isRunning).toBe(true);
        expect(t.timer.getState().remainingMs).toBeLessThan(0);
        expect(slept(t)).toEqual([]);
      } finally {
        Platform.isDesktopApp = true;
      }
    });

    it("needs MORE than 10 minutes between ticks: exactly 10 is not a sleep", () => {
      const t = lifecycle();
      t.timer.start(); // the loop starts at 09:00:00.000
      vi.setSystemTime(new Date(2026, 9, 2, 9, 9, 59, 950));
      vi.advanceTimersByTime(50); // the next tick: 09:10:00.000, 10 minutes on
      expect(t.timer.getState().isRunning).toBe(true);

      vi.setSystemTime(new Date(2026, 9, 2, 9, 19, 59, 951));
      vi.advanceTimersByTime(50); // 09:20:00.001, a millisecond more
      expect(t.timer.getState()).toMatchObject({
        isRunning: false,
        remainingMs: 15 * ONE_MINUTE_MS,
      });
      expect(slept(t)).toEqual([10 * ONE_MINUTE_MS + 1]);
    });

    // Chromium wakes a covered window's interval at most once a minute: three
    // hours of that must count in full, overtime included.
    it.each([
      ["once a minute, as Chromium ticks a covered window, never pauses", 60_000, true],
      ["every 11 minutes pauses at the first", 11 * 60_000, false],
    ])("a tick %s", (_label, every, running) => {
      const fakeInterval = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) =>
        fakeInterval(fn, every)) as never);
      try {
        const t = lifecycle();
        t.timer.start();
        minutes(180);
        expect(t.timer.getState().isRunning).toBe(running);
        expect(slept(t)).toHaveLength(running ? 0 : 1);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("Stop asks about a long focus past its plan (F48)", () => {
    it("asks about a 9h 47m focus, and Keep it all logs every minute of it", async () => {
      const t = lifecycle();
      const asked = asking(t, "keep");
      t.timer.setTask("Write docs", PATH, "abc123");
      t.timer.start();
      at(18, 47); // a machine awake all along: the press reads the end time
      await t.timer.finish();

      expect(asked).toEqual([
        {
          activeSeconds: 35_220,
          overtimeSeconds: 33_720,
          plannedEndAt: new Date(2026, 9, 2, 9, 25).getTime(),
        },
      ]);
      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 18:47:00");
      expect(t.field(line, "Total")).toBe("35220");
      expect(t.field(line, "Overtime")).toBe("33720");
      expect(t.timer.getState()).toMatchObject({ mode: "break", isRunning: false });
      expect(t.vault.contents[PATH]).toBe("- [ ] Write docs 🍅 1 🆔 abc123\n");
    });

    it("End at planned end logs the planned length, the pauses before it kept", async () => {
      const t = lifecycle();
      const asked = asking(t, "planned");
      t.timer.start();
      minutes(10);
      t.timer.pause();
      at(9, 40);
      t.timer.start(); // 15 minutes left: the planned end is now 09:55
      at(19, 0);
      await t.timer.finish();

      expect(asked[0].plannedEndAt).toBe(new Date(2026, 9, 2, 9, 55).getTime());
      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 09:55:00");
      expect(t.field(line, "Pauses")).toBe(
        JSON.stringify(["2026-10-02 09:10:00 - 2026-10-02 09:40:00"])
      );
      expect(t.field(line, "Total")).toBe("1500");
      expect(t.field(line, "Overtime")).toBe("0");
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(1);
    });

    // The line is written in whole seconds and the press is not: the planned
    // end must not move with the milliseconds of the Start and the Stop.
    it.each([
      ["the Stop's fraction below the Start's", 700, 200],
      ["the Stop's fraction above the Start's", 200, 700],
      ["a Start a hair before the second", 999, 0],
    ])("End at planned end ends exactly on the plan, %s (F20)", async (_label, startMs, stopMs) => {
      const t = lifecycle();
      const asked = asking(t, "planned");
      vi.setSystemTime(new Date(2026, 9, 2, 9, 0, 0, startMs as number));
      t.timer.start();
      vi.setSystemTime(new Date(2026, 9, 2, 17, 20, 0, stopMs as number));
      await t.timer.finish();

      expect(asked[0].plannedEndAt).toBe(new Date(2026, 9, 2, 9, 25).getTime());
      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 09:25:00");
      expect(t.field(line, "Scheduled")).toBe("1500");
      expect(t.field(line, "Total")).toBe("1500");
      expect(t.field(line, "Overtime")).toBe("0");
    });

    it("End at planned end follows +5: the plan is the clock's, not the setting's (F20)", async () => {
      const t = lifecycle();
      asking(t, "planned");
      t.timer.start();
      minutes(1);
      t.timer.addMinutes(5); // planned end 09:30
      at(17, 0);
      await t.timer.finish();

      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 09:30:00");
      expect(t.field(line, "Total")).toBe("1800");
      expect(t.field(line, "Overtime")).toBe("0");
    });

    it("closing the question cancels the Stop: nothing logged, the timer as it was", async () => {
      const t = lifecycle();
      asking(t, "cancel");
      t.timer.start();
      at(17, 0);
      const before = t.timer.getState();
      const session = t.timer.session;
      await t.timer.finish();

      expect(t.lines()).toEqual([]);
      expect(t.played).toEqual([DRUM]);
      expect(t.timer.getState()).toEqual(before);
      expect(t.timer.session).toBe(session);
      expect(t.lm.openSessionDay()).toBe("2026-10-02");

      asking(t, "keep");
      await t.timer.finish();
      expect(t.lines()).toHaveLength(1);
    });

    it.each([
      ["under the threshold", 6, 25, 5 * 60 + 59, "focus"],
      ["within its plan", 6, 8 * 60, 7 * 60, "focus"],
      ["for a break", 6, 25, 7 * 60, "break"],
      ["with the question off", 0, 25, 9 * 60, "focus"],
    ])("does not ask %s", async (_label, hours, plan, ran, mode) => {
      const t = lifecycle();
      const asked = asking(t, "planned");
      t.stub.settings.longSessionPromptHours = hours as number;
      t.stub.settings.focusMinutes = plan as number;
      t.stub.settings.breakMinutes = plan as number;
      t.timer.switchMode(mode as PomoMode, true);
      at(9 + Math.floor((ran as number) / 60), (ran as number) % 60);
      await t.timer.finish();
      expect(asked).toEqual([]);
      expect(t.lines()).toHaveLength(1);
    });

    it("asks from exactly the threshold", async () => {
      const t = lifecycle();
      const asked = asking(t, "keep");
      t.stub.settings.longSessionPromptHours = 2;
      t.timer.start();
      at(11, 0);
      await t.timer.finish();
      expect(asked).toEqual([
        expect.objectContaining({ activeSeconds: 7200, overtimeSeconds: 5700 }),
      ]);
    });

    it("holds no claim while open: Skip ends the session, and the answer then does nothing", async () => {
      const t = lifecycle();
      let answer = (_a: LongSessionAnswer) => {};
      const asked = asking(
        t,
        new Promise<LongSessionAnswer>((r) => {
          answer = r;
        })
      );
      t.timer.start();
      at(17, 0);
      const stop = t.timer.finish();
      expect(asked).toHaveLength(1);

      await t.timer.finish(); // a second Stop while it is open asks nothing
      expect(asked).toHaveLength(1);
      await t.timer.skip();
      expect(t.lines()).toHaveLength(1);
      expect(t.field(t.lines()[0], "Status")).toBe("cancelled");

      answer("keep");
      await stop;
      expect(t.lines()).toHaveLength(1);
      expect(t.timer.getState()).toMatchObject({ mode: "break", isRunning: false });
    });

    it("lets Pause through while it is open, and ends the session at the press", async () => {
      const t = lifecycle();
      let answer = (_a: LongSessionAnswer) => {};
      asking(
        t,
        new Promise<LongSessionAnswer>((r) => {
          answer = r;
        })
      );
      t.timer.start();
      at(17, 0);
      const stop = t.timer.finish();
      t.timer.pause();
      expect(t.timer.getState().isRunning).toBe(false);

      at(17, 5);
      answer("keep");
      await stop;
      const [line] = t.lines();
      expect(t.field(line, "End")).toBe("2026-10-02 17:00:00");
      expect(t.field(line, "Pauses")).toBe("[]");
      expect(t.field(line, "Total")).toBe("28800");
    });

    it("keeps it all when the question cannot be asked", async () => {
      const t = lifecycle();
      t.plugin.askAboutLongSession = () => Promise.reject(new Error("no dialog"));
      t.timer.start();
      at(17, 0);
      await t.timer.finish();
      expect(t.field(t.lines()[0], "Total")).toBe("28800");
    });
  });

  describe("a task switch mid-focus (F52)", () => {
    const TWO = "- [ ] Write docs 🆔 abc123\n- [ ] Review 🆔 rev456\n";
    const docs = (t: ReturnType<typeof lifecycle>) => t.timer.setTask("Write docs", PATH, "abc123");
    const review = (t: ReturnType<typeof lifecycle>) => t.timer.setTask("Review", PATH, "rev456");
    const split = (taskLines = TWO) => {
      const t = lifecycle(taskLines);
      t.stub.settings.taskSwitchLogging = "split";
      return t;
    };
    const fields = (t: ReturnType<typeof lifecycle>, ...keys: string[]) =>
      t.lines().map((line) => keys.map((key) => t.field(line, key)));

    it("by default gives the whole session to the task linked at the end", async () => {
      const t = lifecycle(TWO);
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      minutes(10);
      await t.timer.finish();

      expect(fields(t, "Task", "Start", "Total")).toEqual([
        [`[[${PATH}|Review]]`, "2026-10-02 09:00:00", "1800"],
      ]);
      expect(t.vault.contents[PATH]).toBe(
        "- [ ] Write docs 🆔 abc123\n- [ ] Review 🍅 1 🆔 rev456\n"
      );
    });

    it("split: a line per task, end to start; one 🍅, to the task linked at the end; one step", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      minutes(10);
      await t.timer.finish();

      expect(fields(t, "Task", "ID", "Start", "End", "Total", "Overtime")).toEqual([
        [
          `[[${PATH}|Write docs]]`,
          "abc123",
          "2026-10-02 09:00:00",
          "2026-10-02 09:20:00",
          "1200",
          "0",
        ],
        [
          `[[${PATH}|Review]]`,
          "rev456",
          "2026-10-02 09:20:00",
          "2026-10-02 09:30:00",
          "600",
          "300",
        ],
      ]);
      expect(fields(t, "Scheduled", "Status")).toEqual([
        ["1500", "finished"],
        ["1500", "finished"],
      ]);
      expect(t.vault.contents[PATH]).toBe(
        "- [ ] Write docs 🆔 abc123\n- [ ] Review 🍅 1 🆔 rev456\n"
      );
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(1);
    });

    it("split: Skip writes every line cancelled, with no 🍅 and no step", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      minutes(3);
      await t.timer.skip();

      expect(fields(t, "Task", "Start", "End", "Total", "Status")).toEqual([
        [
          `[[${PATH}|Write docs]]`,
          "2026-10-02 09:00:00",
          "2026-10-02 09:20:00",
          "1200",
          "cancelled",
        ],
        [`[[${PATH}|Review]]`, "2026-10-02 09:20:00", "2026-10-02 09:23:00", "180", "cancelled"],
      ]);
      expect(t.vault.contents[PATH]).toBe(TWO);
      expect(t.stub.settings.sessionsSinceLongBreak).toBe(0);
    });

    it("split: the overtime goes to the last minutes, back over the switch", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(28);
      review(t);
      minutes(2);
      await t.timer.finish();
      expect(fields(t, "Total", "Overtime")).toEqual([
        ["1680", "180"],
        ["120", "120"],
      ]);
    });

    it.each([
      [59_000, [[`[[${PATH}|Review]]`, "2026-10-02 09:00:00", "1259"]]],
      [
        60_000,
        [
          [`[[${PATH}|Write docs]]`, "2026-10-02 09:00:00", "60"],
          [`[[${PATH}|Review]]`, "2026-10-02 09:01:00", "1200"],
        ],
      ],
    ])("split: a switch %s ms in", async (first, expected) => {
      // Under a minute, those seconds go to the next task, as by default.
      const t = split();
      docs(t);
      t.timer.start();
      vi.advanceTimersByTime(first);
      review(t);
      minutes(20);
      await t.timer.finish();
      expect(fields(t, "Task", "Start", "Total")).toEqual(expected);
    });

    it("split: a last task under a minute joins the line before, and still takes the 🍅", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      vi.advanceTimersByTime(30_000);
      await t.timer.finish();
      expect(fields(t, "Task", "End", "Total")).toEqual([
        [`[[${PATH}|Write docs]]`, "2026-10-02 09:20:30", "1230"],
      ]);
      expect(t.vault.contents[PATH]).toBe(
        "- [ ] Write docs 🆔 abc123\n- [ ] Review 🍅 1 🆔 rev456\n"
      );
    });

    it("split: a pause across the switch is split between the lines", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(10);
      t.timer.pause();
      at(9, 15);
      review(t);
      at(9, 20);
      t.timer.start();
      minutes(10);
      await t.timer.finish();
      expect(fields(t, "Task", "Start", "End", "Pauses", "Total")).toEqual([
        [
          `[[${PATH}|Write docs]]`,
          "2026-10-02 09:00:00",
          "2026-10-02 09:15:00",
          JSON.stringify(["2026-10-02 09:10:00 - 2026-10-02 09:15:00"]),
          "600",
        ],
        [
          `[[${PATH}|Review]]`,
          "2026-10-02 09:15:00",
          "2026-10-02 09:30:00",
          JSON.stringify(["2026-10-02 09:15:00 - 2026-10-02 09:20:00"]),
          "600",
        ],
      ]);
    });

    it("split: Reset throws every segment away", async () => {
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      minutes(5);
      t.timer.reset();
      minutes(25);
      await t.timer.finish();
      expect(fields(t, "Task", "Start", "Total")).toEqual([
        [`[[${PATH}|Review]]`, "2026-10-02 09:25:00", "1500"],
      ]);
    });

    it("split: the linked task renamed is not a switch", async () => {
      const t = split("- [ ] Write docs 🆔 abc123\n");
      docs(t);
      t.timer.start();
      minutes(20);
      await t.edit("- [ ] Write the docs 🆔 abc123\n");
      minutes(10);
      await t.timer.finish();
      expect(fields(t, "Task", "Start", "Total")).toEqual([
        [`[[${PATH}|Write the docs]]`, "2026-10-02 09:00:00", "1800"],
      ]);
    });

    it("split: every line takes its own task's name as the note has it now", async () => {
      // Renamed in the note with no modify event reaching the timer (an edit
      // synced from another device): the 🆔 lookup at the write still finds
      // both, the first line's and the last's.
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      review(t);
      minutes(10);
      await t.vault.process(
        t.vault.getAbstractFileByPath(PATH) as TFile,
        () => "- [ ] Write the docs 🆔 abc123\n- [ ] Review the PR 🆔 rev456\n"
      );
      await t.timer.finish();
      expect(fields(t, "Task")).toEqual([
        [`[[${PATH}|Write the docs]]`],
        [`[[${PATH}|Review the PR]]`],
      ]);
    });

    it("split: picking the SAME task again is not a switch", async () => {
      // Re-picking the linked task after a minute or more must not close a
      // segment: one session, one line, or the review's per-line session
      // count goes up for a session that never changed task.
      const t = split();
      docs(t);
      t.timer.start();
      minutes(20);
      docs(t);
      minutes(10);
      await t.timer.finish();
      expect(fields(t, "Task", "Start", "Total")).toEqual([
        [`[[${PATH}|Write docs]]`, "2026-10-02 09:00:00", "1800"],
      ]);
    });

    it("split: a pick during a break makes no segment", async () => {
      const t = split();
      t.timer.switchMode("break", true);
      minutes(3);
      docs(t);
      minutes(3);
      await t.timer.skip();
      expect(t.lines()).toHaveLength(1);
      expect(parseLogLine(t.lines()[0])?.kind).toBe("rest");
    });

    it("split: End at planned end drops the task picked after it", async () => {
      const t = split();
      asking(t, "planned");
      t.stub.settings.longSessionPromptHours = 2;
      docs(t);
      t.timer.start();
      minutes(28);
      review(t);
      at(11, 30);
      await t.timer.finish();
      expect(fields(t, "Task", "End", "Total", "Overtime")).toEqual([
        [`[[${PATH}|Write docs]]`, "2026-10-02 09:25:00", "1500", "0"],
      ]);
    });
  });

  it("a length changed mid-session waits for the next session, log included (F17)", async () => {
    const t = lifecycle();
    t.timer.start();
    minutes(10);
    t.stub.settings.focusMinutes = 50;
    t.timer.updateDuration("focusMinutes");
    minutes(15); // the session still runs out at 09:25
    expect(t.timer.getState().remainingMs).toBeLessThanOrEqual(0);
    await t.timer.finish();
    await t.timer.finish(); // the break, never started: no line
    at(10, 0);
    t.timer.start();
    minutes(50);
    await t.timer.finish();

    const lines = t.lines();
    expect(lines.map((l) => t.field(l, "Scheduled"))).toEqual(["1500", "3000"]);
    expect(lines.map((l) => t.field(l, "Overtime"))).toEqual(["0", "0"]);
  });

  it("cancel() is gone: it ended a session without claiming the end (F60)", () => {
    const t = lifecycle();
    expect((t.timer as unknown as { cancel?: unknown }).cancel).toBeUndefined();
  });
});

describe("'No Task' is a name, never the unlinked test (F36)", () => {
  it("no source decides 'linked' by comparing a name with NO_TASK_LABEL", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const codeOnly = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const sources = readdirSync(root).filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts"));
    expect(sources).toContain("GentlePomoView.ts");
    for (const name of sources) {
      const code = codeOnly(readFileSync(resolve(root, name), "utf8"));
      expect(code, name).not.toMatch(/[!=]==\s*NO_TASK_LABEL|NO_TASK_LABEL\s*[!=]==/);
    }
  });
});
