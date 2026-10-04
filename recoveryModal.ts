import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import {
  RECOVERY_DISCARD_LABEL,
  RECOVERY_LOG_LABEL,
  RECOVERY_PLANNED_LABEL,
  RECOVERY_TITLE,
  type RecoveryAnswer,
} from "./sessionRecovery";

/** What the dialog shows; the wording comes from sessionRecovery.ts. */
export interface RecoveryPrompt {
  message: string;
  /** Offer "Log up to planned end": a long session past its plan (F18). */
  plannedEnd: boolean;
}

/**
 * The question at startup about a session an earlier run left open (0.6.9,
 * F23). Resolves "log" or "discard" from those buttons — and "planned" from
 * "Log up to planned end", shown only for a long session past its plan
 * (F18) — and "later" on every other way out — Esc, the close button, a click
 * outside — which keeps the session to be asked about at the next start:
 * closing a dialog is not a choice to lose the time. `openDialogs` holds the
 * dialog while it is open, so the plugin can close it at unload (F19).
 */
export function askRecovery(
  app: App,
  prompt: RecoveryPrompt,
  openDialogs?: Set<{ close(): void }>
): Promise<RecoveryAnswer> {
  return new Promise((resolve) => {
    new RecoveryModal(app, prompt, resolve, openDialogs).open();
  });
}

export class RecoveryModal extends Modal {
  private answer: RecoveryAnswer = "later";

  constructor(
    app: App,
    private readonly prompt: RecoveryPrompt,
    private readonly resolveAnswer: (answer: RecoveryAnswer) => void,
    private readonly openDialogs?: Set<{ close(): void }>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.openDialogs?.add(this);
    this.modalEl.addClass("gp-confirm-modal");
    this.titleEl.setText(RECOVERY_TITLE);
    this.contentEl.createEl("p", { text: this.prompt.message });

    const buttons = new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText(RECOVERY_DISCARD_LABEL).onClick(() => {
        this.choose("discard");
      })
    );
    // A long session's two ways to log it are both a choice the user makes,
    // so neither is the call to action — as in Stop's question about one.
    if (this.prompt.plannedEnd) {
      buttons.addButton((btn) =>
        btn.setButtonText(RECOVERY_PLANNED_LABEL).onClick(() => {
          this.choose("planned");
        })
      );
    }
    buttons.addButton((btn) => {
      btn.setButtonText(RECOVERY_LOG_LABEL).onClick(() => {
        this.choose("log");
      });
      if (!this.prompt.plannedEnd) btn.setCta();
    });
  }

  private choose(answer: RecoveryAnswer): void {
    this.answer = answer;
    this.close();
  }

  override onClose(): void {
    this.openDialogs?.delete(this);
    this.contentEl.empty();
    // Every way out lands here, so the promise always settles.
    this.resolveAnswer(this.answer);
  }
}
