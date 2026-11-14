import { FuzzySuggestModal, Modal, Setting, setIcon } from "obsidian";
import type { App, DropdownComponent, TextComponent } from "obsidian";
import { markDestructive } from "./confirmModal";
import { FACE_LABELS, FOCUS_NOTE_PROMPTS, NOTE_DRAFT_MAX } from "./focusNote";
import {
  FOCUS_NOTE_FACES_LABEL,
  FOCUS_NOTE_TEXT_LABEL,
  FOCUS_NOTE_TITLE,
  isComposing,
  isSaveShortcut,
  saveShortcutText,
} from "./focusNoteCard";
import { NOTE_FACES, type FocusNote, type NoteFace } from "./logLine";
import {
  EXPORT_FOLDER_NOTE,
  EXPORT_FORMATS,
  EXPORT_KINDS,
  EXPORT_RANGES,
  NO_LOG_FILES_YET,
  type ExportForm,
  type ExportFormat,
  type ExportKinds,
  type ExportRange,
} from "./logExport";
import { logger } from "./logger";
import {
  SESSION_KIND_OPTIONS,
  SESSION_STATUS_OPTIONS,
  sessionTaskLabel,
  type LoggedLine,
  type SessionForm,
  type SessionKind,
  type SessionStatus,
  type SessionTask,
} from "./logEditor";

/** A task the dialog can pick, with the text the picker lists it by. */
export interface SessionTaskChoice {
  task: SessionTask;
  label: string;
}

export interface SessionFormOptions {
  title: string;
  /** The values the dialog opens with. Never written to: the dialog edits a copy. */
  form: SessionForm;
  submitText: string;
  /** Offer Delete (a logged session). */
  canDelete: boolean;
  /** The tasks to pick from, read when the picker opens. */
  tasks: () => Promise<SessionTaskChoice[]>;
  /** Why these values cannot be saved, or null. Checked before the dialog closes. */
  check: (form: SessionForm) => string | null;
  /** One plain line in place of the focus note box, for a focus that can't take a note. */
  noteHint?: string;
}

export type SessionFormAnswer = { action: "save"; form: SessionForm } | { action: "delete" } | null;

/**
 * The session dialog for "Add a session" and "Fix a logged session" (0.6.9,
 * C6). Resolves with the values on Save, "delete" on Delete — the caller asks
 * before deleting — and null on every other way out, Esc and a click outside
 * included, so the promise always settles.
 */
export function askSessionForm(app: App, options: SessionFormOptions): Promise<SessionFormAnswer> {
  return new Promise((resolve) => {
    new SessionFormModal(app, options, resolve).open();
  });
}

class SessionFormModal extends Modal {
  private answer: SessionFormAnswer = null;
  private readonly form: SessionForm;
  private problemEl: HTMLElement | null = null;
  /** The focus note box and its hint: only a focus has either. */
  private readonly noteParts: HTMLElement[] = [];

  constructor(
    app: App,
    private readonly options: SessionFormOptions,
    private readonly resolveAnswer: (answer: SessionFormAnswer) => void
  ) {
    super(app);
    this.form = { ...options.form };
  }

