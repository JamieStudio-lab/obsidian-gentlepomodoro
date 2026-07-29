import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TFile } from "obsidian";
import {
  effectiveFocusBaseSeconds,
  formatLogLine,
  parseFocusTotalSeconds,
  shouldFireGoalNotice,
  LogManager,
  type SessionLog,
} from "../logManager";
import type GentlePomoPlugin from "../main";
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

describe("effectiveFocusBaseSeconds", () => {
  const TODAY = "2025-05-18";

  it("counts a base fetched today", () => {
    expect(effectiveFocusBaseSeconds(7200, TODAY, TODAY)).toBe(7200);
  });

  it("zeroes a base fetched yesterday (app kept open across midnight)", () => {
    expect(effectiveFocusBaseSeconds(7200, "2025-05-17", TODAY)).toBe(0);
  });

  it("zeroes a base that was never fetched", () => {
    expect(effectiveFocusBaseSeconds(0, null, TODAY)).toBe(0);
    expect(effectiveFocusBaseSeconds(7200, null, TODAY)).toBe(0);
  });

  it("keeps yesterday's total from firing a spurious day-2 goal notice", () => {
    // Day 1: 3h focused, 2h goal hit, lastGoalHitDate = day 1. The app stays
    // open across midnight, so the cached base still holds day 1's total when
    // day 2's first short session starts. Unguarded, 10800 + 60 crossed the
    // goal and lastGoalHitDate !== today, so the notice fired spuriously.
    const staleBase = 10800;
    const liveSeconds = 60;
    const current = effectiveFocusBaseSeconds(staleBase, "2025-05-17", TODAY) + liveSeconds;
    expect(shouldFireGoalNotice(current, 120, true, "2025-05-17", TODAY)).toBe(false);
  });

  it("still fires once the fresh fetch crosses the goal for real", () => {
    // Later on day 2 the refetched base is today's own total and the goal is
    // genuinely met — the notice must not have been consumed by the rollover.
    expect(effectiveFocusBaseSeconds(7200, TODAY, TODAY)).toBe(7200);
    expect(shouldFireGoalNotice(7200, 120, true, "2025-05-17", TODAY)).toBe(true);
  });
});

describe("LogManager.writeLog — daily-log write robustness", () => {
  // logManager.ts uses Obsidian's global `moment`; stub it to a fixed instant so
  // the log filename and formatted line are deterministic.
  const FIXED = new Date("2025-12-23T10:00:00Z");

  beforeEach(() => {
    (globalThis as unknown as { moment: () => MomentLike }).moment = () => new TestMoment(FIXED);
  });

  afterEach(() => {
    delete (globalThis as unknown as { moment?: () => MomentLike }).moment;
    vi.restoreAllMocks();
  });

  // A finished short-break session avoids the focus-only task-name refresh path,
  // keeping the test focused on the file write.
  const runBreakSession = async (vault: unknown) => {
    const plugin = {
      settings: { logFolderPath: "Logs" },
      app: { vault },
    } as unknown as GentlePomoPlugin;
    const lm = new LogManager(plugin);
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    await lm.endSession("finished");
  };

  const expectedLine =
    "- ☕ Rest | Start:: 2025-12-23 10:00:00 | End:: 2025-12-23 10:00:00 | " +
    "Scheduled:: 300 | Total:: 0 | Type:: short-break";

  it("appends via the Vault API when the file is in the index", async () => {
    const file = Object.assign(new TFile(), {
      path: "Logs/2025-12-23-gentle-pomodoro-log.md",
    });
    const append = vi.fn().mockResolvedValue(undefined);
    const adapterAppend = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: adapterAppend },
      getAbstractFileByPath: vi.fn().mockReturnValue(file),
      append,
      create: vi.fn(),
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(append).toHaveBeenCalledWith(file, `\n${expectedLine}`);
    expect(adapterAppend).not.toHaveBeenCalled();
  });

  it("does NOT silently drop the line when the index lags the filesystem", async () => {
    // Index says "no such file" but create() rejects "already exists" because the
    // file is on disk — the old adapter.exists()+getAbstractFileByPath() mix
    // dropped the session here. We must fall back to adapter.append.
    const adapterAppend = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: adapterAppend },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockRejectedValue(new Error("File already exists.")),
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(adapterAppend).toHaveBeenCalledWith(
      "Logs/2025-12-23-gentle-pomodoro-log.md",
      `\n${expectedLine}`
    );
  });

  it("creates the file via the Vault API when it does not exist yet", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: vi.fn() },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create,
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(create).toHaveBeenCalledWith("Logs/2025-12-23-gentle-pomodoro-log.md", expectedLine);
  });

  it("creates the log folder when missing", async () => {
    const createFolder = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(false), append: vi.fn() },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      createFolder,
    };

    await runBreakSession(vault);

    expect(createFolder).toHaveBeenCalledWith("Logs");
  });

  it("does not throw out of endSession when every write attempt fails", async () => {
    // A write failure must not break the timer state machine — endSession resolves.
    const vault = {
      adapter: {
        exists: vi.fn().mockResolvedValue(true),
        append: vi.fn().mockRejectedValue(new Error("disk full")),
      },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockRejectedValue(new Error("File already exists.")),
      createFolder: vi.fn(),
    };

    await expect(runBreakSession(vault)).resolves.toBeUndefined();
  });
});
