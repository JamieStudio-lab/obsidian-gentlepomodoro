import type { TimerState } from "./types";

/**
 * What the status bar item says, worked out from the timer's state (0.6.8).
 *
 * Pure: no `obsidian`, no DOM, no clock of its own. main.ts builds the item
 * and paints it from what these return, so every rule about WHAT it shows —
 * which state it is in, which words, which menu entries — can be tested
 * without an Obsidian runtime. The look itself lives in styles.css, keyed off
 * the classes `statusBarClasses` names.
 */

/** Which time the item shows beside the mode. Hidden is the default, for the
 *  reason the timer panel hides its countdown: a ticking number in the corner
 *  of your eye is the thing this plugin exists to avoid. */
export const STATUS_BAR_TIMES = {
  hidden: "Hidden",
  minutes: "Minutes left",
  clock: "Clock",
  end: "End time",
} as const;

export type StatusBarTime = keyof typeof STATUS_BAR_TIMES;

export const DEFAULT_STATUS_BAR_TIME: StatusBarTime = "hidden";

const STATUS_BAR_TIME_IDS = Object.keys(STATUS_BAR_TIMES) as StatusBarTime[];

/**
 * A stored value as a time display. An id-list check, never `in`: `in` walks
 * the prototype chain, so "toString" would pass (the `resolveTheme` lesson).
 * coerceToDefaults keeps any string, so a hand-edited or newer value lands here
 * and falls back to hidden rather than to a display with no rules.
 */
export function resolveStatusBarTime(value: unknown): StatusBarTime {
  return typeof value === "string" && (STATUS_BAR_TIME_IDS as string[]).includes(value)
    ? (value as StatusBarTime)
    : DEFAULT_STATUS_BAR_TIME;
}

/**
 * The first value of `statusBarTime` for someone who has none stored.
 *
 * Before 0.6.8 the only choice was a click on the word, which flipped
 * `showStatusBarTimeLeft` and showed the clock. So an upgrade that had the
 * clock on keeps the clock, and everyone else — a fresh install included —
 * starts hidden. Returns undefined when a value is already stored, so the
 * caller only writes what it derived.
 */
export function deriveStatusBarTime(
  loaded: { statusBarTime?: unknown; showStatusBarTimeLeft?: unknown } | null
): StatusBarTime | undefined {
  if (loaded && loaded.statusBarTime !== undefined) return undefined;
  return loaded?.showStatusBarTimeLeft === true ? "clock" : DEFAULT_STATUS_BAR_TIME;
}

/** Idle = a session that has not started; paused = one that has. */
export type StatusBarPhase = "idle" | "running" | "paused";

export function statusBarPhase(state: TimerState): StatusBarPhase {
  if (state.isRunning) return "running";
  return state.remainingMs === state.totalMs ? "idle" : "paused";
}

/** Time's up: the session reached zero and the clock is counting up. The end
 *  is silent by design, so this is how a glance learns it. */
export function isOvertime(state: TimerState): boolean {
  return state.remainingMs < 0;
}

export function statusModeLabel(state: TimerState): string {
  if (state.mode === "focus") return "Focus";
  return state.breakType === "long" ? "Long break" : "Break";
}

/** Whole minutes, rounded UP and never below 1 — "0m" must never show while
 *  time is left, and "+0m" must never show once it has run out. */
function wholeMinutes(ms: number): number {
  return Math.max(1, Math.ceil(Math.abs(ms) / 60_000));
}

/** "12:34", or "+03:12" in overtime. The seconds are rounded up, like the
 *  timer panel's clock, so the two never disagree. */
