import { Modal, Setting } from "obsidian";
import type { App, ButtonComponent } from "obsidian";

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label of the confirming button, e.g. "Repair 12 marker(s)". */
  ctaText: string;
  /** Style the confirming button as destructive (red). */
  destructive?: boolean;
}

/**
 * Promise-based confirmation dialog. Resolves `true` only when the user
 * clicks the confirming button; Cancel, Esc, and clicking outside the modal
 * all resolve `false`.
 */
export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly options: ConfirmOptions,
    private readonly resolveConfirm: (confirmed: boolean) => void
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("gp-confirm-modal");
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl("p", { text: this.options.body });

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((btn) => {
        btn
          .setButtonText(this.options.ctaText)
          .setCta()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          });
        if (this.options.destructive) markDestructive(btn);
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    // Runs on every way out (confirm, Cancel, Esc, click-outside), so the
    // promise can never be left dangling.
    this.resolveConfirm(this.confirmed);
  }
}

// setDestructive() only exists on Obsidian 1.13+, so probe for it at runtime;
// older versions fall back to setWarning(), their only destructive styling.
function markDestructive(btn: ButtonComponent): void {
  const probe = btn as unknown as { setDestructive?: () => void };
  if (probe.setDestructive) {
    probe.setDestructive();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    btn.setWarning();
  }
}
