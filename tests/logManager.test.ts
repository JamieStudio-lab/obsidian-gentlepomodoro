import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { TFile } from "obsidian";
// The recording Notice, imported from the mock by path so `tsc` sees its
// `shown` list (tests/settingTab.test.ts explains why this is the same module).
import { Notice } from "../__mocks__/obsidian";
import {
  appendToLog,
  effectiveFocusBaseSeconds,
  lastLogLine,
  shouldFireGoalNotice,
  LogManager,
} from "../logManager";
import { UNWRITTEN_LINES_KEY, UNWRITTEN_LINE_NOTICE, readUnwrittenLines } from "../sessionRecovery";
import { memoryStorage } from "./memoryStorage";
import { formatLogLine, parseFocusTotalSeconds, parseLogLine, type SessionLog } from "../logLine";
import type GentlePomoPlugin from "../main";
import type { MomentLike } from "../momentTypes";
import { fakeVault, linkCache, type FakeVault } from "./fakeVault";

// Minimal moment-like stub with what logLine.ts uses. UTC throughout, so test
// output doesn't depend on the host timezone; `locale` is recorded but, like
// the "en" moment stamp asks for, formats in ASCII.
class TestMoment implements MomentLike {
  constructor(public date: Date) {}

  format(fmt: string): string {
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");
    return fmt
      .replace("YYYY", String(this.date.getUTCFullYear()))
      .replace("MM", pad(this.date.getUTCMonth() + 1))
      .replace("DD", pad(this.date.getUTCDate()))
      .replace("HH", pad(this.date.getUTCHours()))
      .replace("mm", pad(this.date.getUTCMinutes()))
      .replace("ss", pad(this.date.getUTCSeconds()));
  }

