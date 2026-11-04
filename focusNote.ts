import type { DeviceStorage } from "./deviceStorage";
import {
  NOTE_FACES,
  NOTE_TEXT_MAX,
  cleanNoteText,
  isSessionId,
  parseNoteValue,
  readLogTime,
  type FocusNote,
  type NoteFace,
  type SessionNoteLine,
} from "./logLine";
import type { MomentFactory } from "./momentTypes";
import { linkedTaskDisplayName } from "./taskLoader";

/**
 * The focus note (0.7.1): after a focus session ends and its line is written
 * (Stop, Skip, time-up), a small card asks how it went and keeps a face and a
 * few words on that session's line, `[Note:: meh · stuck on refs]`
 * (logLine.ts). Off by default, and nothing during focus: the zero crossing
 * stays silent, and the card stays until the next FOCUS session starts.
 *
 * This module holds what is shared by every card and the command: the store
 * (one per plugin, so every open panel, the modal and the command see one
 * state), the card's state as words and switches, and the choice of "the last
 * session". No `obsidian` import: every side effect arrives through the host,
 * so the rules can be tested with a fake, as FocusTotalTracker's are.
 */

/** Shared verbatim by the settings tab and the timer panel. */
export const FOCUS_NOTE_LABEL = "Offer a focus note";

export const FOCUS_NOTE_DESC =
  "After each focus session is logged, a small card in the timer panel asks how it went and keeps a few words on that session's line in the log. Needs a log folder. Your keyboard's dictation works in the box.";

/** The command's name, and the status bar menu entry's title. */
export const FOCUS_NOTE_COMMAND_NAME = "Add a note to the last session";

/** The box's placeholder: a question for the face pressed, or for none. */
export const FOCUS_NOTE_PROMPTS: Record<NoteFace | "none", string> = {
  none: "What moved forward? Where will you pick up?",
  frown: "What got in the way?",
  meh: "What would make the next one easier?",
  smile: "What went well?",
};

/** The faces' accessible names (and their hover text). */
export const FACE_LABELS: Record<NoteFace, string> = {
  frown: "Rough",
  meh: "Okay",
  smile: "Good",
};

/** What the card shows in place of the form when no log folder is set. */
export const FOCUS_NOTE_HINT = "Set a log folder to keep a short note after each focus session.";

/** Kept on this device (deviceStorage), never in data.json. */
export const FOCUS_NOTE_KEY = "gentle-pomodoro-focus-note";

/** Where a note goes: the session that just ended, as the log manager wrote it. */
export interface FocusNoteTarget {
  sessionId: string;
  /** The log file the line was written to, or would be; null with no folder. */
  path: string | null;
  /** In the file, waiting in the retry queue, or not logged (no folder). */
  logged: "file" | "queued" | "none";
  startMs: number;
  endMs: number;
  /** The last line's task name (after a 🆔 refresh), NO_TASK_LABEL for none. */
  taskName: string;
  taskPath?: string;
}

/** How LogManager tells the store a focus ended or began (setFocusNoteHooks). */
export interface FocusNoteHooks {
  /** A counted focus session's lines were written (or kept to retry, or not logged). */
  ended(target: FocusNoteTarget): void;
  /** A new focus session opened: the card goes. */
  focusStarted(): void;
}

/** What a note write did (LogManager.writeSessionNote). */
export type NoteWriteResult = "saved" | "unchanged" | "waiting" | "no-file" | "missing" | "failed";

/** The Notice for each write that did not land. The status line says only "Not saved". */
export const NOTE_WRITE_MESSAGES: Record<
  Exclude<NoteWriteResult, "saved" | "unchanged">,
  string
> = {
  waiting: "The session's line isn't in the log yet — your note is kept. Try again in a moment.",
  "no-file": "The log file for that session isn't there, or isn't ready yet — your note is kept.",
  missing: "That session's line is no longer in the log, so the note wasn't saved.",
  failed: "Couldn't save the focus note — your note is kept.",
};

/** A dirty draft, when a card that shows hides: the next focus started. */
export const UNSAVED_NOTE_NOTICE = `Your focus note isn't saved yet. Run "${FOCUS_NOTE_COMMAND_NAME}" to finish it.`;

/** A dirty draft, when the next counted focus end replaces its session. */
export const DROPPED_NOTE_NOTICE = "An unsaved focus note for the session before was dropped.";

