export type MomentUnit = string;

// Minimal shape used by this plugin (Obsidian exposes a global `moment`).
export interface MomentLike {
  startOf(unit: MomentUnit): MomentLike;
  endOf(unit: MomentUnit): MomentLike;
  add(amount: number, unit: MomentUnit): MomentLike;

  format(formatString: string): string;
  diff(other: MomentLike): number;

  isSameOrBefore(other: MomentLike): boolean;
  isBefore(other: MomentLike): boolean;
  isSame(other: MomentLike, unit?: MomentUnit): boolean;
}

export type MomentFactory = (input?: string) => MomentLike;

