/**
 * The plain-English line under each pair of toggles in the timer panel's
 * settings, saying what will actually happen when a session's time is up.
 *
 * It exists because the two toggles became independent in 0.6.3, and "Play a
 * chime" does not carry its own scope: under a heading naming an event, a
 * reader can fairly take it to mean "…if the timer just sits there" rather than
 * "on this transition, however it happens". The honest fix is not a cleverer
 * label — it is to stop making the reader infer, and say the outcome outright.
 * Every one of the four combinations per edge gets a sentence, so the question
 * "does it chime when the break starts on its own?" is answered on screen
 * instead of by experiment.
 *
 * Kept pure and in its own module so the copy is testable: the panel that
 * renders it cannot be imported by a test, and eight strings that must each
 * stay true to the behaviour are exactly the kind of thing that rots quietly.
 */

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
  const chime = focus ? settings.focusEndSoundEnabled : settings.breakEndSoundEnabled;
  // Note the deliberate crossing: the FOCUS edge is governed by autoStartBreak,
  // because what starts when focus ends is the break.
  const autoStart = focus ? settings.autoStartBreak : settings.autoStartFocus;
  const next = focus ? "the break starts" : "focus starts again";

  if (autoStart) {
    // The state 0.6.2 could not express is the one most worth spelling out: a
    // hand-over that makes no sound at all.
    return chime ? `A chime, then ${next}.` : `${capitalize(next)}, with no sound.`;
  }
  // No auto-start: the timer slides into overtime and counts up, which is the
  // plugin's deliberate flow-protecting default.
  return chime ? "A chime, then the timer counts up." : "Nothing — the timer counts up.";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