/** Clear's own words for a write that did not land: the note is still there. */
export const NOTE_CLEAR_MESSAGES: Record<
  Exclude<NoteWriteResult, "saved" | "unchanged">,
  string
> = {
  waiting: "The session's line isn't in the log yet, so there is no note to take off.",
  "no-file":
    "The log file for that session isn't there, or isn't ready yet — the note wasn't taken off.",
  missing: "That session's line is no longer in the log.",
  failed: "Couldn't take the focus note off — it is still in the log.",
};

/** A write for the session before that failed after the card moved on. */
export const EARLIER_NOTE_FAILED_NOTICE = "Couldn't save the focus note for the session before.";

/** A clear for the session before that failed after the card moved on. */
export const EARLIER_CLEAR_FAILED_NOTICE =
  "Couldn't take the focus note off the session before — it is still in the log.";

/**
 * The most a draft holds, in UTF-16 units. Every code point is one or two
 * units, so this keeps at least NOTE_TEXT_MAX code points and Save can still
 * say it cut the rest; it bounds what each keystroke cleans and stores, so a
 * huge paste cannot make typing slow (flattenLinks is quadratic in nesting).
 */
export const NOTE_DRAFT_MAX = NOTE_TEXT_MAX * 4;

/** A draft's words, held to NOTE_DRAFT_MAX. */
export function capDraftText(text: string): string {
  return text.length > NOTE_DRAFT_MAX ? text.slice(0, NOTE_DRAFT_MAX) : text;
}

/** The command, when there is no session to add a note to. */
export const NO_SESSION_NOTICE = "No logged focus session to add a note to yet.";

/** What is in the line, as far as this device knows. `at`: when this device
 *  saved it; null when it was read from the file. */
export interface SavedNote extends FocusNote {
  at: number | null;
}

/** What the store keeps on this device (FOCUS_NOTE_KEY). */
export interface FocusNoteState {
  target: FocusNoteTarget | null;
  cardOpen: boolean;
  draft: FocusNote;
  saved: SavedNote | null;
}

const EMPTY_NOTE: FocusNote = { face: null, text: "" };

function isFace(value: unknown): value is NoteFace {
  return NOTE_FACES.includes(value as NoteFace);
}

/**
 * A note as typed, made what the line will store (§1 of the 0.7.1 spec): the
 * words cleaned (sanitizeNote), and `cut` when the cap shortened them. Words
 * typed without a face that read as one (`meh`, `smile · went fine`) are
 * given that face here, before saving — the line has no way to store them as
 * words — so what the card shows after a save is what is stored.
 */
export function noteFromInput(face: NoteFace | null, text: string): FocusNote & { cut: boolean } {
  const { text: clean, cut } = cleanNoteText(text);
  const pressed = isFace(face) ? face : null;
  if (pressed === null) {
    const read = parseNoteValue(clean);
    if (read?.face) return { face: read.face, text: read.text, cut };
  }
  return { face: pressed, text: clean, cut };
}

function sameNote(a: FocusNote, b: FocusNote): boolean {
  return a.face === b.face && a.text === b.text;
}

/** Whether `draft` would change the line: it differs from `saved` once made
 *  what the line stores, or the cap cut it (so Save shows what was kept). */
export function noteIsDirty(draft: FocusNote, saved: FocusNote | null): boolean {
  return cleanedIsDirty(noteFromInput(draft.face, draft.text), saved);
}

/** noteIsDirty for a draft already cleaned (cardView cleans it once). */
function cleanedIsDirty(note: ReturnType<typeof noteFromInput>, saved: FocusNote | null): boolean {
  return note.cut || !sameNote(note, saved ?? EMPTY_NOTE);
}

/** One time format for the card's two lines: the app's, as "Ends 15:30" is. */
export function noteTime(moment: MomentFactory, ms: number): string {
  return moment(ms).format("LT");
}

/** The "Last time" line under the task button (0.7.1): its label's first word. */
export const LAST_NOTE_LABEL = "Last time";

/**
 * When the linked task's newest note was, for the "Last time" label:
 * "today" and "yesterday" by the logical day of the log file it was found in
 * (`daysAgo`, as LogManager walks them, "Day starts at" counted), else the
 * line's Start as a short date in the app's language — shown, never stored.
 * The file's own logical day (`day`, YYYY-MM-DD) stands in when Start cannot
 * be read — not today's date less `daysAgo`, which is a day late after
 * midnight under "Day starts at".
 */
