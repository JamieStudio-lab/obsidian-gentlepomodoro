import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { TimerEngine } from "../TimerEngine";
import { DEFAULT_SETTINGS } from "../constants";
import type { TimerState } from "../types";

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
        vault: {
          getAbstractFileByPath: () => null,
        },
      },
      manifest: { dir: null },
      saveSettings: async () => {},
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

    timer.updateDuration("focus", 40);
    const s = timer.getState();
    expect(s.totalMs).toBe(40 * ONE_MINUTE_MS);
    expect(s.remainingMs).toBe(40 * ONE_MINUTE_MS);
  });

  it("does NOT affect remainingMs of a different mode", () => {
    const stub = makePluginStub({ focusMinutes: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = new TimerEngine(stub.plugin as any);

    const before = timer.getState();
    timer.updateDuration("break", 10);
    const after = timer.getState();
    expect(after.totalMs).toBe(before.totalMs); // still focus mode
  });
});
