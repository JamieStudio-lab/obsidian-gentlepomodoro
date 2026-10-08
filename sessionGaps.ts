/**
 * Time the log should not count as focus without asking (0.6.9, F48): a
 * computer asleep with the timer running, and a focus left running for hours
 * past its planned end. The real logs held four overnight sessions logged as
 * 9–17 h of finished focus, 8% of everything counted.
 *
 * Pure: the rules, the setting's values and every line of wording. The engine
 * decides when, the plugin shows the notice and the modal.
 */

/** The choices for "Ask about long sessions", in hours; 0 is off. */
export const LONG_SESSION_PROMPT_HOURS = [0, 2, 4, 6, 8] as const;

/** DEFAULT_SETTINGS' value: rare enough to be worth a question (7 of the 358
 *  real focus lines ran longer; 2 hours would have asked about a quarter of
 *  them), and short of a night's sleep. */
const DEFAULT_LONG_SESSION_PROMPT_HOURS = 6;

/** The stored hours if they are one of the choices, else the default. An id
 *  list, never a range: a hand-edited 5 is not a choice the row can show. */
export function resolveLongSessionPromptHours(value: unknown): number {
  return LONG_SESSION_PROMPT_HOURS.some((hours) => hours === value)
    ? (value as number)
    : DEFAULT_LONG_SESSION_PROMPT_HOURS;
}

/** A length as the status bar writes one: "9h 47m", "47m". */
export function describeDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return minutes === 0 ? "under a minute" : `${String(minutes)}m`;
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

/** The notice after a sleep pause; `gapMs` is the time not counted. */
export function sleepPauseMessage(gapMs: number): string {
  return `Gentle pomodoro: paused while your computer was asleep — ${describeDuration(gapMs / 1000)} not counted.`;
}

/** What Stop asks about, read off the session as the press found it. */
export interface LongSessionQuestion {
  /** The session's active time if all of it is kept. */
  activeSeconds: number;
  /** Of that, the active time past the planned end. */
  overtimeSeconds: number;
  /** The instant the active time reached the planned length (ms). */
  plannedEndAt: number;
}

/** How the user answered. "cancel" — the dialog closed — cancels the Stop. */
export type LongSessionAnswer = "keep" | "planned" | "cancel";

/**
 * Whether a session is one to ask about before it is logged: a focus that ran
 * `longSessionPromptHours` or more of active time AND past its planned end.
 * Stop asks about such a session as it ends, and the startup question about a
 * session an earlier run left offers to end it at its planned end (F18) — one
 * rule, so the two offer it for the same sessions. `hoursSetting` is the
 * stored setting; off (0) asks about nothing.
 */
export function isLongSession(
  mode: "focus" | "break",
  activeSeconds: number,
  overtimeSeconds: number,
  hoursSetting: unknown
): boolean {
  if (mode !== "focus" || overtimeSeconds <= 0) return false;
  const hours = resolveLongSessionPromptHours(hoursSetting);
  return hours !== 0 && activeSeconds >= hours * 3600;
}

/**
 * Where the answer "planned" ends a session — Stop's "End at planned end" and
 * the startup's "Log up to planned end" alike: where its active time reached
 * the plan, with no Overtime. Its line's Total is then the planned length.
 */
export function plannedSessionEnd(question: LongSessionQuestion): {
  endAt: number;
  overtimeSeconds: number;
} {
  return { endAt: question.plannedEndAt, overtimeSeconds: 0 };
}

export const LONG_SESSION_TITLE = "Log this long focus?";
export const LONG_SESSION_KEEP_LABEL = "Keep it all";

export function longSessionMessage(activeSeconds: number, overtimeSeconds: number): string {
  return `This focus ran ${describeDuration(activeSeconds)} — ${describeDuration(overtimeSeconds)} past its planned end.`;
}

/** The second button; `endTime` is the planned end as the clock shows it. */
export function longSessionPlannedLabel(endTime: string): string {
  return `End at planned end (${endTime})`;
}