  override onOpen(): void {
    const form = this.form;
    this.titleEl.setText(this.options.title);

    new Setting(this.contentEl).setName("Kind").addDropdown((dropdown) => {
      for (const option of SESSION_KIND_OPTIONS) dropdown.addOption(option.value, option.label);
      dropdown.setValue(form.kind).onChange((value) => {
        form.kind = value as SessionKind;
        this.syncNoteParts();
      });
    });
    new Setting(this.contentEl)
      .setName("Task")
      .setDesc("Breaks are logged without one.")
      .addButton((button) => {
        button.setButtonText(sessionTaskLabel(form.task)).onClick(() => {
          void this.options
            .tasks()
            // A note that cannot be read leaves the list short, not the dialog stuck.
            .catch((e: unknown) => {
              logger.warn("Could not list the tasks for the session dialog", e);
              return [];
            })
            .then((tasks) => {
              new SessionTaskModal(this.app, tasks, (task) => {
                form.task = task;
                button.setButtonText(sessionTaskLabel(task));
              }).open();
            });
        });
      });
    new Setting(this.contentEl)
      .setName("Date")
      .setDesc("The day the session started.")
      .addText((text) =>
        text
          .setPlaceholder("2026-10-02")
          .setValue(form.date)
          .onChange((value) => {
            form.date = value;
          })
      );
    new Setting(this.contentEl)
      .setName("Start time")
      .setDesc("24-hour clock.")
      .addText((text) =>
        text
          .setPlaceholder("09:30")
          .setValue(form.time)
          .onChange((value) => {
            form.time = value;
          })
      );
    new Setting(this.contentEl)
      .setName("Active minutes")
      .setDesc("The time spent, not counting pauses.")
      .addText((text) =>
        text.setValue(form.minutes).onChange((value) => {
          form.minutes = value;
        })
      );
    new Setting(this.contentEl)
      .setName("Status")
      .setDesc("A skipped focus doesn't count toward the daily goal. Breaks have none.")
      .addDropdown((dropdown) => {
        for (const option of SESSION_STATUS_OPTIONS) dropdown.addOption(option.value, option.label);
        dropdown.setValue(form.status).onChange((value) => {
          form.status = value as SessionStatus;
        });
      });

    if (form.note !== undefined) this.buildNoteBox(form.note);
    if (this.options.noteHint !== undefined) this.buildNoteHint(this.options.noteHint);
    this.syncNoteParts();

    this.problemEl = this.contentEl.createDiv("gp-setting-note");
    const buttons = new Setting(this.contentEl).addButton((button) =>
      button.setButtonText("Cancel").onClick(() => {
        this.close();
      })
    );
    if (this.options.canDelete) {
      buttons.addButton((button) => {
        button.setButtonText("Delete").onClick(() => {
          this.answer = { action: "delete" };
          this.close();
        });
        markDestructive(button);
      });
    }
    buttons.addButton((button) =>
      button
        .setButtonText(this.options.submitText)
        .setCta()
        .onClick(() => {
          this.submit();
        })
    );
  }

  /** The Save button, and Mod+Enter in the note box. */
  private submit(): void {
    // Said in the dialog, which stays open: the values typed are kept.
    const message = this.options.check(this.form);
    this.problemEl?.setText(message ?? "");
    if (message !== null) return;
    this.answer = { action: "save", form: { ...this.form } };
    this.close();
  }

  /**
   * The focus note card's face row and box (focusNoteCard.ts), under its
   * classes so its rules apply. Every change assigns a new `form.note`, so
   * neither the form the dialog was given nor an answer shares an object with
   * a later keystroke. The listeners go with the nodes when the dialog empties.
   */
  private buildNoteBox(opening: FocusNote): void {
    const form = this.form;
    const note = (): FocusNote => form.note ?? opening;
    const box = this.notePart();
    box.createEl("div", { cls: "gp-note-title", text: FOCUS_NOTE_TITLE });
    const row = box.createEl("div", { cls: "gp-note-form" });
    const faces = row.createEl("div", {
      cls: "gp-note-faces",
      attr: { role: "group", "aria-label": FOCUS_NOTE_FACES_LABEL },
    });
    const textarea = row.createEl("textarea", {
      cls: "gp-note-text",
      attr: {
        rows: "2",
        maxlength: String(NOTE_DRAFT_MAX),
        "aria-label": FOCUS_NOTE_TEXT_LABEL,
        "aria-keyshortcuts": saveShortcutText().aria,
      },
    });
    textarea.value = opening.text;

    const buttons = new Map<NoteFace, HTMLElement>();
    const paint = () => {
      const pressed = note().face;
      for (const [face, button] of buttons) {
        button.setAttr("aria-pressed", pressed === face ? "true" : "false");
      }
      textarea.setAttr("placeholder", FOCUS_NOTE_PROMPTS[pressed ?? "none"]);
    };
    for (const face of NOTE_FACES) {
      const button = faces.createEl("button", {
        cls: "gp-note-face",
        attr: { type: "button", "data-face": face, "aria-label": FACE_LABELS[face] },
      });
      setIcon(button, face);
      buttons.set(face, button);
      button.addEventListener("click", () => {
        form.note = { face: note().face === face ? null : face, text: note().text };
        paint();
      });
    }
    paint();

    textarea.addEventListener("input", () => {
      form.note = { face: note().face, text: textarea.value };
    });
    // Plain Enter is a new line. The chord never is, a held or a composing one
    // included, but only a fresh press outside an input method saves.
    textarea.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (!isSaveShortcut(evt)) return;
      evt.preventDefault();
      if (!evt.repeat && !isComposing(evt)) this.submit();
    });
  }

  private buildNoteHint(hint: string): void {
    this.notePart().createEl("p", { cls: "gp-note-hint", text: hint });
  }

  /** The card's own wrapper: hidden by `.gp-note.gp-hidden`, as a dialog has no `.gp-root`. */
  private notePart(): HTMLElement {
    const part = this.contentEl.createDiv("gp-note gp-note-in-modal gp-fix-note");
    this.noteParts.push(part);
    return part;
  }

  private syncNoteParts(): void {
    for (const part of this.noteParts) part.toggleClass("gp-hidden", this.form.kind !== "focus");
  }

  override onClose(): void {
    this.contentEl.empty();
    this.resolveAnswer(this.answer);
  }
}

