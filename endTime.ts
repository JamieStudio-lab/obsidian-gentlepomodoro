import type { MomentFactory } from "./momentTypes";

/**
 * An instant as the clock shows it — "17:25", or "Thu 17:25" when it is not
 * today. The two session questions name one this way (F21): the unfinished
 * session's start, and the long focus's planned end — which, for the timer
 * left running overnight that question exists for, is yesterday's, and a bare
 * time then read as later today. Shown, never stored: the clock as the app's
 * language writes it.
 */
export function clockLabel(moment: MomentFactory, ms: number): string {
  const at = moment(ms);
  return at.isSame(moment(), "day") ? at.format("LT") : at.format("ddd LT");
}

/**
 * Format a projected end timestamp as a localized wall-clock time — "Ends
 * 15:30" (or "Ends 3:30 PM" per locale, via moment's LT). When the session
 * finishes on a later calendar day than now (a late start plus a long
 * session), append "(+1 day)" — or "(+N days)" in the extreme. The delta is
 * measured on local-midnight boundaries (startOf("day")), so it counts
 * calendar days and stays correct across DST rather than counting 24h chunks.
 *
 * Shared by the timer panel and the status bar (0.6.8), so the two name the
 * same end the same way. `moment` is passed in because both callers read
 * Obsidian's global, and a test can hand it the real library.
 */
export function formatEndTime(moment: MomentFactory, endMs: number): string {
  const end = moment(endMs);
  const time = end.format("LT");
  // startOf mutates `end` in place; it isn't read again after this.
  const dayDelta = end.startOf("day").diff(moment().startOf("day"), "days");
  if (dayDelta <= 0) return `Ends ${time}`;
  const suffix = dayDelta === 1 ? "+1 day" : `+${String(dayDelta)} days`;
  return `Ends ${time} (${suffix})`;
}
