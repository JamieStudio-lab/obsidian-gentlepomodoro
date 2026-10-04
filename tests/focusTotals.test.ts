import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  FocusTotalTracker,
  GoalNotice,
  NO_LOG_FOLDER_HINT,
  panelGoalText,
  focusGoalText,
  formatHoursMinutes,
  liveFocusSeconds,
  liveFocusSecondsToday,
  type FocusTotalHost,
  type GoalNoticeHost,
} from "../focusTotals";
import { FOCUS_TOTAL_CACHE_TTL_MS, FOCUS_TOTAL_READ_TIMEOUT_MS } from "../constants";
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
  /** Timers on the harness's own clock: `elapse` runs the ones that come due. */
  timers: { callback: () => void; due: number; cancelled: boolean }[] = [];
  setTimer(callback: () => void, ms: number): () => void {
    const timer = { callback, due: this.clock + ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  async elapse(ms: number): Promise<void> {
    this.clock += ms;
    for (const timer of this.timers) {
      if (!timer.cancelled && timer.due <= this.clock) {
        timer.cancelled = true;
        timer.callback();
      }
    }
    // Let the promise chain the timers settled run.
    for (let i = 0; i < 5; i++) await Promise.resolve();
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

  it("never goes negative when remaining time exceeds the total", () => {
    // A system clock stepped back raises remainingMs above totalMs. A negative
    // here would subtract from the logged total it is added to.
    expect(liveFocusSeconds(state({ remainingMs: 30 * 60 * 1000, totalMs: 25 * 60 * 1000 }))).toBe(
      0
    );
  });
});

describe("liveFocusSecondsToday (F8)", () => {
  const running = state({ remainingMs: 1 * 60 * 1000 }); // 24 minutes in

  it("counts a session that started today", () => {
    expect(liveFocusSecondsToday(running, "2026-10-03", "2026-10-03")).toBe(1440);
  });

  it("counts nothing of one that started on an earlier day: its line goes in that day's file", () => {
    expect(liveFocusSecondsToday(running, "2026-10-02", "2026-10-03")).toBe(0);
  });

  it("is liveFocusSeconds when the log holds no open session", () => {
    expect(liveFocusSecondsToday(running, null, "2026-10-03")).toBe(1440);
    expect(liveFocusSecondsToday(state({ mode: "break", remainingMs: 0 }), null, "x")).toBe(0);
  });

  it("is what main.ts adds to the logged total, with the log's day on both sides", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");
    expect(main).toContain(
      "return ( this.focusTotals.loggedSeconds() + liveFocusSecondsToday(state, this.logManager.openSessionDay(), this.logicalToday()) );"
    );
    expect(main).not.toMatch(/\bliveFocusSeconds\(/);
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
    // Caught inside (C4): every caller is `void`, so a rejection out of here
    // was an unhandled rejection on every tick.
    await expect(failing.tracker.refresh()).resolves.toBeUndefined();
    failing.fetchLoggedSeconds = () => Promise.resolve(900);
    failing.clock += FOCUS_TOTAL_CACHE_TTL_MS;
    await failing.tracker.refresh();
    expect(failing.tracker.loggedSeconds()).toBe(900);
  });
});

describe("a read that fails or hangs (C4)", () => {
  it("does not read again on every tick after a failure, even on a stale day", async () => {
    // The day stamp bypasses the TTL, and the stamp is only set on success, so
    // a failing read was retried on every 50 ms emit.
    let reads = 0;
    h.fetchLoggedSeconds = () => {
      reads++;
      return Promise.reject(new Error("EACCES"));
    };
    for (let i = 0; i < 20; i++) {
      await h.tracker.refresh();
      h.clock += 50;
    }
    expect(reads).toBe(1);
  });

  it("tries again once the TTL has passed, and at once after a write", async () => {
    let reads = 0;
    h.fetchLoggedSeconds = () => {
      reads++;
      return Promise.reject(new Error("EACCES"));
    };
    await h.tracker.refresh();
    h.clock += FOCUS_TOTAL_CACHE_TTL_MS - 1;
    await h.tracker.refresh();
    expect(reads).toBe(1);
    h.clock += 1;
    await h.tracker.refresh();
    expect(reads).toBe(2);
    h.tracker.invalidate();
    await h.tracker.refresh();
    expect(reads).toBe(3);
  });

  it("gives up on a read that never settles, so the next one can run", async () => {
    // An iCloud placeholder, a stuck read on a phone: the in-flight guard was
    // held for good, and the meter and the goal notice stopped until restart.
    h.pending = true;
    const first = h.tracker.refresh();
    await h.elapse(FOCUS_TOTAL_READ_TIMEOUT_MS - 1);
    void h.tracker.refresh();
    expect(h.fetches).toBe(1);
    await h.elapse(1);
    await first;

    // Waits out the TTL like any failure, then reads afresh.
    h.pending = false;
    h.logged = 1200;
    await h.tracker.refresh();
    expect(h.fetches).toBe(1);
    h.clock += FOCUS_TOTAL_CACHE_TTL_MS;
    await h.tracker.refresh();
    expect(h.fetches).toBe(2);
    expect(h.tracker.loggedSeconds()).toBe(1200);
  });

  it("gives a read about ten seconds, and gives up before the next is due", () => {
    // Too short fails a slow but healthy read (a phone, a file iCloud is
    // fetching); too long keeps the meter and the goal notice waiting. Under
    // the TTL, so a hung read is over before the next refresh would run.
    expect(FOCUS_TOTAL_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(FOCUS_TOTAL_READ_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(FOCUS_TOTAL_READ_TIMEOUT_MS).toBeLessThan(FOCUS_TOTAL_CACHE_TTL_MS);
  });

  it("drops the late answer of a read it gave up on", async () => {
    h.pending = true;
    const first = h.tracker.refresh();
    await h.elapse(FOCUS_TOTAL_READ_TIMEOUT_MS);
    await first;
    await h.finish(9000);
    expect(h.landed).toEqual([]);
    expect(h.goalChecks).toEqual([]);
    expect(h.tracker.loggedSeconds()).toBe(0);
  });

  it("cancels the timeout when the read lands in time", async () => {
    await h.tracker.refresh();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].cancelled).toBe(true);
  });

  it("does not let a failing repaint escape either", async () => {
    h.onLanded = () => {
      throw new Error("view gone");
    };
    await expect(h.tracker.refresh()).resolves.toBeUndefined();
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

describe("the panel's goal line with no log folder (F5)", () => {
  it("says no log folder is set, and nothing else changes", () => {
    expect(panelGoalText("Today 0h 24m / 2h 0m", "")).toBe(
      `Today 0h 24m / 2h 0m · ${NO_LOG_FOLDER_HINT}`
    );
    expect(panelGoalText("Today 0h 24m / 2h 0m", "  ")).toContain(NO_LOG_FOLDER_HINT);
    expect(panelGoalText("Today 0h 24m / 2h 0m", "Logs")).toBe("Today 0h 24m / 2h 0m");
  });

  it("is what main.ts shows in every panel, from both of the paths that paint it", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");
    expect(main).toContain(
      "view.setGoalProgress(panelGoalText(text, this.settings.logFolderPath), met);"
    );
    expect(main).toContain(
      "leaf.view.setGoalProgress(panelGoalText(totalText, this.settings.logFolderPath), goalMet);"
    );
    expect(main.match(/setGoalProgress\(/g)).toHaveLength(2);
  });
});

describe("the goal notice checks data.json first (C5)", () => {
  /** One device: its own flag, and what data.json on disk says. */
  function device(stored: unknown, lastHit: string | null = null) {
    const fired: string[] = [];
    const adopted: string[] = [];
    const host: GoalNoticeHost & {
      day: string;
      flag: string | null;
      disk: unknown;
      reads: number;
    } = {
      day: "2026-10-02",
      flag: lastHit,
      disk: stored,
      reads: 0,
      goalMinutes: () => 120,
      noticeEnabled: () => true,
      lastGoalHitDate: () => host.flag,
      storedGoalHitDate: () => {
        host.reads++;
        return Promise.resolve(host.disk);
      },
      today: () => host.day,
      adopt: (date) => {
        adopted.push(date);
        host.flag = date;
      },
      fire: (date) => {
        fired.push(date);
        host.flag = date;
      },
    };
    return { host, notice: new GoalNotice(host), fired, adopted };
  }

  it("fires when the goal is crossed and no device has said so today", async () => {
    const d = device("2026-10-01");
    await d.notice.check(7200);
    expect(d.fired).toEqual(["2026-10-02"]);
  });

  it("does not fire when another device already did today: it takes that device's flag", async () => {
    // The idle laptop fired its own notice a minute after the desktop's, then
    // saved its whole stale settings object over data.json.
    const d = device("2026-10-02");
    await d.notice.check(7200);
    expect(d.fired).toEqual([]);
    expect(d.adopted).toEqual(["2026-10-02"]);
    // Taken: the next landing asks nothing more.
    await d.notice.check(7300);
    expect(d.host.reads).toBe(1);
  });

  it("reads nothing below the goal, or once this device has fired", async () => {
    const below = device("2026-10-01");
    await below.notice.check(7199);
    const done = device("2026-10-01", "2026-10-02");
    await done.notice.check(9000);
    expect(below.host.reads + done.host.reads).toBe(0);
    expect(below.fired.concat(done.fired)).toEqual([]);
  });

  it("decides on what this device knows when data.json cannot be read", async () => {
    const d = device(undefined);
    d.host.storedGoalHitDate = () => Promise.reject(new Error("locked"));
    await d.notice.check(7200);
    expect(d.fired).toEqual(["2026-10-02"]);
  });

  it("fires once for two landings that arrive while data.json is being read, reading it once", async () => {
    const d = device(null);
    await Promise.all([d.notice.check(7200), d.notice.check(7300)]);
    expect(d.fired).toEqual(["2026-10-02"]);
    expect(d.host.reads).toBe(1);
  });

  it("does not fire for a day that ended while data.json was read", async () => {
    const d = device(null);
    d.host.storedGoalHitDate = () => {
      d.host.day = "2026-10-03";
      return Promise.resolve(null);
    };
    await d.notice.check(7200);
    expect(d.fired).toEqual([]);
  });

  it("is what main.ts wires: data.json's own flag, read through the settings store", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");
    expect(main).toContain(
      'storedGoalHitDate: () => this.settingsStore.storedValue("lastGoalHitDate"),'
    );
    expect(main).toContain("void this.goalNotice.check(loggedSeconds);");
    expect(main).toContain("today: () => this.logicalToday(),");
  });

  it("is what main.ts does with the answer: adopt takes the flag, fire shows, sets and saves it", () => {
    // Read as text: main.ts cannot be imported by a test (vitest would load
    // the built main.js, which needs a real Obsidian). The fake host above
    // sets its own flag, so these two bodies are what nothing else checks.
    // Broken, adopt or fire leaves the flag unset and the notice repeats on
    // every landing; adopt saving would write this device's settings, loaded
    // hours ago, over the newer data.json the flag was just read from.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const main = readFileSync(resolve(root, "main.ts"), "utf8").replace(/\s+/g, " ");
    const start = main.indexOf("private createGoalNoticeHost(): GoalNoticeHost {");
    expect(start).toBeGreaterThan(-1);
    const host = main.slice(start, main.indexOf("private logicalToday()", start));

    expect(host).toContain("adopt: (date) => { this.settings.lastGoalHitDate = date; },");

    const fire = host.slice(host.indexOf("fire: (date) => {"), host.indexOf("}, }; }"));
    const notice = fire.indexOf("new Notice(`[GentlePomo] Daily focus goal hit: ${goalHm}`);");
    const flag = fire.indexOf("this.settings.lastGoalHitDate = date;");
    const save = fire.indexOf("void this.saveSettings();");
    expect(notice).toBeGreaterThan(-1);
    // The flag is set before the save: the save writes the settings as they are.
    expect(flag).toBeGreaterThan(notice);
    expect(save).toBeGreaterThan(flag);
  });
});