/** The dialog's task picker: "No task", then the tasks the timer's picker would list. */
class SessionTaskModal extends FuzzySuggestModal<SessionTaskChoice | null> {
  constructor(
    app: App,
    private readonly tasks: SessionTaskChoice[],
    private readonly choose: (task: SessionTask | null) => void
  ) {
    super(app);
    this.setPlaceholder("Pick a task");
  }

  override getItems(): (SessionTaskChoice | null)[] {
    return [null, ...this.tasks];
  }

  override getItemText(choice: SessionTaskChoice | null): string {
    return choice === null ? "No task" : choice.label;
  }

  override onChooseItem(choice: SessionTaskChoice | null): void {
    this.choose(choice === null ? null : choice.task);
  }
}

export interface PickSessionOptions {
  /** The day the list opens on, YYYY-MM-DD. */
  date: string;
  /** That day's session lines, or null when it has no log. */
  sessionsOn: (date: string) => Promise<LoggedLine[] | null>;
  describe: (line: LoggedLine) => string;
  pick: (date: string, line: LoggedLine) => void;
}

/**
 * "Fix a logged session", step one: a day, and its sessions to choose from.
 * The list follows the date box once it holds a whole date.
 */
export class PickSessionModal extends Modal {
  private listEl: HTMLElement | null = null;
  // A newer date typed while a day's log was being read wins.
  private generation = 0;

  constructor(
    app: App,
    private readonly options: PickSessionOptions
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Fix a logged session");
    new Setting(this.contentEl)
      .setName("Date")
      .setDesc("The day's log to open.")
      .addText((text) =>
        text
          .setPlaceholder("2026-10-02")
          .setValue(this.options.date)
          .onChange((value) => {
            const date = value.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) void this.show(date);
          })
      );
    this.listEl = this.contentEl.createDiv();
    void this.show(this.options.date);
  }

  private async show(date: string): Promise<void> {
    const generation = ++this.generation;
    // A read that fails (a file still syncing, a locked file) must say so: show
    // runs with `void`, so a rejection here would leave the list blank, or
    // still showing the day typed before, with nothing said.
    let lines: LoggedLine[] | null;
    let failed = false;
    try {
      lines = await this.options.sessionsOn(date);
    } catch (e) {
      logger.warn(`Could not read the log for ${date}`, e);
      lines = null;
      failed = true;
    }
    const list = this.listEl;
    if (generation !== this.generation || list === null) return;
    list.empty();
    if (failed) {
      list.createEl("p", { text: `The log for ${date} couldn't be opened.` });
      return;
    }
    if (lines === null || lines.length === 0) {
      list.createEl("p", { text: `No sessions logged on ${date}.` });
      return;
    }
    for (const line of lines) {
      new Setting(list).setName(this.options.describe(line)).addButton((button) =>
        button.setButtonText("Edit").onClick(() => {
          this.close();
          this.options.pick(date, line);
        })
      );
    }
  }

  override onClose(): void {
    this.generation++;
    this.listEl = null;
    this.contentEl.empty();
  }
}

