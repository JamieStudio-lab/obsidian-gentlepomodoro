import { describe, it, expect, beforeEach } from "vitest";
import {
  FocusTotalTracker,
  focusGoalText,
  formatHoursMinutes,
  liveFocusSeconds,
  type FocusTotalHost,
} from "../focusTotals";
import { FOCUS_TOTAL_CACHE_TTL_MS } from "../constants";
import type { TimerState } from "../types";

function state(overrides: Partial<TimerState> = {}): TimerState {
  return {
    mode: "focus",
    isRunning: true,
    remainingMs: 25 * 60 * 1000,
    totalMs: 25 * 60 * 1000,
    taskName: "No task",
    ...overrides,
  } as TimerState;
}

class Harness implements FocusTotalHost {
  clock = 1_700_000_000_000;
  date = "2026-08-27";
  logged = 0;
  fetches = 0;
  landed: number[] = [];
  goalChecks: number[] = [];
  /** Set to hold the next read open, so the in-flight guard can be observed. */
  private release: ((value: number) => void) | null = null;
  pending = false;

  readonly tracker = new FocusTotalTracker(this);

  now(): number {
    return this.clock;
  }
  today(): string {
    return this.date;
  }
  fetchLoggedSeconds(): Promise<number> {
    this.fetches++;
    if (!this.pending) return Promise.resolve(this.logged);
    return new Promise<number>((resolve) => {
      this.release = resolve;
    });
  }
  onLanded(loggedSeconds: number): void {
    this.landed.push(loggedSeconds);
  }
  checkGoalNotice(loggedSeconds: number): void {
    this.goalChecks.push(loggedSeconds);
  }

  /** Let a held read finish. */
  finish(value = this.logged): Promise<void> {
    this.release?.(value);
    this.release = null;
    return Promise.resolve();
  }
}

describe("liveFocusSeconds", () => {
  it("counts elapsed focus time", () => {
    expect(liveFocusSeconds(state({ remainingMs: 24 * 60 * 1000 }))).toBe(60);
  });

  it("is zero outside a focus session", () => {
    expect(liveFocusSeconds(state({ mode: "break", remainingMs: 0 }))).toBe(0);
  });

  it("is zero for a focus session sitting untouched at full duration", () => {
    // Not started is not "no time in it" — it must not read as a fresh session
    // that has somehow elapsed nothing.
    expect(liveFocusSeconds(state({ isRunning: false }))).toBe(0);
  });

  it("counts a paused session that has actually run", () => {
    expect(liveFocusSeconds(state({ isRunning: false, remainingMs: 20 * 60 * 1000 }))).toBe(300);
  });

  it("keeps counting into overtime", () => {
    expect(liveFocusSeconds(state({ remainingMs: -5000 }))).toBe(25 * 60 + 5);
  });

  it("never goes negative when the duration is shortened under a running session", () => {
    // remainingMs can exceed totalMs after the duration is changed mid-session.
    // A negative here would subtract from the logged total it is added to.
    expect(liveFocusSeconds(state({ remainingMs: 30 * 60 * 1000, totalMs: 25 * 60 * 1000 }))).toBe(
      0
    );
  });
});

