import { describe, it, expect } from "vitest";
import moment from "moment";
import { loggedTotalSeconds, type SessionLog } from "../logLine";
import {
  TASK_SWITCH_LOGGINGS,
  TASK_SWITCH_OPTIONS,
  activeReachedAt,
  pausesWithin,
  resolveTaskSwitchLogging,
  sameTask,
  segmentLogs,
  type ClosedSegment,
} from "../logSegments";
import type { MomentLike } from "../momentTypes";

/** 2 Oct 2026 at h:mm:ss(.ms), as the moment the log keeps. */
const t = (h: number, m: number, s = 0, ms = 0) =>
  moment(new Date(2026, 9, 2, h, m, s, ms)) as unknown as MomentLike;
const clock = (m: MomentLike) => (m as unknown as moment.Moment).format("HH:mm:ss");

function session(over: Partial<SessionLog> = {}): SessionLog {
  return {
    mode: "focus",
    taskName: "Review",
    taskPath: "Projects/B.md",
    taskId: "rev456",
    scheduledDurationMinutes: 25,
    startTime: t(9, 0),
    endTime: t(9, 30),
    pauses: [],
    status: "finished",
    breakType: null,
    overtimeSeconds: 300,
    ...over,
  };
}

const docs = (end: MomentLike): ClosedSegment => ({
  taskName: "Write docs",
  taskPath: "Projects/A.md",
  taskId: "abc123",
  end,
});

describe("resolveTaskSwitchLogging", () => {
  it("reads 'split' as split and anything else as the old rule", () => {
    expect(resolveTaskSwitchLogging("split")).toBe("split");
    for (const value of ["last-task", "Split", "", 1, null, undefined]) {
      expect(resolveTaskSwitchLogging(value)).toBe("last-task");
    }
  });

  it("labels each choice once, in the settings order", () => {
    expect(TASK_SWITCH_OPTIONS.map((o) => o.value)).toEqual([...TASK_SWITCH_LOGGINGS]);
    expect(TASK_SWITCH_OPTIONS.map((o) => o.label)).toEqual([
      "Last task gets the whole session",
      "Split at the switch",
    ]);
  });
});

describe("sameTask", () => {
  const a = { taskName: "Write docs", taskPath: "A.md", taskId: "abc" };
  it("is the same line picked again", () => {
    expect(sameTask(a, { ...a })).toBe(true);
  });
  it.each([
    ["another name", { ...a, taskName: "Other" }],
    ["another note", { ...a, taskPath: "B.md" }],
    ["another 🆔", { ...a, taskId: "xyz" }],
    ["no task", { taskName: "No Task" }],
  ])("is not %s", (_label, b) => {
    expect(sameTask(a, b)).toBe(false);
  });
});

describe("pausesWithin", () => {
  const pause = (a: MomentLike, b: MomentLike) => ({ start: a, end: b });
  const show = (ps: { start: MomentLike; end: MomentLike }[]) =>
    ps.map((p) => `${clock(p.start)}-${clock(p.end)}`);

  it("cuts a pause across either edge, and keeps one inside whole", () => {
    const pauses = [pause(t(8, 55), t(9, 5)), pause(t(9, 10), t(9, 12)), pause(t(9, 18), t(9, 25))];
    expect(show(pausesWithin(pauses, t(9, 0), t(9, 20)))).toEqual([
      "09:00:00-09:05:00",
      "09:10:00-09:12:00",
      "09:18:00-09:20:00",
    ]);
  });

  it("gives a pause ending at the edge to the part before, one starting there to the part after", () => {
    const pauses = [pause(t(9, 10), t(9, 20)), pause(t(9, 20), t(9, 22))];
    expect(show(pausesWithin(pauses, t(9, 0), t(9, 20)))).toEqual(["09:10:00-09:20:00"]);
    expect(show(pausesWithin(pauses, t(9, 20), t(9, 30)))).toEqual(["09:20:00-09:22:00"]);
  });

  it("keeps an instant pause on the edge in the part it opens", () => {
    const pauses = [pause(t(9, 20), t(9, 20))];
    expect(pausesWithin(pauses, t(9, 0), t(9, 20))).toEqual([]);
    expect(show(pausesWithin(pauses, t(9, 20), t(9, 30)))).toEqual(["09:20:00-09:20:00"]);
  });
});

describe("activeReachedAt — where End at planned end ends a session (F18)", () => {
  const ms = (m: MomentLike) => m.valueOf();
  const pause = (from: MomentLike, to: MomentLike) => ({ start: from, end: to });

  it("is the start plus the active time when nothing pauses it", () => {
    expect(activeReachedAt(t(9, 0), [], 1500)).toBe(ms(t(9, 25)));
  });

  it("stops at a pause that starts exactly where the plan is reached, not after it", () => {
    expect(activeReachedAt(t(9, 0), [pause(t(9, 10), t(9, 20))], 600)).toBe(ms(t(9, 10)));
    expect(activeReachedAt(t(9, 0), [pause(t(9, 10), t(9, 20))], 601)).toBe(ms(t(9, 20, 1)));
  });

  it("counts time two overlapping pauses share once", () => {
    const overlapping = [pause(t(9, 10), t(9, 20)), pause(t(9, 15), t(9, 25))];
    expect(activeReachedAt(t(9, 0), overlapping, 900)).toBe(ms(t(9, 30)));
    // A pause inside another ends before the cursor: it never moves it back.
    const nested = [pause(t(9, 10), t(9, 30)), pause(t(9, 15), t(9, 20))];
    expect(activeReachedAt(t(9, 0), nested, 900)).toBe(ms(t(9, 35)));
  });

  it("ignores a pause that ended before the session began", () => {
    expect(activeReachedAt(t(9, 0), [pause(t(8, 50), t(8, 55))], 600)).toBe(ms(t(9, 10)));
  });

  it("works in whole seconds, as a line writes Total", () => {
    expect(activeReachedAt(t(9, 0), [], 600.7)).toBe(ms(t(9, 10)));
  });
});

