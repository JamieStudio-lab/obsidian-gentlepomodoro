import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { LONG_SESSION_KEEP_LABEL, LONG_SESSION_TITLE, type LongSessionAnswer } from "./sessionGaps";

/** What the dialog shows; the wording comes from sessionGaps.ts. */
export interface LongSessionPrompt {
  message: string;
  plannedLabel: string;
}

/**
 * Stop's question about a long focus (0.6.9). Resolves "keep" or "planned"
 * from the two buttons, and "cancel" on every other way out — Esc, the close
 * button, a click outside — which cancels the Stop: the timer goes on as if
 * it had not been pressed. `openDialogs` holds the dialog while it is open,
 * so the plugin can close it at unload (F19).
 */
export function askLongSession(
  app: App,
  prompt: LongSessionPrompt,
  openDialogs?: Set<{ close(): void }>
): Promise<LongSessionAnswer> {
  return new Promise((resolve) => {
    new LongSessionModal(app, prompt, resolve, openDialogs).open();
  });
}

export class LongSessionModal extends Modal {
  private answer: LongSessionAnswer = "cancel";

  constructor(
    app: App,
    private readonly prompt: LongSessionPrompt,
    private readonly resolveAnswer: (answer: LongSessionAnswer) => void,
    private readonly openDialogs?: Set<{ close(): void }>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.openDialogs?.add(this);
    this.modalEl.addClass("gp-confirm-modal");
    this.titleEl.setText(LONG_SESSION_TITLE);
    this.contentEl.createEl("p", { text: this.prompt.message });

    // Neither button is the call to action: both keep a choice the user makes.
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText(LONG_SESSION_KEEP_LABEL).onClick(() => {
          this.choose("keep");
        })
      )
      .addButton((btn) =>
        btn.setButtonText(this.prompt.plannedLabel).onClick(() => {
          this.choose("planned");
        })
      );
  }

  private choose(answer: LongSessionAnswer): void {
    this.answer = answer;
    this.close();
  }

  override onClose(): void {
    this.openDialogs?.delete(this);
    this.contentEl.empty();
    // Every way out lands here, so the promise always settles — and anything
    // but a button is "cancel".
    this.resolveAnswer(this.answer);
  }
}