describe("goal text", () => {
  it("shows the total alone when no goal is set", () => {
    expect(focusGoalText(4800, 0)).toEqual({ text: "Today 1h 20m", met: false });
  });

  it("shows the total against the goal, and whether it is met", () => {
    expect(focusGoalText(4800, 120)).toEqual({ text: "Today 1h 20m / 2h 0m", met: false });
    expect(focusGoalText(7200, 120).met).toBe(true);
  });

  it("counts the goal as met exactly on the boundary", () => {
    expect(focusGoalText(7199, 120).met).toBe(false);
    expect(focusGoalText(7200, 120).met).toBe(true);
  });

  it("floors to whole minutes", () => {
    expect(formatHoursMinutes(0)).toBe("0h 0m");
    expect(formatHoursMinutes(59)).toBe("0h 0m");
    expect(formatHoursMinutes(3599)).toBe("0h 59m");
    expect(formatHoursMinutes(3600)).toBe("1h 0m");
  });
});

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe("the cache", () => {
  it("reads once and then serves the cached total", async () => {
    h.logged = 1200;
    await h.tracker.refresh();
    expect(h.tracker.loggedSeconds()).toBe(1200);
    await h.tracker.refresh();
    expect(h.fetches).toBe(1);
  });

  it("re-reads once the TTL has passed", async () => {
    await h.tracker.refresh();
    h.clock += FOCUS_TOTAL_CACHE_TTL_MS + 1;
    await h.tracker.refresh();
    expect(h.fetches).toBe(2);
  });

  it("re-reads at once when a log line was just written", async () => {
    await h.tracker.refresh();
    h.tracker.invalidate();
    await h.tracker.refresh();
    expect(h.fetches).toBe(2);
  });

  it("does not start a second read while one is in the air", async () => {
    h.pending = true;
    const first = h.tracker.refresh();
    h.tracker.invalidate();
    void h.tracker.refresh();
    expect(h.fetches).toBe(1);
    await h.finish(600);
    await first;
    expect(h.tracker.loggedSeconds()).toBe(600);
  });

  it("clears the in-flight guard when a read throws, rather than freezing forever", async () => {
    const failing = new Harness();
    failing.fetchLoggedSeconds = () => Promise.reject(new Error("vault unreadable"));
    await expect(failing.tracker.refresh()).rejects.toThrow("vault unreadable");
    failing.fetchLoggedSeconds = () => Promise.resolve(900);
    await failing.tracker.refresh();
    expect(failing.tracker.loggedSeconds()).toBe(900);
  });
});

describe("midnight (the 0.5.2 family)", () => {
  it("reads 0 for a base stamped with another day, without waiting for the TTL", async () => {
    h.logged = 5400;
    await h.tracker.refresh();
    expect(h.tracker.loggedSeconds()).toBe(5400);
    // The app was left open across local midnight. Yesterday's hours must not
    // be what the meter shows on the first tick of the new day.
    h.date = "2026-08-28";
    expect(h.tracker.loggedSeconds()).toBe(0);
  });

  it("re-reads on the day boundary even inside the TTL", async () => {
    await h.tracker.refresh();
    h.date = "2026-08-28";
    h.logged = 300;
    await h.tracker.refresh(); // no clock movement at all
    expect(h.fetches).toBe(2);
    expect(h.tracker.loggedSeconds()).toBe(300);
  });

  it("stamps the base with the day the read was started for", async () => {
    // Resolved before the await, so a midnight crossing during the read cannot
    // label yesterday's file with today's date — which would then look fresh.
    h.pending = true;
    h.logged = 5400;
    const first = h.tracker.refresh();
    h.date = "2026-08-28"; // midnight passes while the file is being read
    await h.finish(5400);
    await first;
    expect(h.tracker.loggedSeconds()).toBe(0);
  });

  it("does not feed yesterday's total to the goal check", async () => {
    // The once-per-day notice is not reversible: firing it off yesterday's
    // hours consumes the flag and silences the real goal hit later today.
    h.pending = true;
    const first = h.tracker.refresh();
    h.date = "2026-08-28";
    await h.finish(9000);
    await first;
    expect(h.goalChecks).toEqual([]);
    // ...and the stale stamp means the next beat re-reads with the new day.
    h.pending = false;
    h.logged = 120;
    await h.tracker.refresh();
    expect(h.goalChecks).toEqual([120]);
  });

  it("checks the goal on every landing that stays inside its own day", async () => {
    h.logged = 3600;
    await h.tracker.refresh();
    expect(h.goalChecks).toEqual([3600]);
    h.tracker.invalidate();
    h.logged = 7200;
    await h.tracker.refresh();
    expect(h.goalChecks).toEqual([3600, 7200]);
  });

  it("repaints on every landing, including one that crossed midnight", async () => {
    // Painting a stale number for a moment is harmless and self-correcting,
    // which is why this is not gated the way the goal check is.
    h.pending = true;
    const first = h.tracker.refresh();
    h.date = "2026-08-28";
    await h.finish(9000);
    await first;
    expect(h.landed).toEqual([9000]);
  });
});
