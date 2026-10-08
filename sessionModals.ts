import { FuzzySuggestModal, Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { markDestructive } from "./confirmModal";
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

    const problem = this.contentEl.createDiv("gp-setting-note");
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
          // Said in the dialog, which stays open: the values typed are kept.
          const message = this.options.check(form);
          problem.setText(message ?? "");
          if (message !== null) return;
          this.answer = { action: "save", form: { ...form } };
          this.close();
        })
    );
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
