import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import moment from "moment";
// The mock's Modal, by path so `tsc` sees `opened` (settingTab.test.ts explains
// why this is the module longSessionModal.ts imports under "obsidian").
import { Modal } from "../__mocks__/obsidian";
import { askLongSession } from "../longSessionModal";
import { clockLabel } from "../endTime";
import type { MomentFactory } from "../momentTypes";
import {
  LONG_SESSION_KEEP_LABEL,
  LONG_SESSION_PROMPT_HOURS,
  LONG_SESSION_TITLE,
  describeDuration,
  isLongSession,
  longSessionMessage,
  longSessionPlannedLabel,
  plannedSessionEnd,
  resolveLongSessionPromptHours,
  sleepPauseMessage,
} from "../sessionGaps";

describe("resolveLongSessionPromptHours", () => {
  it.each(LONG_SESSION_PROMPT_HOURS)("keeps %s, a choice the row offers", (hours) => {
    expect(resolveLongSessionPromptHours(hours)).toBe(hours);
  });

  it("keeps 0, which is off — never the default in disguise", () => {
    expect(resolveLongSessionPromptHours(0)).toBe(0);
  });

  it.each([5, 6.5, -2, 10, "6", null, undefined, Number.NaN])(
    "reads %s as the default, 6",
    (value) => {
      expect(resolveLongSessionPromptHours(value)).toBe(6);
    }
  );
});

describe("which sessions are asked about (Stop's question, and the startup's third answer)", () => {
  it("asks about a focus of the threshold or more that ran past its plan, and nothing else", () => {
    expect(isLongSession("focus", 6 * 3600, 1, 6)).toBe(true);
    expect(isLongSession("focus", 6 * 3600 - 1, 1, 6)).toBe(false);
    expect(isLongSession("focus", 9 * 3600, 0, 6)).toBe(false);
    expect(isLongSession("break", 9 * 3600, 3600, 6)).toBe(false);
    expect(isLongSession("focus", 9 * 3600, 3600, 0)).toBe(false);
    expect(isLongSession("focus", 2 * 3600, 60, 2)).toBe(true);
    // A stored value the row cannot show reads as the default, 6.
    expect(isLongSession("focus", 5 * 3600, 60, 5)).toBe(false);
  });

  it("ends the answer 'planned' where the plan was reached, with no Overtime", () => {
    expect(
      plannedSessionEnd({ activeSeconds: 9 * 3600, overtimeSeconds: 8 * 3600, plannedEndAt: 1234 })
    ).toEqual({ endAt: 1234, overtimeSeconds: 0 });
  });
});

describe("the wording", () => {
  it("writes a length as the status bar does", () => {
    expect(describeDuration(9 * 3600 + 47 * 60 + 59)).toBe("9h 47m");
    expect(describeDuration(3600)).toBe("1h 0m");
    expect(describeDuration(47 * 60)).toBe("47m");
    expect(describeDuration(59)).toBe("under a minute");
  });

  it("says how long a sleep was not counted", () => {
    expect(sleepPauseMessage((8 * 60 + 10) * 60_000 + 400)).toBe(
      "Gentle pomodoro: paused while your computer was asleep — 8h 10m not counted."
    );
  });

  it("asks about a 9h 47m focus as the design does", () => {
    expect(longSessionMessage(35_220, 33_720)).toBe(
      "This focus ran 9h 47m — 9h 22m past its planned end."
    );
    expect(longSessionPlannedLabel("09:25")).toBe("End at planned end (09:25)");
  });
});

describe("an instant as the session questions name it (F21)", () => {
  const m = moment as unknown as MomentFactory;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    moment.locale("en");
    // Friday 2 October 2026, 08:00.
    vi.setSystemTime(new Date(2026, 9, 2, 8, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is the bare time today", () => {
    expect(clockLabel(m, new Date(2026, 9, 2, 7, 25).getTime())).toBe("7:25 AM");
  });

  it("carries the weekday on another day: a focus left running overnight ended yesterday", () => {
    expect(clockLabel(m, new Date(2026, 9, 1, 17, 25).getTime())).toBe("Thu 5:25 PM");
    expect(longSessionPlannedLabel(clockLabel(m, new Date(2026, 9, 1, 17, 25).getTime()))).toBe(
      "End at planned end (Thu 5:25 PM)"
    );
  });
});

