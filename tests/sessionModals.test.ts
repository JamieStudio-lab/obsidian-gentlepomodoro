import { describe, it, expect, beforeEach } from "vitest";
import type { App } from "obsidian";
// The recording stubs, by path so `tsc` sees them (see tests/settingTab.test.ts).
import { FuzzySuggestModal, Modal, type RecordedComponent } from "../__mocks__/obsidian";
import {
  PickSessionModal,
  askSessionForm,
  type SessionFormOptions,
  type SessionTaskChoice,
} from "../sessionModals";
import { loggedLines, type LoggedLine, type SessionForm, type SessionTask } from "../logEditor";

/**
 * The session dialog (0.6.9, C6), run on the recording mock: what it hands
 * back, that it stays open on values it cannot save, and that every way out
 * settles. The rules for the values are logEditor's (tests/logEditor.test.ts).
 */

const FORM: SessionForm = {
  kind: "focus",
  task: null,
  date: "2026-10-02",
  time: "09:30",
  minutes: "25",
  status: "finished",
};

function open(set: Partial<SessionFormOptions> = {}) {
  let settled = false;
  const options: SessionFormOptions = {
    title: "Add a session",
    form: { ...FORM },
    submitText: "Add",
    canDelete: false,
    tasks: () => Promise.resolve([]),
    check: (form) => (form.minutes === "0" ? "Not a session." : null),
    ...set,
  };
  const answer = askSessionForm({} as App, options).then((value) => {
    settled = true;
    return value;
  });
  const modal = Modal.opened;
  if (!modal) throw new Error("the dialog did not open");
  const rows = modal.contentEl.settings;
  const field = (name: string): RecordedComponent => {
    const row = rows.find((r) => r.name === name);
    if (!row) throw new Error(`no row ${name}`);
    return row.components[0];
  };
  const button = (text: string): RecordedComponent => {
    const found = rows[rows.length - 1].components.find((c) => c.buttonText === text);
    if (!found) throw new Error(`no button ${text}`);
    return found;
  };
  const problem = () =>
    modal.contentEl.children.find((c) => c.classes.includes("gp-setting-note"))?.text;
  return { options, answer, modal, rows, field, button, problem, settled: () => settled };
}

beforeEach(() => {
  Modal.opened = null;
  FuzzySuggestModal.opened = null;
});