export function lastNoteWhen(
  moment: MomentFactory,
  daysAgo: number,
  start: string,
  day: string
): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  const seconds = readLogTime(start);
  return (seconds === null ? moment(day) : moment(seconds * 1000)).format("ll");
}

/** What a card draws: the form or the hint, its words and its switches. */
export interface CardView {
  mode: "form" | "hint";
  dirty: boolean;
  saveLabel: "Save" | "Update";
  saveActive: boolean;
  clearActive: boolean;
  /** "", "Not saved", "Saving…", "Saved" or "Saved <time>". */
  status: string;
  placeholder: string;
  sessionLine: string;
}

/** The store's state a card reads (FocusNoteStore.view). */
export interface CardState {
  target: FocusNoteTarget;
  saved: SavedNote | null;
  draft: FocusNote;
  busy: boolean;
}

/**
 * The card, from the store's state. Both empty never saves — taking a note
 * off is Clear's job, which asks first — and a face with an empty box has
 * Clear inactive (deselect the face instead). Inactive while a write runs.
 */
export function cardView(state: CardState, moment: MomentFactory): CardView {
  const { target, saved, draft, busy } = state;
  const note = noteFromInput(draft.face, draft.text);
  const dirty = cleanedIsDirty(note, saved);
  let status = "";
  if (busy) status = "Saving…";
  else if (dirty) status = "Not saved";
  else if (saved !== null) {
    status = saved.at === null ? "Saved" : `Saved ${noteTime(moment, saved.at)}`;
  }
  return {
    mode: target.logged === "none" ? "hint" : "form",
    dirty,
    saveLabel: saved !== null ? "Update" : "Save",
    saveActive: dirty && (note.face !== null || note.text !== "") && !busy,
    clearActive: (saved !== null || draft.text.trim() !== "") && !busy,
    status,
    placeholder: FOCUS_NOTE_PROMPTS[isFace(draft.face) ? draft.face : "none"],
    sessionLine: `${noteTime(moment, target.startMs)}–${noteTime(moment, target.endMs)} · ${linkedTaskDisplayName(target.taskName)}`,
  };
}

function readTarget(raw: unknown): FocusNoteTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const logged = t.logged;
  if (
    !isSessionId(t.sessionId) ||
    !(typeof t.path === "string" || t.path === null) ||
    !(logged === "file" || logged === "queued" || logged === "none") ||
    typeof t.startMs !== "number" ||
    !Number.isFinite(t.startMs) ||
    typeof t.endMs !== "number" ||
    !Number.isFinite(t.endMs) ||
    typeof t.taskName !== "string" ||
    !(t.taskPath === undefined || typeof t.taskPath === "string")
  ) {
    return null;
  }
  const target: FocusNoteTarget = {
    sessionId: t.sessionId,
    path: t.path,
    logged,
    startMs: t.startMs,
    endMs: t.endMs,
    taskName: t.taskName,
  };
  if (typeof t.taskPath === "string") target.taskPath = t.taskPath;
  return target;
}

function readNote(raw: unknown): FocusNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  if (!(n.face === null || isFace(n.face)) || typeof n.text !== "string") return null;
  return { face: n.face, text: capDraftText(n.text) };
}

/**
 * The stored state read back defensively (data from this device, but from an
 * older or a damaged run as much as this one): anything that is not what the
 * store writes is dropped, and without a usable target there is nothing.
 */
export function readFocusNoteState(raw: unknown): FocusNoteState {
  const empty: FocusNoteState = { target: null, cardOpen: false, draft: EMPTY_NOTE, saved: null };
  if (typeof raw !== "object" || raw === null) return empty;
  const r = raw as Record<string, unknown>;
  const target = readTarget(r.target);
  if (target === null) return empty;
  let saved: SavedNote | null = null;
  const savedNote = readNote(r.saved);
  const at = (r.saved as { at?: unknown } | null | undefined)?.at;
  if (
    savedNote !== null &&
    (savedNote.face !== null || savedNote.text !== "") &&
    (at === null || (typeof at === "number" && Number.isFinite(at)))
  ) {
    saved = { ...savedNote, at };
  }
  return {
    target,
    cardOpen: r.cardOpen === true,
    draft: readNote(r.draft) ?? EMPTY_NOTE,
    saved,
  };
}

/** The newest focus line in today's or yesterday's log, as LogManager read it. */
export interface FileNoteLine {
  path: string;
  line: SessionNoteLine;
  /** Its note now (readSessionNote), null when it has none. */
  note: FocusNote | null;
}

