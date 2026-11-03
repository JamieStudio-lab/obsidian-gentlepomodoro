import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Modal, stubEl, stubFocus, type StubEl } from "../__mocks__/obsidian";
import {
  FACE_LABELS,
  FOCUS_NOTE_HINT,
  FOCUS_NOTE_PROMPTS,
  FocusNoteStore,
  NOTE_DRAFT_MAX,
  type FocusNoteHost,
  type FocusNoteTarget,
  type NoteWriteResult,
} from "../focusNote";
import {
  CLEAR_NOTE_TITLE,
  FOCUS_NOTE_FACES_LABEL,
  FOCUS_NOTE_TEXT_LABEL,
  FocusNoteCard,
  FocusNoteModal,
} from "../focusNoteCard";
import type { FocusNote } from "../logLine";
import type { MomentFactory } from "../momentTypes";
import { memoryStorage } from "./memoryStorage";
import { callbackBody } from "./sourceText";

/**
 * The focus note's card (0.7.1), on the mock's stub elements: built, loaded,
 * clicked and typed into as the timer panel and the dialog do, against a real
 * FocusNoteStore whose writes the test settles. Then the view, which nothing
 * can import, read as text for where the card goes and how it is synced.
 */

const moment = createRequire(import.meta.url)("moment") as MomentFactory;

const ID = "s000000001";
const at = (h: number, m: number) => new Date(2026, 10, 3, h, m).getTime();
const target = (overrides: Partial<FocusNoteTarget> = {}): FocusNoteTarget => ({
  sessionId: ID,
  path: "Logs/2026-11-03-gentle-pomodoro-log.md",
  logged: "file",
  startMs: at(10, 0),
  endMs: at(10, 25),
  taskName: "Write docs #task/research/paper",
  ...overrides,
});

