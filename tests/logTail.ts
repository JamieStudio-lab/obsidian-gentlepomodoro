import { vi } from "vitest";

/**
 * Helpers for the 0.7.0 tail on lines LogManager writes (logLine.ts), for
 * tests that compare whole lines.
 */

/** The ID newSessionId makes from nine zero bytes. */
export const ZERO_SESSION_ID = "s000000000";

/**
 * Every Session ID minted while this runs is ZERO_SESSION_ID: crypto's random
 * bytes all come back 0. Undone by vi.restoreAllMocks().
 */
export function zeroSessionIds() {
  return vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint8Array) array.fill(0);
    return array;
  });
}

/**
 * The Offset a line started at local time `at` writes in the zone the tests
 * run in: minutes east of UTC, as text ("0", never "-0").
 */
export function offsetAt(at: Date): string {
  return String(-at.getTimezoneOffset() || 0);
}