export type LastSessionChoice =
  | { kind: "store" }
  | { kind: "file"; target: FocusNoteTarget; saved: FocusNote | null }
  | { kind: "none" };

/**
 * "The last session", for the command and the status bar menu. This device's
 * own while its end is on one of `days` (today and the day before, logical)
 * and no newer focus line is in the log: the same session, or one that ended
 * no later — which keeps a line still waiting to be written and a session
 * logged with no folder. Otherwise the log's newest focus line (another
 * device's, or after a long gap), and with neither, none.
 */
export function chooseLastSession(input: {
  store: FocusNoteTarget | null;
  file: FileNoteLine | null;
  days: readonly string[];
  /** The logical date of an instant, as the log names its files. */
  dayOf: (ms: number) => string;
}): LastSessionChoice {
  const { store, file, days, dayOf } = input;
  const seconds = (text: string) => readLogTime(text);
  const fileStart = file ? seconds(file.line.start) : null;
  const fileEnd = file ? seconds(file.line.end) : null;
  if (store !== null && days.includes(dayOf(store.endMs))) {
    if (
      file === null ||
      store.sessionId === file.line.sessionId ||
      fileEnd === null ||
      store.endMs >= fileEnd * 1000
    ) {
      return { kind: "store" };
    }
  }
  if (file === null) return { kind: "none" };
  const endSec = fileEnd ?? fileStart;
  const startSec = fileStart ?? fileEnd;
  // A line whose times cannot be read gives the card nothing to say which
  // session it is: no note goes on it from here.
  if (endSec === null || startSec === null) return { kind: "none" };
  return {
    kind: "file",
    target: {
      sessionId: file.line.sessionId,
      path: file.path,
      logged: "file",
      startMs: startSec * 1000,
      endMs: endSec * 1000,
      taskName: file.line.taskName,
    },
    saved: file.note,
  };
}

/** What the store needs from the plugin. */
export interface FocusNoteHost {
  storage: DeviceStorage;
  /** The setting, read now: the "isn't saved" Notice is for a card that showed. */
  enabled(): boolean;
  /** Write `note` on the target's line, or take it off (null) —
   *  LogManager.writeSessionNote. `moved` is told when the line was found in
   *  another file than the target's path. */
  write(
    target: FocusNoteTarget,
    note: FocusNote | null,
    moved: (path: string) => void
  ): Promise<NoteWriteResult>;
  notice(message: string): void;
  now(): number;
}

/** A write the store has started and not yet settled. */
interface PendingWrite {
  sessionId: string;
  note: FocusNote | null;
  typed: FocusNote;
}

/** A store change. `reseed`: every card takes the store's draft, the one
 *  being typed in too — after a save, a clear, or a new session. */
export interface FocusNoteChange {
  reseed: boolean;
}
export type FocusNoteListener = (change: FocusNoteChange) => void;

/**
 * The focus note's one state, shared by every card, the modal and the command
 * (§3 of the 0.7.1 spec). Kept on this device at every change, so a reload
 * shows a card that was open open again — only a focus start closes it.
 */
export class FocusNoteStore {
  private state: FocusNoteState;
  /**
   * Writes not yet settled, oldest first: the one running, then any waiting
   * behind it. Each has its session, the note it puts there (null for a
   * clear) and the draft as the click left it. One per session; a write for
   * another session waits its turn, so two never run at once.
   */
  private writes: PendingWrite[] = [];
  /** Sessions whose line a write of this store has settled on. */
  private readonly wrote = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<FocusNoteListener>();
  /** Settled writes so far (revision). */
  private settled = 0;

  constructor(private readonly host: FocusNoteHost) {
    this.state = readFocusNoteState(host.storage.load(FOCUS_NOTE_KEY));
  }

  /** The session a note goes on; kept across a focus start, so the command
   *  still reaches it during the next focus. */
  get target(): FocusNoteTarget | null {
    return this.state.target;
  }
  /** True from a counted focus end until the next focus starts. A panel shows
   *  the card when this, the setting and a target all hold. */
  get cardOpen(): boolean {
    return this.state.cardOpen;
  }
  get saved(): SavedNote | null {
    return this.state.saved;
  }
  /**
   * Moves each time a write of this store settles, whatever its result: the
   * log may hold another note now. The panel's "Last time" line re-reads the
   * log on it — and on nothing a keystroke changes, as every setDraft is a
   * change too.
   */
  get revision(): number {
    return this.settled;
  }
  /** What is typed, shared by every card. */
  get draft(): FocusNote {
    return this.state.draft;
  }
  /** A write for the card's own session in flight: Save and Clear are
   *  inactive meanwhile. A write for an earlier session does not count. */
  get busy(): boolean {
    return this.pendingFor(this.state.target?.sessionId) !== null;
  }