  diff(other: MomentLike): number {
    return this.date.getTime() - other.valueOf();
  }
  valueOf(): number {
    return this.date.getTime();
  }
  hour(): number {
    return this.date.getUTCHours();
  }
  clone(): MomentLike {
    return new TestMoment(new Date(this.date.getTime()));
  }
  locale(_: string): MomentLike {
    return this;
  }
  subtract(n: number, unit: string): MomentLike {
    const ms = unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("d") ? n * 86_400_000 : n;
    return new TestMoment(new Date(this.date.getTime() - ms));
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

const focus = (overrides: Partial<SessionLog> = {}): SessionLog => ({
  mode: "focus",
  taskName: "Write docs",
  taskPath: "Projects/Docs.md",
  scheduledDurationMinutes: 25,
  startTime: m("2025-12-23T10:00:00"),
  endTime: m("2025-12-23T10:25:00"),
  pauses: [],
  status: "finished",
  ...overrides,
});

// The schema users' Dataview queries are pinned to. 0.6.9 moved every field
// into brackets (version 2) — the names, their order and the value text are
// version 1's, with Overtime added at the end of a focus line.
describe("formatLogLine — focus (version 2)", () => {
  it("formats a finished focus session with task link and ID", () => {
    expect(formatLogLine(focus({ taskId: "abc123" }))).toBe(
      "- 🍅 Focus [Task:: [[Projects/Docs.md|Write docs]]] [ID:: abc123] " +
        "[Start:: 2025-12-23 10:00:00] [End:: 2025-12-23 10:25:00] " +
        "[Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] " +
        "[Overtime:: 0]"
    );
  });

  it("omits ID when not present", () => {
    const line = formatLogLine(focus());
    expect(line).not.toContain("ID::");
    expect(line).toContain("[Task:: [[Projects/Docs.md|Write docs]]] [Start:: ");
  });

  it("uses plain text instead of wiki-link when no path is given", () => {
    expect(formatLogLine(focus({ taskPath: undefined }))).toContain("[Task:: Write docs] [Start::");
  });

  it("writes 'No Task' for an unlinked session", () => {
    expect(formatLogLine(focus({ taskName: "No Task", taskPath: undefined }))).toContain(
      "[Task:: No Task] [Start::"
    );
    expect(formatLogLine(focus({ taskName: "", taskPath: undefined }))).toContain(
      "[Task:: No Task] [Start::"
    );
  });

  it("links a task that is literally called 'No Task' (unlinked is no path, not a name)", () => {
    expect(formatLogLine(focus({ taskName: "No Task", taskId: "abc123" }))).toContain(
      "[Task:: [[Projects/Docs.md|No Task]]] [ID:: abc123]"
    );
  });

  it("subtracts pause duration from Total", () => {
    const line = formatLogLine(
      focus({
        endTime: m("2025-12-23T10:30:00"), // 30 minutes wall-clock
        pauses: [{ start: m("2025-12-23T10:10:00"), end: m("2025-12-23T10:15:00") }], // 5 min paused
      })
    );
    // 30 min - 5 min pause = 25 min = 1500s
    expect(line).toContain("[Total:: 1500]");
  });

  it("serializes pause intervals as JSON array of formatted ranges", () => {
    const line = formatLogLine(
      focus({
        endTime: m("2025-12-23T10:30:00"),
        pauses: [{ start: m("2025-12-23T10:10:00"), end: m("2025-12-23T10:15:00") }],
      })
    );
    expect(line).toContain('[Pauses:: ["2025-12-23 10:10:00 - 2025-12-23 10:15:00"]]');
  });

  it("emits 'cancelled' status when set", () => {
    expect(formatLogLine(focus({ status: "cancelled" }))).toContain("[Status:: cancelled]");
  });

  it("works Total out from the written seconds, so a line balances exactly", () => {
    // 10:00:00.900 → 10:25:00.100 is 1499.2 s, and up to 0.6.8 it read 1499
    // beside a Start and End 1500 s apart. A pause cut the same way.
    expect(
      formatLogLine(
        focus({
          startTime: m("2025-12-23T10:00:00.900"),
          endTime: m("2025-12-23T10:25:00.100"),
        })
      )
    ).toContain("[Total:: 1500]");
    expect(
      formatLogLine(
        focus({
          startTime: m("2025-12-23T10:00:00.900"),
          endTime: m("2025-12-23T10:30:00.100"),
          pauses: [{ start: m("2025-12-23T10:10:00.100"), end: m("2025-12-23T10:15:00.900") }],
        })
      )
    ).toContain("[Total:: 1500]");
  });

  it("never writes a negative Total (a clock stepped back mid-session)", () => {
    const line = formatLogLine(
      focus({ startTime: m("2025-12-23T10:10:00"), endTime: m("2025-12-23T09:00:00") })
    );
    expect(line).toContain("[Total:: 0]");
  });

  it("writes the overtime it is given, in whole seconds and never below 0", () => {
    expect(formatLogLine(focus({ overtimeSeconds: 312.9 }))).toMatch(/\[Overtime:: 312\]$/);
    expect(formatLogLine(focus({ overtimeSeconds: -5 }))).toMatch(/\[Overtime:: 0\]$/);
    expect(formatLogLine(focus({ overtimeSeconds: Number.NaN }))).toMatch(/\[Overtime:: 0\]$/);
  });

  it("puts the task name through the sanitizer, tags kept", () => {
    expect(
      formatLogLine(focus({ taskName: "Read [[Some Paper]] [draft] x:: y #task/research/x" }))
    ).toContain("[Task:: [[Projects/Docs.md|Read Some Paper (draft) x: y #task/research/x]]]");
  });
});

describe("formatLogLine — break (version 2)", () => {
  const rest = (overrides: Partial<SessionLog> = {}): SessionLog => ({
    mode: "break",
    taskName: "No Task",
    scheduledDurationMinutes: 5,
    startTime: m("2025-12-23T10:25:00"),
    endTime: m("2025-12-23T10:30:00"),
    pauses: [],
    status: "finished",
    breakType: "short",
    ...overrides,
  });

  it("emits the shorter rest format with short-break Type", () => {
    expect(formatLogLine(rest())).toBe(
      "- ☕ Rest [Start:: 2025-12-23 10:25:00] [End:: 2025-12-23 10:30:00] " +
        "[Scheduled:: 300] [Total:: 300] [Type:: short-break]"
    );
  });

  it("emits long-break Type when breakType is 'long'", () => {
    expect(
      formatLogLine(
        rest({
          scheduledDurationMinutes: 15,
          startTime: m("2025-12-23T11:00:00"),
          endTime: m("2025-12-23T11:15:00"),
          breakType: "long",
        })
      )
    ).toBe(
      "- ☕ Rest [Start:: 2025-12-23 11:00:00] [End:: 2025-12-23 11:15:00] " +
        "[Scheduled:: 900] [Total:: 900] [Type:: long-break]"
    );
  });

  it("defaults to short-break when breakType is missing", () => {
    expect(formatLogLine(rest({ breakType: undefined }))).toContain("[Type:: short-break]");
  });

  it("carries no Overtime, even when given one", () => {
    expect(formatLogLine(rest({ overtimeSeconds: 60 }))).not.toContain("Overtime");
  });
});

describe("parseFocusTotalSeconds", () => {
  const v2 = (total: number, status = "finished", name = "A") =>
    `- 🍅 Focus [Task:: ${name}] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] ` +
    `[Scheduled:: 1500] [Pauses:: []] [Total:: ${total}] [Status:: ${status}] [Type:: focus] [Overtime:: 0]`;
  const v1 = (total: number, status = "finished", name = "A") =>
    `- 🍅 Focus | Task:: ${name} | Start:: 2026-10-02 10:00:00 | End:: 2026-10-02 10:25:00 | ` +
    `Scheduled:: 1500 | Pauses:: [] | Total:: ${total} | Status:: ${status} | Type:: focus`;

  it("sums Total across all focus lines (version 2)", () => {
    const content = [
      v2(1500),
      "- ☕ Rest [Start:: 2026-10-02 10:25:00] [End:: 2026-10-02 10:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]",
      v2(1200),
    ].join("\n");
    expect(parseFocusTotalSeconds(content)).toBe(2700);
  });

  it("sums Total across all focus lines (version 1, every earlier version)", () => {
    const content = [
      "- 🍅 Focus | Task:: A | Start:: ... | Total:: 1500 | Status:: finished",
      "- ☕ Rest | Start:: ... | Total:: 300",
      "- 🍅 Focus | Task:: B | Start:: ... | Total:: 1200 | Status:: finished",
    ].join("\n");

    expect(parseFocusTotalSeconds(content)).toBe(2700);
  });

  it("adds up a file holding both formats the same as either alone", () => {
    // The transition: today's file may start in version 1 and continue in 2.
    expect(parseFocusTotalSeconds([v1(1500), v2(1200), v1(600, "cancelled")].join("\n"))).toBe(
      2700
    );
    expect(parseFocusTotalSeconds([v2(1500), v1(1200), v2(600, "cancelled")].join("\n"))).toBe(
      2700
    );
  });

  it("reads the lines of a CRLF file", () => {
    expect(parseFocusTotalSeconds([v1(1500), v2(1200), ""].join("\r\n"))).toBe(2700);
  });

  it("reads the oldest lines too: a checkbox before the marker, no ID, no Type", () => {
    const content = [
      "- [x] 🍅 Focus | Task:: A | Start:: 2025-12-20 08:15:10 | End:: 2025-12-20 08:16:10 | Scheduled:: 1500 | Pauses:: [] | Total:: 60 | Status:: finished",
      "- [ ] ☕ Rest | Start:: 2025-12-20 21:40:00 | End:: 2025-12-20 21:40:05 | Scheduled:: 300 | Total:: 5",
    ].join("\n");
    expect(parseFocusTotalSeconds(content)).toBe(60);
  });

  it("excludes cancelled focus lines from the total (skipped sessions are forfeited)", () => {
    // Skip = discard: a skipped session's minutes count toward neither the
    // meter nor the goal notice. Stop logs `finished` and still counts.
    const content = [
      "- 🍅 Focus | Task:: A | Start:: ... | Total:: 1500 | Status:: finished",
      "- 🍅 Focus | Task:: B | Start:: ... | Total:: 600 | Status:: cancelled",
      v2(900, "cancelled"),
    ].join("\n");

    expect(parseFocusTotalSeconds(content)).toBe(1500);
  });

  it("counts focus lines without a Status:: field (hand-edited entries)", () => {
    // Only an explicit `cancelled` is excluded — manual additions keep working.
    expect(parseFocusTotalSeconds("- 🍅 Focus | Task:: A | Start:: ... | Total:: 900")).toBe(900);
    expect(parseFocusTotalSeconds("- 🍅 Focus [Task:: A] [Total:: 900]")).toBe(900);
  });

  it("reads the line's own Total and Status, not ones inside the task name", () => {
    // Up to 0.6.8 the first "Total::" anywhere won, so a task called
    // "Write report [Total:: 7]" counted 7 s, and "Status:: cancelled" in a
    // name dropped a finished session.
    for (const line of [v1, v2]) {
      expect(parseFocusTotalSeconds(line(1500, "finished", "Write report [Total:: 7]"))).toBe(1500);
      expect(parseFocusTotalSeconds(line(1500, "finished", "Triage [Status:: cancelled] x"))).toBe(
        1500
      );
    }
    expect(
      parseFocusTotalSeconds(v1(1500, "finished", "Odd | Total:: 7 | Status:: cancelled"))
    ).toBe(1500);
  });

  it("ignores rest lines and lines without a Total:: field", () => {
    const content = [
      "- ☕ Rest | Start:: ... | Total:: 300",
      "- ☕ Rest [Start:: 2026-10-02 10:25:00] [Total:: 300]",
      "Some notes here.",
      "A line that mentions 🍅 Focus | Total:: 900 but is not a session",
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
  // the log filename and formatted line are deterministic. Each session ends
  // five minutes in (endSession's endAt): one under a minute writes no line.
  const FIXED = new Date("2025-12-23T10:00:00Z");
  const END = FIXED.getTime() + 5 * 60_000;

  beforeEach(() => {
    (globalThis as unknown as { moment: (at?: number) => MomentLike }).moment = (at?: number) =>
      new TestMoment(at === undefined ? FIXED : new Date(at));
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
    await lm.endSession("finished", { endAt: END });
  };

  const expectedLine =
    "- ☕ Rest [Start:: 2025-12-23 10:00:00] [End:: 2025-12-23 10:05:00] " +
    "[Scheduled:: 300] [Total:: 300] [Type:: short-break]";

  it("appends through Vault.process when the file is in the index (F39)", async () => {
    const file = Object.assign(new TFile(), {
      path: "Logs/2025-12-23-gentle-pomodoro-log.md",
    });
    let content = "- earlier line";
    const process = vi.fn((_: TFile, fn: (data: string) => string) => {
      content = fn(content);
      return Promise.resolve(content);
    });
    const append = vi.fn();
    const adapterAppend = vi.fn();
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: adapterAppend },
      getAbstractFileByPath: vi.fn().mockReturnValue(file),
      process,
      append,
      create: vi.fn(),
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(process).toHaveBeenCalledTimes(1);
    expect(content).toBe(`- earlier line\n${expectedLine}\n`);
    expect(append).not.toHaveBeenCalled();
    expect(adapterAppend).not.toHaveBeenCalled();
  });

  it("falls back to the adapter when the index lags the filesystem", async () => {
    // Index says "no such file" but create() rejects "already exists" because the
    // file is on disk — the old adapter.exists()+getAbstractFileByPath() mix
    // dropped the session here. We must fall back to adapter.append.
    const adapterAppend = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue("- earlier line"),
        append: adapterAppend,
      },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockRejectedValue(new Error("File already exists.")),
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(adapterAppend).toHaveBeenCalledWith(
      "Logs/2025-12-23-gentle-pomodoro-log.md",
      `\n${expectedLine}\n`
    );
  });

  it("creates a new file ending in a line break (F39)", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: vi.fn() },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create,
      createFolder: vi.fn(),
    };

    await runBreakSession(vault);

    expect(create).toHaveBeenCalledWith(
      "Logs/2025-12-23-gentle-pomodoro-log.md",
      `${expectedLine}\n`
    );
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

  it("invalidates the plugin focus-total TTL when a focus line lands", async () => {
    // The goal notice fires from the refetch landing; this invalidation is what
    // makes that refetch happen at the session boundary (with the end bell)
    // instead of up to a TTL later.
    const invalidate = vi.fn();
    const vault = {
      adapter: { exists: vi.fn().mockResolvedValue(true), append: vi.fn() },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn(),
    };
    const plugin = {
      settings: { logFolderPath: "Logs" },
      app: { vault },
      invalidateFocusTotalCache: invalidate,
    } as unknown as GentlePomoPlugin;
    const lm = new LogManager(plugin);

    // A skipped (cancelled) focus session invalidates too — its line is still
    // written, and the prompt refetch is what drops the forfeited minutes from
    // the meter right away.
    lm.startSession("focus", "No Task", 25);
    await lm.endSession("cancelled", { endAt: END });
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Break sessions don't touch the focus-total caches.
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    await lm.endSession("finished", { endAt: END });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not throw out of endSession when every write attempt fails", async () => {
    // A write failure must not break the timer state machine — endSession resolves.
    const vault = {
      adapter: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue(""),
        append: vi.fn().mockRejectedValue(new Error("disk full")),
      },
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      append: vi.fn(),
      create: vi.fn().mockRejectedValue(new Error("File already exists.")),
      createFolder: vi.fn(),
    };

    Notice.shown.length = 0;
    await expect(runBreakSession(vault)).resolves.toBeUndefined();
    expect(Notice.shown.some((s) => s.includes("couldn't write the session log"))).toBe(true);
  });
});

describe("appendToLog and lastLogLine (F39)", () => {
  it("adds a line break in front only when the text does not end in one", () => {
    expect(appendToLog("", ["a"])).toBe("a\n");
    expect(appendToLog("x", ["a"])).toBe("x\na\n");
    // A file an editor or sync tool ended with a line break: no blank line.
    expect(appendToLog("x\n", ["a"])).toBe("x\na\n");
  });

  it("keeps a CRLF file CRLF, lines and ending alike", () => {
    expect(appendToLog("x\r\n", ["a", "b"])).toBe("x\r\na\r\nb\r\n");
    expect(appendToLog("x\r\ny", ["a"])).toBe("x\r\ny\r\na\r\n");
  });

  it("joins several lines with the file's line ending, and adds nothing for none", () => {
    expect(appendToLog("x", ["a", "b"])).toBe("x\na\nb\n");
    expect(appendToLog("x", [])).toBe("x");
  });

  it("finds the last line that is not blank", () => {
    expect(lastLogLine("a\nb\n\n")).toBe("b");
    expect(lastLogLine("a\r\nb\r\n")).toBe("b");
    expect(lastLogLine("\n \n")).toBeNull();
  });
});

describe("LogManager — writing the log through failures (F38, F53)", () => {
  // A disk and an index that can disagree, as on mobile and after a sync:
  // `indexed` is what getAbstractFileByPath sees, `disk` what the adapter
  // does. create() is exists-then-write, as Obsidian's is.
  const PATH = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const FIXED = new Date("2026-10-02T10:00:00Z");

  beforeEach(() => {
    (globalThis as unknown as { moment: (at?: number) => MomentLike }).moment = (at?: number) =>
      new TestMoment(at === undefined ? FIXED : new Date(at));
    Notice.shown.length = 0;
  });
  afterEach(() => {
    delete (globalThis as unknown as { moment?: () => MomentLike }).moment;
    vi.restoreAllMocks();
  });

  function disk(files: Record<string, string> = {}, indexed: string[] = Object.keys(files)) {
    const contents = new Map(Object.entries(files));
    const index = new Set(indexed);
    const fileAt = (path: string) => Object.assign(new TFile(), { path });
    const vault = {
      contents,
      index,
      getAbstractFileByPath: (path: string) => (index.has(path) ? fileAt(path) : null),
      process: vi.fn((file: TFile, fn: (data: string) => string) => {
        const next = fn(contents.get(file.path) ?? "");
        contents.set(file.path, next);
        return Promise.resolve(next);
      }),
      create: vi.fn((path: string, data: string) => {
        if (contents.has(path)) return Promise.reject(new Error("File already exists."));
        contents.set(path, data);
        index.add(path);
        return Promise.resolve(fileAt(path));
      }),
      createFolder: vi.fn((_path: string) => Promise.resolve()),
      adapter: {
        exists: vi.fn((path: string) => Promise.resolve(path === "Logs" || contents.has(path))),
        read: vi.fn((path: string) => Promise.resolve(contents.get(path) ?? "")),
        append: vi.fn((path: string, data: string) => {
          contents.set(path, (contents.get(path) ?? "") + data);
          return Promise.resolve();
        }),
      },
    };
    return vault;
  }

  function manager(vault: unknown, storage = memoryStorage()) {
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour: 0 },
      app: { vault },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    return { lm: new LogManager(plugin, { storage, plannedMs: () => null }), storage, plugin };
  }

  /** A five-minute break, ended `minute` minutes past 10:00. */
  async function breakEndingAt(lm: LogManager, minute: number) {
    const start = FIXED.getTime() + (minute - 5) * 60_000;
    (globalThis as unknown as { moment: (at?: number) => MomentLike }).moment = (at?: number) =>
      new TestMoment(new Date(at === undefined ? start : at));
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    await lm.endSession("finished", { endAt: start + 5 * 60_000 });
  }
  const restLine = (minute: number) =>
    `- ☕ Rest [Start:: 2026-10-02 10:${String(minute - 5).padStart(2, "0")}:00] ` +
    `[End:: 2026-10-02 10:${String(minute).padStart(2, "0")}:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]`;

  it("keeps a CRLF file CRLF when it appends to it", async () => {
    const vault = disk({ [PATH]: "- earlier\r\n" });
    await breakEndingAt(manager(vault).lm, 10);
    expect(vault.contents.get(PATH)).toBe(`- earlier\r\n${restLine(10)}\r\n`);
  });

  it("does not append a line a timed-out create has already written (F38)", async () => {
    // The create's write landed, then the adapter's 60 s kill rejected it.
    // The fallback used to append the same line again, counting it twice.
    const vault = disk();
    vault.create.mockImplementationOnce((path: string, data: string) => {
      vault.contents.set(path, data);
      return Promise.reject(new Error("File system operation timed out."));
    });
    await breakEndingAt(manager(vault).lm, 10);
    expect(vault.adapter.append).not.toHaveBeenCalled();
    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n`);
  });

  it("does not append a split session's lines a timed-out create has already written (F38)", async () => {
    // A split session writes its lines as one block. The fallback has to
    // compare the block's LAST line with the file's; compared by its first,
    // a block that landed reads as missing and is appended a second time.
    const vault = disk();
    vault.create.mockImplementationOnce((path: string, data: string) => {
      vault.contents.set(path, data);
      return Promise.reject(new Error("File system operation timed out."));
    });
    const { lm, plugin } = manager(vault);
    plugin.settings.taskSwitchLogging = "split";
    let now = FIXED.getTime();
    (globalThis as unknown as { moment: (at?: number) => MomentLike }).moment = (at?: number) =>
      new TestMoment(new Date(at === undefined ? now : at));
    lm.startSession("focus", "Task A", 25);
    now += 10 * 60_000;
    lm.updateTask("Task B");
    now += 15 * 60_000;
    expect(await lm.endSession("finished", { endAt: now })).toBe(true);

    const written = (vault.contents.get(PATH) ?? "").split("\n").filter((line) => line !== "");
    expect(written.map((line) => parseLogLine(line)?.task?.name)).toEqual(["Task A", "Task B"]);
    expect(vault.adapter.append).not.toHaveBeenCalled();
  });

  it("falls back only when the file is there: any other failure keeps the line", async () => {
    const vault = disk();
    vault.create.mockImplementationOnce(() => Promise.reject(new Error("EACCES")));
    const { lm, storage } = manager(vault);
    await breakEndingAt(lm, 10);
    expect(vault.adapter.read).not.toHaveBeenCalled();
    expect(vault.adapter.append).not.toHaveBeenCalled();
    expect(vault.contents.has(PATH)).toBe(false);
    expect(storage.load(UNWRITTEN_LINES_KEY)).toEqual([
      { path: PATH, folder: "Logs", lines: [restLine(10)], focus: false },
    ]);
  });

  it("keeps a line that cannot be written, says so, and puts the line in the console (F53)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const vault = disk();
    vault.create.mockImplementation(() => Promise.reject(new Error("EACCES")));
    const { lm, storage } = manager(vault);
    await breakEndingAt(lm, 10);

    expect(Notice.shown).toEqual([UNWRITTEN_LINE_NOTICE]);
    expect(String(error.mock.calls[0]?.[0])).toContain(restLine(10));
    expect(readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY))).toHaveLength(1);
  });

  it("writes a kept line before the next one, and forgets it once written", async () => {
    const vault = disk();
    vault.create.mockImplementationOnce(() => Promise.reject(new Error("EACCES")));
    const { lm, storage } = manager(vault);
    await breakEndingAt(lm, 10);
    await breakEndingAt(lm, 20);

    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n${restLine(20)}\n`);
    expect(storage.load(UNWRITTEN_LINES_KEY)).toBeNull();
    expect(Notice.shown).toContain(
      "Gentle pomodoro: wrote 1 session line(s) that couldn't be written earlier."
    );
  });

  it("writes kept lines at the next start, from this device's storage", async () => {
    const storage = memoryStorage();
    const failing = disk();
    failing.create.mockImplementation(() => Promise.reject(new Error("EACCES")));
    await breakEndingAt(manager(failing, storage).lm, 10);

    // Obsidian restarts; the folder can be written now.
    const vault = disk();
    const written = await manager(vault, storage).lm.retryUnwrittenLines();
    expect(written).toBe(1);
    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n`);
    expect(storage.load(UNWRITTEN_LINES_KEY)).toBeNull();
  });

  it("does not write a kept line again that landed after all", async () => {
    // A write reported as failed whose data reached the disk anyway (F38's
    // timeout): the retry finds the line in the file and leaves it there once.
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      { path: PATH, folder: "Logs", lines: [restLine(10), restLine(20)], focus: false },
    ]);
    const vault = disk({ [PATH]: `${restLine(10)}\n` });
    expect(await manager(vault, storage).lm.retryUnwrittenLines()).toBe(2);
    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n${restLine(20)}\n`);
  });