function host() {
  const writes: { target: FocusNoteTarget; note: FocusNote | null }[] = [];
  let settle: ((result: NoteWriteResult) => void) | null = null;
  const h: FocusNoteHost = {
    storage: memoryStorage(),
    enabled: () => true,
    write: (t, note) => {
      writes.push({ target: t, note });
      return new Promise((done) => {
        settle = done;
      });
    },
    notice: () => undefined,
    now: () => at(10, 27),
  };
  return {
    h,
    writes,
    async settle(result: NoteWriteResult) {
      expect(settle, "no write in flight").not.toBeNull();
      settle?.(result);
      settle = null;
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
  };
}

/** Every element under `el` with this class, in document order. */
function all(el: StubEl, cls: string): StubEl[] {
  const out: StubEl[] = [];
  const walk = (n: StubEl) => {
    if (n.classes.includes(cls)) out.push(n);
    n.children.forEach(walk);
  };
  walk(el);
  return out;
}
function one(el: StubEl, cls: string): StubEl {
  const found = all(el, cls);
  expect(found, cls).toHaveLength(1);
  return found[0];
}

let enabled = true;

function mount(store: FocusNoteStore, surface: "panel" | "modal" = "panel") {
  const parent = stubEl("gp-controls");
  const card = new FocusNoteCard(parent as unknown as HTMLElement, store, {
    surface,
    app: {} as never,
    moment,
    enabled: () => enabled,
  });
  card.load();
  const section = parent.children[0];
  const face = (name: string) =>
    all(section, "gp-note-face").find((b) => b.attrs["data-face"] === name)!;
  const textarea = one(section, "gp-note-text");
  const save = one(section, "gp-note-save");
  const clear = one(section, "gp-note-clear");
  return {
    card,
    section,
    face,
    textarea,
    save,
    clear,
    status: () => one(section, "gp-note-status-text").text,
    statusIcon: () => one(section, "gp-note-status-icon"),
    session: () => one(section, "gp-note-session"),
    shown: () => !section.classes.includes("gp-hidden"),
    pressed: () =>
      all(section, "gp-note-face")
        .filter((b) => b.attrs["aria-pressed"] === "true")
        .map((b) => b.attrs["data-face"]),
    /** A click as the browser delivers it to the section's one listener. */
    click(el: StubEl) {
      for (const listener of section.listeners.click ?? []) {
        listener({ target: el, detail: 1 } as never);
      }
    },
    type(text: string) {
      textarea.value = text;
      for (const listener of textarea.listeners.input ?? []) listener({} as never);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => {
  enabled = true;
  stubFocus.el = null;
  stubFocus.dropped = 0;
  Modal.opened = null;
  vi.stubGlobal("activeDocument", {
    get activeElement() {
      return stubFocus.el;
    },
  });
  vi.stubGlobal("moment", moment);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the card's DOM", () => {
  it("is built hidden, once, with the design's parts and names", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    expect(c.section.tag).toBe("section");
    expect(c.section.classes).toEqual(["gp-note", "gp-hidden"]);
    const title = one(c.section, "gp-note-title");
    expect(title.text).toBe("Focus note");
    expect(c.section.attrs["aria-labelledby"]).toBe(title.attrs.id);
    expect(one(c.section, "gp-note-status").attrs.role).toBe("status");
    const group = one(c.section, "gp-note-faces");
    expect(group.attrs).toMatchObject({ role: "group", "aria-label": FOCUS_NOTE_FACES_LABEL });
    expect(all(group, "gp-note-face").map((b) => [b.tag, b.attrs, b.icon])).toEqual(
      (["frown", "meh", "smile"] as const).map((f) => [
        "button",
        { type: "button", "data-face": f, "aria-label": FACE_LABELS[f], "aria-pressed": "false" },
        f,
      ])
    );
    expect(c.textarea.tag).toBe("textarea");
    expect(c.textarea.attrs).toMatchObject({
      rows: "2",
      maxlength: String(NOTE_DRAFT_MAX),
      "aria-label": FOCUS_NOTE_TEXT_LABEL,
    });
    expect([c.clear.text, c.save.text]).toEqual(["Clear", "Save"]);
    expect([c.clear.attrs.type, c.save.attrs.type]).toEqual(["button", "button"]);
    expect(one(c.section, "gp-note-hint").text).toBe(FOCUS_NOTE_HINT);
    expect(c.statusIcon().icon).toBe("check");
    // No settings button: the typings have no public way to open it.
    expect(all(c.section, "gp-note-setup")).toEqual([]);
  });

  it("gives every card its own title id, so a second panel or the dialog names its own", () => {
    const store = new FocusNoteStore(host().h);
    const a = mount(store);
    const b = mount(store, "modal");
    expect(a.section.attrs["aria-labelledby"]).not.toBe(b.section.attrs["aria-labelledby"]);
    expect(one(b.section, "gp-note-title").attrs.id).toBe(b.section.attrs["aria-labelledby"]);
  });
});

describe("when the panel shows the card", () => {
  it("shows it from a counted focus end until the next focus starts, while the setting is on", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    expect(c.shown()).toBe(false);
    store.ended(target());
    expect(c.shown()).toBe(true);
    // A pause, a break, a reload: the card stays. A focus start closes it.
    store.focusStarted();
    expect(c.shown()).toBe(false);
  });

  it("hides with the setting and comes back with it, through sync()", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target());
    enabled = false;
    c.card.sync();
    expect(c.shown()).toBe(false);
    enabled = true;
    c.card.sync();
    expect(c.shown()).toBe(true);
  });

  it("is always shown in the dialog, for the store's session", () => {
    const store = new FocusNoteStore(host().h);
    store.ended(target());
    store.focusStarted();
    enabled = false;
    const c = mount(store, "modal");
    expect(c.section.classes).toContain("gp-note-in-modal");
    expect(c.shown()).toBe(true);
  });

  it("shows the hint and no form when the session was not logged (no folder)", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target({ logged: "none", path: null }));
    expect(one(c.section, "gp-note-form").classes).toContain("gp-hidden");
    expect(one(c.section, "gp-note-empty").classes).not.toContain("gp-hidden");
    store.ended(target({ sessionId: "s000000002" }));
    expect(one(c.section, "gp-note-form").classes).not.toContain("gp-hidden");
    expect(one(c.section, "gp-note-empty").classes).toContain("gp-hidden");
  });
});

