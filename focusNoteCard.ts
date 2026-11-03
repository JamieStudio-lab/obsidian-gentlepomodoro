import { Component, Modal, setIcon } from "obsidian";
import type { App } from "obsidian";
import { confirmAction } from "./confirmModal";
import {
  FACE_LABELS,
  FOCUS_NOTE_HINT,
  NOTE_DRAFT_MAX,
  noteFromInput,
  type FocusNoteStore,
} from "./focusNote";
import { NOTE_FACES, type NoteFace } from "./logLine";
import type { MomentFactory } from "./momentTypes";

declare const moment: MomentFactory;

/** The card's own words; what changes with the note comes from cardView. */
export const FOCUS_NOTE_TITLE = "Focus note";
export const FOCUS_NOTE_FACES_LABEL = "How did it go?";
export const FOCUS_NOTE_TEXT_LABEL = "A few words about this session";
export const CLEAR_NOTE_TITLE = "Clear this focus note?";
export const CLEAR_NOTE_BODY =
  "The face and the words are taken off the session's line in the log.";

/**
 * A module counter for the title's id: two cards (two panels, or a panel and
 * the dialog) are in the document at once, and `aria-labelledby` must name
 * the card's own title, never the other one's.
 */
let titleIds = 0;

export interface FocusNoteCardOptions {
  /** The timer panel shows the card only while it is open and the setting is
   *  on; the dialog always shows it (the form, or the hint with no folder). */
  surface: "panel" | "modal";
  app: App;
  moment: MomentFactory;
  /** The setting, read now. */
  enabled: () => boolean;
}

/**
 * The focus note's card (0.7.1, §9 of the spec): a face, a few words, Save
 * and Clear, under the task button in the timer panel and in the dialog the
 * command opens. Every card reads and writes the plugin's one FocusNoteStore,
 * so two panels and the dialog show the same note.
 *
 * Built once, in the constructor, where the caller puts it; nothing is
 * rebuilt afterwards. Its listeners are the component's own (registerDomEvent,
 * and the store's listener taken off by a register() callback), so they go
 * when the panel or the dialog unloads it — Component.registerDomEvent
 * releases on unload, never on removal.
 *
 * Two rules that read like tidy-up targets and are not (DESIGN.md entry 15):
 *  - A button that cannot act is `aria-disabled="true"`, never `disabled`. A
 *    disabled button that has focus drops it to the document in Chromium, and
 *    Save goes inactive the moment it is pressed — focus must stay on it.
 *  - Save's accent is `can-save` on the section, set from `saveActive`, not
 *    from `dirty`: a note being saved, and a saved note emptied, are dirty
 *    and inactive at once.
 */
export class FocusNoteCard extends Component {
  readonly sectionEl: HTMLElement;
  private readonly statusIconEl: HTMLElement;
  private readonly statusTextEl: HTMLElement;
  private readonly sessionEl: HTMLElement;
  private readonly formEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly faceButtons = new Map<NoteFace, HTMLButtonElement>();
  private readonly textarea: HTMLTextAreaElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  /** What sync() last painted from: the DOM is touched only when it moves. */
  private lastKey: string | null = null;
  private readonly listener = (change: { reseed: boolean }) => {
    this.seed(change.reseed);
    this.sync();
  };