  private pendingFor(sessionId: string | undefined): PendingWrite | null {
    if (sessionId === undefined) return null;
    const own = this.writes.filter((w) => w.sessionId === sessionId);
    return own.length > 0 ? own[own.length - 1] : null;
  }

  /**
   * Whether the card holds words that will not reach the line — what the
   * UNSAVED and DROPPED notices ask. An empty card is not: nothing typed can
   * be lost, and a saved note it emptied is still in the log (only Clear
   * takes it off). While its session's write runs, what lands is the note
   * being written, so the draft is judged against that by content (the cut
   * does not count: the write cut it the same way).
   */
  isDirty(): boolean {
    const { target, draft, saved } = this.state;
    if (target === null) return false;
    const note = noteFromInput(draft.face, draft.text);
    if (note.face === null && note.text === "") return false;
    const pending = this.pendingFor(target.sessionId);
    if (pending === null) return cleanedIsDirty(note, saved);
    return draft !== pending.typed && !sameNote(note, pending.note ?? EMPTY_NOTE);
  }

  /** The card's words and switches now; null with no session. */
  view(moment: MomentFactory): CardView | null {
    const { target, saved, draft } = this.state;
    if (target === null) return null;
    return cardView({ target, saved, draft, busy: this.busy }, moment);
  }

  onChange(listener: FocusNoteListener): void {
    this.listeners.add(listener);
  }
  offChange(listener: FocusNoteListener): void {
    this.listeners.delete(listener);
  }

  /**
   * A counted focus session ended: its card opens, empty. A draft for the
   * session before that was never saved is dropped, and the user told.
   * With "Offer a focus note" off, the session becomes the target and nothing
   * more: no card opens — or it would show for this session the moment the
   * setting is turned on — and a dropped draft, which no card was showing,
   * says nothing.
   */
  ended(target: FocusNoteTarget): void {
    const enabled = this.host.enabled();
    if (enabled && this.isDirty()) this.host.notice(DROPPED_NOTE_NOTICE);
    this.state = { target: { ...target }, cardOpen: enabled, draft: EMPTY_NOTE, saved: null };
    this.changed(true);
  }

  /**
   * A focus session opened: the card goes. Its draft stays — the command
   * brings it back — and a card that was showing with words not saved says
   * so once. A card that was not showing (the setting off) says nothing.
   */
  focusStarted(): void {
    if (!this.state.cardOpen) return;
    if (this.host.enabled() && this.isDirty()) this.host.notice(UNSAVED_NOTE_NOTICE);
    this.state = { ...this.state, cardOpen: false };
    this.changed(false);
  }

  /** What a card's face or box now holds. */
  setDraft(face: NoteFace | null, text: string): void {
    if (this.state.target === null) return;
    const draft = { face: isFace(face) ? face : null, text: capDraftText(text) };
    if (sameNote(draft, this.state.draft)) return;
    this.state = { ...this.state, draft };
    this.changed(false);
  }

  /** Clear with nothing saved: only the typed words go, and nothing is written. */
  clearDraft(): void {
    if (this.state.target === null || sameNote(this.state.draft, EMPTY_NOTE)) return;
    this.state = { ...this.state, draft: EMPTY_NOTE };
    this.changed(true);
  }

  /**
   * Write `note` — normalised (noteFromInput), as captured at the click — on
   * `target`'s line. Null while a write for that session is unsettled (a
   * double click); a write for another session waits behind the running one.
   */
  save(target: FocusNoteTarget, note: FocusNote): Promise<NoteWriteResult | null> {
    return this.write(target, { face: note.face, text: note.text });
  }

  /** Take the note off `target`'s line (Clear, once confirmed). */
  clear(target: FocusNoteTarget): Promise<NoteWriteResult | null> {
    return this.write(target, null);
  }