describe("the card's states", () => {
  it("A — fresh: both buttons inactive, the session line and the open question", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target());
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.clear.attrs["aria-disabled"]).toBe("true");
    expect(c.section.classes).not.toContain("can-save");
    expect(c.status()).toBe("");
    expect(c.statusIcon().classes).toContain("gp-hidden");
    expect(c.textarea.attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.none);
    const line = `${moment(at(10, 0)).format("LT")}–${moment(at(10, 25)).format("LT")} · Write docs`;
    expect(c.session().text).toBe(line);
    expect(c.session().attrs.title).toBe(line);
  });

  it("E/F — a face pressed, the box empty: Save active, Clear not; pressed again, off", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target());
    c.click(c.face("frown"));
    expect(c.pressed()).toEqual(["frown"]);
    expect(c.textarea.attrs.placeholder).toBe(FOCUS_NOTE_PROMPTS.frown);
    expect(c.save.attrs["aria-disabled"]).toBe("false");
    expect(c.section.classes).toContain("can-save");
    expect(c.clear.attrs["aria-disabled"]).toBe("true");
    expect(c.status()).toBe("Not saved");
    // At most one: another face moves the press.
    c.click(c.face("smile"));
    expect(c.pressed()).toEqual(["smile"]);
    c.click(c.face("smile"));
    expect(c.pressed()).toEqual([]);
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.section.classes).not.toContain("can-save");
  });

  it("B — face and words typed: Save and Clear active, the store's draft is the card's", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target());
    c.click(c.face("meh"));
    c.type("stuck on the second paragraph");
    expect(store.draft).toEqual({ face: "meh", text: "stuck on the second paragraph" });
    expect(c.save.attrs["aria-disabled"]).toBe("false");
    expect(c.clear.attrs["aria-disabled"]).toBe("false");
    expect(c.status()).toBe("Not saved");
  });

  it("G — saving: both inactive and no accent, focus left on Save; C — saved: Update, quiet", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.click(c.face("smile"));
    c.type("went fine");
    c.save.focus();
    c.click(c.save);
    expect(hs.writes).toEqual([{ target: target(), note: { face: "smile", text: "went fine" } }]);
    expect(c.status()).toBe("Saving…");
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.clear.attrs["aria-disabled"]).toBe("true");
    expect(c.section.classes).not.toContain("can-save");
    await hs.settle("saved");
    expect(c.save.text).toBe("Update");
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.clear.attrs["aria-disabled"]).toBe("false");
    expect(c.status()).toBe(`Saved ${moment(at(10, 27)).format("LT")}`);
    expect(c.statusIcon().classes).not.toContain("gp-hidden");
    // Inactive by aria-disabled, never disabled: focus stays where it was.
    expect(stubFocus.el).toBe(c.save);
    expect(stubFocus.dropped).toBe(0);
    expect(c.save.attrs.disabled).toBeUndefined();
  });

  it("H — saved, then emptied: dirty but Save inactive (both empty never saves), Clear active", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.type("went fine");
    c.click(c.save);
    await hs.settle("saved");
    c.type("");
    expect(c.status()).toBe("Not saved");
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.section.classes).not.toContain("can-save");
    expect(c.clear.attrs["aria-disabled"]).toBe("false");
  });

  it("does nothing on an inactive Save", () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.click(c.save);
    expect(hs.writes).toEqual([]);
  });
});

