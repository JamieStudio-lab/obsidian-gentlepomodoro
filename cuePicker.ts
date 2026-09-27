import { FuzzySuggestModal, type App } from "obsidian";
import { CUE_MAX_SECONDS, cueChoiceText, cueChoices, type CueChoice } from "./timerCues";

/**
 * The list behind a sound row's button: the built-in sounds, then the vault's
 * mp3, m4a and wav files, searchable by name. A modal rather than a text box
 * with suggestions, because the pre-1.13 settings path commits a text box on
 * every keystroke, and a half-typed path is not a sound anyone chose.
 */
export class CuePickerModal extends FuzzySuggestModal<CueChoice> {
  constructor(
    app: App,
    private readonly choose: (choice: CueChoice) => void
  ) {
    super(app);
    this.setPlaceholder(
      `Pick a built-in sound, or an mp3, m4a or wav file of up to ${String(CUE_MAX_SECONDS)} seconds`
    );
    // The built-ins are always listed, so this only shows for a search that
    // matches nothing — which is also when someone is looking for a file that
    // is not in the vault yet.
    this.emptyStateText =
      "No sound matches. To use your own, add an mp3, m4a or wav file to your vault first.";
  }

  override getItems(): CueChoice[] {
    return cueChoices(this.app.vault.getFiles());
  }

  override getItemText(choice: CueChoice): string {
    return cueChoiceText(choice);
  }

  override onChooseItem(choice: CueChoice): void {
    this.choose(choice);
  }
}
