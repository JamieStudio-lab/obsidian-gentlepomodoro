import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DROPPED_NOTE_NOTICE,
  EARLIER_CLEAR_FAILED_NOTICE,
  EARLIER_NOTE_FAILED_NOTICE,
  FOCUS_NOTE_COMMAND_NAME,
  FOCUS_NOTE_HINT,
  FOCUS_NOTE_KEY,
  FOCUS_NOTE_PROMPTS,
  FocusNoteStore,
  NOTE_CLEAR_MESSAGES,
  NOTE_DRAFT_MAX,
  NOTE_WRITE_MESSAGES,
  UNSAVED_NOTE_NOTICE,
  cardView,
  chooseLastSession,
  noteFromInput,
  noteIsDirty,
  noteTime,
  readFocusNoteState,
  type FileNoteLine,
  type FocusNoteHost,
  type FocusNoteTarget,
  type NoteWriteResult,
} from "../focusNote";
import { FocusNoteModal } from "../focusNoteCard";
import {
  NOTE_FACES,
  NOTE_TEXT_MAX,
  formatNoteValue,
  parseNoteValue,
  type FocusNote,
} from "../logLine";
import type { MomentFactory } from "../momentTypes";
import { memoryStorage } from "./memoryStorage";
import { callbackBody } from "./sourceText";

const moment = createRequire(import.meta.url)("moment") as MomentFactory;

const ID = "s000000001";
const OTHER = "s000000002";
const at = (h: number, m: number, day = 3) => new Date(2026, 10, day, h, m).getTime();

const target = (overrides: Partial<FocusNoteTarget> = {}): FocusNoteTarget => ({
  sessionId: ID,
  path: "Logs/2026-11-03-gentle-pomodoro-log.md",
  logged: "file",
  startMs: at(10, 0),
  endMs: at(10, 25),
  taskName: "Write docs #task/research/paper",
  ...overrides,
});

const EMPTY: FocusNote = { face: null, text: "" };

describe("noteFromInput", () => {
  it("cleans the words as the line will store them, and says when the cap cut them", () => {
    expect(noteFromInput("meh", "stuck on\n[refs]")).toEqual({
      face: "meh",
      text: "stuck on / (refs)",
      cut: false,
    });
    const long = noteFromInput(null, "a".repeat(NOTE_TEXT_MAX + 1));
    expect(long.text).toBe("a".repeat(NOTE_TEXT_MAX));
    expect(long.cut).toBe(true);
    expect(noteFromInput(null, "a".repeat(NOTE_TEXT_MAX)).cut).toBe(false);
  });

  it("takes a face out of words typed without one", () => {
    expect(noteFromInput(null, "smile")).toEqual({ face: "smile", text: "", cut: false });
    expect(noteFromInput(null, "meh · went fine")).toEqual({
      face: "meh",
      text: "went fine",
      cut: false,
    });
    // Pressed, a face is the face, and words that start with one are words.
    expect(noteFromInput("frown", "smile · x")).toEqual({
      face: "frown",
      text: "smile · x",
      cut: false,
    });
    // Not a face unless the grammar says so.
    expect(noteFromInput(null, "Smile · x").face).toBeNull();
    expect(noteFromInput(null, "meh·x").face).toBeNull();
  });

  it("reads back from the line as it was made, whatever is typed (seeded fuzz)", () => {
    // mulberry32, as tests/logLine.test.ts: its low bits vary too.
    let seed = 7101;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const pieces = [
      "[",
      "]",
      "[[",
      "]]",
      "|",
      "\\",
      "::",
      "#",
      "%%",
      "🍅",
      "☕",
      "\n",
      "\r\n",
      " ",
      "  ",
      "·",
      " · ",
      " ·",
      "· ",
      "meh",
      "smile",
      "frown",
      "Meh",
      "x",
      "🎧",
      "y".repeat(80),
    ];
    const faces = [...NOTE_FACES, null];
    for (let n = 0; n < 20_000; n++) {
      let text = "";
      const count = next(30);
      for (let i = 0; i < count; i++) text += pieces[next(pieces.length)];
      const face = faces[next(faces.length)];
      const note = noteFromInput(face, text);
      const value = formatNoteValue(note);
      const back = value === null ? null : parseNoteValue(value);
      const want =
        note.face === null && note.text === "" ? null : { face: note.face, text: note.text };
      if (JSON.stringify(back) !== JSON.stringify(want)) {
        expect({ face, text, back }).toEqual({ face, text, back: want });
      }
      // Made once, a note is made: a second Save of it is the same note.
      const again = noteFromInput(note.face, note.text);
      if (again.face !== note.face || again.text !== note.text || again.cut) {
        expect({ face, text, again }).toEqual({ face, text, again: { ...note, cut: false } });
      }
    }
  });
});

