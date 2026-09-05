import { describe, expect, it } from "vitest";
import {
  activeSegmentIndex,
  parseVolumeOptionKey,
  volumeOptionKey,
  VOLUME_DROPDOWN_OPTIONS,
  VOLUME_OPTIONS,
} from "../segmentedChoice";

/**
 * The two volume rows' stops — the shipped list itself, not a copy of it. A
 * hand-typed fixture here would let the shipped stops move without a single
 * test noticing, which is the exact failure this module exists to prevent.
 */
const VOLUME: readonly { value: number }[] = VOLUME_OPTIONS;

describe("activeSegmentIndex", () => {
  it("lights the exact option", () => {
    expect(activeSegmentIndex(VOLUME, 0.3)).toBe(0);
    expect(activeSegmentIndex(VOLUME, 0.7)).toBe(1);
    expect(activeSegmentIndex(VOLUME, 1.0)).toBe(2);
  });

  // The reason this function exists. A strict-equality re-seed answers Low for
  // every one of these while construction answers Mid or High, so the panel
  // would move its highlight for a value nobody changed.
  it("lights the NEAREST option for a value between the stops", () => {
    expect(activeSegmentIndex(VOLUME, 0.6)).toBe(1);
    expect(activeSegmentIndex(VOLUME, 0.55)).toBe(1);
    expect(activeSegmentIndex(VOLUME, 0.9)).toBe(2);
  });

  it("clamps to the ends rather than falling off", () => {
    expect(activeSegmentIndex(VOLUME, 0)).toBe(0);
    expect(activeSegmentIndex(VOLUME, -1)).toBe(0);
    expect(activeSegmentIndex(VOLUME, 2)).toBe(2);
  });

  it("keeps the earlier option on an exact tie", () => {
    // Binary-exact stops, so this really is a tie. 0.5 against the real
    // Low/Mid stops is NOT one — 0.5 - 0.3 is 0.19999999999999998 and
    // 0.7 - 0.5 is 0.19999999999999996, so Mid wins by one ulp. That is the
    // rule this replaces, kept byte-for-byte: it is not worth an epsilon.
    expect(activeSegmentIndex([{ value: 0.25 }, { value: 0.75 }], 0.5)).toBe(0);
    expect(activeSegmentIndex(VOLUME, 0.5)).toBe(1);
  });

  it("uses strict equality for non-numeric values, first option as fallback", () => {
    const themes = [{ value: "classic" }, { value: "frosted-glass" }];
    expect(activeSegmentIndex(themes, "frosted-glass")).toBe(1);
    expect(activeSegmentIndex(themes, "nope")).toBe(0);
  });

  it("returns -1 for an empty row instead of throwing", () => {
    // The rule it replaces called options.reduce with no seed, which throws.
    expect(activeSegmentIndex([], 0.5)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 0.6.3 — the volume stops, now rendered on two surfaces (a segmented row in
// the timer panel, a dropdown in the settings tab) from ONE list.
// ---------------------------------------------------------------------------
describe("the shared volume stops", () => {
  it("derives the dropdown map from the one list, in the panel's order", () => {
    expect(VOLUME_DROPDOWN_OPTIONS).toEqual({ low: "Low", mid: "Mid", high: "High" });
    // Order, not just membership. The keys must be NAMES: JS puts integer-like
    // keys first and in numeric order, ahead of everything else, so keying the
    // top stop "1" renders the dropdown High / Low / Mid. Nothing in the types
    // can see that — this assertion is the only thing that can.
    expect(Object.keys(VOLUME_DROPDOWN_OPTIONS)).toEqual(VOLUME_OPTIONS.map((o) => o.key));
    expect(Object.keys(VOLUME_DROPDOWN_OPTIONS)).toEqual(["low", "mid", "high"]);
    for (const key of Object.keys(VOLUME_DROPDOWN_OPTIONS)) {
      expect(String(Number(key)), `${key} must not be an array index`).not.toBe(key);
    }
  });

  it("snaps a stored value to a real option key before rendering it", () => {
    // The whole reason getControlValue cannot look up by exact value: 0.1.0
    // shipped a volume SLIDER and coerceToDefaults only checks the field's
    // type, so any float can still be in data.json. Unsnapped, the tab would
    // show nothing sensible for a value the panel happily paints as "Mid".
    expect(volumeOptionKey(0.6)).toBe("mid");
    expect(volumeOptionKey(0.42)).toBe("low");
    expect(volumeOptionKey(0.9)).toBe("high");
    // And an exact stop is unchanged.
    expect(volumeOptionKey(1)).toBe("high");
    expect(volumeOptionKey(0.3)).toBe("low");
  });

  it("round-trips every stop", () => {
    for (const option of VOLUME_OPTIONS) {
      expect(parseVolumeOptionKey(volumeOptionKey(option.value))).toBe(option.value);
    }
  });

  it("reads a stop back as its exact float, NOT floored", () => {
    // The neighbouring taskSelectorDays case uses Math.floor. Copy-pasted here
    // it turns 0.3 and 0.7 into 0 — a silent channel, with no error anywhere.
    expect(parseVolumeOptionKey("low")).toBe(0.3);
    expect(parseVolumeOptionKey("mid")).toBe(0.7);
    expect(parseVolumeOptionKey("high")).toBe(1);
  });

  it("returns null for anything that is not one of the stops", () => {
    // Null, not a clamp: setControlValue writes nothing on null, which is the
    // established answer for a value that should not be persisted. A clamp
    // would quietly accept a hand-edited option key and store a fourth level.
    expect(parseVolumeOptionKey("0.6")).toBeNull();
    expect(parseVolumeOptionKey("loud")).toBeNull();
    expect(parseVolumeOptionKey("")).toBeNull();
    expect(parseVolumeOptionKey(0.3)).toBeNull();
    expect(parseVolumeOptionKey(null)).toBeNull();
    expect(parseVolumeOptionKey(undefined)).toBeNull();
  });
});