describe("a save re-seeds every card from what the line stores", () => {
  it("shows a face typed as words pressed, and the box cleaned", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.type("smile");
    c.click(c.save);
    expect(hs.writes[0].note).toEqual({ face: "smile", text: "" });
    await hs.settle("saved");
    expect(c.pressed()).toEqual(["smile"]);
    expect(c.textarea.value).toBe("");
    expect(c.save.attrs["aria-disabled"]).toBe("true");
    expect(c.status()).toMatch(/^Saved /);
  });

  it("re-seeds a second card even while its box has the caret", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const a = mount(store);
    const b = mount(store);
    store.ended(target());
    a.type("one\ntwo  [x]");
    // The other panel's box holds the same words, and the caret.
    expect(b.textarea.value).toBe("one\ntwo  [x]");
    b.textarea.focus();
    a.click(a.save);
    await hs.settle("saved");
    expect(a.textarea.value).toBe("one / two (x)");
    expect(b.textarea.value).toBe("one / two (x)");
  });

  it("spares words typed during the save: they stay, and the card is dirty again", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.type("first");
    c.click(c.save);
    c.textarea.focus();
    c.type("first and more");
    await hs.settle("saved");
    expect(c.textarea.value).toBe("first and more");
    expect(c.status()).toBe("Not saved");
    expect(c.save.attrs["aria-disabled"]).toBe("false");
  });

  it("leaves a box with the caret alone on an ordinary change, and re-seeds one without", () => {
    const store = new FocusNoteStore(host().h);
    const a = mount(store);
    const b = mount(store);
    store.ended(target());
    b.textarea.focus();
    b.textarea.value = "half a wor";
    a.type("typed in a");
    expect(b.textarea.value).toBe("half a wor");
    // The caret gone, the next change reaches it.
    stubFocus.el = null;
    a.type("typed in a again");
    expect(b.textarea.value).toBe("typed in a again");
  });
});

describe("Clear", () => {
  it("with nothing saved, empties the card at once: no question, no write", () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.click(c.face("meh"));
    c.type("not worth keeping");
    c.click(c.clear);
    expect(Modal.opened).toBeNull();
    expect(hs.writes).toEqual([]);
    expect(c.textarea.value).toBe("");
    expect(c.pressed()).toEqual([]);
    expect(c.clear.attrs["aria-disabled"]).toBe("true");
  });

  it("with a saved note, asks first; Cancel writes nothing, Clear takes the note off", async () => {
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.click(c.face("meh"));
    c.type("stuck");
    c.click(c.save);
    await hs.settle("saved");

    const answer = async (button: 0 | 1) => {
      c.click(c.clear);
      const modal = Modal.opened as unknown as {
        titleEl: StubEl;
        contentEl: { settings: { components: { click?: () => void; destructive: boolean }[] }[] };
        close(): void;
      };
      expect(modal.titleEl.text).toBe(CLEAR_NOTE_TITLE);
      const buttons = modal.contentEl.settings[0].components;
      expect(buttons[1].destructive).toBe(true);
      buttons[button].click?.();
      await flush();
    };

    await answer(0);
    expect(hs.writes).toHaveLength(1);
    expect(c.pressed()).toEqual(["meh"]);

    await answer(1);
    expect(hs.writes[1]).toEqual({ target: target(), note: null });
    await hs.settle("saved");
    expect(c.pressed()).toEqual([]);
    expect(c.textarea.value).toBe("");
    expect(c.status()).toBe("");
    expect(c.save.text).toBe("Save");
  });

  it("writes nothing when the next session ended while the question was open", async () => {
    // The answer was about the note the card showed when it asked; the card
    // now shows another session, so no line is touched.
    const hs = host();
    const store = new FocusNoteStore(hs.h);
    const c = mount(store);
    store.ended(target());
    c.type("stuck");
    c.click(c.save);
    await hs.settle("saved");
    c.click(c.clear);
    const modal = Modal.opened as unknown as {
      contentEl: { settings: { components: { click?: () => void }[] }[] };
    };
    store.ended(target({ sessionId: "s000000002" }));
    modal.contentEl.settings[0].components[1].click?.();
    await flush();
    expect(hs.writes).toHaveLength(1);
    expect(store.target?.sessionId).toBe("s000000002");
  });
});

describe("the card's sync", () => {
  it("touches the DOM only when what it shows has moved (the 50ms tick calls it)", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    store.ended(target());
    c.type("words");
    const status = one(c.section, "gp-note-status-text");
    status.setText("scribbled over");
    for (let i = 0; i < 3; i++) c.card.sync();
    expect(status.text).toBe("scribbled over");
    c.type("words and more");
    expect(status.text).toBe("Not saved");
  });

  it("takes its store listener and its DOM listeners with it when unloaded", () => {
    const store = new FocusNoteStore(host().h);
    const c = mount(store);
    c.card.unload();
    store.ended(target());
    expect(c.shown()).toBe(false);
    expect(c.section.listeners.click ?? []).toEqual([]);
    expect(c.textarea.listeners.input ?? []).toEqual([]);
  });
});

