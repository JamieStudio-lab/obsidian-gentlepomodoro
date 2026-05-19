import { describe, it, expect } from "vitest";
import {
  formatLogLine,
  parseFocusTotalSeconds,
  shouldFireGoalNotice,
  type SessionLog,
} from "../logManager";
import type { MomentLike } from "../momentTypes";

// Minimal moment-like stub that supports the two methods formatLogLine uses.
class TestMoment implements MomentLike {
  constructor(public date: Date) {}

  format(fmt: string): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");
    // Use UTC accessors so test output doesn't depend on the host timezone.
    return fmt
      .replace("YYYY", String(this.date.getUTCFullYear()))
      .replace("MM", pad(this.date.getUTCMonth() + 1))
      .replace("DD", pad(this.date.getUTCDate()))
      .replace("HH", pad(this.date.getUTCHours()))
      .replace("mm", pad(this.date.getUTCMinutes()))
      .replace("ss", pad(this.date.getUTCSeconds()));
  }

  diff(other: MomentLike): number {
    return this.date.getTime() - (other as TestMoment).date.getTime();
  }

  startOf(_: string): MomentLike {
    return this;
  }
  endOf(_: string): MomentLike {
    return this;
  }
  add(_n: number, _u: string): MomentLike {
    return this;
  }
  isBefore(): boolean {
    return false;
  }
  isSame(): boolean {
    return false;
  }
  isSameOrBefore(): boolean {
    return false;
  }
}

const m = (iso: string) => new TestMoment(new Date(`${iso}Z`));

describe("formatLogLine — focus", () => {
  it("formats a finished focus session with task link and ID", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      taskPath: "Projects/Docs.md",
      taskId: "abc123",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:25:00"),
      pauses: [],
      status: "finished",
    };

    const line = formatLogLine(session);

    expect(line).toBe(
      "- 🍅 Focus | Task:: [[Projects/Docs.md|Write docs]] | ID:: abc123 | " +
        "Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:25:00 | " +
        "Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus"
    );
  });

  it("omits ID when not present", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      taskPath: "Projects/Docs.md",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:25:00"),
      pauses: [],
      status: "finished",
    };

    expect(formatLogLine(session)).not.toContain("ID::");
    expect(formatLogLine(session)).toContain("Task:: [[Projects/Docs.md|Write docs]]");
  });

  it("uses plain text instead of wiki-link when no path is given", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:25:00"),
      pauses: [],
      status: "finished",
    };

    expect(formatLogLine(session)).toContain("Task:: Write docs |");
  });

  it("uses 'No Task' when taskName is the no-task sentinel", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "No Task",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:25:00"),
      pauses: [],
      status: "finished",
    };

    expect(formatLogLine(session)).toContain("Task:: No Task |");
  });

  it("subtracts pause duration from Total::", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:30:00"), // 30 minutes wall-clock
      pauses: [{ start: m("2025-12-23T10:10:00"), end: m("2025-12-23T10:15:00") }], // 5 min paused
      status: "finished",
    };

    // 30 min - 5 min pause = 25 min = 1500s
    expect(formatLogLine(session)).toContain("Total:: 1500");
  });

  it("serializes pause intervals as JSON array of formatted ranges", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:30:00"),
      pauses: [{ start: m("2025-12-23T10:10:00"), end: m("2025-12-23T10:15:00") }],
      status: "finished",
    };

    expect(formatLogLine(session)).toContain(
      'Pauses:: ["2025-12-23 10:10:00 - 2025-12-23 10:15:00"]'
    );
  });

  it("emits 'cancelled' status when set", () => {
    const session: SessionLog = {
      mode: "focus",
      taskName: "Write docs",
      scheduledDurationMinutes: 25,
      startTime: m("2025-12-23T10:00:00"),
      endTime: m("2025-12-23T10:10:00"),
      pauses: [],
      status: "cancelled",
    };

    expect(formatLogLine(session)).toContain("Status:: cancelled");
  });
});

