/**
 * Which option a segmented control shows as active for a stored value.
 *
 * It exists for one reason: the panel's segmented rows are seeded twice — once
 * when renderSettingsPanel() builds them, and again by syncSettingsPanel() when
 * the value moves on the other surface — and the two seedings must agree. The
 * construction rule was NEAREST NUMERIC (0.1.2 replaced a volume slider with
 * Low/Mid/High, so any float can still be in data.json and every one of them has
 * to light a button), and the re-seed anyone would write by hand is strict
 * equality. For a stored 0.6 those disagree: construction lights Mid, strict
 * equality finds nothing and falls back to the first option, Low. One rule, in
 * one place, read by both — same reason skyPhase() moved out of the view in
 * 0.6.1, where the badge and the artwork each derived the arc and disagreed.
 *
 * Ties keep the earlier option, and an unmatched non-numeric value falls back to
 * the first — both verbatim from the rule this replaces.
 */
export function activeSegmentIndex<T>(options: readonly { value: T }[], current: T): number {
  if (options.length === 0) return -1;
  if (typeof current !== "number") {
    const found = options.findIndex((o) => o.value === current);
    return found === -1 ? 0 : found;
  }
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < options.length; i++) {
    const value = options[i].value;
    // A non-numeric option in a numeric row cannot be "nearest" to anything;
    // skipping it keeps the row on a real button instead of NaN-comparing.
    if (typeof value !== "number") continue;
    const distance = Math.abs(value - current);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The three volume stops, once — the ONLY place they are written down.
 *
 * Both surfaces render this list: the gear panel as a segmented row, the
 * settings tab as a dropdown. Two hand-typed copies would be two lists that
 * agree today, and a "Mid" meaning 0.7 on one screen and 0.6 on the other is
 * exactly the class of drift this release exists to close — with the added
 * cruelty that the panel's nearest-numeric rule would still light "Mid" for the
 * tab's 0.6, so the two would LOOK consistent while storing different numbers.
 *
 * `key` is a NAME, not the number as a string, and that is load-bearing: a
 * dropdown's options are a plain object, and JS orders integer-like keys first,
 * numerically, ahead of every other key in insertion order. Keying High as "1"
 * therefore rendered the dropdown as High / Low / Mid — the stops out of order,
 * with nothing in the type system to notice. (The neighbouring taskSelectorDays
 * dropdown escapes only because ALL of its keys are integers and ascending.)
 * Naming the keys also separates the two jobs cleanly: the key identifies the
 * stop, the value is what gets stored.
 */
export const VOLUME_OPTIONS = [
  { key: "low", label: "Low", value: 0.3 },
  { key: "mid", label: "Mid", value: 0.7 },
  { key: "high", label: "High", value: 1 },
] as const;

/**
 * The same three stops as a dropdown's `{optionKey: label}` map — DERIVED, so
 * the tab cannot offer a stop the panel does not have, in an order the panel
 * does not use. (Built with a loop rather than `Object.fromEntries`, which is
 * ES2019 and outside this project's `lib`.)
 */
export const VOLUME_DROPDOWN_OPTIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const option of VOLUME_OPTIONS) out[option.key] = option.label;
  return out;
})();

/**
 * The dropdown key for a stored volume — SNAPPED to the nearest stop first.
 *
 * A lookup by exact value is wrong for the same reason a strict-equality
 * re-seed is: 0.1.0 shipped a volume SLIDER (0.1.2 replaced it with Low/Mid/
 * High) and `coerceToDefaults` only checks the field's TYPE, so a real
 * data.json can hold `soundVolume: 0.42`. Unsnapped, the tab's dropdown would
 * be handed a key it does not have, match no option and render arbitrarily —
 * while the panel showed "Low" for the same number. Snapping makes the two
 * surfaces answer the same question the same way, which is the whole point of
 * the shared rule.
 */
export function volumeOptionKey(stored: number): string {
  return VOLUME_OPTIONS[activeSegmentIndex<number>(VOLUME_OPTIONS, stored)].key;
}

/**
 * A dropdown key back to a stored volume, or null when it is not one of ours.
 *
 * Null rather than a clamp: `setControlValue` writes nothing on null, which is
 * the established answer for a value that should not be persisted (see
 * `numericSetting`). Note what this must NOT do — `Math.floor`, the pattern the
 * neighbouring `taskSelectorDays` case uses, turns 0.3 and 0.7 into 0 and
 * silences the channel while reporting no error at all. It is also deliberately
 * strict about the key: a dropdown hands back one of its own option keys or
 * nothing, so anything else is a bug, and refusing it leaves the stored value
 * alone rather than inventing a fourth level.
 */
export function parseVolumeOptionKey(value: unknown): number | null {
  const key = typeof value === "string" ? value : "";
  const option = VOLUME_OPTIONS.find((o) => o.key === key);
  return option ? option.value : null;
}