describe("the session dialog", () => {
  it("shows the six values it edits, filled from the form it was given", () => {
    const d = open({ form: { ...FORM, kind: "long-break", status: "cancelled" } });
    expect(d.rows.slice(0, 6).map((r) => r.name)).toEqual([
      "Kind",
      "Task",
      "Date",
      "Start time",
      "Active minutes",
      "Status",
    ]);
    expect(d.field("Kind").value).toBe("long-break");
    expect(d.field("Kind").options.map((o) => o.label)).toEqual([
      "Focus",
      "Short break",
      "Long break",
    ]);
    expect(d.field("Task").buttonText).toBe("No task");
    expect(d.field("Date").value).toBe("2026-10-02");
    expect(d.field("Start time").value).toBe("09:30");
    expect(d.field("Active minutes").value).toBe("25");
    expect(d.field("Status").value).toBe("cancelled");
    expect(d.field("Status").options.map((o) => o.label)).toEqual(["Finished", "Skipped"]);
  });

  it("hands back what was typed, and leaves the form it was given alone", async () => {
    const d = open();
    d.field("Kind").change?.("short-break" as never);
    d.field("Date").change?.("2026-10-01" as never);
    d.field("Start time").change?.("8:15" as never);
    d.field("Active minutes").change?.("5" as never);
    d.field("Status").change?.("cancelled" as never);
    d.button("Add").click?.();
    await expect(d.answer).resolves.toEqual({
      action: "save",
      form: {
        kind: "short-break",
        task: null,
        date: "2026-10-01",
        time: "8:15",
        minutes: "5",
        status: "cancelled",
      },
    });
    expect(d.options.form).toEqual(FORM);
  });

  it("stays open and says why when the values cannot be saved", async () => {
    const d = open();
    d.field("Active minutes").change?.("0" as never);
    d.button("Add").click?.();
    await Promise.resolve();
    expect(d.settled()).toBe(false);
    expect(d.problem()).toBe("Not a session.");
    // Fixed, it goes through, and the message clears.
    d.field("Active minutes").change?.("30" as never);
    d.button("Add").click?.();
    await expect(d.answer).resolves.toMatchObject({ action: "save", form: { minutes: "30" } });
    expect(d.problem()).toBe("");
  });

  it("picks a task from the list, or no task", async () => {
    const task: SessionTask = {
      name: "Write docs #task/develop/docs",
      path: "Docs.md",
      id: "d0c5",
    };
    const choices: SessionTaskChoice[] = [{ task, label: "Write docs" }];
    const d = open({ tasks: () => Promise.resolve(choices) });
    d.field("Task").click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const picker = FuzzySuggestModal.opened;
    if (!picker) throw new Error("the picker did not open");
    expect(picker.getItems().map((item) => picker.getItemText(item))).toEqual([
      "No task",
      "Write docs",
    ]);
    picker.onChooseItem(choices[0]);
    expect(d.field("Task").buttonText).toBe("Write docs #task/develop/docs");
    picker.onChooseItem(null);
    expect(d.field("Task").buttonText).toBe("No task");
    picker.onChooseItem(choices[0]);
    d.button("Add").click?.();
    await expect(d.answer).resolves.toMatchObject({ action: "save", form: { task } });
  });

  it("still opens the picker when the tasks cannot be read", async () => {
    const d = open({ tasks: () => Promise.reject(new Error("note unreadable")) });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      d.field("Task").click?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.warn = warn;
    }
    const picker = FuzzySuggestModal.opened;
    expect(picker?.getItems()).toEqual([null]);
  });

  it("offers Delete to a logged session only, styled destructive", async () => {
    const buttons = (d: ReturnType<typeof open>) =>
      d.rows[d.rows.length - 1].components.map((c) => c.buttonText);
    expect(buttons(open())).toEqual(["Cancel", "Add"]);
    const d = open({ canDelete: true, submitText: "Save" });
    expect(buttons(d)).toEqual(["Cancel", "Delete", "Save"]);
    expect(d.button("Delete").destructive).toBe(true);
    expect(d.button("Save").cta).toBe(true);
    d.button("Delete").click?.();
    await expect(d.answer).resolves.toEqual({ action: "delete" });
  });

  it("settles with nothing on Cancel and on every other way out", async () => {
    const cancelled = open();
    cancelled.button("Cancel").click?.();
    await expect(cancelled.answer).resolves.toBeNull();
    // Esc, the close button, a click outside: Obsidian closes the modal.
    const closed = open();
    closed.modal.close();
    await expect(closed.answer).resolves.toBeNull();
  });
});

