/**
 * A task switch in the middle of a focus (0.6.9, F52). Until then the whole
 * session went to the task linked when it ended: twenty minutes on "Write
 * docs" and five on "Other" logged 25 minutes of "Other" and nothing at all
 * for the docs. That stays the default — the Daily Review counts one session
 * per line, so splitting raises its counts — and "split" is the choice.
 *
 * In "split", LogManager closes a SEGMENT at each switch and keeps it for the
 * task it was for; `segmentLogs` turns the segments into one line each when
 * the session ends. Pure: no obsidian, the moments are the ones it is given.
 */
import { MIN_SESSION_SECONDS } from "./constants";
import { loggedTotalSeconds, type SessionLog } from "./logLine";
import type { MomentLike } from "./momentTypes";

export const TASK_SWITCH_LOGGINGS = ["last-task", "split"] as const;
export type TaskSwitchLogging = (typeof TASK_SWITCH_LOGGINGS)[number];

/** The setting's choices with their labels, for the settings row. */
export const TASK_SWITCH_OPTIONS: readonly { value: TaskSwitchLogging; label: string }[] = [
  { value: "last-task", label: "Last task gets the whole session" },
  { value: "split", label: "Split at the switch" },
];

/** The stored choice, or "last-task" — what every earlier version did. */
export function resolveTaskSwitchLogging(value: unknown): TaskSwitchLogging {
  return value === "split" ? "split" : "last-task";
}

/** A session's task, as the log line names it. */
export interface SegmentTask {
  taskName: string;
  taskPath?: string;
  taskId?: string;
}

/** A segment a switch closed: its task, and the instant of the switch. */
export interface ClosedSegment extends SegmentTask {
  end: MomentLike;
}

/** Is this the task the segment is for? A pick of the same line again is not
 *  a switch; a rename of the linked task never asks (LogManager.updateTask). */
export function sameTask(a: SegmentTask, b: SegmentTask): boolean {
  return a.taskName === b.taskName && a.taskPath === b.taskPath && a.taskId === b.taskId;
}

type Pause = SessionLog["pauses"][number];

/**
 * The pauses that fall within [start, end), cut to it. A pause across a
 * switch is split between the two lines, so each line balances on its own
 * and the totals still add up to the session's.
 */
export function pausesWithin(pauses: readonly Pause[], start: MomentLike, end: MomentLike) {
  const from = start.valueOf();
  const to = end.valueOf();
  const within: Pause[] = [];
  for (const pause of pauses) {
    const s = pause.start.valueOf();
    const e = pause.end.valueOf();
    // Ending at `from` is the previous part's; starting at `to`, the next's.
    if (s >= to || e < from || (e === from && s < from)) continue;
    within.push({ start: s < from ? start : pause.start, end: e > to ? end : pause.end });
  }
  return within;
}

/** Active seconds in [start, end), as the line for it would write Total. */
export function activeSecondsWithin(
  pauses: readonly Pause[],
  start: MomentLike,
  end: MomentLike
): number {
  return loggedTotalSeconds({
    startTime: start,
    endTime: end,
    pauses: pausesWithin(pauses, start, end),
  });
}

/**
 * The instant (ms) a session that began at `start` reached `activeSeconds` of
 * active time, given its `pauses`. Worked in whole seconds, as a line is
 * written, so a session ended there writes exactly that Total. Where "End at
 * planned end" ends a session, the open one (LogManager) or one an earlier run
 * left (sessionRecovery.ts) — the same instant for the same session.
 */
export function activeReachedAt(
  start: MomentLike,
  pauses: readonly Pause[],
  activeSeconds: number
): number {
  const seconds = (m: MomentLike) => Math.floor(m.valueOf() / 1000);
  let cursor = seconds(start);
  let left = Math.max(0, Math.floor(activeSeconds));
  for (const pause of pauses) {
    const pauseStart = seconds(pause.start);
    if (pauseStart - cursor >= left) break;
    left -= Math.max(0, pauseStart - cursor);
    cursor = Math.max(cursor, seconds(pause.end));
  }
  return (cursor + left) * 1000;
}

interface Part {
  task: SegmentTask;
  start: MomentLike;
  end: MomentLike;
  /** Its task is one a switch closed, not the session's last. */
  closed: boolean;
}

/**
 * A line segmentLogs returns. `closedBySwitch` marks a segment whose task a
 * switch closed: its name is history, so when its note is read at the end a
 * ticked copy it names keeps it (writeLog). Only the session's last task is
 * the timer's live key, which follows a task copied forward (resolveIdLine).
 */
export type SegmentLine = SessionLog & { closedBySwitch?: true };

/**
 * The lines a session ends as: one per segment, or the session itself when
 * no switch closed one. `session` is the whole session as LogManager would
 * write it — its task the one linked at the end, its pauses already cut to
 * its end — and `closed` the segments switches closed, in order.
 *
 * - Every line has the session's status, Scheduled and break type.
 * - A segment after the end is dropped and one across it cut: a session ends
 *   at the zero crossing, or at its planned end, before the switches made
 *   after it.
 * - A segment under a minute is merged into the next one (the last into the
 *   one before it): no line under a minute, as for a whole session (F59).
 * - Overtime goes from the END backwards: the last minutes of a session are
 *   the ones past its planned end, whoever they were for.
 */
export function segmentLogs(session: SessionLog, closed: readonly ClosedSegment[]): SegmentLine[] {
  if (closed.length === 0) return [session];

  const limit = session.endTime.valueOf();
  const parts: Part[] = [];
  let start = session.startTime;
  const segments = [...closed, { ...session, end: session.endTime }];
  for (const [i, segment] of segments.entries()) {
    const cut = segment.end.valueOf() >= limit;
    const end = cut ? session.endTime : segment.end;
    parts.push({ task: segment, start, end, closed: i < closed.length });
    if (cut) break;
    start = segment.end;
  }

  const active = (part: Part) => activeSecondsWithin(session.pauses, part.start, part.end);
  for (let i = 0; i < parts.length - 1; ) {
    if (active(parts[i]) < MIN_SESSION_SECONDS) {
      parts[i + 1] = { ...parts[i + 1], start: parts[i].start };
      parts.splice(i, 1);
    } else {
      i++;
    }
  }
  const last = parts.length - 1;
  if (last > 0 && active(parts[last]) < MIN_SESSION_SECONDS) {
    parts[last - 1] = { ...parts[last - 1], end: parts[last].end };
    parts.pop();
  }

  let overtimeLeft = Math.max(0, Math.floor(session.overtimeSeconds ?? 0));
  const overtimes = parts.map(() => 0);
  for (let i = parts.length - 1; i >= 0 && overtimeLeft > 0; i--) {
    overtimes[i] = Math.min(overtimeLeft, active(parts[i]));
    overtimeLeft -= overtimes[i];
  }

  return parts.map((part, i) => ({
    ...session,
    taskName: part.task.taskName,
    taskPath: part.task.taskPath,
    taskId: part.task.taskId,
    startTime: part.start,
    endTime: part.end,
    pauses: pausesWithin(session.pauses, part.start, part.end),
    overtimeSeconds: overtimes[i],
    ...(part.closed ? { closedBySwitch: true as const } : {}),
  }));
}