  it("runs one retry at a time: a second call while one runs joins it", async () => {
    // Startup and a session's own write can both ask at once. Two runs would
    // each take the first kept entry, and each drop one for it — so the
    // second entry was dropped without being written.
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      { path: PATH, folder: "Logs", lines: [restLine(10)], focus: false },
      { path: PATH, folder: "Logs", lines: [restLine(20)], focus: false },
    ]);
    const vault = disk();
    const { lm } = manager(vault, storage);

    const first = lm.retryUnwrittenLines();
    const second = lm.retryUnwrittenLines();
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([2, 2]);
    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n${restLine(20)}\n`);
    expect(storage.load(UNWRITTEN_LINES_KEY)).toBeNull();
    expect(Notice.shown).toEqual([
      "Gentle pomodoro: wrote 2 session line(s) that couldn't be written earlier.",
    ]);
    // Settled, the next call is a run of its own.
    const next = lm.retryUnwrittenLines();
    expect(next).not.toBe(first);
    expect(await next).toBe(0);
  });

  it("keeps a kept line that still fails, and still writes the new one", async () => {
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      {
        path: "Old/2026-10-01-gentle-pomodoro-log.md",
        folder: "Old",
        lines: ["- kept"],
        focus: false,
      },
    ]);
    const vault = disk();
    vault.createFolder.mockImplementation(() => Promise.reject(new Error("read-only")));
    const { lm } = manager(vault, storage);
    await breakEndingAt(lm, 10);
    expect(vault.contents.get(PATH)).toBe(`${restLine(10)}\n`);
    expect(readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY))).toEqual([
      {
        path: "Old/2026-10-01-gentle-pomodoro-log.md",
        folder: "Old",
        lines: ["- kept"],
        focus: false,
      },
    ]);
  });

  it("never lets a retry that throws stop the session's own line", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      { path: PATH, folder: "Logs", lines: ["- x"], focus: true },
    ]);
    const vault = disk();
    const { lm, plugin } = manager(vault, storage);
    (plugin as unknown as { invalidateFocusTotalCache: () => void }).invalidateFocusTotalCache =
      () => {
        throw new Error("gone");
      };
    await expect(lm.retryUnwrittenLines()).resolves.toBe(0);
    storage.save(UNWRITTEN_LINES_KEY, null);
    await breakEndingAt(lm, 10);
    expect(vault.contents.get(PATH)).toBe(`- x\n${restLine(10)}\n`);
  });

  it("tells the user the line will be tried again (F53)", () => {
    // The wording is the promise: the Notice is all a phone user sees, and
    // the old one sent them to check a folder that was fine.
    expect(UNWRITTEN_LINE_NOTICE).toMatch(/try again/i);
    expect(UNWRITTEN_LINE_NOTICE).not.toMatch(/check the log folder/i);
  });

  it("marks a kept focus line as focus, so today's total is read again once it lands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const vault = disk();
    vault.create.mockImplementationOnce(() => Promise.reject(new Error("EACCES")));
    const { lm, storage } = manager(vault);
    const start = FIXED.getTime();
    lm.startSession("focus", "No Task", 25);
    await lm.endSession("finished", { endAt: start + 25 * 60_000 });
    const kept = readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY));
    expect(kept).toHaveLength(1);
    expect(kept[0].focus).toBe(true);
  });

  it("stops at the first kept entry that still fails, keeping it and the ones after it, in order", async () => {
    // Written out of order, a later line would land above an earlier one in
    // a day's file; dropped, it would be lost.
    const storage = memoryStorage();
    const first = {
      path: "Old/2026-10-01-gentle-pomodoro-log.md",
      folder: "Old",
      lines: ["- first"],
      focus: false,
    };
    const second = { path: PATH, folder: "Logs", lines: ["- second"], focus: false };
    storage.save(UNWRITTEN_LINES_KEY, [first, second]);
    const vault = disk();
    vault.createFolder.mockImplementation((path: string) =>
      path === "Old" ? Promise.reject(new Error("read-only")) : Promise.resolve()
    );
    const { lm } = manager(vault, storage);
    expect(await lm.retryUnwrittenLines()).toBe(0);
    expect(vault.contents.has(PATH)).toBe(false);
    expect(readUnwrittenLines(storage.load(UNWRITTEN_LINES_KEY))).toEqual([first, second]);
  });

  it("retries through the adapter fallback without repeating a line the file holds anywhere", async () => {
    // The file is on disk but the index lags (so create says "already
    // exists"), and another device has appended a later line since the kept
    // ones landed: the last-line check alone would append them again.
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      { path: PATH, folder: "Logs", lines: [restLine(10), restLine(20)], focus: false },
    ]);
    const landed = `${restLine(10)}\n${restLine(20)}\n${restLine(30)}\n`;
    const vault = disk({ [PATH]: landed }, []);
    expect(await manager(vault, storage).lm.retryUnwrittenLines()).toBe(2);
    expect(vault.adapter.append).not.toHaveBeenCalled();
    expect(vault.contents.get(PATH)).toBe(landed);
  });

  it("reads today's total again once a kept focus line is written", async () => {
    const storage = memoryStorage();
    storage.save(UNWRITTEN_LINES_KEY, [
      { path: PATH, folder: "Logs", lines: ["- x"], focus: true },
    ]);
    const { lm, plugin } = manager(disk(), storage);
    await lm.retryUnwrittenLines();
    expect(plugin.invalidateFocusTotalCache).toHaveBeenCalledTimes(1);
  });

  it("does not read today's total again after a write that failed — only once the line lands", async () => {
    // A failed write put nothing on disk, so a re-read would find the old
    // total; the read belongs to the moment the kept line is written.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const vault = disk();
    vault.create.mockImplementationOnce(() => Promise.reject(new Error("EACCES")));
    const { lm, plugin } = manager(vault);
    lm.startSession("focus", "No Task", 25);
    await lm.endSession("finished", { endAt: FIXED.getTime() + 25 * 60_000 });
    expect(plugin.invalidateFocusTotalCache).not.toHaveBeenCalled();

    expect(await lm.retryUnwrittenLines()).toBe(1);
    expect(plugin.invalidateFocusTotalCache).toHaveBeenCalledTimes(1);
  });
});

describe("LogManager.refreshLoggedTaskNamesById", () => {
  // The command re-reads each logged task with a 🆔 from its line, so renames
  // reach old logs. The line also carries the 🍅 counter's count, which is not
  // a rename: up to 0.6.8 the command wrote the current count into every line.
  // It asks first (tests/taskIdentity.test.ts drives the dialog); here every
  // run is confirmed.
  const line = (name: string, id: string) =>
    `- 🍅 Focus | Task:: [[Projects/Docs.md|${name}]] | ID:: ${id} | Start:: 2026-09-30 09:00:00 | ` +
    "End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | " +
    "Status:: finished | Type:: focus";
  const yes = () => Promise.resolve(true);
  const managerFor = (vault: FakeVault) =>
    new LogManager({
      settings: { logFolderPath: "Logs" },
      app: { vault, metadataCache: linkCache(vault) },
    } as unknown as GentlePomoPlugin);

  it("renames a line whose task was renamed, and leaves one that differs only by the count", async () => {
    const before = [
      line("Write docs", "abc123"),
      line("Write docs 🍅 4", "abc123"),
      line("Old name", "abc123"),
      line("Read paper", "def456"),
    ].join("\n");
    const vault = fakeVault({
      "Projects/Docs.md":
        "- [ ] Write docs 🍅 9 🆔 abc123 ⏳ 2026-10-01\n- [ ] Read paper 🆔 def456\n",
      "Logs/2026-09-30-gentle-pomodoro-log.md": before,
    });
    Notice.shown.length = 0;

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents["Logs/2026-09-30-gentle-pomodoro-log.md"]).toBe(
      [
        line("Write docs", "abc123"),
        line("Write docs 🍅 4", "abc123"),
        line("Write docs 🍅 9", "abc123"),
        line("Read paper", "def456"),
      ].join("\n")
    );
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
  });

  const v2Line = (name: string, id: string) =>
    `- 🍅 Focus [Task:: [[Projects/Docs.md|${name}]]] [ID:: ${id}] [Start:: 2026-10-02 09:00:00] ` +
    "[End:: 2026-10-02 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
    "[Status:: finished] [Type:: focus] [Overtime:: 0]";

  it("renames version 2 lines too, each line kept in its own format", async () => {
    const vault = fakeVault({
      "Projects/Docs.md": "- [ ] Write the docs 🆔 abc123\n",
      "Logs/2026-10-02-gentle-pomodoro-log.md": [
        line("Write docs", "abc123"),
        v2Line("Write docs", "abc123"),
      ].join("\n"),
    });
    Notice.shown.length = 0;

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents["Logs/2026-10-02-gentle-pomodoro-log.md"]).toBe(
      [line("Write the docs", "abc123"), v2Line("Write the docs", "abc123")].join("\n")
    );
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 2 line(s) in 1 file(s)."]);
  });

  it("leaves a line whose name differs only by the count when the name has brackets or '::'", async () => {
    // The line holds the name sanitized — (bug), "a: b" — and the task has
    // [bug] and "a:: b". Compared raw, that read as a rename and wrote the
    // current count into the line, which is what 0.6.9 stopped.
    const vault = fakeVault({
      "Projects/Docs.md": "- [ ] Fix [bug] a:: b 🍅 9 🆔 abc123\n",
      "Logs/2026-10-02-gentle-pomodoro-log.md": v2Line("Fix (bug) a: b 🍅 4", "abc123"),
    });
    const confirm = vi.fn(yes);
    Notice.shown.length = 0;

    await managerFor(vault).refreshLoggedTaskNamesById(confirm);

    expect(vault.contents["Logs/2026-10-02-gentle-pomodoro-log.md"]).toBe(
      v2Line("Fix (bug) a: b 🍅 4", "abc123")
    );
    expect(vault.writes).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual(["Gentle pomodoro: no task names to update."]);
  });

  it("leaves a version 1 line's raw brackets alone unless the task was renamed", async () => {
    // Older versions wrote the name raw. Read as written it never matched the
    // sanitized task name, so every such line took the current count.
    const vault = fakeVault({
      "Projects/Docs.md": "- [ ] Fix [bug] a:: b 🍅 9 🆔 abc123\n- [ ] Read [[P]] now 🆔 def456\n",
      "Logs/2026-09-30-gentle-pomodoro-log.md": [
        line("Fix [bug] a:: b 🍅 4", "abc123"),
        line("Read [[P]] 🍅 2", "def456"),
      ].join("\n"),
    });
    Notice.shown.length = 0;

    await managerFor(vault).refreshLoggedTaskNamesById(yes);

    expect(vault.contents["Logs/2026-09-30-gentle-pomodoro-log.md"]).toBe(
      [line("Fix [bug] a:: b 🍅 4", "abc123"), line("Read P now", "def456")].join("\n")
    );
    expect(Notice.shown).toEqual(["Gentle pomodoro: updated 1 line(s) in 1 file(s)."]);
  });
});

describe("LogManager.updateLoggedTaskName — both formats", () => {
  const v1 = (name: string, id: string) =>
    `- 🍅 Focus | Task:: [[Projects/Docs.md|${name}]] | ID:: ${id} | Start:: 2026-09-30 09:00:00 | ` +
    "End:: 2026-09-30 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus";
  const v2 = (name: string, id: string) =>
    `- 🍅 Focus [Task:: [[Projects/Docs.md|${name}]]] [ID:: ${id}] [Start:: 2026-10-02 09:00:00] ` +
    "[End:: 2026-10-02 09:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
    "[Status:: finished] [Type:: focus] [Overtime:: 0]";
  const REST =
    "- ☕ Rest [Start:: 2026-10-02 09:25:00] [End:: 2026-10-02 09:30:00] [Scheduled:: 300] [Total:: 300] [Type:: short-break]";
  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";

  const rename = async (before: string[], name: string) => {
    const vault = fakeVault({ "Projects/Docs.md": "", [LOG]: before.join("\n") });
    const plugin = {
      settings: { logFolderPath: "Logs" },
      app: { vault, metadataCache: linkCache(vault) },
    } as unknown as GentlePomoPlugin;
    await new LogManager(plugin).updateLoggedTaskName({
      taskId: "abc123",
      name,
      taskPath: "Projects/Docs.md",
      createdDate: null,
      line: `- [ ] ${name} 🆔 abc123`,
      copies: [],
    });
    return vault.contents[LOG].split("\n");
  };

  it("rewrites the 🆔's lines in their own format and nothing else", async () => {
    const after = await rename(
      [
        v1("Old", "abc123"),
        v2("Old", "abc123"),
        v1("Other", "def456"),
        v2("Other", "abc1234"),
        REST,
      ],
      "New name"
    );
    expect(after).toEqual([
      v1("New name", "abc123"),
      v2("New name", "abc123"),
      v1("Other", "def456"),
      v2("Other", "abc1234"),
      REST,
    ]);
  });

  it("writes the name through the sanitizer, and '$' patterns as they are", async () => {
    const after = await rename(
      [v1("Old", "abc123"), v2("Old", "abc123")],
      "Read [[P]] [x] $& $1 a:: b"
    );
    expect(after).toEqual([
      v1("Read P (x) $& $1 a: b", "abc123"),
      v2("Read P (x) $& $1 a: b", "abc123"),
    ]);
  });

  it("keeps the link when the new name is 'No Task' (unlinked is no path)", async () => {
    const after = await rename([v2("Old", "abc123")], "No Task");
    expect(after).toEqual([v2("No Task", "abc123")]);
  });
});

describe("LogManager — the day a session is filed under (real moment)", () => {
  // The locale files register on the instance they require, so moment and its
  // locales both come through require.
  const require = createRequire(import.meta.url);
  const realMoment = require("moment") as { locale(key?: string): string };
  require("moment/locale/ar");
  realMoment.locale("en");

  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = realMoment;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
    realMoment.locale("en");
  });

  const at = (d: number, h: number, mi: number) => vi.setSystemTime(new Date(2026, 9, d, h, mi, 0));

  function writable(files: Record<string, string> = {}, dayStartHour?: number) {
    const vault = fakeVault(files);
    const created: string[] = [];
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true), append: vi.fn() },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        return Promise.resolve();
      },
      create: (path: string, data: string) => {
        created.push(path);
        vault.contents[path] = data;
        return Promise.resolve();
      },
      createFolder: vi.fn(),
    });
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour },
      app: { vault },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    return { vault, created, lm: new LogManager(plugin) };
  }

  it.each([
    [0, "Logs/2026-10-03-gentle-pomodoro-log.md"],
    [4, "Logs/2026-10-02-gentle-pomodoro-log.md"],
    [undefined, "Logs/2026-10-03-gentle-pomodoro-log.md"],
  ])("files a session started at 01:30 with the day starting at %s in %s", async (hour, path) => {
    const { vault, created, lm } = writable({}, hour);
    at(3, 1, 30);
    lm.startSession("focus", "No Task", 25);
    at(3, 1, 55);
    await lm.endSession("finished");

    expect(created).toEqual([path]);
    // The line keeps the calendar time it started at.
    expect(vault.contents[path]).toContain(
      "[Start:: 2026-10-03 01:30:00] [End:: 2026-10-03 01:55:00]"
    );
  });

  it("names the file and stamps the line in English digits whatever the app language", async () => {
    const { vault, created, lm } = writable();
    realMoment.locale("ar");
    at(2, 10, 0);
    lm.startSession("focus", "No Task", 25);
    at(2, 10, 25);
    await lm.endSession("finished", { overtimeSeconds: 0 });

    expect(created).toEqual(["Logs/2026-10-02-gentle-pomodoro-log.md"]);
    expect(vault.contents[created[0]]).toBe(
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:25:00] " +
        "[Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]\n"
    );
  });

  it("writes the overtime endSession is given", async () => {
    const { vault, created, lm } = writable();
    at(2, 10, 0);
    lm.startSession("focus", "No Task", 25);
    at(2, 10, 30);
    await lm.endSession("finished", { overtimeSeconds: 300 });
    expect(vault.contents[created[0]]).toMatch(
      /\[Total:: 1800\] \[Status:: finished\] \[Type:: focus\] \[Overtime:: 300\]\n$/
    );
  });

  const mixed = [
    "- 🍅 Focus | Task:: A | Start:: 2026-10-02 09:00:00 | End:: 2026-10-02 09:25:00 | Scheduled:: 1500 | Pauses:: [] | Total:: 1500 | Status:: finished | Type:: focus",
    "- 🍅 Focus [Task:: B] [Start:: 2026-10-02 10:00:00] [End:: 2026-10-02 10:20:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1200] [Status:: finished] [Type:: focus] [Overtime:: 0]",
    "- 🍅 Focus [Task:: C] [Start:: 2026-10-02 11:00:00] [End:: 2026-10-02 11:10:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 600] [Status:: cancelled] [Type:: focus] [Overtime:: 0]",
  ].join("\n");

  it("totals today's file whatever format its lines are in", async () => {
    const { lm } = writable({ "Logs/2026-10-02-gentle-pomodoro-log.md": mixed });
    at(2, 12, 0);
    expect(await lm.getTodayFocusSeconds()).toBe(2700);
  });

  it("reads yesterday's file for today until the day starts", async () => {
    const files = { "Logs/2026-10-02-gentle-pomodoro-log.md": mixed };
    at(3, 2, 0);
    expect(await writable(files, 4).lm.getTodayFocusSeconds()).toBe(2700);
    expect(await writable(files, 0).lm.getTodayFocusSeconds()).toBe(0);
  });

  describe("on the day 0.6.9 is installed under a language with its own digits (F4)", () => {
    // 0.6.8 named the file, and wrote Start and End, in the app language's
    // digits; Total was always English digits.
    const nativeFile = "Logs/٢٠٢٦-١٠-٠٢-gentle-pomodoro-log.md";
    const morning =
      "- 🍅 Focus | Task:: No Task | Start:: ٢٠٢٦-١٠-٠٢ ٠٩:٠٠:٠٠ | End:: ٢٠٢٦-١٠-٠٢ ٠٩:٤٥:٠٠ | " +
      "Scheduled:: 1500 | Pauses:: [] | Total:: 2700 | Status:: finished | Type:: focus";
    const afternoon =
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 13:00:00] [End:: 2026-10-02 13:25:00] " +
      "[Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]";

    it("counts the morning's file 0.6.8 named in those digits", async () => {
      const { lm } = writable({ [nativeFile]: morning });
      realMoment.locale("ar");
      at(2, 11, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(2700);
    });

    it("adds it to the file the timer writes now, so the meter loses neither", async () => {
      const { lm } = writable({
        [nativeFile]: morning,
        "Logs/2026-10-02-gentle-pomodoro-log.md": afternoon,
      });
      realMoment.locale("ar");
      at(2, 14, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(4200);
    });

    it("reads the English-digit file once where the language writes English digits", async () => {
      const { lm } = writable({ "Logs/2026-10-02-gentle-pomodoro-log.md": afternoon });
      at(2, 14, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(1500);
    });
  });
});

describe("LogManager — how a session ends (0.6.9)", () => {
  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = createRequire(import.meta.url)("moment");
    vi.useFakeTimers({ toFake: ["Date"] });
    Notice.shown.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const at = (h: number, mi: number, s = 0) => vi.setSystemTime(new Date(2026, 9, 2, h, mi, s));
  const time = (h: number, mi: number, s = 0) => new Date(2026, 9, 2, h, mi, s).getTime();

  function manager(files: Record<string, string> = {}) {
    const vault = fakeVault({ [LOG]: "", ...files });
    Object.assign(vault, {
      adapter: { exists: () => Promise.resolve(true), append: vi.fn() },
      append: (file: TFile, data: string) => {
        vault.contents[file.path] += data;
        return Promise.resolve();
      },
      create: vi.fn(),
      createFolder: vi.fn(),
    });
    const plugin = {
      settings: { logFolderPath: "Logs", dayStartHour: 0 },
      app: { vault },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin & { invalidateFocusTotalCache: () => void };
    const lines = () => vault.contents[LOG].split("\n").filter(Boolean);
    return { vault, plugin, lm: new LogManager(plugin), lines };
  }

  it("writes nothing under a minute and says it did not count (F59)", async () => {
    const { lm, lines } = manager();
    at(9, 0, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 0, 59);
    expect(await lm.endSession("finished")).toBe(false);
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    at(9, 1, 30);
    expect(await lm.endSession("finished")).toBe(false);
    expect(lines()).toEqual([]);
    expect(lm.openSessionDay()).toBeNull();
  });

  it("writes a minute and says it counted; nothing open says it did not", async () => {
    const { lm, lines } = manager();
    expect(await lm.endSession("finished")).toBe(false);
    at(9, 0, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 1, 0);
    expect(await lm.endSession("finished")).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(parseLogLine(lines()[0])?.values.get("Total")).toBe("60");
  });

  it("with no log folder, writes nothing but a whole session still counts", async () => {
    // The 🍅 and the long-break count do not depend on keeping a log.
    const { lm, plugin, vault } = manager();
    plugin.settings.logFolderPath = "";
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 25);
    expect(await lm.endSession("finished")).toBe(true);
    expect(vault.contents[LOG]).toBe("");
  });

  it("judges a minute by active time, as Total does", async () => {
    const { lm, lines } = manager();
    at(9, 0, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 0, 40);
    lm.pauseSession();
    at(9, 30, 0);
    lm.resumeSession();
    at(9, 30, 19);
    expect(await lm.endSession("finished")).toBe(false);
    expect(lines()).toEqual([]);
  });

  it("ends at endAt: an open pause closes there, and pauses after it are cut (F3)", async () => {
    const { lm, lines } = manager();
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 10);
    lm.pauseSession();
    at(9, 15);
    lm.resumeSession();
    at(9, 20);
    lm.pauseSession();
    at(11, 0);
    await lm.endSession("finished", { endAt: time(9, 22), overtimeSeconds: 0 });
    const parsed = parseLogLine(lines()[0]);
    expect(parsed?.values.get("End")).toBe("2026-10-02 09:22:00");
    expect(parsed?.values.get("Pauses")).toBe(
      JSON.stringify([
        "2026-10-02 09:10:00 - 2026-10-02 09:15:00",
        "2026-10-02 09:20:00 - 2026-10-02 09:22:00",
      ])
    );
    expect(parsed?.values.get("Total")).toBe(String(15 * 60));
  });

  it("drops a pause that began at or after endAt", async () => {
    const { lm, lines } = manager();
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 30);
    lm.pauseSession();
    at(10, 0);
    await lm.endSession("finished", { endAt: time(9, 25) });
    const parsed = parseLogLine(lines()[0]);
    expect(parsed?.values.get("Pauses")).toBe("[]");
    expect(parsed?.values.get("Total")).toBe("1500");
  });

  it("never resumes across modes: a stray focus is dropped when a break starts (F21)", async () => {
    const { lm, lines } = manager();
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 30);
    lm.startSession("break", "No Task", 5, undefined, undefined, "short");
    at(9, 35);
    await lm.endSession("finished");
    expect(lines()).toHaveLength(1);
    expect(parseLogLine(lines()[0])).toMatchObject({ kind: "rest" });
    expect(parseLogLine(lines()[0])?.values.get("Start")).toBe("2026-10-02 09:30:00");
  });

  it("still resumes the same mode from a pause", async () => {
    const { lm, lines } = manager();
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 10);
    lm.pauseSession();
    at(9, 15);
    lm.startSession("focus", "No Task", 25);
    at(9, 30);
    await lm.endSession("finished");
    const parsed = parseLogLine(lines()[0]);
    expect(parsed?.values.get("Start")).toBe("2026-10-02 09:00:00");
    expect(parsed?.values.get("Total")).toBe("1500");
  });

  it("closes the session even when the end throws, so the next one starts fresh (F22)", async () => {
    const { lm, plugin, lines } = manager();
    plugin.invalidateFocusTotalCache = () => {
      throw new Error("boom");
    };
    at(9, 0);
    lm.startSession("focus", "No Task", 25);
    at(9, 25);
    await expect(lm.endSession("finished")).rejects.toThrow("boom");
    expect(lm.openSessionDay()).toBeNull();

    plugin.invalidateFocusTotalCache = () => {};
    at(10, 0);
    lm.startSession("focus", "No Task", 25);
    at(10, 25);
    await lm.endSession("finished");
    expect(parseLogLine(lines()[1])?.values.get("Start")).toBe("2026-10-02 10:00:00");
  });

  it("logs the linked name when the task's note cannot be read (F22)", async () => {
    const { lm, vault, lines } = manager({ "Projects/Docs.md": "- [ ] Renamed 🆔 abc123\n" });
    vault.read = () => Promise.reject(new Error("File system operation timed out."));
    at(9, 0);
    lm.startSession("focus", "Write docs", 25, "Projects/Docs.md", "abc123");
    at(9, 25);
    expect(await lm.endSession("finished")).toBe(true);
    expect(parseLogLine(lines()[0])?.task?.name).toBe("Write docs");
  });

  it("discards without a trace, and knows the day an open session is filed under", async () => {
    const { lm, plugin, lines } = manager();
    vi.setSystemTime(new Date(2026, 9, 3, 1, 30));
    lm.startSession("focus", "No Task", 25);
    expect(lm.openSessionDay()).toBe("2026-10-03");
    plugin.settings.dayStartHour = 4;
    expect(lm.openSessionDay()).toBe("2026-10-02");
    lm.discardSession();
    expect(lm.openSessionDay()).toBeNull();
    expect(await lm.endSession("finished")).toBe(false);
    expect(lines()).toEqual([]);
  });
});

describe("LogManager on a real clock — what a session writes (F18, F27–F30, F32, F45–F47)", () => {
  // A real LogManager on real moment and a fake Date, writing a fake vault.
  // Until 0.6.9 nothing drove its state machine, its write or today's total
  // this way, and a mutant of each passed every test (F58).
  let previousMoment: unknown;
  beforeEach(() => {
    const g = globalThis as unknown as { moment?: unknown };
    previousMoment = g.moment;
    g.moment = createRequire(import.meta.url)("moment");
    vi.useFakeTimers({ toFake: ["Date"] });
    Notice.shown.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (globalThis as unknown as { moment?: unknown }).moment = previousMoment;
  });

  const LOG = "Logs/2026-10-02-gentle-pomodoro-log.md";
  const at = (h: number, mi: number, day = 2) => vi.setSystemTime(new Date(2026, 9, day, h, mi, 0));

  /** A vault that can make files and folders, on top of fakeVault. `created`
   *  lists every file made; `writes` (fakeVault's) every one changed. */
  function writable(files: Record<string, string> = {}, logFolderPath = "Logs") {
    const base = fakeVault(files);
    const created: string[] = [];
    const vault = Object.assign(base, {
      adapter: {
        exists: vi.fn((_path: string) => Promise.resolve(true)),
        read: (path: string) => Promise.resolve(base.contents[path] ?? ""),
        append: vi.fn((path: string, data: string) => {
          base.contents[path] = (base.contents[path] ?? "") + data;
          return Promise.resolve();
        }),
      },
      create: vi.fn((path: string, data: string) => {
        created.push(path);
        base.contents[path] = data;
        return Promise.resolve();
      }),
      createFolder: vi.fn((_path: string) => Promise.resolve()),
    });
    const plugin = {
      settings: { logFolderPath, dayStartHour: 0 },
      app: { vault, metadataCache: linkCache(base) },
      invalidateFocusTotalCache: vi.fn(),
    } as unknown as GentlePomoPlugin;
    return { vault, created, plugin, lm: new LogManager(plugin) };
  }

  /** The one session line `path` holds, read. */
  function onlyLine(vault: FakeVault, path = LOG) {
    const lines = (vault.contents[path] ?? "").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    return parseLogLine(lines[0]);
  }

  describe("the session state machine (F18, F27)", () => {
    it("pause then resume: Start kept, the pause listed once, Total without it", async () => {
      const { vault, lm } = writable();
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 10);
      lm.pauseSession();
      at(10, 15);
      lm.startSession("focus", "No Task", 25); // what the engine's start() does on a resume
      at(10, 30);
      await lm.endSession("finished");

      const line = onlyLine(vault);
      expect(line?.values.get("Start")).toBe("2026-10-02 10:00:00");
      expect(line?.values.get("Pauses")).toBe('["2026-10-02 10:10:00 - 2026-10-02 10:15:00"]');
      expect(line?.values.get("Total")).toBe("1500");
    });

    it("ending while paused closes the pause at the end", async () => {
      const { vault, lm } = writable();
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 20);
      lm.pauseSession();
      at(10, 30);
      await lm.endSession("finished");

      const line = onlyLine(vault);
      expect(line?.values.get("End")).toBe("2026-10-02 10:30:00");
      expect(line?.values.get("Pauses")).toBe('["2026-10-02 10:20:00 - 2026-10-02 10:30:00"]');
      expect(line?.values.get("Total")).toBe("1200");
    });

    it("writes the status it is given", async () => {
      // Skip hands in "cancelled", which leaves the session out of the goal.
      const { vault, lm } = writable();
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 12);
      await lm.endSession("cancelled");
      expect(onlyLine(vault)?.values.get("Status")).toBe("cancelled");
    });

    it("a task picked mid-session is the one logged, its note and 🆔 too", async () => {
      // Start first, pick the task after: a common way to begin, and until
      // 0.6.9 only a stub had seen updateTask called.
      const { vault, lm } = writable({ "Projects/Docs.md": "- [ ] Write docs 🆔 abc123\n" });
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      lm.updateTask("Write docs", "Projects/Docs.md", "abc123");
      at(10, 25);
      await lm.endSession("finished");

      const line = onlyLine(vault);
      expect(line?.task).toMatchObject({ path: "Projects/Docs.md", name: "Write docs" });
      expect(line?.values.get("ID")).toBe("abc123");
    });
  });

  describe("the write (F30, F32, F45, F46)", () => {
    it("takes a rename made while nothing watched the note", async () => {
      // The automatic rename follows a task only while it is linked; the line
      // itself reads the name off the 🆔's line as it is written (F32).
      const { vault, lm } = writable({ "Projects/Docs.md": "- [ ] Write the docs 🆔 abc123\n" });
      at(10, 0);
      lm.startSession("focus", "Write docs", 25, "Projects/Docs.md", "abc123");
      at(10, 25);
      await lm.endSession("finished");
      expect(onlyLine(vault)?.task?.name).toBe("Write the docs");
    });

    it("files a session that crosses midnight under the day it STARTED", async () => {
      // The reviews rebuild the path from the date; 29 real sessions crossed
      // midnight, every one in its start day's file (F45).
      const { vault, created, lm } = writable();
      at(23, 50, 1);
      lm.startSession("focus", "No Task", 25);
      at(0, 15, 2);
      await lm.endSession("finished");
      expect(created).toEqual(["Logs/2026-10-01-gentle-pomodoro-log.md"]);
      expect(onlyLine(vault, created[0])?.values.get("End")).toBe("2026-10-02 00:15:00");
    });

    it("writes nothing, anywhere, with no log folder set — and the session still counts", async () => {
      // The shipped default. An empty path is the vault root to normalizePath,
      // so a missing guard wrote every session there (F46).
      const { vault, created, lm } = writable({}, "");
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 25);
      expect(await lm.endSession("finished")).toBe(true);
      expect(created).toEqual([]);
      expect(vault.writes).toEqual([]);
      expect(vault.createFolder).not.toHaveBeenCalled();
    });

    it("keeps the line when a sync makes the folder between the check and createFolder", async () => {
      // Obsidian's createFolder checks again itself and throws "Folder already
      // exists." — the first session in a freshly synced vault (F30).
      const { vault, lm } = writable();
      vault.adapter.exists.mockResolvedValueOnce(false);
      vault.createFolder.mockRejectedValueOnce(new Error("Folder already exists."));
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 25);
      await lm.endSession("finished");
      expect(onlyLine(vault)?.values.get("Total")).toBe("1500");
      expect(Notice.shown).toEqual([]);
    });

    it("writes no file when the folder cannot be made: the line is kept, and the user told", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { vault, created, lm } = writable();
      vault.adapter.exists.mockResolvedValue(false);
      vault.createFolder.mockRejectedValue(new Error("EACCES"));
      at(10, 0);
      lm.startSession("focus", "No Task", 25);
      at(10, 25);
      await lm.endSession("finished");
      expect(created).toEqual([]);
      expect(Notice.shown).toEqual([UNWRITTEN_LINE_NOTICE]);
    });
  });

  describe("today's total (F28, F29)", () => {
    const focusLine = (total: number) =>
      "- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 09:00:00] [End:: 2026-10-02 09:25:00] " +
      `[Scheduled:: 1500] [Pauses:: []] [Total:: ${total}] [Status:: finished] [Type:: focus] [Overtime:: 0]`;

    it("does not serve yesterday's total after midnight, even inside the cache's 30 s", async () => {
      // The plugin's tracker stamps whatever this returns as today's, so a
      // stale answer here fed yesterday's hours to the goal notice at 00:00.
      const { lm } = writable({
        "Logs/2026-10-01-gentle-pomodoro-log.md": focusLine(5400),
        [LOG]: focusLine(600),
      });
      vi.setSystemTime(new Date(2026, 9, 1, 23, 59, 50));
      expect(await lm.getTodayFocusSeconds()).toBe(5400);
      vi.setSystemTime(new Date(2026, 9, 2, 0, 0, 5));
      expect(await lm.getTodayFocusSeconds()).toBe(600);
    });

    it("reads the file again once the cache runs out, and at once after invalidateTodayTotal", async () => {
      const { vault, lm } = writable({ [LOG]: focusLine(600) });
      at(10, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(600);

      // A session lands: the write invalidates, and the total is read again now.
      vault.contents[LOG] += `\n${focusLine(900)}`;
      lm.invalidateTodayTotal();
      expect(await lm.getTodayFocusSeconds()).toBe(1500);

      // Changed by hand: the cached total until the cache runs out.
      vault.contents[LOG] += `\n${focusLine(100)}`;
      expect(await lm.getTodayFocusSeconds()).toBe(1500);
      at(10, 5);
      expect(await lm.getTodayFocusSeconds()).toBe(1600);
    });

    it("a folder with no file today reads 0, and keeps reading 0 from the cache", async () => {
      const { lm, plugin } = writable({ [LOG]: focusLine(600) });
      at(10, 0);
      expect(await lm.getTodayFocusSeconds()).toBe(600);
      plugin.settings.logFolderPath = "Elsewhere";
      lm.invalidateTodayTotal();
      expect(await lm.getTodayFocusSeconds()).toBe(0);
      expect(await lm.getTodayFocusSeconds()).toBe(0);
    });
  });

  describe("the rewrites with no log folder set (F47)", () => {
    const logged =
      "- 🍅 Focus [Task:: [[Projects/A.md|Old]]] [ID:: abc123] [Start:: 2026-09-01 10:00:00] " +
      "[End:: 2026-09-01 10:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] " +
      "[Status:: finished] [Type:: focus] [Overtime:: 0]";
    const files = { "Daily/2026-09-01.md": logged, "Projects/A.md": "- [ ] New 🆔 abc123\n" };

    it("a rename writes nothing, anywhere", async () => {
      // Held twice over: the folder check, and filesInFolder, which finds no
      // folder at an empty path. Either alone holds it, so the mutant run
      // lists dropping the check as equivalent.
      const { vault, lm } = writable(files, "");
      await lm.updateLoggedTaskName({
        taskId: "abc123",
        name: "New",
        taskPath: "Projects/A.md",
        createdDate: null,
        line: "- [ ] New 🆔 abc123",
        copies: [],
      });
      expect(vault.writes).toEqual([]);
    });

    it("Refresh says so and writes nothing", async () => {
      const { vault, lm } = writable(files, "");
      const confirm = vi.fn(() => Promise.resolve(true));
      await lm.refreshLoggedTaskNamesById(confirm);
      expect(vault.writes).toEqual([]);
      expect(confirm).not.toHaveBeenCalled();
      expect(Notice.shown).toEqual(["Gentle pomodoro: log folder path is not set."]);
    });
  });
});