describe("picking a logged session", () => {
  const day = (hour: string) =>
    `- 🍅 Focus [Task:: No Task] [Start:: 2026-10-02 ${hour}:00:00] [End:: 2026-10-02 ${hour}:25:00] [Scheduled:: 1500] [Pauses:: []] [Total:: 1500] [Status:: finished] [Type:: focus] [Overtime:: 0]`;
  const OCT_2 = loggedLines(`${day("09")}\n${day("11")}\n`);
  const OCT_1 = loggedLines(`${day("08").replace(/2026-10-02/g, "2026-10-01")}\n`);

  /** Until every pending read has landed. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function pickOn(
    logs: Record<string, LoggedLine[] | null>,
    read: (date: string) => Promise<LoggedLine[] | null> = (date) =>
      Promise.resolve(logs[date] ?? null)
  ) {
    const asked: string[] = [];
    const picked: [string, LoggedLine][] = [];
    new PickSessionModal({} as App, {
      date: "2026-10-02",
      sessionsOn: (date) => {
        asked.push(date);
        return read(date);
      },
      describe: (line) => `at ${String(line.index)}`,
      pick: (date, line) => {
        picked.push([date, line]);
      },
    }).open();
    const modal = Modal.opened;
    if (!modal) throw new Error("the list did not open");
    const dateBox = modal.contentEl.settings[0].components[0];
    const list = modal.contentEl.children[0];
    const rows = () => list.settings.map((row) => row.name);
    return { modal, dateBox, list, rows, asked, picked };
  }

  it("opens on its date and lists that day's sessions", async () => {
    const p = pickOn({ "2026-10-02": OCT_2 });
    expect(p.dateBox.value).toBe("2026-10-02");
    await settle();
    expect(p.asked).toEqual(["2026-10-02"]);
    expect(p.rows()).toEqual(["at 0", "at 1"]);
    expect(p.list.settings.map((row) => row.components[0].buttonText)).toEqual(["Edit", "Edit"]);
  });

  it("says so for a day with no log, or no sessions in it", async () => {
    const none = pickOn({});
    await settle();
    expect(none.rows()).toEqual([]);
    expect(none.list.paragraphs).toEqual(["No sessions logged on 2026-10-02."]);
    const empty = pickOn({ "2026-10-02": [] });
    await settle();
    expect(empty.list.paragraphs).toEqual(["No sessions logged on 2026-10-02."]);
  });

  it("follows the date box once it holds a whole date, and only then", async () => {
    const p = pickOn({ "2026-10-02": OCT_2, "2026-10-01": OCT_1 });
    await settle();
    for (const partial of ["2026-10-0", "2026-10-011", "x2026-10-01", "10/01/2026", "2026-1-01"]) {
      p.dateBox.change?.(partial as never);
    }
    await settle();
    expect(p.asked).toEqual(["2026-10-02"]);
    expect(p.rows()).toEqual(["at 0", "at 1"]);
    // Spaces around a whole date are not part of it.
    p.dateBox.change?.(" 2026-10-01 " as never);
    await settle();
    expect(p.asked).toEqual(["2026-10-02", "2026-10-01"]);
    expect(p.rows()).toEqual(["at 0"]);
    expect(p.list.paragraphs).toEqual([]);
  });

  it("shows the date typed last, whichever day's log is read first", async () => {
    const waiting = new Map<string, (lines: LoggedLine[] | null) => void>();
    const p = pickOn(
      {},
      (date) =>
        new Promise((resolve) => {
          waiting.set(date, resolve);
        })
    );
    p.dateBox.change?.("2026-10-01" as never);
    // The opening day's read lands after the newer one.
    waiting.get("2026-10-01")?.(OCT_1);
    await settle();
    waiting.get("2026-10-02")?.(OCT_2);
    await settle();
    expect(p.rows()).toEqual(["at 0"]);
  });

  it("says a day's log couldn't be opened, instead of leaving the last day listed", async () => {
    const p = pickOn({ "2026-10-02": OCT_2 }, (date) =>
      date === "2026-10-01"
        ? Promise.reject(new Error("locked"))
        : Promise.resolve(date === "2026-10-02" ? OCT_2 : null)
    );
    await settle();
    expect(p.rows()).toEqual(["at 0", "at 1"]);
    p.dateBox.change?.("2026-10-01" as never);
    await settle();
    expect(p.rows()).toEqual([]);
    expect(p.list.paragraphs).toEqual(["The log for 2026-10-01 couldn't be opened."]);
    // The next day that reads lists as usual.
    p.dateBox.change?.("2026-10-02" as never);
    await settle();
    expect(p.rows()).toEqual(["at 0", "at 1"]);
    expect(p.list.paragraphs).toEqual([]);
  });

  it("closes and hands over the line picked, with its day", async () => {
    const p = pickOn({ "2026-10-02": OCT_2 });
    await settle();
    p.list.settings[1].components[0].click?.();
    expect(p.picked).toEqual([["2026-10-02", OCT_2[1]]]);
    // Closed: a read landing now writes into nothing.
    expect(p.modal.contentEl.settings).toEqual([]);
  });
});