export interface ExportFormOptions {
  /** The values the dialog opens with. Never written to: the dialog edits a copy. */
  form: ExportForm;
  /** The From and To a Days choice stands for (exportRangeDates): null for
   *  Choose dates, and for Everything when there is no log file yet. */
  datesFor: (range: ExportRange) => { from: string; to: string } | null;
  /** Why these values cannot be exported, or null. Checked before the dialog closes. */
  check: (form: ExportForm) => string | null;
}

/**
 * The Export sessions dialog (0.7.0). Resolves with the values on Export and
 * null on every other way out, Esc and a click outside included, so the
 * promise always settles.
 */
export function askExportForm(app: App, options: ExportFormOptions): Promise<ExportForm | null> {
  return new Promise((resolve) => {
    new ExportFormModal(app, options, resolve).open();
  });
}

class ExportFormModal extends Modal {
  private answer: ExportForm | null = null;
  private readonly form: ExportForm;

  constructor(
    app: App,
    private readonly options: ExportFormOptions,
    private readonly resolveAnswer: (answer: ExportForm | null) => void
  ) {
    super(app);
    this.form = { ...options.form };
  }

  override onOpen(): void {
    const form = this.form;
    this.titleEl.setText("Export sessions");
    let days: DropdownComponent | null = null;
    let fromText: TextComponent | null = null;
    let toText: TextComponent | null = null;
    let problem: HTMLElement | null = null;

    // From and To always show the dates the Days choice stands for, and stay
    // editable: a date typed there makes it "Choose dates". Setting a box's
    // value from here does not run its change handler, in Obsidian as in a
    // plain input, so the two never loop.
    const typed = () => {
      if (form.range === "custom") return;
      form.range = "custom";
      days?.setValue("custom");
    };
    new Setting(this.contentEl).setName("Days").addDropdown((dropdown) => {
      days = dropdown;
      for (const option of EXPORT_RANGES) dropdown.addOption(option.value, option.label);
      dropdown.setValue(form.range).onChange((value) => {
        form.range = value as ExportRange;
        const dates = this.options.datesFor(form.range);
        if (dates !== null) {
          form.from = dates.from;
          form.to = dates.to;
          fromText?.setValue(dates.from);
          toText?.setValue(dates.to);
        }
        problem?.setText(form.range === "all" && dates === null ? NO_LOG_FILES_YET : "");
      });
    });
    new Setting(this.contentEl)
      .setName("From")
      .setDesc("The first day, like 2026-10-01.")
      .addText((text) => {
        fromText = text;
        text
          .setPlaceholder("2026-10-01")
          .setValue(form.from)
          .onChange((value) => {
            form.from = value;
            typed();
          });
      });
    new Setting(this.contentEl)
      .setName("To")
      .setDesc("The last day, included.")
      .addText((text) => {
        toText = text;
        text
          .setPlaceholder("2026-10-31")
          .setValue(form.to)
          .onChange((value) => {
            form.to = value;
            typed();
          });
      });
    new Setting(this.contentEl).setName("Sessions").addDropdown((dropdown) => {
      for (const option of EXPORT_KINDS) dropdown.addOption(option.value, option.label);
      dropdown.setValue(form.kinds).onChange((value) => {
        form.kinds = value as ExportKinds;
      });
    });
    new Setting(this.contentEl).setName("Format").addDropdown((dropdown) => {
      for (const option of EXPORT_FORMATS) dropdown.addOption(option.value, option.label);
      dropdown.setValue(form.format).onChange((value) => {
        form.format = value as ExportFormat;
      });
    });
    new Setting(this.contentEl)
      .setName("Folder")
      .setDesc(EXPORT_FOLDER_NOTE)
      .addText((text) =>
        text.setValue(form.folder).onChange((value) => {
          form.folder = value;
        })
      );

    const problemEl = this.contentEl.createDiv("gp-setting-note");
    problem = problemEl;
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Export")
          .setCta()
          .onClick(() => {
            // Said in the dialog, which stays open: the values typed are kept.
            const message = this.options.check(form);
            problemEl.setText(message ?? "");
            if (message !== null) return;
            this.answer = { ...form };
            this.close();
          })
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.resolveAnswer(this.answer);
  }
}