describe("cardView — the card's states (A–H of the design)", () => {
  const view = (
    state: Partial<{
      target: FocusNoteTarget;
      saved: { face: FocusNote["face"]; text: string; at: number | null } | null;
      draft: FocusNote;
      busy: boolean;
    }> = {}
  ) => cardView({ target: target(), saved: null, draft: EMPTY, busy: false, ...state }, moment);

  it("A — fresh: nothing to save or clear, and the open question", () => {
    expect(view()).toEqual({
      mode: "form",
      dirty: false,
      saveLabel: "Save",
      saveActive: false,
      clearActive: false,
      status: "",
      placeholder: FOCUS_NOTE_PROMPTS.none,
      sessionLine: `${moment(at(10, 0)).format("LT")}–${moment(at(10, 25)).format("LT")} · Write docs`,
    });
  });

  it("B — a face and words, not saved", () => {
    const v = view({ draft: { face: "meh", text: "stuck on refs" } });
    expect(v).toMatchObject({
      dirty: true,
      saveActive: true,
      clearActive: true,
      status: "Not saved",
      placeholder: FOCUS_NOTE_PROMPTS.meh,
    });
  });

  it("E/F — a face with an empty box saves, and Clear stays off (deselect the face instead)", () => {
    for (const face of NOTE_FACES) {
      const v = view({ draft: { face, text: "" } });
      expect(v.saveActive, face).toBe(true);
      expect(v.clearActive, face).toBe(false);
      expect(v.placeholder).toBe(FOCUS_NOTE_PROMPTS[face]);
    }
  });

  it("C — saved: Update, quiet, and the time it was saved in the app's format", () => {
    const saved = { face: "meh" as const, text: "stuck", at: at(10, 27) };
    const v = view({ saved, draft: { face: "meh", text: "stuck" } });
    expect(v).toMatchObject({
      dirty: false,
      saveLabel: "Update",
      saveActive: false,
      clearActive: true,
      status: `Saved ${moment(at(10, 27)).format("LT")}`,
    });
    // One time format for both lines.
    expect(v.status).toBe(`Saved ${noteTime(moment, at(10, 27))}`);
    // Read from the file, the note has no time.
    expect(view({ saved: { ...saved, at: null }, draft: saved }).status).toBe("Saved");
  });

  it("D — no log folder: the hint instead of the form", () => {
    expect(view({ target: target({ logged: "none", path: null }) }).mode).toBe("hint");
    expect(FOCUS_NOTE_HINT).toBe("Set a log folder to keep a short note after each focus session.");
    expect(view({ target: target({ logged: "queued" }) }).mode).toBe("form");
  });

  it("G — saving: dirty, yet neither Save nor Clear", () => {
    const v = view({ draft: { face: "smile", text: "x" }, busy: true });
    expect(v).toMatchObject({
      dirty: true,
      saveActive: false,
      clearActive: false,
      status: "Saving…",
    });
  });

  it("H — saved, then emptied: dirty, but both empty never saves", () => {
    const v = view({ saved: { face: "meh", text: "x", at: 1 }, draft: EMPTY });
    expect(v).toMatchObject({
      dirty: true,
      saveLabel: "Update",
      saveActive: false,
      clearActive: true,
      status: "Not saved",
    });
  });

  it("never saves both empty — words that clean to nothing included", () => {
    expect(view({ draft: { face: null, text: "  " } }).saveActive).toBe(false);
    expect(view({ draft: { face: null, text: "🍅☕" } }).saveActive).toBe(false);
  });

  it("is dirty when the cap cut the words, saved or not", () => {
    const long = "b".repeat(NOTE_TEXT_MAX + 3);
    const kept = { face: null, text: "b".repeat(NOTE_TEXT_MAX), at: 1 };
    expect(noteIsDirty({ face: null, text: long }, kept)).toBe(true);
    expect(view({ saved: kept, draft: { face: null, text: long } }).saveActive).toBe(true);
    expect(noteIsDirty({ face: null, text: kept.text }, kept)).toBe(false);
  });

  it("compares what the line would store, not what is typed", () => {
    const saved = { face: "smile" as const, text: "", at: 1 };
    expect(noteIsDirty({ face: null, text: "smile" }, saved)).toBe(false);
    expect(noteIsDirty({ face: "smile", text: " " }, saved)).toBe(false);
  });

  it("names the task as the task button does, and No Task as it is", () => {
    expect(view({ target: target({ taskName: "No Task" }) }).sessionLine).toMatch(/ · No Task$/);
  });
});

