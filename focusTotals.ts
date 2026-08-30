import { FOCUS_TOTAL_CACHE_TTL_MS } from "./constants";
import { effectiveFocusBaseSeconds } from "./logManager";
import type { TimerState } from "./types";

/**
 * Seconds of focus elapsed in the session running right now. Zero outside a
 * focus session, and never negative — shortening a running session's duration
 * can leave `remainingMs` above `totalMs`, and a negative contribution would
 * subtract from the logged total the caller adds this to.
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

/** What the tracker needs from the plugin. */
export interface FocusTotalHost {
  now(): number;
  /** Local YYYY-MM-DD. Read repeatedly on purpose — midnight can pass mid-fetch. */
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
  /** The local date the cached base was fetched for; other days count as 0. */
  private baseDate: string | null = null;
  private lastFetchMs = 0;
  private inFlight = false;

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

  /** Force the next refresh to actually read the file — a log line was just written. */
  invalidate(): void {
    this.lastFetchMs = 0;
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
    // Resolved once, before the read, so the stamp names the day the log file
    // was picked for even if midnight passes during the await.
    const today = this.host.today();
    // A day boundary invalidates immediately; the TTL alone would let
    // yesterday's total linger into the new day.
    const baseStale = this.baseDate !== today;
    if (!baseStale && now - this.lastFetchMs < FOCUS_TOTAL_CACHE_TTL_MS) return;

    this.inFlight = true;
    try {
      const totalSeconds = await this.host.fetchLoggedSeconds();
      this.baseSeconds = totalSeconds;
      this.baseDate = today;
      this.lastFetchMs = this.host.now();
      // The notice rides the landing, because the logged total is its only
      // input and this is the one place that total can newly cross the goal.
      // Skipped when midnight passed during the await: `totalSeconds` then
      // describes yesterday's file, and the now-stale stamp forces a refetch
      // on the next beat that re-lands with the new day's total.
      if (today === this.host.today()) this.host.checkGoalNotice(totalSeconds);
      this.host.onLanded(totalSeconds);
    } finally {
      // Always cleared, or one failed read leaves the total frozen for the
      // life of the session.
      this.inFlight = false;
    }
  }
}