  /**
   * The command chose a session from the log (chooseLastSession): it becomes
   * the target, with the note its line has. The card's open state stays.
   */
  adopt(target: FocusNoteTarget, saved: FocusNote | null): void {
    if (this.state.target?.sessionId === target.sessionId) return;
    if (this.isDirty()) this.host.notice(DROPPED_NOTE_NOTICE);
    const note = saved && (saved.face !== null || saved.text !== "") ? saved : null;
    this.state = {
      target: { ...target },
      cardOpen: this.state.cardOpen,
      draft: note ? { face: note.face, text: note.text } : EMPTY_NOTE,
      saved: note ? { face: note.face, text: note.text, at: null } : null,
    };
    this.changed(true);
  }

  /**
   * The note the target's line holds, read from the file, when this device
   * knows of none and nothing is typed — written by another device, or
   * before a reinstall. Never over a draft or a note this device saved.
   */
  knowSaved(sessionId: string, note: FocusNote | null): void {
    const s = this.state;
    if (s.target?.sessionId !== sessionId || this.pendingFor(sessionId) || s.saved !== null) return;
    // This device wrote the line since: a read begun before that write is
    // older than what the store knows (a Clear leaves saved null too).
    if (this.wrote.has(sessionId)) return;
    if (note === null || (note.face === null && note.text === "")) return;
    if (!sameNote(s.draft, EMPTY_NOTE)) return;
    this.state = {
      ...s,
      draft: { face: note.face, text: note.text },
      saved: { face: note.face, text: note.text, at: null },
    };
    this.changed(true);
  }

  private write(target: FocusNoteTarget, note: FocusNote | null): Promise<NoteWriteResult | null> {
    if (this.pendingFor(target.sessionId) !== null) return Promise.resolve(null);
    // The draft as the click left it: one typed during the write is kept.
    const entry: PendingWrite = { sessionId: target.sessionId, note, typed: this.state.draft };
    // With nothing ahead it starts now, in this call; else after the last.
    const ahead = this.writes.length > 0;
    this.writes.push(entry);
    this.changed(false);
    const done = ahead
      ? this.queue.then(() => this.runWrite(target, entry))
      : this.runWrite(target, entry);
    this.queue = done.catch(() => undefined);
    return done;
  }

  private async runWrite(target: FocusNoteTarget, entry: PendingWrite): Promise<NoteWriteResult> {
    const { note, typed } = entry;
    let result: NoteWriteResult;
    try {
      result = await this.host.write(target, note, (path) => {
        this.moved(target.sessionId, path);
      });
    } catch {
      result = "failed";
    } finally {
      this.writes = this.writes.filter((w) => w !== entry);
      this.settled++;
    }
    if (result === "saved" || result === "unchanged") this.wrote.add(target.sessionId);
    // A focus that ended meanwhile gave the store another session: this
    // result is the old one's, and moves nothing onto the new. Its words
    // were not called dropped when it ended (they were being written), so a
    // failure says so here.
    if (this.state.target?.sessionId !== target.sessionId) {
      if (result !== "saved" && result !== "unchanged") {
        this.host.notice(note === null ? EARLIER_CLEAR_FAILED_NOTICE : EARLIER_NOTE_FAILED_NOTICE);
      }
      this.changed(false);
      return result;
    }
    if (result === "saved" || result === "unchanged") {
      const kept = note !== null && (note.face !== null || note.text !== "") ? note : null;
      // The draft takes the note that landed when it is the one the click
      // left, or holds the same words (a face pressed off and on meanwhile).
      const draft = this.state.draft;
      const landed =
        draft === typed || sameNote(noteFromInput(draft.face, draft.text), kept ?? EMPTY_NOTE);
      this.state = {
        ...this.state,
        saved: kept ? { ...kept, at: this.host.now() } : null,
        draft: landed ? (kept ?? EMPTY_NOTE) : draft,
      };
      this.changed(true);
    } else {
      this.host.notice((note === null ? NOTE_CLEAR_MESSAGES : NOTE_WRITE_MESSAGES)[result]);
      this.changed(false);
    }
    return result;
  }

  /** The line was found in another file (the log folder setting changed to
   *  where the files were moved, say). */
  private moved(sessionId: string, path: string): void {
    const target = this.state.target;
    if (target?.sessionId !== sessionId || target.path === path) return;
    this.state = { ...this.state, target: { ...target, path, logged: "file" } };
    this.persist();
  }

  private changed(reseed: boolean): void {
    this.persist();
    for (const listener of [...this.listeners]) listener({ reseed });
  }

  private persist(): void {
    const s = this.state;
    this.host.storage.save(FOCUS_NOTE_KEY, s.target === null ? null : s);
  }
}