/** A host whose write waits for the test to settle it. */
function host(enabled = true) {
  const storage = memoryStorage();
  const notices: string[] = [];
  const writes: { target: FocusNoteTarget; note: FocusNote | null }[] = [];
  let settle: ((result: NoteWriteResult) => void) | null = null;
  let moved: ((path: string) => void) | null = null;
  const h: FocusNoteHost = {
    storage,
    enabled: () => enabled,
    write: (t, note, onMoved) => {
      writes.push({ target: t, note });
      moved = onMoved;
      return new Promise((resolveWrite) => {
        settle = resolveWrite;
      });
    },
    notice: (message) => {
      notices.push(message);
    },
    now: () => at(10, 30),
  };
  return {
    h,
    storage,
    notices,
    writes,
    /** Settle the write in flight, and let the store take the result. */
    async settle(result: NoteWriteResult) {
      expect(settle, "no write in flight").not.toBeNull();
      settle?.(result);
      settle = null;
      await Promise.resolve();
      await Promise.resolve();
    },
    move(path: string) {
      moved?.(path);
    },
  };
}

describe("FocusNoteStore", () => {
  it("opens an empty card on a counted focus end, and keeps it until a focus starts", () => {
    const { h } = host();
    const store = new FocusNoteStore(h);
    expect(store.target).toBeNull();
    expect(store.cardOpen).toBe(false);
    store.ended(target());
    expect(store.target).toEqual(target());
    expect(store.cardOpen).toBe(true);
    expect(store.draft).toEqual(EMPTY);
    store.focusStarted();
    expect(store.cardOpen).toBe(false);
    // The target stays: the command still reaches it during the next focus.
    expect(store.target?.sessionId).toBe(ID);
  });

  it("a focus that writes nothing leaves the card closed and the target as it was", () => {
    // focusStarted, then a Stop under a minute: LogManager never calls ended.
    const { h } = host();
    const store = new FocusNoteStore(h);
    store.ended(target());
    store.focusStarted();
    expect(store.cardOpen).toBe(false);
    expect(store.target).toEqual(target());
  });

  it("says once that a showing card's words are not saved, when a focus starts", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "half a thought");
    store.focusStarted();
    expect(c.notices).toEqual([UNSAVED_NOTE_NOTICE]);
    expect(UNSAVED_NOTE_NOTICE).toContain(`"${FOCUS_NOTE_COMMAND_NAME}"`);
    // The draft stays for the command.
    expect(store.draft).toEqual({ face: "meh", text: "half a thought" });
    // Closed already: a second start says nothing more.
    store.focusStarted();
    expect(c.notices).toHaveLength(1);
  });

  it("says nothing of unsaved words when the card was not showing (the setting off)", () => {
    const c = host(false);
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft(null, "words");
    store.focusStarted();
    expect(c.notices).toEqual([]);
    expect(store.cardOpen).toBe(false);
  });

  it("says nothing when the words match what is saved", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("smile", "");
    const saving = store.save(target(), noteFromInput("smile", ""));
    await c.settle("saved");
    await saving;
    store.focusStarted();
    expect(c.notices).toEqual([]);
  });

  it("drops an unsaved draft when the next counted end replaces its session, and says so", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft(null, "never saved");
    store.ended(target({ sessionId: OTHER }));
    expect(c.notices).toEqual([DROPPED_NOTE_NOTICE]);
    expect(store.draft).toEqual(EMPTY);
    expect(store.saved).toBeNull();
    // A clean one goes quietly.
    store.ended(target({ sessionId: ID }));
    expect(c.notices).toHaveLength(1);
  });

  it("saves the note captured at the click, then re-seeds every card with it", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    const changes: boolean[] = [];
    store.onChange((change) => changes.push(change.reseed));
    store.ended(target());
    store.setDraft(null, "smile");
    const note = noteFromInput(store.draft.face, store.draft.text);
    const saving = store.save(target(), note);
    expect(store.busy).toBe(true);
    expect(store.view(moment)?.status).toBe("Saving…");
    await c.settle("saved");
    expect(await saving).toBe("saved");
    expect(c.writes).toEqual([{ target: target(), note: { face: "smile", text: "" } }]);
    // The face taken out of the words shows pressed, and nothing is dirty.
    expect(store.draft).toEqual({ face: "smile", text: "" });
    expect(store.saved).toEqual({ face: "smile", text: "", at: at(10, 30) });
    const v = store.view(moment);
    expect(v).toMatchObject({ dirty: false, saveLabel: "Update", saveActive: false });
    expect(changes[changes.length - 1]).toBe(true);
    expect(store.busy).toBe(false);
  });

  it("re-seeds an unchanged note too", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "x");
    const saving = store.save(target(), noteFromInput("meh", "x"));
    await c.settle("unchanged");
    expect(await saving).toBe("unchanged");
    expect(store.saved).toMatchObject({ face: "meh", text: "x" });
    expect(c.notices).toEqual([]);
  });

  it("after saving a cut note, shows what was kept and is no longer dirty", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft(null, "c".repeat(NOTE_TEXT_MAX + 10));
    expect(store.view(moment)?.saveActive).toBe(true);
    const saving = store.save(target(), noteFromInput(store.draft.face, store.draft.text));
    await c.settle("saved");
    await saving;
    expect(store.draft.text).toBe("c".repeat(NOTE_TEXT_MAX));
    expect(store.view(moment)?.dirty).toBe(false);
  });

  it("keeps words typed while the save ran: the card is dirty again", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "first");
    const saving = store.save(target(), noteFromInput("meh", "first"));
    store.setDraft("meh", "first and more");
    await c.settle("saved");
    await saving;
    expect(store.saved).toMatchObject({ face: "meh", text: "first" });
    expect(store.draft).toEqual({ face: "meh", text: "first and more" });
    expect(store.view(moment)?.status).toBe("Not saved");
  });

  it("never runs two writes at once", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    const first = store.save(target(), { face: "meh", text: "" });
    expect(await store.save(target(), { face: "smile", text: "" })).toBeNull();
    expect(await store.clear(target())).toBeNull();
    expect(c.writes).toHaveLength(1);
    await c.settle("saved");
    await first;
  });

  it("applies a result only to its own session", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    const saving = store.save(target(), { face: "meh", text: "old" });
    // The next focus ended while the write ran.
    store.ended(target({ sessionId: OTHER }));
    await c.settle("saved");
    expect(await saving).toBe("saved");
    expect(store.target?.sessionId).toBe(OTHER);
    expect(store.saved).toBeNull();
    expect(store.draft).toEqual(EMPTY);
    // Nor its refusals: "your note is kept" would be false, since the card
    // has moved on. The note is lost, so it says that instead.
    const second = store.save(target({ sessionId: OTHER }), { face: "meh", text: "" });
    store.ended(target());
    await c.settle("waiting");
    await second;
    expect(c.notices).toEqual([EARLIER_NOTE_FAILED_NOTICE]);
  });

  it("does not call a note being written unsaved or dropped (review round 1)", async () => {
    // The next focus starts while the save runs: the words are being written.
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "words");
    const saving = store.save(target(), noteFromInput("meh", "words"));
    store.focusStarted();
    expect(c.notices).toEqual([]);
    await c.settle("saved");
    await saving;
    expect(c.notices).toEqual([]);
    // The next focus ends while the save runs: nothing was dropped.
    const d = host();
    const next = new FocusNoteStore(d.h);
    next.ended(target());
    next.setDraft("meh", "words");
    const writing = next.save(target(), noteFromInput("meh", "words"));
    next.ended(target({ sessionId: OTHER }));
    expect(d.notices).toEqual([]);
    await d.settle("saved");
    await writing;
    expect(d.notices).toEqual([]);
    // A clear in flight is not unsaved words either.
    const e = host();
    const cleared = new FocusNoteStore(e.h);
    cleared.ended(target());
    cleared.setDraft("meh", "words");
    const first = cleared.save(target(), noteFromInput("meh", "words"));
    await e.settle("saved");
    await first;
    const clearing = cleared.clear(target());
    cleared.focusStarted();
    expect(e.notices).toEqual([]);
    await e.settle("saved");
    await clearing;
  });

  it("still warns about words typed after the click, judged against the note being written", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "words");
    const saving = store.save(target(), noteFromInput("meh", "words"));
    store.setDraft("meh", "words, and more");
    store.focusStarted();
    expect(c.notices).toEqual([UNSAVED_NOTE_NOTICE]);
    await c.settle("saved");
    await saving;
    // Typed after the click, then back to what is being written: not dirty.
    const d = host();
    const back = new FocusNoteStore(d.h);
    back.ended(target());
    back.setDraft("meh", "words");
    const again = back.save(target(), noteFromInput("meh", "words"));
    back.setDraft("meh", "words!");
    back.setDraft("meh", "words");
    back.ended(target({ sessionId: OTHER }));
    expect(d.notices).toEqual([]);
    await d.settle("saved");
    await again;
  });

  it("does not show the next session's card as saving while an earlier write runs", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    const first = store.save(target(), { face: "meh", text: "old" });
    store.ended(target({ sessionId: OTHER }));
    expect(store.busy).toBe(false);
    store.setDraft("smile", "new");
    const view = store.view(moment);
    expect(view?.status).toBe("Not saved");
    expect(view?.saveActive).toBe(true);
    expect(view?.clearActive).toBe(true);
    // Its save waits for the first write, and runs after it: never two at once.
    const second = store.save(target({ sessionId: OTHER }), { face: "smile", text: "new" });
    expect(store.busy).toBe(true);
    expect(c.writes).toHaveLength(1);
    await c.settle("saved");
    expect(await first).toBe("saved");
    expect(c.writes).toHaveLength(2);
    expect(c.writes[1]).toMatchObject({
      target: { sessionId: OTHER },
      note: { face: "smile", text: "new" },
    });
    // A second click on the waiting card writes nothing more.
    expect(
      await store.save(target({ sessionId: OTHER }), { face: "smile", text: "new" })
    ).toBeNull();
    await c.settle("saved");
    expect(await second).toBe("saved");
    expect(store.saved).toMatchObject({ face: "smile", text: "new" });
    expect(store.busy).toBe(false);
    expect(c.notices).toEqual([]);
  });

  it("says a failed Clear left the note in the log, never that it wasn't saved (round 2)", async () => {
    for (const result of ["waiting", "no-file", "missing", "failed"] as const) {
      const c = host();
      const store = new FocusNoteStore(c.h);
      store.ended(target());
      const first = store.save(target(), { face: "meh", text: "a" });
      await c.settle("saved");
      await first;
      const clearing = store.clear(target());
      await c.settle(result);
      await clearing;
      expect(c.notices, result).toEqual([NOTE_CLEAR_MESSAGES[result]]);
      // And for the session before, once the card has moved on.
      const d = host();
      const moved = new FocusNoteStore(d.h);
      moved.ended(target());
      const saved = moved.save(target(), { face: "meh", text: "a" });
      await d.settle("saved");
      await saved;
      const clear = moved.clear(target());
      moved.ended(target({ sessionId: OTHER }));
      await d.settle(result);
      await clear;
      expect(d.notices, result).toEqual([EARLIER_CLEAR_FAILED_NOTICE]);
    }
  });

  it("does not let a read of the line overwrite what this device wrote since (round 2)", async () => {
    // A read that lands while the session's write runs is dropped.
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "");
    const saving = store.save(target(), { face: "meh", text: "" });
    store.setDraft(null, "");
    store.knowSaved(ID, { face: "smile", text: "from the file" });
    expect(store.saved).toBeNull();
    expect(store.draft).toEqual(EMPTY);
    await c.settle("saved");
    await saving;
    // A read begun before this device's Clear, landing after it, is too.
    const d = host();
    const cleared = new FocusNoteStore(d.h);
    cleared.ended(target());
    const first = cleared.save(target(), { face: "meh", text: "a" });
    await d.settle("saved");
    await first;
    const clearing = cleared.clear(target());
    await d.settle("saved");
    await clearing;
    expect(cleared.saved).toBeNull();
    cleared.knowSaved(ID, { face: "meh", text: "a" });
    expect(cleared.saved).toBeNull();
    expect(cleared.draft).toEqual(EMPTY);
    // A session this device never wrote still takes what the file holds.
    const e = host();
    const fresh = new FocusNoteStore(e.h);
    fresh.ended(target());
    fresh.knowSaved(ID, { face: "meh", text: "a" });
    expect(fresh.saved).toMatchObject({ face: "meh", text: "a" });
  });

  it("judges a draft by its words while a cut note is written, not by which object it is (round 2)", async () => {
    const long = "a ".repeat(600);
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", long);
    const note = noteFromInput("meh", long);
    expect(note.cut).toBe(true);
    const saving = store.save(target(), { face: note.face, text: note.text });
    // The face pressed off and on: a new draft object with the same words.
    store.setDraft(null, long);
    store.setDraft("meh", long);
    store.focusStarted();
    expect(c.notices).toEqual([]);
    await c.settle("saved");
    await saving;
    expect(store.view(moment)).toMatchObject({ dirty: false, saveActive: false });
    expect(store.draft).toEqual({ face: "meh", text: note.text });
  });

  it("says nothing when an emptied card leaves a saved note in the log (round 2)", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    const saving = store.save(target(), { face: "smile", text: "good" });
    await c.settle("saved");
    await saving;
    store.setDraft(null, "");
    expect(store.view(moment)?.dirty).toBe(true);
    store.focusStarted();
    store.ended(target({ sessionId: OTHER }));
    expect(c.notices).toEqual([]);
    // A face alone is something to save, and is still told about.
    store.setDraft("frown", "");
    store.ended(target());
    expect(c.notices).toEqual([DROPPED_NOTE_NOTICE]);
  });

  it("holds a draft to NOTE_DRAFT_MAX, typed or read back", () => {
    const { h, storage } = host();
    const store = new FocusNoteStore(h);
    store.ended(target());
    store.setDraft(null, "[[".repeat(5000) + "x" + "]]".repeat(5000));
    expect(store.draft.text).toHaveLength(NOTE_DRAFT_MAX);
    expect(NOTE_DRAFT_MAX).toBeGreaterThanOrEqual(2 * 500);
    // A long draft still says it was cut: the cap keeps more than Save keeps.
    store.setDraft(null, "a".repeat(NOTE_DRAFT_MAX + 10));
    expect(store.view(moment)?.dirty).toBe(true);
    const stored = storage.load(FOCUS_NOTE_KEY) as { draft: { text: string } };
    expect(stored.draft.text).toHaveLength(NOTE_DRAFT_MAX);
    const big = { ...stored, draft: { face: null, text: "b".repeat(NOTE_DRAFT_MAX * 3) } };
    expect(readFocusNoteState(big).draft.text).toHaveLength(NOTE_DRAFT_MAX);
    // In UTF-16 units, as the box's maxlength counts: astral characters are two.
    store.setDraft(null, "😀".repeat(NOTE_DRAFT_MAX));
    expect(store.draft.text).toHaveLength(NOTE_DRAFT_MAX);
  });

  it("keeps the words on a refusal, and says why", async () => {
    for (const result of ["waiting", "no-file", "missing", "failed"] as const) {
      const c = host();
      const store = new FocusNoteStore(c.h);
      store.ended(target());
      store.setDraft("frown", "kept");
      const saving = store.save(target(), noteFromInput("frown", "kept"));
      await c.settle(result);
      expect(await saving).toBe(result);
      expect(c.notices, result).toEqual([NOTE_WRITE_MESSAGES[result]]);
      expect(store.draft).toEqual({ face: "frown", text: "kept" });
      expect(store.saved).toBeNull();
      expect(store.view(moment)?.status).toBe("Not saved");
    }
  });

  it("calls a write that throws failed", async () => {
    const c = host();
    const store = new FocusNoteStore({ ...c.h, write: () => Promise.reject(new Error("x")) });
    store.ended(target());
    expect(await store.save(target(), { face: "meh", text: "" })).toBe("failed");
    expect(c.notices).toEqual([NOTE_WRITE_MESSAGES.failed]);
    expect(store.busy).toBe(false);
  });

  it("clears a saved note off the line, and empties the card", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    const saving = store.save(target(), { face: "meh", text: "x" });
    await c.settle("saved");
    await saving;
    const clearing = store.clear(target());
    expect(c.writes[1]).toEqual({ target: target(), note: null });
    await c.settle("saved");
    await clearing;
    expect(store.saved).toBeNull();
    expect(store.draft).toEqual(EMPTY);
    expect(store.view(moment)?.status).toBe("");
  });

  it("clears unsaved words without a write", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "typed");
    store.clearDraft();
    expect(store.draft).toEqual(EMPTY);
    expect(c.writes).toEqual([]);
  });

  it("follows the line to the file it was found in", async () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target({ logged: "queued" }));
    const saving = store.save(target(), { face: "meh", text: "" });
    c.move("Renamed/2026-11-03-gentle-pomodoro-log.md");
    await c.settle("saved");
    await saving;
    expect(store.target).toMatchObject({
      path: "Renamed/2026-11-03-gentle-pomodoro-log.md",
      logged: "file",
    });
  });

  it("shares one draft between every card, and tells each of a change", () => {
    const { h } = host();
    const store = new FocusNoteStore(h);
    const a = vi.fn();
    const b = vi.fn();
    store.onChange(a);
    store.onChange(b);
    store.ended(target());
    store.setDraft("smile", "x");
    expect(store.draft).toEqual({ face: "smile", text: "x" });
    expect(a).toHaveBeenLastCalledWith({ reseed: false });
    expect(b).toHaveBeenLastCalledWith({ reseed: false });
    store.offChange(b);
    store.setDraft("smile", "xy");
    expect(b).toHaveBeenCalledTimes(2);
    // No session, no draft.
    const empty = new FocusNoteStore(host().h);
    empty.setDraft("meh", "x");
    expect(empty.draft).toEqual(EMPTY);
  });

  it("is kept on this device, and a reload shows a card that was open open again", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "unsaved");
    const again = new FocusNoteStore(c.h);
    expect(again.target).toEqual(target());
    expect(again.cardOpen).toBe(true);
    expect(again.draft).toEqual({ face: "meh", text: "unsaved" });
    again.focusStarted();
    expect(new FocusNoteStore(c.h).cardOpen).toBe(false);
    // Stored under its own key, never in data.json.
    expect(c.storage.values.has(FOCUS_NOTE_KEY)).toBe(true);
  });

  it("takes the session the command chose from the log, with the note its line has", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft(null, "unsaved");
    store.adopt(target({ sessionId: OTHER }), { face: "smile", text: "from the file" });
    expect(c.notices).toEqual([DROPPED_NOTE_NOTICE]);
    expect(store.target?.sessionId).toBe(OTHER);
    expect(store.cardOpen).toBe(true);
    expect(store.saved).toEqual({ face: "smile", text: "from the file", at: null });
    expect(store.view(moment)).toMatchObject({ dirty: false, status: "Saved" });
  });

  it("keeps what it has when the command chooses the session it already holds", () => {
    const c = host();
    const store = new FocusNoteStore(c.h);
    store.ended(target());
    store.setDraft("meh", "typed here");
    store.adopt(target(), { face: "smile", text: "from the file" });
    expect(c.notices).toEqual([]);
    expect(store.draft).toEqual({ face: "meh", text: "typed here" });
    expect(store.saved).toBeNull();
  });

  it("learns a note from the file only when it knows none and nothing is typed", () => {
    const { h } = host();
    const store = new FocusNoteStore(h);
    store.ended(target());
    store.knowSaved(OTHER, { face: "meh", text: "x" });
    expect(store.saved).toBeNull();
    store.setDraft(null, "typing");
    store.knowSaved(ID, { face: "meh", text: "x" });
    expect(store.saved).toBeNull();
    store.clearDraft();
    store.knowSaved(ID, { face: "meh", text: "x" });
    expect(store.saved).toEqual({ face: "meh", text: "x", at: null });
    expect(store.draft).toEqual({ face: "meh", text: "x" });
  });
});

