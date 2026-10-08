export type MomentUnit = string;

// Minimal shape used by this plugin (Obsidian exposes a global `moment`).
export interface MomentLike {
  startOf(unit: MomentUnit): MomentLike;
  endOf(unit: MomentUnit): MomentLike;
  add(amount: number, unit: MomentUnit): MomentLike;
  subtract(amount: number, unit: MomentUnit): MomentLike;
  clone(): MomentLike;
  // Sets the instance's locale. Stored date text goes through logLine.ts's
  // `stamp`, which sets "en" on a clone so the app language cannot reach it.
  locale(key: string): MomentLike;
  valueOf(): number;
  // The wall-clock hour, 0-23 (logLine.ts's logicalDate).
  hour(): number;

  format(formatString: string): string;
  diff(other: MomentLike, unit?: MomentUnit): number;

  isSameOrBefore(other: MomentLike): boolean;
  isBefore(other: MomentLike): boolean;
  isSame(other: MomentLike, unit?: MomentUnit): boolean;
}

export type MomentFactory = (input?: string | number) => MomentLike;
