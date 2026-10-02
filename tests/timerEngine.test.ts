import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TFile } from "obsidian";
import moment from "moment";
import { TimerEngine } from "../TimerEngine";
import { LogManager } from "../logManager";
import { DEFAULT_SETTINGS, NO_TASK_LABEL } from "../constants";
import { TASK_LINE_REGEX, normalizeTaskText, parsePomodoroCount } from "../taskLoader";
import type { TimerState } from "../types";
import { fakeVault } from "./fakeVault";

// TimerEngine uses `window.setInterval` / `window.clearInterval`. In Node those
// live on globalThis, so we just alias window -> globalThis for the test run.
beforeAll(() => {
  if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
  // Some TimerEngine paths read moment(). Stub it minimally if not already present.
  const g = globalThis as unknown as { moment?: unknown };
  if (typeof g.moment === "undefined") {
    g.moment = () => ({
      format: (_fmt: string) => "2025-05-18", // fixed "today" for deterministic tests
    });
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
}

function makePluginStub(opts: PluginStubOptions = {}) {
  const calls: LogCall[] = [];
  const record = (name: string) => {
    return (...args: unknown[]) => {
      calls.push({ name, args });
    };
  };
  const recordAsync = (name: string) => {
    return async (...args: unknown[]) => {
      calls.push({ name, args });
    };
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
        endSession: recordAsync("endSession"),
        updateTask: record("updateTask"),
      },
      app: {
        vault: opts.vault ?? {
          getAbstractFileByPath: () => null,
        },
      },
      manifest: { dir: null },
      saveSettings: async () => {},
      notifySessionEnd: record("notifySessionEnd"),
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
      if (endSessions > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finishWrite = resolve;
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

  it("counts and unlinks its own ticked line before another that differs only by the count", async () => {
    // The linked task was ticked during the session; another open task reads
    // the same once the count is left out. The exact line is the linked one.
    const other = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, timer } = counting(`${other}\n- [ ] Write docs 🍅 1 ⏳ 2026-10-01\n`);
    link(timer, "- [ ] Write docs 🍅 1 ⏳ 2026-10-01");
    vault.contents[PATH] = `${other}\n- [x] Write docs 🍅 1 ⏳ 2026-10-01 ✅ 2026-10-02\n`;

    await timer.finish();

    expect(vault.contents[PATH]).toBe(
      `${other}\n- [x] Write docs 🍅 2 ⏳ 2026-10-01 ✅ 2026-10-02\n`
    );
    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
  });

  it("unlinks a task ticked after a count it did not make", async () => {
    // A count from another device arrives by sync; the timer never followed
    // it, so only the count-free key still finds the line once it is ticked.
    const line = "- [ ] Write docs ⏳ 2026-10-01";
    const { vault, timer } = counting(`${line}\n`);
    link(timer, line);
    vault.contents[PATH] = "- [x] Write docs 🍅 3 ⏳ 2026-10-01 ✅ 2026-10-02\n";

    const file = vault.getAbstractFileByPath(PATH);
    if (!file) throw new Error("fixture note missing");
    await timer.onFileModify(file);

    expect(timer.getState().taskName).toBe(NO_TASK_LABEL);
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
    vi.useFakeTimers({ toFake: ["Date"] });
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
    /** The user (or sync) changes the task's line. */
    const edit = async (next: string) => {
      await vault.process(note, () => `${next}\n`);
      await settle();
    };
    /** One focus session, logged and counted, then the break (not started, so not logged). */
    const session = async () => {
      timer.start();
      await timer.finish();
      await settle();
      await timer.finish();
      await settle();
    };
    return { vault, timer, settle, edit, session, note };
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
    timer.reset();
    timer.start();
    timer.pause();
    expect(timer.session).toBe(first);
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

  it("moves only the total of a session already under way, and tells the listeners", () => {
    vi.useFakeTimers();
    try {
      const stub = makePluginStub({ focusMinutes: 25 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timer = new TimerEngine(stub.plugin as any);
      timer.start();
      vi.advanceTimersByTime(60_000);
      timer.pause();
      const remaining = timer.getState().remainingMs;
      expect(remaining).toBeLessThan(25 * ONE_MINUTE_MS);

      let emitted = 0;
      timer.onChange(() => emitted++);
      emitted = 0; // onChange replays the current state once on subscribe
      stub.settings.focusMinutes = 30;
      timer.updateDuration("focusMinutes");

      const s = timer.getState();
      expect(s.totalMs).toBe(30 * ONE_MINUTE_MS);
      expect(s.remainingMs, "time already spent is kept").toBe(remaining);
      expect(emitted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
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

    timer.reset(); // visible in overtime, and clears the flag
    stub.settings.focusEndSoundEnabled = false; // second crossing is silent
    vi.advanceTimersByTime(61_000);
    expect(played).toEqual([DRUM, BELL]);

    await timer.finish();
    expect(played).toEqual([DRUM, BELL, BELL]); // silent without the reset() clear
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
      new Promise<void>((resolve) => {
        gate.release = resolve;
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