describe("readFocusNoteState", () => {
  const good = {
    target: target(),
    cardOpen: true,
    draft: { face: "meh", text: "x" },
    saved: { face: "smile", text: "", at: 5 },
  };

  it("reads back what the store keeps", () => {
    expect(readFocusNoteState(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(
      readFocusNoteState({ ...good, saved: { face: null, text: "y", at: null } }).saved
    ).toEqual({ face: null, text: "y", at: null });
  });

  it("refuses anything else", () => {
    const empty = { target: null, cardOpen: false, draft: EMPTY, saved: null };
    for (const raw of [null, 7, "x", [], {}]) expect(readFocusNoteState(raw)).toEqual(empty);
    for (const bad of [
      { sessionId: "not-an-id" },
      { path: 3 },
      { logged: "maybe" },
      { startMs: Number.NaN },
      { endMs: "10" },
      { taskName: null },
      { taskPath: 1 },
    ]) {
      const raw = { ...good, target: { ...target(), ...bad } };
      expect(readFocusNoteState(raw), JSON.stringify(bad)).toEqual(empty);
    }
    expect(readFocusNoteState({ ...good, cardOpen: "yes" }).cardOpen).toBe(false);
    expect(readFocusNoteState({ ...good, draft: { face: "grin", text: "" } }).draft).toEqual(EMPTY);
    expect(readFocusNoteState({ ...good, draft: { face: null } }).draft).toEqual(EMPTY);
    for (const saved of [
      { face: "smile", text: "", at: "5" },
      { face: null, text: "", at: 1 },
      { face: "Smile", text: "x", at: 1 },
      "smile",
    ]) {
      expect(readFocusNoteState({ ...good, saved }).saved, JSON.stringify(saved)).toBeNull();
    }
  });
});

describe("chooseLastSession — the command's last session", () => {
  const days = ["2026-11-03", "2026-11-02"];
  const dayOf = (ms: number) => moment(ms).format("YYYY-MM-DD");
  const file = (overrides: Partial<FileNoteLine["line"]> = {}, note: FocusNote | null = null) => ({
    path: "Logs/2026-11-03-gentle-pomodoro-log.md",
    line: {
      sessionId: OTHER,
      start: "2026-11-03 11:00:00",
      end: "2026-11-03 11:25:00",
      taskName: "Other device",
      ...overrides,
    },
    note,
  });

  it("takes this device's session while no newer focus line is in the log", () => {
    expect(chooseLastSession({ store: target(), file: null, days, dayOf })).toEqual({
      kind: "store",
    });
    // The same session's line.
    const same = file({ sessionId: ID, end: "2026-11-03 10:25:00" });
    expect(chooseLastSession({ store: target(), file: same, days, dayOf }).kind).toBe("store");
    // An older line — or one ending at the same second.
    const older = file({ end: "2026-11-03 09:25:00" });
    expect(chooseLastSession({ store: target(), file: older, days, dayOf }).kind).toBe("store");
    const tie = file({ end: "2026-11-03 10:25:00" });
    expect(chooseLastSession({ store: target(), file: tie, days, dayOf }).kind).toBe("store");
    // Logged with no folder, or still waiting: no line at all.
    const none = target({ logged: "none", path: null });
    expect(chooseLastSession({ store: none, file: null, days, dayOf }).kind).toBe("store");
    // Yesterday's still counts.
    const yesterday = target({ endMs: at(23, 0, 2) });
    expect(chooseLastSession({ store: yesterday, file: null, days, dayOf }).kind).toBe("store");
  });

  it("takes the log's newer line, with its note", () => {
    const note = { face: "meh" as const, text: "from the other device" };
    expect(chooseLastSession({ store: target(), file: file({}, note), days, dayOf })).toEqual({
      kind: "file",
      target: {
        sessionId: OTHER,
        path: "Logs/2026-11-03-gentle-pomodoro-log.md",
        logged: "file",
        startMs: at(11, 0),
        endMs: at(11, 25),
        taskName: "Other device",
      },
      saved: note,
    });
  });

  it("takes the log's line over a session from before yesterday", () => {
    const old = target({ endMs: at(10, 25, 1) });
    const older = file({ end: "2026-11-01 09:00:00", start: "2026-11-01 08:35:00" });
    expect(chooseLastSession({ store: old, file: older, days, dayOf }).kind).toBe("file");
    expect(chooseLastSession({ store: old, file: null, days, dayOf })).toEqual({ kind: "none" });
  });

  it("finds none with neither, nor on a line whose times cannot be read", () => {
    expect(chooseLastSession({ store: null, file: null, days, dayOf })).toEqual({ kind: "none" });
    const broken = file({ start: "", end: "" });
    expect(chooseLastSession({ store: null, file: broken, days, dayOf })).toEqual({ kind: "none" });
    // One readable time is enough to name it.
    const half = chooseLastSession({ store: null, file: file({ start: "" }), days, dayOf });
    expect(half).toMatchObject({
      kind: "file",
      target: { startMs: at(11, 25), endMs: at(11, 25) },
    });
  });
});

describe("FocusNoteModal", () => {
  it("is held in the plugin's open dialogs only while it is open, so unload can close it", () => {
    const open = new Set<{ close(): void }>();
    const closed = vi.fn();
    const store = new FocusNoteStore(host().h);
    const modal = new FocusNoteModal({} as never, store, open, closed);
    modal.open();
    expect([...open]).toEqual([modal]);
    modal.close();
    expect(open.size).toBe(0);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("main.ts wires the focus note", () => {
  // main.ts cannot be imported by a test (vitest resolves it to the built
  // main.js), so the lines that matter are read as text, comments stripped.
  const main = readFileSync(resolve(__dirname, "..", "main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
  const onload = callbackBody(main, "override async onload() {");
  const onunload = callbackBody(main, "override onunload() {");

  it("gives the log manager the store's two methods at load, and takes them back at unload", () => {
    expect(onload).toContain(
      "this.logManager.setFocusNoteHooks({ ended: (target) => { this.focusNotes.ended(target); }, focusStarted: () => { this.focusNotes.focusStarted(); }, });"
    );
    // After both exist.
    const hooks = onload.indexOf("this.logManager.setFocusNoteHooks(");
    expect(hooks).toBeGreaterThan(onload.indexOf("this.logManager = new LogManager("));
    expect(hooks).toBeGreaterThan(onload.indexOf("this.focusNotes = new FocusNoteStore("));
    expect(onunload).toContain("this.logManager.setFocusNoteHooks(null);");
    // Before the log manager is disposed, which an end still writing outlives.
    expect(onunload.indexOf("setFocusNoteHooks(null)")).toBeLessThan(
      onunload.indexOf("this.logManager.dispose();")
    );
  });

  it("keeps the store on this device and writes through the log manager", () => {
    const store = onload.slice(onload.indexOf("this.focusNotes = new FocusNoteStore({"));
    expect(store).toContain("storage: deviceStorage(this.app),");
    expect(store).toContain("enabled: () => this.settings.focusNoteEnabled,");
    expect(store).toContain(
      "write: (target, note, moved) => this.logManager.writeSessionNote(target, note, moved),"
    );
  });

  it("offers the command only while the note is offered", () => {
    const at = onload.indexOf('id: "add-focus-note"');
    expect(at).toBeGreaterThan(-1);
    const command = onload.slice(at, onload.indexOf("this.addCommand(", at));
    expect(command).toContain("name: FOCUS_NOTE_COMMAND_NAME,");
    expect(command).toContain(
      "checkCallback: (checking: boolean) => { if (!this.settings.focusNoteEnabled) return false; if (!checking) void this.openFocusNote(); return true; },"
    );
    expect(FOCUS_NOTE_COMMAND_NAME).toBe("Add a note to the last session");
    // Beside "Open today's log".
    expect(onload.indexOf('id: "open-todays-log"')).toBeLessThan(at);
  });

  it("opens one dialog at a time, held among the session dialogs unload closes", () => {
    const open = callbackBody(main, "async openFocusNote(): Promise<void> {");
    expect(open.trim().startsWith("if (this.focusNoteDialog) return;")).toBe(true);
    expect(open).toContain(
      "const dialog = new FocusNoteModal(this.app, store, this.sessionDialogs, () => { if (this.focusNoteDialog === dialog) this.focusNoteDialog = null; });"
    );
    expect(open.indexOf("this.focusNoteDialog = dialog;")).toBeLessThan(
      open.indexOf("dialog.open();")
    );
    expect(open).toContain("new Notice(NO_SESSION_NOTICE);");
    expect(open).toContain("store.adopt(choice.target, choice.saved);");
  });

  it("chooses among today's and yesterday's sessions, as the log names its days", () => {
    const open = callbackBody(main, "async openFocusNote(): Promise<void> {");
    expect(open).toContain(
      'days: [ logicalDate(moment(), dayStartHour), logicalDate(moment().subtract(1, "day"), dayStartHour), ], dayOf: (ms) => logicalDate(moment(ms), dayStartHour),'
    );
    expect(open).toContain("const dayStartHour = this.settings.dayStartHour;");
  });
});