  constructor(
    parent: HTMLElement,
    private readonly store: FocusNoteStore,
    private readonly options: FocusNoteCardOptions
  ) {
    super();
    const titleId = `gp-note-title-${++titleIds}`;
    const cls = options.surface === "modal" ? "gp-note gp-note-in-modal" : "gp-note gp-hidden";
    this.sectionEl = parent.createEl("section", { cls, attr: { "aria-labelledby": titleId } });

    const header = this.sectionEl.createDiv("gp-note-header");
    const titleRow = header.createDiv("gp-note-title-row");
    titleRow.createSpan({ cls: "gp-note-title", text: FOCUS_NOTE_TITLE, attr: { id: titleId } });
    const status = titleRow.createSpan({ cls: "gp-note-status", attr: { role: "status" } });
    // Its own span, so setting the text never takes the icon with it.
    this.statusIconEl = status.createSpan({ cls: "gp-note-status-icon gp-hidden" });
    setIcon(this.statusIconEl, "check");
    this.statusTextEl = status.createSpan({ cls: "gp-note-status-text" });
    // The full line in `title` too: a native tooltip for a task name the
    // ellipsis cuts (an aria-label would replace what a screen reader reads).
    this.sessionEl = header.createDiv("gp-note-session");

    this.formEl = this.sectionEl.createDiv("gp-note-form");
    const faces = this.formEl.createDiv({
      cls: "gp-note-faces",
      attr: { role: "group", "aria-label": FOCUS_NOTE_FACES_LABEL },
    });
    for (const face of NOTE_FACES) {
      const btn = faces.createEl("button", {
        cls: "gp-note-face",
        attr: {
          type: "button",
          "data-face": face,
          "aria-label": FACE_LABELS[face],
          "aria-pressed": "false",
        },
      });
      setIcon(btn, face);
      this.faceButtons.set(face, btn);
    }
    this.textarea = this.formEl.createEl("textarea", {
      cls: "gp-note-text",
      attr: {
        rows: "2",
        maxlength: String(NOTE_DRAFT_MAX),
        "aria-label": FOCUS_NOTE_TEXT_LABEL,
      },
    });
    const actions = this.formEl.createDiv("gp-note-actions");
    this.clearBtn = actions.createEl("button", {
      cls: "gp-note-btn gp-note-clear",
      text: "Clear",
      attr: { type: "button" },
    });
    this.saveBtn = actions.createEl("button", {
      cls: "gp-note-btn gp-note-save",
      text: "Save",
      attr: { type: "button" },
    });

    // No log folder: nothing to keep the note in. No settings button — the
    // typings give no public way to open a plugin's settings page.
    this.emptyEl = this.sectionEl.createDiv("gp-note-empty gp-hidden");
    this.emptyEl.createEl("p", { cls: "gp-note-hint", text: FOCUS_NOTE_HINT });
  }

  override onload(): void {
    // One delegated listener for the five buttons. `contains` rather than
    // closest(): a click on a face lands on its svg, and contains works on
    // any node, in a pop-out window's realm too.
    this.registerDomEvent(this.sectionEl, "click", (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      for (const [face, btn] of this.faceButtons) {
        if (btn.contains(target)) {
          this.pressFace(face);
          return;
        }
      }
      if (this.saveBtn.contains(target)) void this.save();
      else if (this.clearBtn.contains(target)) void this.clear();
    });
    // The card's own DOM, never through the timer's tick. Enter is a new
    // line: no shortcut saves.
    this.registerDomEvent(this.textarea, "input", () => {
      this.store.setDraft(this.store.draft.face, this.textarea.value);
    });
    this.store.onChange(this.listener);
    this.register(() => this.store.offChange(this.listener));
    this.seed(true);
    this.sync();
  }