describe("formatLogLine — break", () => {
  it("emits the shorter rest format with short-break Type", () => {
    const session: SessionLog = {
      mode: "break",
      taskName: "No Task",
      scheduledDurationMinutes: 5,
      startTime: m("2025-12-23T10:25:00"),
      endTime: m("2025-12-23T10:30:00"),
      pauses: [],
      status: "finished",
      breakType: "short",
    };

    expect(formatLogLine(session)).toBe(
      "- ☕ Rest | Start:: 2025-12-23 10:25:00 | End:: 2025-12-23 10:30:00 | " +
        "Scheduled:: 300 | Total:: 300 | Type:: short-break"
    );
  });

  it("emits long-break Type when breakType is 'long'", () => {
    const session: SessionLog = {
      mode: "break",
      taskName: "No Task",
      scheduledDurationMinutes: 15,
      startTime: m("2025-12-23T11:00:00"),
      endTime: m("2025-12-23T11:15:00"),
      pauses: [],
      status: "finished",
      breakType: "long",
    };

    expect(formatLogLine(session)).toBe(
      "- ☕ Rest | Start:: 2025-12-23 11:00:00 | End:: 2025-12-23 11:15:00 | " +
        "Scheduled:: 900 | Total:: 900 | Type:: long-break"
    );
  });

  it("defaults to short-break when breakType is missing", () => {
    const session: SessionLog = {
      mode: "break",
      taskName: "No Task",
      scheduledDurationMinutes: 5,
      startTime: m("2025-12-23T10:25:00"),
      endTime: m("2025-12-23T10:30:00"),
      pauses: [],
      status: "finished",
    };

    expect(formatLogLine(session)).toContain("Type:: short-break");
  });
});

describe("parseFocusTotalSeconds", () => {
  it("sums Total:: across all focus lines", () => {
    const content = [
      "- 🍅 Focus | Task:: A | Start:: ... | Total:: 1500 | Status:: finished",
      "- ☕ Rest | Start:: ... | Total:: 300",
      "- 🍅 Focus | Task:: B | Start:: ... | Total:: 1200 | Status:: finished",
    ].join("\n");

    expect(parseFocusTotalSeconds(content)).toBe(2700);
  });

  it("ignores rest lines and lines without a Total:: field", () => {
    const content = [
      "- ☕ Rest | Start:: ... | Total:: 300",
      "Some notes here.",
      "- 🍅 Focus | Task:: A | Status:: cancelled", // no Total::
    ].join("\n");

    expect(parseFocusTotalSeconds(content)).toBe(0);
  });

  it("returns 0 for empty content", () => {
    expect(parseFocusTotalSeconds("")).toBe(0);
  });
});

describe("shouldFireGoalNotice", () => {
  const TODAY = "2025-05-18";

  it("fires when seconds cross the goal and notice hasn't fired today", () => {
    expect(shouldFireGoalNotice(7200, 120, true, null, TODAY)).toBe(true);
    expect(shouldFireGoalNotice(7200, 120, true, "2025-05-17", TODAY)).toBe(true);
  });

  it("does NOT fire when goal is 0 (disabled)", () => {
    expect(shouldFireGoalNotice(99999, 0, true, null, TODAY)).toBe(false);
  });

  it("does NOT fire when notice is disabled", () => {
    expect(shouldFireGoalNotice(7200, 120, false, null, TODAY)).toBe(false);
  });

  it("does NOT fire when below the threshold", () => {
    expect(shouldFireGoalNotice(7199, 120, true, null, TODAY)).toBe(false);
  });

  it("does NOT fire when already fired today (date matches)", () => {
    expect(shouldFireGoalNotice(7200, 120, true, TODAY, TODAY)).toBe(false);
  });

  it("fires again on the next day even if lastGoalHitDate is set", () => {
    // lastGoalHitDate is yesterday, today is new -> fires
    expect(shouldFireGoalNotice(7200, 120, true, "2025-05-17", TODAY)).toBe(true);
  });
});