describe("segmentLogs", () => {
  it("is the session itself when no switch closed a segment", () => {
    const whole = session();
    expect(segmentLogs(whole, [])).toEqual([whole]);
  });

  it("writes a line per task, end to start, with the session's status and Scheduled", () => {
    const lines = segmentLogs(session(), [docs(t(9, 20))]);
    expect(lines.map((l) => [l.taskName, l.taskId, clock(l.startTime), clock(l.endTime)])).toEqual([
      ["Write docs", "abc123", "09:00:00", "09:20:00"],
      ["Review", "rev456", "09:20:00", "09:30:00"],
    ]);
    expect(lines.map((l) => [l.status, l.scheduledDurationMinutes])).toEqual([
      ["finished", 25],
      ["finished", 25],
    ]);
  });

  it("gives a skipped session's status to every line, not just the last", () => {
    // Skip logs a focus as cancelled; "finished" above is also the default a
    // line would fall back to, so it cannot tell a line that kept the status.
    const lines = segmentLogs(session({ status: "cancelled", scheduledDurationMinutes: 50 }), [
      docs(t(9, 10)),
      { ...docs(t(9, 20)), taskName: "C" },
    ]);
    expect(lines.map((l) => [l.taskName, l.status, l.scheduledDurationMinutes])).toEqual([
      ["Write docs", "cancelled", 50],
      ["C", "cancelled", 50],
      ["Review", "cancelled", 50],
    ]);
  });

  it("gives the overtime to the last minutes, back over the switch when they run out", () => {
    const lines = segmentLogs(session({ overtimeSeconds: 300 }), [docs(t(9, 28))]);
    expect(lines.map((l) => l.overtimeSeconds)).toEqual([180, 120]);
    const within = segmentLogs(session({ overtimeSeconds: 300 }), [docs(t(9, 20))]);
    expect(within.map((l) => l.overtimeSeconds)).toEqual([0, 300]);
  });

  it("adds up to the session's Total, whatever the milliseconds at the switch", () => {
    const whole = session({
      startTime: t(9, 0, 0, 700),
      endTime: t(9, 30, 4, 300),
      pauses: [{ start: t(9, 18, 0, 900), end: t(9, 21, 30, 100) }],
    });
    const lines = segmentLogs(whole, [docs(t(9, 20, 10, 500))]);
    expect(lines).toHaveLength(2);
    const sum = lines.reduce((n, l) => n + loggedTotalSeconds(l), 0);
    expect(sum).toBe(loggedTotalSeconds(whole));
  });

  it("drops the segments after the end and cuts the one across it", () => {
    // Ended at its planned end, 09:25, before the switches at 09:28 and 09:40.
    const lines = segmentLogs(session({ endTime: t(9, 25), overtimeSeconds: 0 }), [
      docs(t(9, 28)),
      { ...docs(t(9, 40)), taskName: "C" },
    ]);
    expect(lines.map((l) => [l.taskName, clock(l.startTime), clock(l.endTime)])).toEqual([
      ["Write docs", "09:00:00", "09:25:00"],
    ]);
  });

  it("merges a segment under a minute into the next, and the last into the one before", () => {
    const short = segmentLogs(session(), [docs(t(9, 0, 50)), { ...docs(t(9, 20)), taskName: "C" }]);
    expect(short.map((l) => [l.taskName, clock(l.startTime), clock(l.endTime)])).toEqual([
      ["C", "09:00:00", "09:20:00"],
      ["Review", "09:20:00", "09:30:00"],
    ]);
    const last = segmentLogs(session({ endTime: t(9, 20, 30), overtimeSeconds: 0 }), [
      docs(t(9, 20)),
    ]);
    expect(last.map((l) => [l.taskName, clock(l.startTime), clock(l.endTime)])).toEqual([
      ["Write docs", "09:00:00", "09:20:30"],
    ]);
  });

  it("marks the lines whose task a switch closed, never the session's last task (F22)", () => {
    // writeLog reads only the last task as the timer's live key, which follows
    // a task copied forward; a closed segment's name is history.
    const lines = segmentLogs(session(), [docs(t(9, 0, 50)), { ...docs(t(9, 20)), taskName: "C" }]);
    expect(lines.map((l) => [l.taskName, l.closedBySwitch])).toEqual([
      ["C", true],
      ["Review", undefined],
    ]);
    // The last task merged away (under a minute) or cut off: every line is closed.
    const merged = segmentLogs(session({ endTime: t(9, 20, 30), overtimeSeconds: 0 }), [
      docs(t(9, 20)),
    ]);
    expect(merged.map((l) => l.closedBySwitch)).toEqual([true]);
    const cut = segmentLogs(session({ endTime: t(9, 25), overtimeSeconds: 0 }), [docs(t(9, 28))]);
    expect(cut.map((l) => l.closedBySwitch)).toEqual([true]);
  });
});