describe("the long-session dialog", () => {
  // Never read: the mock Modal keeps it and nothing else.
  const app = {} as never;
  const prompt = { message: "This focus ran 9h 47m.", plannedLabel: "End at planned end (09:25)" };

  beforeEach(() => {
    Modal.opened = null;
  });

  /** The dialog just opened, and its two buttons in order. */
  function opened() {
    const modal = Modal.opened;
    if (modal === null) throw new Error("no dialog opened");
    const content = modal.contentEl;
    const buttons = content.settings.flatMap((row) => row.components);
    return { modal, content, buttons };
  }

  it("shows the question and the two answers", () => {
    void askLongSession(app, prompt);
    const { modal, content, buttons } = opened();
    expect(modal.titleEl.text).toBe(LONG_SESSION_TITLE);
    expect(modal.modalEl.classes).toContain("gp-confirm-modal");
    expect(content.paragraphs).toEqual([prompt.message]);
    expect(buttons.map((b) => b.buttonText)).toEqual([
      LONG_SESSION_KEEP_LABEL,
      prompt.plannedLabel,
    ]);
  });

  it.each([
    [0, "keep"],
    [1, "planned"],
  ])("button %s answers %s", async (index, answer) => {
    const asked = askLongSession(app, prompt);
    opened().buttons[index].click?.();
    await expect(asked).resolves.toBe(answer);
  });

  it("closing it any other way — Esc, ×, a click outside — answers cancel", async () => {
    const asked = askLongSession(app, prompt);
    opened().modal.close();
    await expect(asked).resolves.toBe("cancel");
  });

  it("is held in the plugin's open dialogs only while it is open, so unload can close it (F19)", async () => {
    const open = new Set<InstanceType<typeof Modal>>();
    const asked = askLongSession(app, prompt, open);
    const { modal } = opened();
    expect([...open]).toEqual([modal]);
    modal.close();
    expect(open.size).toBe(0);
    await expect(asked).resolves.toBe("cancel");
  });
});

describe("the plugin's wiring", () => {
  // The engine calls these two through the plugin, and its tests stub both, so
  // nothing above reaches the lines that put up the notice and the dialog.
  // main.ts is read as text, comments stripped, as for the other wiring: an
  // import of "../main" finds the built main.js first wherever one was built.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

  it.each([
    ["Notice", "obsidian"],
    ["askLongSession", "./longSessionModal"],
    ["sleepPauseMessage", "./sessionGaps"],
    ["longSessionMessage", "./sessionGaps"],
    ["longSessionPlannedLabel", "./sessionGaps"],
    ["clockLabel", "./endTime"],
  ])("takes %s from %s", (name, from) => {
    const imports = [...main.matchAll(/import \{([^}]*)\} from "([^"]+)";/g)];
    const source = imports.find(([, names]) => names.split(",").some((n) => n.trim() === name));
    expect(source?.[2]).toBe(from);
  });

  it("shows the sleep notice with the gap it was given", () => {
    expect(main).toContain(
      "notifySleepPause(gapMs: number): void { new Notice(sleepPauseMessage(gapMs)); }"
    );
  });

  it("asks with the session's own lengths and planned end, and hands back the answer", () => {
    // The planned end with its weekday when it was not today (F21), and the
    // dialog held where unload closes it (F19).
    expect(main).toContain(
      "askAboutLongSession(question: LongSessionQuestion): Promise<LongSessionAnswer> { " +
        "return askLongSession( this.app, { " +
        "message: longSessionMessage(question.activeSeconds, question.overtimeSeconds), " +
        "plannedLabel: longSessionPlannedLabel(clockLabel(moment, question.plannedEndAt)), " +
        "}, this.sessionDialogs ); }"
    );
  });

  it("names the unfinished session's start the same way (F21)", () => {
    // Its planned end too, when it offers to log up to it (F18).
    expect(main).toContain(
      "recoveryMessage( saved.mode, clockLabel(moment, saved.startMs), savedSessionSeconds(saved, (ms) => moment(ms)), long && { overtimeSeconds: long.overtimeSeconds, plannedEndLabel: clockLabel(moment, long.plannedEndAt), } ), plannedEnd: long !== null, }, this.sessionDialogs"
    );
  });

  it("closes the session questions still open at unload, before anything is disposed (F19)", () => {
    const unload = main.slice(
      main.indexOf("override onunload()"),
      main.indexOf("async activateView()")
    );
    const close = unload.indexOf("for (const dialog of [...this.sessionDialogs]) dialog.close();");
    expect(close).toBeGreaterThan(-1);
    expect(close).toBeLessThan(unload.indexOf("this.logManager.dispose();"));
    expect(close).toBeLessThan(unload.indexOf("this.timer.dispose();"));
  });
});