  /**
   * Paint the card from the store, when something it shows has moved. Run by
   * every store change and, on the panel, from the view's applySettings() for
   * the setting — which runs on the 50ms tick, so the key below is what keeps
   * this from touching the DOM there.
   */
  sync(): void {
    const s = this.store;
    const target = s.target;
    const shown =
      target !== null &&
      (this.options.surface === "modal" || (s.cardOpen && this.options.enabled()));
    const key = JSON.stringify([
      shown,
      target?.sessionId,
      target?.logged,
      target?.startMs,
      target?.endMs,
      target?.taskName,
      s.saved,
      s.busy,
      s.draft,
    ]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.sectionEl.toggleClass("gp-hidden", !shown);
    const view = shown ? s.view(this.options.moment) : null;
    if (view === null) return;

    this.sessionEl.setText(view.sessionLine);
    this.sessionEl.setAttr("title", view.sessionLine);
    const saved = view.status.startsWith("Saved");
    this.statusIconEl.toggleClass("gp-hidden", !saved);
    this.statusTextEl.setText(view.status);

    const hint = view.mode === "hint";
    this.formEl.toggleClass("gp-hidden", hint);
    this.emptyEl.toggleClass("gp-hidden", !hint);
    if (hint) return;

    this.sectionEl.toggleClass("can-save", view.saveActive);
    this.saveBtn.setText(view.saveLabel);
    this.saveBtn.setAttr("aria-disabled", view.saveActive ? "false" : "true");
    this.clearBtn.setAttr("aria-disabled", view.clearActive ? "false" : "true");
    this.textarea.setAttr("placeholder", view.placeholder);
  }

  /**
   * The faces and the box from the store's draft. The faces always; the box
   * only when forced (a save, a clear, a new session — every card, the one
   * typed in too) or when it has no caret in it, the rule the panel's number
   * inputs use. A box typed into during a save already holds the store's
   * draft (the store keeps it), so forcing never takes a keystroke away.
   */
  private seed(force: boolean): void {
    const draft = this.store.draft;
    for (const [face, btn] of this.faceButtons) {
      btn.setAttr("aria-pressed", draft.face === face ? "true" : "false");
    }
    if (!force && activeDocument.activeElement === this.textarea) return;
    if (this.textarea.value !== draft.text) this.textarea.value = draft.text;
  }

  /** Pressing the pressed face takes it off; at most one is pressed. */
  private pressFace(face: NoteFace): void {
    const next = this.store.draft.face === face ? null : face;
    this.store.setDraft(next, this.textarea.value);
  }

  /**
   * Save what the card shows, as the line will store it. The target and the
   * note are captured here, at the click: the store applies the result only
   * to that session, and re-seeds every card from that note, so a face taken
   * out of the words shows pressed and the box shows the cleaned words.
   */
  private async save(): Promise<void> {
    const target = this.store.target;
    if (target === null || !this.store.view(this.options.moment)?.saveActive) return;
    const { face, text } = noteFromInput(this.store.draft.face, this.textarea.value);
    await this.store.save(target, { face, text });
  }

  /**
   * Take the note off. With a note in the log it asks first and writes; with
   * only words typed, nothing in the log changes, so they just go.
   */
  private async clear(): Promise<void> {
    const target = this.store.target;
    if (target === null || !this.store.view(this.options.moment)?.clearActive) return;
    if (this.store.saved === null) {
      this.store.clearDraft();
      return;
    }
    const confirmed = await confirmAction(this.options.app, {
      title: CLEAR_NOTE_TITLE,
      body: CLEAR_NOTE_BODY,
      ctaText: "Clear",
      destructive: true,
    });
    // The next session may have ended while the question was open.
    if (!confirmed || this.store.target?.sessionId !== target.sessionId) return;
    await this.store.clear(target);
  }
}

/**
 * The focus note for the last session, in a dialog — the command "Add a note
 * to the last session" and the status bar menu (0.7.1), so a note can be kept
 * with the timer panel closed and on a phone. main.ts opens one at a time and
 * chooses the session first (chooseLastSession), so this only shows the
 * store's target.
 *
 * Escape or a click outside closes it; the draft stays in the store. Closed
 * at unload with the other session dialogs (main.ts's sessionDialogs).
 */
export class FocusNoteModal extends Modal {
  private card: FocusNoteCard | null = null;

  constructor(
    app: App,
    readonly store: FocusNoteStore,
    private readonly openDialogs?: Set<{ close(): void }>,
    private readonly onClosed?: () => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.openDialogs?.add(this);
    // A desktop width cap like the confirmation dialog's; a phone keeps its
    // bottom sheet.
    this.modalEl.addClass("gp-note-modal");
    this.card = new FocusNoteCard(this.contentEl, this.store, {
      surface: "modal",
      app: this.app,
      // Read when a time is shown, not when the dialog is built.
      moment: (input) => moment(input),
      enabled: () => true,
    });
    this.card.load();
  }

  override onClose(): void {
    // Takes the card's store listener and its DOM events with it.
    this.card?.unload();
    this.card = null;
    this.openDialogs?.delete(this);
    this.contentEl.empty();
    this.onClosed?.();
  }
}
