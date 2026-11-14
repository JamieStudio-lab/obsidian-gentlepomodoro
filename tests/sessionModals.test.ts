import { describe, it, expect, beforeEach } from "vitest";
import type { App } from "obsidian";
// The recording stubs, by path so `tsc` sees them (see tests/settingTab.test.ts).
import {
  FuzzySuggestModal,
  Modal,
  Platform,
  clickEl,
  type ModalContent,
  type RecordedComponent,
  type StubEl,
} from "../__mocks__/obsidian";
import { FACE_LABELS, FOCUS_NOTE_PROMPTS, NOTE_DRAFT_MAX } from "../focusNote";
import {
  FOCUS_NOTE_FACES_LABEL,
  FOCUS_NOTE_TEXT_LABEL,
  FOCUS_NOTE_TITLE,
  saveShortcutText,
} from "../focusNoteCard";
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

describe("the focus note box in the session dialog", () => {
  const box = (d: ReturnType<typeof open>): ModalContent => {
    const found = d.modal.contentEl.children.find((c) => c.classes.includes("gp-fix-note"));
    if (!found) throw new Error("no box");
    return found;
  };
  const parts = (d: ReturnType<typeof open>) =>
    d.modal.contentEl.children.filter((c) => c.classes.includes("gp-fix-note"));
  const inBox = (d: ReturnType<typeof open>, cls: string): StubEl[] =>
    box(d).elements.filter((el) => el.classes.includes(cls));
  const one = (d: ReturnType<typeof open>, cls: string): StubEl => {
    const [el] = inBox(d, cls);
    return el;
  };
  const face = (d: ReturnType<typeof open>, name: string): StubEl => {
    const found = inBox(d, "gp-note-face").find((el) => el.attrs["data-face"] === name);
    if (!found) throw new Error(`no face ${name}`);
    return found;
  };
  const pressed = (d: ReturnType<typeof open>) =>
    inBox(d, "gp-note-face")
      .filter((el) => el.attrs["aria-pressed"] === "true")
      .map((el) => el.attrs["data-face"]);
  const type = (d: ReturnType<typeof open>, text: string) => {
    const area = one(d, "gp-note-text");
    area.value = text;
    for (const listener of area.listeners.input ?? []) listener({} as never);
  };
  /** A keydown on the box; says whether it was prevented. */
  const key = (d: ReturnType<typeof open>, set: Partial<KeyboardEvent>) => {
    let prevented = false;
    const event = {
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: () => (prevented = true),
      ...set,
    };
    for (const listener of one(d, "gp-note-text").listeners.keydown ?? []) listener(event as never);
    return prevented;
  };
  const NOTE = { face: null, text: "" };
  const withNote = (note: SessionForm["note"] = NOTE) => ({ form: { ...FORM, note } });

  it("builds the card's own parts, so the card's rules apply", () => {
    const d = open(withNote());
    expect(box(d).classes).toEqual(["gp-note", "gp-note-in-modal", "gp-fix-note"]);
    const title = one(d, "gp-note-title");
    expect(title.tag).toBe("div");
    expect(box(d).paragraphs).toEqual([FOCUS_NOTE_TITLE]);
    expect(FOCUS_NOTE_TITLE).toBe("Focus note");
    expect(one(d, "gp-note-form").tag).toBe("div");
    expect(one(d, "gp-note-faces").attrs).toMatchObject({
      role: "group",
      "aria-label": FOCUS_NOTE_FACES_LABEL,
    });
    expect(inBox(d, "gp-note-face").map((el) => [el.tag, el.icon, el.attrs])).toEqual(
      (["frown", "meh", "smile"] as const).map((name) => [
        "button",
        name,
        {
          type: "button",
          "data-face": name,
          "aria-label": FACE_LABELS[name],
          "aria-pressed": "false",
        },
      ])
    );
    const area = one(d, "gp-note-text");
    expect(area.tag).toBe("textarea");
    expect(area.attrs).toMatchObject({
      "aria-label": FOCUS_NOTE_TEXT_LABEL,
      // The card's two lines, and the chord named as the card names it.
      rows: "2",
      "aria-keyshortcuts": saveShortcutText().aria,
      maxlength: String(NOTE_DRAFT_MAX),
      placeholder: FOCUS_NOTE_PROMPTS.none,
    });
  });

  it("sits after the six rows' values and before the line that says what's wrong", () => {
    const d = open(withNote());
    const kids = d.modal.contentEl.children;
    expect(kids.indexOf(box(d))).toBeLessThan(
      kids.findIndex((c) => c.classes.includes("gp-setting-note"))
    );
  });

  it("opens on the note it was given", () => {
    const d = open(withNote({ face: "meh", text: "stuck on refs" }));
    expect(pressed(d)).toEqual(["meh"]);
    expect(one(d, "gp-note-text").value).toBe("stuck on refs");
    expect(one(d, "gp-note-text").attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.meh);
  });

  it("has neither a box nor a hint when the form has no note and no hint was given", () => {
    expect(parts(open())).toEqual([]);
  });

  it("toggles a face, and the placeholder follows it", () => {
    const d = open(withNote());
    clickEl(face(d, "smile"));
    expect(pressed(d)).toEqual(["smile"]);
    expect(one(d, "gp-note-text").attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.smile);
    clickEl(face(d, "frown"));
    expect(pressed(d)).toEqual(["frown"]);
    expect(one(d, "gp-note-text").attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.frown);
    clickEl(face(d, "frown"));
    expect(pressed(d)).toEqual([]);
    expect(one(d, "gp-note-text").attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.none);
  });

  it("answers with what the box holds, the face kept when the words change", async () => {
    const d = open(withNote());
    clickEl(face(d, "meh"));
    type(d, "half a thought");
    d.button("Add").click?.();
    await expect(d.answer).resolves.toMatchObject({
      form: { note: { face: "meh", text: "half a thought" } },
    });
  });

  it("keeps the words when the face changes after them", async () => {
    const d = open(withNote());
    type(d, "half a thought");
    clickEl(face(d, "smile"));
    d.button("Add").click?.();
    await expect(d.answer).resolves.toMatchObject({
      form: { note: { face: "smile", text: "half a thought" } },
    });
  });

  it("assigns a new note for each change: nothing shared with what it was given or answered", async () => {
    const given = { face: "meh" as const, text: "as logged" };
    const d = open(withNote(given));
    type(d, "edited");
    clickEl(face(d, "meh"));
    expect(given).toEqual({ face: "meh", text: "as logged" });
    expect(d.options.form.note).toBe(given);
    // A check sees the note of that moment, and keeps it if it wants.
    const seen: SessionForm["note"][] = [];
    let live: SessionForm | null = null;
    const checked = open({
      ...withNote(),
      check: (form) => {
        live = form;
        seen.push(form.note);
        return form.note?.text === "second" ? null : "Not yet.";
      },
    });
    type(checked, "first");
    checked.button("Add").click?.();
    type(checked, "second");
    expect(seen[0]).toEqual({ face: null, text: "first" });
    checked.button("Add").click?.();
    const answer = await checked.answer;
    // The answer is a copy of what the dialog was editing.
    expect(answer).toMatchObject({ form: { note: { text: "second" } } });
    expect(answer && answer.action === "save" ? answer.form : null).not.toBe(live);
  });

  it("stays open with what was typed when the note can't be saved", async () => {
    const d = open({
      ...withNote(),
      check: (form) => (form.note?.text === "too long" ? "Shorten it." : null),
    });
    type(d, "too long");
    d.button("Add").click?.();
    await Promise.resolve();
    expect(d.settled()).toBe(false);
    expect(d.problem()).toBe("Shorten it.");
    expect(one(d, "gp-note-text").value).toBe("too long");
    type(d, "short");
    d.button("Add").click?.();
    await expect(d.answer).resolves.toMatchObject({ form: { note: { text: "short" } } });
  });

  describe("Mod+Enter in the box", () => {
    it("runs the same submit as the Save button, the check included", async () => {
      const d = open({
        ...withNote(),
        check: (form) => (form.note?.text === "no" ? "Not that." : null),
      });
      type(d, "no");
      expect(key(d, { ctrlKey: true })).toBe(true);
      await Promise.resolve();
      expect(d.settled()).toBe(false);
      expect(d.problem()).toBe("Not that.");
      type(d, "yes");
      expect(key(d, { ctrlKey: true })).toBe(true);
      await expect(d.answer).resolves.toMatchObject({
        action: "save",
        form: { note: { text: "yes" } },
      });
      expect(d.problem()).toBe("");
    });

    it("is Cmd on a Mac", async () => {
      Platform.isMacOS = true;
      try {
        const d = open(withNote());
        expect(key(d, { ctrlKey: true })).toBe(false);
        await Promise.resolve();
        expect(d.settled()).toBe(false);
        expect(key(d, { metaKey: true })).toBe(true);
        await expect(d.answer).resolves.toMatchObject({ action: "save" });
      } finally {
        Platform.isMacOS = false;
      }
    });

    it("leaves plain Enter and Shift+Enter to the box as a new line", async () => {
      const d = open(withNote());
      expect(key(d, {})).toBe(false);
      expect(key(d, { shiftKey: true })).toBe(false);
      expect(key(d, { ctrlKey: true, shiftKey: true })).toBe(false);
      expect(key(d, { key: "a", ctrlKey: true })).toBe(false);
      await Promise.resolve();
      expect(d.settled()).toBe(false);
    });

    it.each([
      ["a composing input method", { isComposing: true }],
      ["WebKit's composing Enter", { keyCode: 229 }],
      ["a key held down", { repeat: true }],
    ])("never submits on %s, and still never types a new line", async (_name, set) => {
      let checks = 0;
      const d = open({
        ...withNote(),
        check: () => {
          checks++;
          return null;
        },
      });
      expect(key(d, { ctrlKey: true, ...set })).toBe(true);
      await Promise.resolve();
      expect(d.settled()).toBe(false);
      expect(checks).toBe(0);
    });
  });

  describe("the kind", () => {
    it("hides the box away from focus, and brings it back with what was typed", async () => {
      const d = open(withNote());
      type(d, "half a thought");
      clickEl(face(d, "meh"));
      expect(box(d).classes).not.toContain("gp-hidden");
      d.field("Kind").change?.("short-break" as never);
      expect(box(d).classes).toContain("gp-hidden");
      d.field("Kind").change?.("long-break" as never);
      expect(box(d).classes).toContain("gp-hidden");
      d.field("Kind").change?.("focus" as never);
      expect(box(d).classes).not.toContain("gp-hidden");
      expect(one(d, "gp-note-text").value).toBe("half a thought");
      expect(pressed(d)).toEqual(["meh"]);
      d.button("Add").click?.();
      await expect(d.answer).resolves.toMatchObject({
        form: { kind: "focus", note: { face: "meh", text: "half a thought" } },
      });
    });

    it("opens hidden on a break, and shows once it is made a focus", () => {
      const d = open({ form: { ...FORM, kind: "short-break", note: NOTE } });
      expect(box(d).classes).toContain("gp-hidden");
      d.field("Kind").change?.("focus" as never);
      expect(box(d).classes).not.toContain("gp-hidden");
    });
  });

  describe("the hint", () => {
    it("is one plain line in the card's wrapper, with no box", () => {
      const d = open({ noteHint: "Can't hold a note." });
      const [hint] = parts(d);
      expect(hint.classes).toEqual(["gp-note", "gp-note-in-modal", "gp-fix-note"]);
      expect(hint.elements.map((el) => [el.tag, el.classes])).toEqual([["p", ["gp-note-hint"]]]);
      expect(hint.paragraphs).toEqual(["Can't hold a note."]);
    });

    it("hides away from focus, and comes back", () => {
      const d = open({ noteHint: "Can't hold a note." });
      const [hint] = parts(d);
      d.field("Kind").change?.("short-break" as never);
      expect(hint.classes).toContain("gp-hidden");
      d.field("Kind").change?.("focus" as never);
      expect(hint.classes).not.toContain("gp-hidden");
    });

    it("opens hidden on a break", () => {
      const d = open({ form: { ...FORM, kind: "short-break" }, noteHint: "Can't hold a note." });
      expect(parts(d)[0].classes).toContain("gp-hidden");
    });
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