describe("FocusNoteModal", () => {
  it("builds the card in the dialog on open, and unloads it on close", () => {
    const store = new FocusNoteStore(host().h);
    store.ended(target());
    const modal = new FocusNoteModal({} as never, store);
    modal.open();
    // The modal's content records every element made in it (the mock's
    // ModalContent), the section among them.
    const made = (modal.contentEl as unknown as { elements: StubEl[] }).elements;
    const sections = made.filter((e) => e.classes.includes("gp-note"));
    expect(sections).toHaveLength(1);
    const section = sections[0];
    expect(section.classes).toEqual(["gp-note", "gp-note-in-modal"]);
    expect((modal.modalEl as unknown as StubEl).classes).toContain("gp-note-modal");
    expect(section.listeners.click).toHaveLength(1);
    modal.close();
    expect(section.listeners.click).toEqual([]);
    // No listener left on the store for the dialog's card.
    expect((store as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });
});

describe("the card's source", () => {
  const card = readFileSync(resolve(__dirname, "..", "focusNoteCard.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("goes inactive by aria-disabled only, never by disabling the button", () => {
    expect(card).not.toMatch(/\.disabled\s*=/);
    expect(card).not.toMatch(/setAttr(?:ibute)?\(\s*"disabled"/);
    expect(card).not.toMatch(/toggleAttribute\(\s*"disabled"/);
    expect(card).toContain('setAttr("aria-disabled", view.saveActive ? "false" : "true")');
    expect(card).toContain('setAttr("aria-disabled", view.clearActive ? "false" : "true")');
  });

  it("sets can-save from saveActive, never from dirty", () => {
    expect(card).toContain('this.sectionEl.toggleClass("can-save", view.saveActive);');
    expect(card).not.toContain("is-dirty");
  });

  it("re-seeds on a store change, forced when the change says so", () => {
    expect(card).toMatch(/this\.seed\(change\.reseed\);\s*this\.sync\(\);/);
  });

  it("never moves focus on its own", () => {
    expect(card).not.toMatch(/\.focus\(/);
  });
});

describe("the view holds one card", () => {
  const view = readFileSync(resolve(__dirname, "..", "GentlePomoView.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("adds it once, in onOpen, between the task list and the music rule", () => {
    const onOpen = callbackBody(view, "override onOpen(): Promise<void> {");
    expect(view.match(/new FocusNoteCard\(/g)).toHaveLength(1);
    const list = onOpen.indexOf('this.taskListContainer = controls.createDiv("gp-task-list"');
    const card = onOpen.indexOf("this.focusNoteCard = this.addChild(");
    const rule = onOpen.indexOf('this.musicDivider = controls.createDiv("gp-music-divider")');
    expect(list).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(list);
    expect(rule).toBeGreaterThan(card);
    expect(onOpen.slice(card, rule)).toMatch(
      /new FocusNoteCard\(controls, this\.plugin\.focusNotes,/
    );
    expect(onOpen.slice(card, rule)).toContain('surface: "panel"');
    expect(onOpen.slice(card, rule)).toContain(
      "enabled: () => this.plugin.settings.focusNoteEnabled"
    );
    // A reopened view unloads the card it had first, or that card's store
    // listener stays on for a section that is gone.
    const removed = onOpen.indexOf("if (this.focusNoteCard) this.removeChild(this.focusNoteCard);");
    expect(removed).toBeGreaterThan(list);
    expect(removed).toBeLessThan(card);
  });

  it("syncs it from applySettings, behind the card's key, and nowhere else", () => {
    expect(view.match(/focusNoteCard\?\.sync\(\)/g)).toHaveLength(1);
    const apply = callbackBody(view, "\n  applySettings() {");
    expect(apply).toContain("this.focusNoteCard?.sync();");
  });
});
