/**
 * The plain-English line under each pair of toggles in the timer panel's
 * settings, saying what will actually happen when a session's time is up.
 *
 * It exists because the two toggles became independent in 0.6.3, and "Play a
 * sound" does not carry its own scope: under a heading naming an event, a
 * reader can fairly take it to mean "…if the timer just sits there" rather than
 * "on this transition, however it happens". The honest fix is not a cleverer
 * label — it is to stop making the reader infer, and say the outcome outright.
 * Every one of the four combinations per edge gets a sentence, so the question
 * "does it still play when the break starts on its own?" is answered on screen
 * instead of by experiment.
 *
 * Kept pure and in its own module so the copy is testable: the panel that
 * renders it cannot be imported by a test, and eight strings that must each
 * stay true to the behaviour are exactly the kind of thing that rots quietly.
 *
 * It has also become the home of the Audio group's shared LABELS, for the same
 * reason — they are copy that both surfaces must spell identically, and this is
 * the one audio module a test can import. The name is now narrower than the
 * contents; renaming it to `audioCopy.ts` is a mechanical follow-up worth doing
 * once nothing else in this release is moving.
 */

/**
 * The auto-start toggle labels, shared verbatim by the timer panel and the
 * settings tab.
 *
 * Shared because they are identical, and identical because they can be: each
 * says what it does without needing context from around it. The two CHIME
 * per-edge labels are deliberately NOT shared — the panel says "Play a sound"
 * under a section heading that already names the moment, while the tab has no
 * heading doing that and must spell out "Play a sound when focus ends". Sharing
 * that has to differ per surface would be worse than duplicating one.
 *
 * "Auto-start" rather than "Start": the earlier "Start the break" read as
 * though pressing it might begin one immediately.
 */
/**
 * The master sound switch, shared verbatim by both surfaces for the same reason
 * as the auto-start labels below.
 *
 * "Timer sounds" rather than "All sounds" or a bare "Sound": it names the
 * sounds by SOURCE, which is the only accurate scope. `soundEnabled` is read
 * exclusively by TimerEngine.playSound() and never reaches the YouTube player,
 * so "All sounds" would sit on screen claiming silence while the lofi music
 * kept playing. Naming a CLASS also stops it reading as a sibling of the
 * per-edge rows, which name an ACTION ("Play a sound") — where a bare "Sound"
 * beside "Play a sound" is two different things one word apart.
 */
export const MASTER_SOUND_LABEL = "Timer sounds";

export const AUTO_START_BREAK_LABEL = "Auto-start the break";
export const AUTO_START_FOCUS_LABEL = "Auto-start the focus";

/**
 * The three mixer labels, shared for the same reason and by the same test.
 *
 * Each names its channel first, so it stands alone: the tab has no "Audio"
 * heading doing that work for it in settings search, where a bare "Volume"
 * would be one of two rows with the same name. They are also the pairing that
 * makes the group readable — "Timer sounds" with "Timer volume", "Music sound"
 * with "Music volume" — which only holds while both surfaces spell them the
 * same way.
 *
 * Note the deliberate singular/plural: "Timer sounds" is a CLASS of sounds
 * (drum, bell, ding), while "Music sound" is one channel being audible or not.
 *
 * These three are shared even though the per-edge "Play a sound" labels are
 * not, and the difference is the test from the block above: these say what they
 * do with no heading above them, and "Play a sound" does not.
 */
export const TIMER_VOLUME_LABEL = "Timer volume";
export const MUSIC_SOUND_LABEL = "Music sound";
export const MUSIC_VOLUME_LABEL = "Music volume";

/** Which end-of-session boundary the summary describes. */
export type SessionEndEdge = "focus" | "break";

/**
 * The four settings this line depends on. Taking the settings rather than two
 * pre-resolved booleans is deliberate: it puts the edge→field mapping INSIDE
 * the tested function. With the mapping in the caller a mutation run proved it
 * uncovered — the view cannot be imported by a test, so reading the wrong
 * edge's chime there killed nothing.
 */
export interface SessionEndSettings {
  /**
   * The master mute. It is in here because the line's whole job is to say
   * whether a sound will happen, and `playSound()` returns at its first
   * statement when this is false — so a summary that ignored it would promise a
   * chime that cannot ring, which is the confusion issue #5 reported, handed
   * back to the users who muted.
   */
  soundEnabled: boolean;
  focusEndSoundEnabled: boolean;
  breakEndSoundEnabled: boolean;
  autoStartBreak: boolean;
  autoStartFocus: boolean;
}

/**
 * Deliberately phrased from the reader's position: the section heading above it
 * already says WHICH moment ("When focus ends"), so the line only has to say
 * what follows. Kept short — the panel column is a hard 260px, and a sentence
 * that wraps to three lines stops being a glanceable answer.
 */
export function sessionEndSummary(edge: SessionEndEdge, settings: SessionEndSettings): string {
  const focus = edge === "focus";
  // A sound is only real if the master switch is on as well. Reported as
  // "Sounds are off" rather than silently downgrading to the no-sound wording,
  // because the user asked for one and deserves to know why they will not
  // get one — the settings tab has no master control on it at all.
  const wantsChime = focus ? settings.focusEndSoundEnabled : settings.breakEndSoundEnabled;
  const chime = wantsChime && settings.soundEnabled;
  const muted = wantsChime && !settings.soundEnabled;
  // Note the deliberate crossing: the FOCUS edge is governed by autoStartBreak,
  // because what starts when focus ends is the break.
  const autoStart = focus ? settings.autoStartBreak : settings.autoStartFocus;
  const next = focus ? "the break starts" : "focus starts again";

  if (autoStart) {
    if (muted) return `Sounds are off — ${next}.`;
    // The state 0.6.2 could not express is the one most worth spelling out: a
    // hand-over that makes no sound at all.
    return chime ? `A sound, then ${next}.` : `${capitalize(next)}, with no sound.`;
  }
  if (muted) return "Sounds are off — the timer counts up.";
  // No auto-start: the timer slides into overtime and counts up, which is the
  // plugin's deliberate flow-protecting default.
  return chime ? "A sound, then the timer counts up." : "Nothing — the timer counts up.";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
