import { describe, it, expect } from "vitest";
import { sessionEndSummary, MASTER_SOUND_LABEL } from "../sessionEndSummary";
import type { SessionEndSettings } from "../sessionEndSummary";

/** Only the four fields the summary reads. */
const settings = (o: Partial<SessionEndSettings> = {}): SessionEndSettings => ({
  soundEnabled: true,
  focusEndSoundEnabled: false,
  breakEndSoundEnabled: false,
  autoStartBreak: false,
  autoStartFocus: false,
  ...o,
});

/** Set the pair that governs one edge, so a test reads as the user sees it. */
const forEdge = (edge: "focus" | "break", chime: boolean, autoStart: boolean) =>
  edge === "focus"
    ? settings({ focusEndSoundEnabled: chime, autoStartBreak: autoStart })
    : settings({ breakEndSoundEnabled: chime, autoStartFocus: autoStart });

// ---------------------------------------------------------------------------
// The line under each pair of end-of-session toggles in the timer panel.
//
// It exists to answer one question on screen instead of by experiment: "if the
// break starts on its own and the chime is off, does it still make a sound?"
// (It does not.) So the tests that matter are the ones pinning that each of the
// four combinations per edge says something DIFFERENT and TRUE — a summary that
// quietly stopped tracking the behaviour would be worse than no summary at all.
// ---------------------------------------------------------------------------
// The master switch's label had two tempting wrong answers, each rejected for a
// concrete reason. Pinned as properties rather than as the literal string, so
// the rule survives a future rewording that keeps the meaning.
describe("MASTER_SOUND_LABEL", () => {
  it("is not the bare word that made it ambiguous", () => {
    // "Sound" sat one word away from the per-edge "Play a sound" — two labels
    // for two different things, distinguishable only by a verb.
    expect(MASTER_SOUND_LABEL.toLowerCase()).not.toBe("sound");
    expect(MASTER_SOUND_LABEL.toLowerCase()).not.toBe("play a sound");
  });

  it("does not claim to cover every sound, because it does not", () => {
    // soundEnabled is read only by TimerEngine.playSound and never reaches the
    // YouTube player, so "All sounds" would sit on screen claiming silence
    // while the lofi music kept playing.
    expect(MASTER_SOUND_LABEL.toLowerCase().startsWith("all ")).toBe(false);
    expect(MASTER_SOUND_LABEL.toLowerCase()).not.toContain("every");
  });

  it("names a class of sounds, so it cannot read as a sibling of the per-edge rows", () => {
    // The per-edge rows are imperatives ("Play a sound"); the master is a noun
    // phrase. A label starting with a verb would put them back on one level.
    expect(MASTER_SOUND_LABEL.toLowerCase().startsWith("play")).toBe(false);
    expect(MASTER_SOUND_LABEL.toLowerCase()).toContain("sound");
  });
});