export function formatClock(remainingMs: number): string {
  const total = Math.ceil(Math.abs(remainingMs) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const text = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return remainingMs < 0 ? `+${text}` : text;
}

/**
 * The time text beside the mode. "" when there is nothing to show — hidden,
 * or the end time when there is no end to name (idle, paused, overtime: a
 * paused session's end moves every second, and one that is over has none).
 * `formatEnd` is the timer panel's own "Ends 15:30", passed in so the two read
 * alike and this file needs no moment.
 */
export function statusTimeText(
  state: TimerState,
  time: StatusBarTime,
  nowMs: number,
  formatEnd: (endMs: number) => string
): string {
  switch (time) {
    case "hidden":
      return "";
    case "minutes":
      return `${state.remainingMs < 0 ? "+" : ""}${String(wholeMinutes(state.remainingMs))}m`;
    case "clock":
      return formatClock(state.remainingMs);
    case "end":
      return state.isRunning && state.remainingMs > 0 ? formatEnd(nowMs + state.remainingMs) : "";
  }
}

/** Today's goal as a fraction for the ring, 0..1. 0 with no goal set. */
export function goalFraction(focusSeconds: number, goalMinutes: number): number {
  if (!(goalMinutes > 0)) return 0;
  const fraction = focusSeconds / (goalMinutes * 60);
  if (!Number.isFinite(fraction) || fraction < 0) return 0;
  return Math.min(1, fraction);
}

export interface StatusBarLook {
  phase: StatusBarPhase;
  overtime: boolean;
  goalOn: boolean;
  goalMet: boolean;
  time: StatusBarTime;
  showTotal: boolean;
}

/**
 * Every state class the item carries, each paired with whether it is on, so
 * the caller can `toggleClass` them all and a class never lingers from the
 * state before. styles.css uses only these names (not every one of them —
 * the time classes, for one, are there for themes and snippets).
 */
export function statusBarClasses(state: TimerState, look: StatusBarLook): [string, boolean][] {
  return [
    ["gp-state-idle", look.phase === "idle"],
    ["gp-state-running", look.phase === "running"],
    ["gp-state-paused", look.phase === "paused"],
    ["gp-state-overtime", look.overtime],
    ["gp-mode-focus", state.mode === "focus"],
    ["gp-mode-break", state.mode === "break"],
    ["gp-break-long", state.mode === "break" && state.breakType === "long"],
    ["gp-goal-on", look.goalOn],
    ["gp-goal-met", look.goalMet],
    ...STATUS_BAR_TIME_IDS.map((id): [string, boolean] => [`gp-time-${id}`, look.time === id]),
    ["gp-show-total", look.showTotal],
  ];
}

function minutesPhrase(ms: number): string {
  return `${String(wholeMinutes(ms))} min`;
}

export interface StatusTooltipInput {
  state: TimerState;
  nowMs: number;
  formatEnd: (endMs: number) => string;
  /** The linked task as the timer panel's button shows it, or null. */
  taskName: string | null;
  /** "1h 24m" — today's focus so far. */
  todayText: string;
  /** "4h 0m", or null when no goal is set. */
  goalText: string | null;
  goalMet: boolean;
}

/**
 * The hover text: everything the item leaves out, one fact per line. It gives
 * the time even when the time display is hidden — hovering is asking, the way
 * hovering the timer panel's square reveals its clock.
 */
export function statusTooltip(input: StatusTooltipInput): string {
  const { state } = input;
  const mode = statusModeLabel(state);
  const phase = statusBarPhase(state);
  let session: string;
  if (isOvertime(state)) {
    session = `${mode}: time is up (${minutesPhrase(state.remainingMs)} over)`;
    if (phase === "paused") session += ", paused";
  } else if (phase === "idle") {
    session = `${mode}: not started (${minutesPhrase(state.totalMs)})`;
  } else if (phase === "paused") {
    session = `${mode}: paused, ${minutesPhrase(state.remainingMs)} left`;
  } else {
    const end = input.formatEnd(input.nowMs + state.remainingMs);
    session = `${mode}: ${minutesPhrase(state.remainingMs)} left. ${end}`;
  }

  const lines = [session];
  if (input.taskName) lines.push(`Task: ${input.taskName}`);
  if (input.goalText === null) {
    lines.push(`Today: ${input.todayText}`);
  } else {
    lines.push(
      `Today: ${input.todayText} of ${input.goalText}${input.goalMet ? " (goal met)" : ""}`
    );
  }
  lines.push("Click for timer controls");
  return lines.join("\n");
}

export type StatusMenuAction =
  | "start"
  | "pause"
  | "resume"
  | "finish"
  | "skip"
  | "open"
  | `time:${StatusBarTime}`;

/** The actions that change the timer. The rest (open the panel, choose the
 *  time display) are safe whatever the timer has done since. */
export function isTimerAction(action: StatusMenuAction): boolean {
  return (
    action === "start" ||
    action === "resume" ||
    action === "pause" ||
    action === "finish" ||
    action === "skip"
  );
}

/**
 * What the menu's timer entries were chosen for: this session, in this phase.
 * The menu closes when it changes, and a timer action whose key no longer
 * matches does nothing — the menu can sit open across a zero crossing that
 * auto-starts the next session, and "Finish & next" must not then finish a
 * session nobody saw.
 */
export function statusMenuKey(session: number, state: TimerState): string {
  return `${String(session)}|${statusBarPhase(state)}`;
}

export interface StatusMenuEntry {
  action: StatusMenuAction;
  title: string;
  /** A Lucide id. Every entry has one: Obsidian's menu gives an item without
   *  an icon no icon column, so its title would sit out of line with the rest. */
  icon: string;
  checked?: boolean;
}

/** Plain-language titles for the time choices in the menu. The settings tab
 *  names the same four as a dropdown (STATUS_BAR_TIMES). */
const TIME_MENU: Record<StatusBarTime, { title: string; icon: string }> = {
  hidden: { title: "Hide time", icon: "eye-off" },
  minutes: { title: "Show minutes left", icon: "hourglass" },
  clock: { title: "Show clock", icon: "timer" },
  end: { title: "Show end time", icon: "flag" },
};

/**
 * What a click on the item offers, in order, with `null` for a separator.
 *
 * The timer entries use the names the timer panel's buttons and the command
 * palette use ("Finish & next", "Skip to next"), and appear on the same
 * conditions as those commands: Finish & next once there is something to
 * finish, Skip to next always. "Resume" rather than "Start" once a session
 * has begun, because that is what the button then does.
 */
export function statusMenuEntries(
  state: TimerState,
  time: StatusBarTime
): (StatusMenuEntry | null)[] {
  const phase = statusBarPhase(state);
  const entries: (StatusMenuEntry | null)[] = [];
  if (phase === "running") entries.push({ action: "pause", title: "Pause", icon: "pause" });
  else if (phase === "paused") entries.push({ action: "resume", title: "Resume", icon: "play" });
  else entries.push({ action: "start", title: "Start", icon: "play" });
  if (phase !== "idle") {
    entries.push({ action: "finish", title: "Finish & next", icon: "square" });
  }
  entries.push({ action: "skip", title: "Skip to next", icon: "skip-forward" });
  entries.push(null);
  entries.push({ action: "open", title: "Open timer", icon: "clock" });
  entries.push(null);
  for (const id of STATUS_BAR_TIME_IDS) {
    entries.push({
      action: `time:${id}`,
      title: TIME_MENU[id].title,
      icon: TIME_MENU[id].icon,
      checked: time === id,
    });
  }
  return entries;
}
