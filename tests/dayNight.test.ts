import { describe, expect, it } from "vitest";
import { DAY_NIGHT_ICON_ORDER, dayNightIconFor, skyPhase } from "../icons";
import type { PomoMode, TimerState } from "../types";

/** A session `elapsed` of the way through, as the engine would report it. */
const at = (mode: PomoMode, elapsed: number, totalMs = 1000): TimerState => ({
  mode,
  isRunning: true,
  remainingMs: totalMs - elapsed * totalMs,
  totalMs,
  taskName: "",
  breakType: mode === "focus" ? null : "short",
});

describe("skyPhase", () => {
  it("runs day to night across a focus session", () => {
    expect(skyPhase(at("focus", 0))).toBe(0);
    expect(skyPhase(at("focus", 0.5))).toBeCloseTo(0.5);
    expect(skyPhase(at("focus", 1))).toBe(1);
  });

  it("runs night back to day across a break, so no consumer needs the mode", () => {
    expect(skyPhase(at("break", 0))).toBe(1);
    expect(skyPhase(at("break", 0.5))).toBeCloseTo(0.5);
    expect(skyPhase(at("break", 1))).toBe(0);
  });

  it("clamps overtime rather than running past night", () => {
    // remainingMs goes negative in overtime; the arc has nowhere further to go.
    expect(skyPhase({ ...at("focus", 1), remainingMs: -60_000 })).toBe(1);
    expect(skyPhase({ ...at("break", 1), remainingMs: -60_000 })).toBe(0);
  });

  it("treats a zero-length session as the start of the arc", () => {
    expect(skyPhase({ ...at("focus", 0), totalMs: 0 })).toBe(0);
  });
});

describe("dayNightIconFor", () => {
  it("moves sun -> sunset -> moon across a focus session", () => {
    expect(dayNightIconFor(at("focus", 0))).toBe("sun");
    expect(dayNightIconFor(at("focus", 0.5))).toBe("sunset");
    expect(dayNightIconFor(at("focus", 0.9))).toBe("moon");
  });

  it("moves moon -> sunrise -> sun across a break", () => {
    expect(dayNightIconFor(at("break", 0))).toBe("moon");
    expect(dayNightIconFor(at("break", 0.5))).toBe("sunrise");
    expect(dayNightIconFor(at("break", 0.9))).toBe("sun");
  });

  // THE BUG THIS FUNCTION WAS EXTRACTED TO FIX. The old view-local version
  // branched on remainingMs at halves and only returned "moon" once
  // remainingMs <= 0 — so across an entire normal focus session the badge went
  // sun, sunset, and stopped, while the square behind it faded all the way to
  // night. The moon was unreachable unless you ran into overtime.
  it("reaches the moon before overtime, while the session is still running", () => {
    const end = at("focus", 0.95);
    expect(end.remainingMs).toBeGreaterThan(0);
    expect(dayNightIconFor(end)).toBe("moon");
  });

  it("mirrors it: a break reaches the sun before overtime", () => {
    const end = at("break", 0.95);
    expect(end.remainingMs).toBeGreaterThan(0);
    expect(dayNightIconFor(end)).toBe("sun");
  });

  // The badge sits on the artwork, so it may never name a time of day the
  // square is not showing. The classic theme cross-fades dusk over the first
  // half and night over the second, both derived from this same scalar.
  it("never disagrees with the layer the artwork is showing", () => {
    for (const mode of ["focus", "break"] as PomoMode[]) {
      for (let i = 0; i <= 20; i++) {
        const state = at(mode, i / 20);
        const phase = skyPhase(state);
        const icon = dayNightIconFor(state);
        const night = phase < 0.5 ? 0 : (phase - 0.5) * 2;
        if (icon === "sun") expect(night).toBe(0);
        if (icon === "moon") expect(night).toBeGreaterThan(0);
      }
    }
  });

  it("only ever returns a glyph the icon stack actually builds", () => {
    for (const mode of ["focus", "break"] as PomoMode[]) {
      for (let i = 0; i <= 20; i++) {
        expect(DAY_NIGHT_ICON_ORDER).toContain(dayNightIconFor(at(mode, i / 20)));
      }
    }
  });
});
