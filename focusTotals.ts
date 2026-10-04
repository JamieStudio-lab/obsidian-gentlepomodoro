import { FOCUS_TOTAL_CACHE_TTL_MS, FOCUS_TOTAL_READ_TIMEOUT_MS } from "./constants";
import { effectiveFocusBaseSeconds, shouldFireGoalNotice } from "./logManager";
import { logger } from "./logger";
import type { TimerState } from "./types";

/**
 * Seconds of focus elapsed in the session running right now. Zero outside a
 * focus session, and never negative — a system clock stepped back can leave
 * `remainingMs` above `totalMs` (the tick reads it off the end time), and a
 * negative contribution would subtract from the logged total the caller adds
 * this to. (Changing the length mid-session no longer can: since 0.6.9 a
 * session under way keeps its length.)
 */
export function liveFocusSeconds(state: TimerState): number {
  if (state.mode !== "focus") return 0;
  // An untouched session reads as zero through the arithmetic below anyway
  // (remaining === total means nothing elapsed); stated here because that is
  // the intent, not a coincidence worth rediscovering.
  if (!state.isRunning && state.remainingMs === state.totalMs) return 0;
  const elapsedMs = state.totalMs - state.remainingMs;
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

/**
 * The live seconds that count toward TODAY's total. A session is filed under
 * the day it STARTED (its log line goes in that day's file), so one that began
 * on an earlier day adds nothing to today — counting it made the meter climb
 * past midnight and then drop at Stop, when the line landed in yesterday's
 * file (F8). `sessionDay` is the open session's day from LogManager; null when
 * the log holds none, which changes nothing.
 */
export function liveFocusSecondsToday(
  state: TimerState,
  sessionDay: string | null,
  today: string
): number {
  if (sessionDay !== null && sessionDay !== today) return 0;
  return liveFocusSeconds(state);
}

/** "1h 20m". Whole minutes, floored — the status bar has no room for seconds. */
export function formatHoursMinutes(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${String(minutes)}m`;
}

/**
 * The "Today 1h 20m / 2h 0m" line, and whether the goal is met. A goal of 0
 * means no goal, so the total is shown on its own and nothing is ever met.
 */
export function focusGoalText(
  totalSeconds: number,
  goalMinutes: number
): { text: string; met: boolean } {
  let text = `Today ${formatHoursMinutes(totalSeconds)}`;
  if (goalMinutes <= 0) return { text, met: false };
  text += ` / ${formatHoursMinutes(goalMinutes * 60)}`;
  return { text, met: totalSeconds >= goalMinutes * 60 };
}

/**
 * The goal line's hint with no log folder set (F5): nothing is logged, so the
 * goal counts only the session that is running, and drops back to zero at
 * every Stop. Said where the number that looks broken is — the panel's goal
 * line, and the status bar's hover text on the desktop, where that line is
 * hidden (F30).
 */
export const NO_LOG_FOLDER_HINT = "no log folder set";

/** The hint for this log folder setting, or null when a folder is set. */
export function logFolderHint(logFolderPath: string): string | null {
  return logFolderPath.trim() === "" ? NO_LOG_FOLDER_HINT : null;
}

/** The panel's goal line: `text`, and the hint when there is no log folder. */
export function panelGoalText(text: string, logFolderPath: string): string {
  const hint = logFolderHint(logFolderPath);
  return hint === null ? text : `${text} · ${hint}`;
}

/** What the tracker needs from the plugin. */
export interface FocusTotalHost {
  now(): number;
  /** Today as the log names it (logLine.ts's logicalDate). Read repeatedly on
   *  purpose — the day can turn mid-fetch. */
  today(): string;
  /** Today's logged focus seconds, read from the daily log file. */
  fetchLoggedSeconds(): Promise<number>;
  /**
   * A fresh total landed. Repaint whatever shows it.
   *
   * Separate from the goal check below because the two have different
   * correctness rules: painting yesterday's number for a moment is harmless
   * and self-correcting, while firing the once-per-day notice off it is not.
   */
  onLanded(loggedSeconds: number): void;
  /** The logged total moved; it may have newly crossed the daily goal. */
  checkGoalNotice(loggedSeconds: number): void;
  /** Call `callback` after `ms`; returns what cancels it. */
  setTimer(callback: () => void, ms: number): () => void;
}

/**
 * Today's logged focus total, cached with a TTL and a date stamp.
 *
 * The date stamp is the part that matters. 0.5.2 shipped a version of this
 * cache with a TTL alone, and an app left open across local midnight then fed
 * yesterday's total into the first tick of the new day — which both painted a
 * stale meter and consumed the once-per-day goal notice, silencing the real
 * goal hit hours later. Everything here is arranged so that a day boundary
 * invalidates immediately rather than after the TTL.
 */
export class FocusTotalTracker {
  private readonly host: FocusTotalHost;
  private baseSeconds = 0;
  /** The day (the log's, "Day starts at" applied) the cached base was fetched
   *  for; other days count as 0. */
  private baseDate: string | null = null;
  private lastFetchMs = 0;
  private inFlight = false;
  // Not before this, after a read that failed or timed out (C4). The stale-day
  // bypass ignores the TTL, so without it a failing read was retried on every
  // 50 ms tick, each failure an unhandled rejection in the console.
  private retryAfterMs = 0;

  constructor(host: FocusTotalHost) {
    this.host = host;
  }

  /**
   * Today's logged seconds. A base stamped with any other day reads as 0 —
   * the refetch that corrects it is asynchronous, and showing yesterday's
   * hours in the meantime is the bug this exists to prevent.
   */
  loggedSeconds(): number {
    return effectiveFocusBaseSeconds(this.baseSeconds, this.baseDate, this.host.today());
  }

  /** Force the next refresh to actually read the file — a log line was just
   *  written. A failed read's wait goes too: the write is news, and writes are
   *  few, so this cannot become a loop. */
  invalidate(): void {
    this.lastFetchMs = 0;
    this.retryAfterMs = 0;
  }

  /**
   * Read the logged total if the cache is due, and hand it on.
   *
   * Called from the engine tick, a 60s heartbeat and the window focus event,
   * so the common case has to be two comparisons and a return.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    const now = this.host.now();
    // After a failure, even a stale day waits: the read failing is the news.
    if (now < this.retryAfterMs) return;
    // Resolved once, before the read, so the stamp names the day the log file
    // was picked for even if the day turns during the await.
    const today = this.host.today();
    // A day boundary invalidates immediately; the TTL alone would let
    // yesterday's total linger into the new day.
    const baseStale = this.baseDate !== today;
    if (!baseStale && now - this.lastFetchMs < FOCUS_TOTAL_CACHE_TTL_MS) return;

    this.inFlight = true;
    let totalSeconds: number;
    try {
      totalSeconds = await this.readWithTimeout();
    } catch (e) {
      // Caught here: every caller is `void`, and a rejection escaping one was
      // an unhandled rejection per tick. The old total stays on screen, and
      // the next read waits a TTL.
      logger.warn("Could not read today's focus total", e);
      this.lastFetchMs = this.host.now();
      this.retryAfterMs = this.lastFetchMs + FOCUS_TOTAL_CACHE_TTL_MS;
      return;
    } finally {
      // Always cleared, or one failed read leaves the total frozen for the
      // life of the session.
      this.inFlight = false;
    }
    this.baseSeconds = totalSeconds;
    this.baseDate = today;
    this.lastFetchMs = this.host.now();
    try {
      // The notice rides the landing, because the logged total is its only
      // input and this is the one place that total can newly cross the goal.
      // Skipped when the day turned during the await: `totalSeconds` then
      // describes yesterday's file, and the now-stale stamp forces a refetch
      // on the next beat that re-lands with the new day's total.
      if (today === this.host.today()) this.host.checkGoalNotice(totalSeconds);
      this.host.onLanded(totalSeconds);
    } catch (e) {
      logger.error("Could not show today's focus total", e);
    }
  }

  /**
   * The read, or a rejection once FOCUS_TOTAL_READ_TIMEOUT_MS has passed. A
   * read that never settles held the in-flight guard for good, and the meter
   * and the goal notice stopped until Obsidian restarted (C4). A late answer
   * from a read given up on is dropped: the race has already settled.
   */
  private readWithTimeout(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const cancel = this.host.setTimer(() => {
        reject(new Error("Reading today's log timed out"));
      }, FOCUS_TOTAL_READ_TIMEOUT_MS);
      this.host.fetchLoggedSeconds().then(
        (seconds) => {
          cancel();
          resolve(seconds);
        },
        (e: unknown) => {
          cancel();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    });
  }
}

/** What the goal notice needs from the plugin (C5). */
export interface GoalNoticeHost {
  goalMinutes(): number;
  noticeEnabled(): boolean;
  /** The once-a-day flag as this device holds it. */
  lastGoalHitDate(): string | null;
  /** The same flag as data.json on disk says now — another device may have
   *  fired the notice and saved it since this one loaded. */
  storedGoalHitDate(): Promise<unknown>;
  /** Today as the log names it. */
  today(): string;
  /** Take the stored flag; data.json says so already, so nothing is saved. */
  adopt(date: string): void;
  /** Show the notice and save the flag. */
  fire(date: string): void;
}

/**
 * The once-a-day "goal hit" notice, checked against data.json before it fires
 * (C5). The flag lived only in memory, so with the vault open on two devices
 * the idle one fired its own notice within a minute of the other's — the log
 * syncs — and then saved its whole settings object, loaded hours earlier,
 * over the newer one. Re-reading only this flag first answers both; reloading
 * every setting from disk is beyond this.
 */
export class GoalNotice {
  private readonly host: GoalNoticeHost;
  private checking = false;

  constructor(host: GoalNoticeHost) {
    this.host = host;
  }

  private due(loggedSeconds: number, today: string): boolean {
    return shouldFireGoalNotice(
      loggedSeconds,
      this.host.goalMinutes(),
      this.host.noticeEnabled(),
      this.host.lastGoalHitDate(),
      today
    );
  }

  /** Fire if `loggedSeconds` has crossed the goal and no device has said so today. */
  async check(loggedSeconds: number): Promise<void> {
    const today = this.host.today();
    if (!this.due(loggedSeconds, today) || this.checking) return;
    this.checking = true;
    try {
      let stored: unknown = null;
      try {
        stored = await this.host.storedGoalHitDate();
      } catch (e) {
        // Unreadable: decide on what this device knows, as before 0.6.9.
        logger.warn("Could not read the goal notice's date from data.json", e);
      }
      if (stored === today) {
        this.host.adopt(today);
        return;
      }
      // The read awaited: the day may have turned, or the flag been set.
      if (this.host.today() !== today || !this.due(loggedSeconds, today)) return;
      this.host.fire(today);
    } finally {
      this.checking = false;
    }
  }
}