describe("sessionEndSummary", () => {
  it("says a silent hand-over is silent — the question that prompted this line", () => {
    // Auto-start on, chime off. The state 0.6.2 could not express, and the one
    // a reader cannot infer from the label "Play a chime".
    expect(sessionEndSummary("focus", forEdge("focus", false, true))).toBe(
      "The break starts, with no sound."
    );
    expect(sessionEndSummary("break", forEdge("break", false, true))).toBe(
      "Focus starts again, with no sound."
    );
  });

  it("says a chimed hand-over chimes", () => {
    expect(sessionEndSummary("focus", forEdge("focus", true, true))).toBe(
      "A sound, then the break starts."
    );
    expect(sessionEndSummary("break", forEdge("break", true, true))).toBe(
      "A sound, then focus starts again."
    );
  });

  it("describes the deliberate default — nothing happens and the timer counts up", () => {
    for (const edge of ["focus", "break"] as const) {
      expect(sessionEndSummary(edge, forEdge(edge, false, false))).toBe(
        "Nothing — the timer counts up."
      );
    }
  });

  it("describes a chime with no hand-over", () => {
    for (const edge of ["focus", "break"] as const) {
      expect(sessionEndSummary(edge, forEdge(edge, true, false))).toBe(
        "A sound, then the timer counts up."
      );
    }
  });

  it("gives every combination its own sentence on each edge", () => {
    // Two summaries that read the same for different settings would defeat the
    // purpose: the reader could not tell which state they are in.
    for (const edge of ["focus", "break"] as const) {
      const seen = new Set<string>();
      for (const chime of [false, true]) {
        for (const autoStart of [false, true]) {
          seen.add(sessionEndSummary(edge, forEdge(edge, chime, autoStart)));
        }
      }
      expect(seen.size, edge).toBe(4);
    }
  });

  it("distinguishes the two edges wherever the next session is named", () => {
    // With no auto-start nothing edge-specific is said, and that is fine — the
    // section heading above already named the moment.
    for (const chime of [false, true]) {
      expect(sessionEndSummary("focus", forEdge("focus", chime, true))).not.toBe(
        sessionEndSummary("break", forEdge("break", chime, true))
      );
    }
  });

  it("reads each edge's OWN pair, and crosses chime to auto-start correctly", () => {
    // The crossing is the subtle part: what starts when FOCUS ends is the
    // break, so the focus edge is governed by autoStartBreak. Setting only the
    // other edge's pair must leave this one at its default sentence.
    expect(
      sessionEndSummary("focus", settings({ breakEndSoundEnabled: true, autoStartFocus: true }))
    ).toBe("Nothing — the timer counts up.");

    expect(
      sessionEndSummary("break", settings({ focusEndSoundEnabled: true, autoStartBreak: true }))
    ).toBe("Nothing — the timer counts up.");

    // And each edge does react to its own pair.
    expect(sessionEndSummary("focus", settings({ autoStartBreak: true }))).toBe(
      "The break starts, with no sound."
    );
    expect(sessionEndSummary("break", settings({ autoStartFocus: true }))).toBe(
      "Focus starts again, with no sound."
    );
  });

  it("says so when the master mute would silence a chime the user asked for", () => {
    // The line's whole job is to answer "will this make a sound?". Ignoring the
    // master gate would promise a chime that playSound() drops at its first
    // statement — reintroducing issue #5's confusion for muted users, inside
    // the very mechanism added to stop people guessing. The settings tab has
    // its own Sound row now, but the panel's is five rows above this line.
    expect(
      sessionEndSummary("focus", settings({ soundEnabled: false, focusEndSoundEnabled: true }))
    ).toBe("Sounds are off — the timer counts up.");

    expect(
      sessionEndSummary(
        "focus",
        settings({ soundEnabled: false, focusEndSoundEnabled: true, autoStartBreak: true })
      )
    ).toBe("Sounds are off — the break starts.");

    expect(
      sessionEndSummary(
        "break",
        settings({ soundEnabled: false, breakEndSoundEnabled: true, autoStartFocus: true })
      )
    ).toBe("Sounds are off — focus starts again.");
  });

  it("does not blame the mute when no chime was asked for", () => {
    // Muted with the chime OFF is not a thwarted intention — nothing was going
    // to play anyway, so the ordinary wording is the honest one.
    expect(sessionEndSummary("focus", settings({ soundEnabled: false }))).toBe(
      "Nothing — the timer counts up."
    );
    expect(
      sessionEndSummary("focus", settings({ soundEnabled: false, autoStartBreak: true }))
    ).toBe("The break starts, with no sound.");
  });

  it("stays short enough for a 260px column", () => {
    for (const edge of ["focus", "break"] as const) {
      for (const soundEnabled of [false, true]) {
        for (const chime of [false, true]) {
          for (const autoStart of [false, true]) {
            const text = sessionEndSummary(edge, {
              ...forEdge(edge, chime, autoStart),
              soundEnabled,
            });
            expect(text.length, text).toBeLessThanOrEqual(40);
            expect(text.endsWith("."), text).toBe(true);
          }
        }
      }
    }
  });
});
