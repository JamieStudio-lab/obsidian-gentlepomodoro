import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";

/** The one part of the Clipboard API a copy needs. */
export interface TextClipboard {
  writeText(text: string): Promise<void>;
}

export const COPY_FALLBACK_TITLE = "Copy the code";
export const COPY_FALLBACK_TEXT =
  "Couldn't reach the clipboard. Select the code and copy it yourself.";

/**
 * Put `text` on the clipboard and say so with `copiedNotice` (0.7.0, the
 * Dataview tables' Copy buttons).
 *
 * `writeText` is called at once, inside the click that asked: iOS gives the
 * clipboard only to a user gesture, as it gives WebAudio only to one
 * (wakeAudio, 0.6.7), so nothing may be awaited first — the text is built from
 * the settings alone for that reason. Where there is no clipboard, or it
 * refuses (a web view's permission, a page out of focus), a dialog shows the
 * text selected, to copy by hand. Not Obsidian's own fallback of a hidden
 * textarea and `execCommand("copy")`: that call is deprecated, and the
 * textarea would need an inline style.
 */
export function copyText(
  app: App,
  text: string,
  copiedNotice: string,
  clipboard: TextClipboard | null = systemClipboard()
): void {
  let written: Promise<void>;
  try {
    if (clipboard === null) throw new Error("No clipboard");
    written = clipboard.writeText(text);
  } catch {
    new CopyFallbackModal(app, text).open();
    return;
  }
  written.then(
    () => {
      new Notice(copiedNotice);
    },
    () => {
      new CopyFallbackModal(app, text).open();
    }
  );
}

/** The window's clipboard, or null where it has none (some mobile web views). */
function systemClipboard(): TextClipboard | null {
  try {
    const clipboard = window.navigator?.clipboard as TextClipboard | undefined;
    return typeof clipboard?.writeText === "function" ? clipboard : null;
  } catch {
    return null;
  }
}

/** The text, read-only and selected, for a copy the clipboard refused. */
export class CopyFallbackModal extends Modal {
  constructor(
    app: App,
    private readonly text: string
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(COPY_FALLBACK_TITLE);
    this.contentEl.createEl("p", { text: COPY_FALLBACK_TEXT });
    const area = this.contentEl.createEl("textarea", {
      cls: "gp-copy-fallback",
      attr: { readonly: "", rows: "12", spellcheck: "false", "aria-label": COPY_FALLBACK_TITLE },
    });
    area.value = this.text;
    area.focus();
    area.select();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
