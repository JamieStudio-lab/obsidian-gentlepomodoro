import { describe, it, expect, vi } from "vitest";
import {
  SLOT_MOVING_CLASS,
  SlotGroup,
  SlotPart,
  type SlotBox,
  type SlotMotionHost,
} from "../slotMotion";

/**
 * The note slot's motion (0.7.1): the card and the "Last time" line take
 * turns in one place. What matters is the order — the one leaving folds away
 * before the other unfolds, words are written only as a part starts to show,
 * and an overtaken move never finishes — so the element and its animations
 * are fakes that record and let the test land each animation by hand.
 */

interface FakeAnimation {
  keyframes: Keyframe[];
  duration: number;
  cancelled: boolean;
  land(): Promise<void>;
}

const NATURAL: SlotBox = {
  height: 120,
  marginTop: -12,
  marginBottom: 12,
  paddingTop: 12,
  paddingBottom: 12,
  borderTop: 1,
  borderBottom: 1,
  opacity: 1,
};

function fakeEl(name: string, hidden = true) {
  const classes = new Set<string>(hidden ? ["gp-hidden"] : []);
  const animations: FakeAnimation[] = [];
  const el = {
    name,
    animations,
    classList: {
      contains: (c: string) => classes.has(c),
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
    },
    get hidden() {
      return classes.has("gp-hidden");
    },
    get moving() {
      return classes.has(SLOT_MOVING_CLASS);
    },
    animate(keyframes: Keyframe[], options: { duration: number }) {
      let resolveFinished: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const animation: FakeAnimation = {
        keyframes,
        duration: options.duration,
        cancelled: false,
        land: async () => {
          resolveFinished();
          await flush();
        },
      };
      animations.push(animation);
      return {
        finished,
        cancel: () => {
          animation.cancelled = true;
        },
      };
    },
  };
  return el;
}
type FakeEl = ReturnType<typeof fakeEl>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(options: { armed?: boolean; reduce?: boolean; cardShown?: boolean } = {}) {
  let reduce = options.reduce ?? false;
  const host: SlotMotionHost = {
    reduceMotion: () => reduce,
    // Hidden: no room. Shown: the natural box (mid-animation the tests do not
    // need anything finer).
    measure: (el) =>
      (el as unknown as FakeEl).hidden ? { ...NATURAL, height: 0, opacity: 0 } : NATURAL,
    rowGap: () => 12,
  };
  const group = new SlotGroup(host);
  const cardEl = fakeEl("card", !(options.cardShown ?? true));
  const lineEl = fakeEl("line");
  const card = new SlotPart(cardEl as unknown as HTMLElement, group);
  const line = new SlotPart(lineEl as unknown as HTMLElement, group);
  if (options.armed ?? true) group.arm();
  return {
    group,
    card,
    line,
    cardEl,
    lineEl,
    setReduce: (on: boolean) => {
      reduce = on;
    },
  };
}

const last = (el: FakeEl) => el.animations[el.animations.length - 1];

describe("the note slot: one part at a time", () => {
  it("a focus starts: the card folds away, then the line unfolds with its words", async () => {
    const { card, line, cardEl, lineEl } = setup();
    const write = vi.fn();
    card.hide();
    line.show(write);
    // The line waits for the place: nothing written, nothing shown yet.
    expect(write).not.toHaveBeenCalled();
    expect(lineEl.hidden).toBe(true);
    expect(lineEl.animations).toHaveLength(0);
    expect(cardEl.moving).toBe(true);

    await last(cardEl).land();
    expect(cardEl.hidden).toBe(true);
    expect(cardEl.moving).toBe(false);
    // Now the line: written as it starts, shown, unfolding.
    expect(write).toHaveBeenCalledTimes(1);
    expect(lineEl.hidden).toBe(false);
    expect(lineEl.animations).toHaveLength(1);
    expect(line.current).toBe("showing");
    await last(lineEl).land();
    expect(line.current).toBe("shown");
    expect(lineEl.moving).toBe(false);
  });

  it("waits the same when the line asks first, in the same moment", async () => {
    const { card, line, cardEl, lineEl } = setup();
    line.show(vi.fn());
    card.hide();
    expect(lineEl.animations).toHaveLength(0);
    await last(cardEl).land();
    expect(lineEl.animations).toHaveLength(1);
  });

  it("a session ends: the line folds away, then the card unfolds", async () => {
    const { card, line, cardEl, lineEl } = setup({ cardShown: false });
    line.show(vi.fn());
    await last(lineEl).land();
    card.show();
    line.hide();
    expect(cardEl.hidden).toBe(true);
    expect(cardEl.animations).toHaveLength(0);
    await last(lineEl).land();
    expect(lineEl.hidden).toBe(true);
    expect(cardEl.hidden).toBe(false);
    expect(card.current).toBe("showing");
  });

  it("folds everything that takes room, and gives the row gap back", () => {
    const { card, cardEl } = setup();
    card.hide();
    const frames = last(cardEl).keyframes;
    expect(frames[0]).toMatchObject({ height: "120px", paddingTop: "12px", borderTopWidth: "1px" });
    expect(frames[frames.length - 1]).toMatchObject({
      height: "0px",
      marginTop: "0px",
      marginBottom: "-12px",
      paddingTop: "0px",
      paddingBottom: "0px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
      opacity: 0,
    });
  });

  it("unfolds from nothing to its own box, rising a little", async () => {
    const { card, line, cardEl, lineEl } = setup();
    card.hide();
    line.show(vi.fn());
    await last(cardEl).land();
    const frames = last(lineEl).keyframes;
    expect(frames[0]).toMatchObject({
      height: "0px",
      marginBottom: "-12px",
      opacity: 0,
      transform: "translateY(-4px)",
    });
    expect(frames[frames.length - 1]).toMatchObject({
      height: "120px",
      marginTop: "-12px",
      marginBottom: "12px",
      opacity: 1,
      transform: "translateY(0px)",
    });
  });
});

describe("the note slot: changes in the middle", () => {
  it("new words in a line that stays: a dip, the words swapped at the bottom", async () => {
    const { card, line, cardEl, lineEl } = setup();
    card.hide();
    line.show(vi.fn());
    await last(cardEl).land();
    await last(lineEl).land();
    const write = vi.fn();
    line.show(write);
    expect(write).not.toHaveBeenCalled();
    expect(last(lineEl).keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    await last(lineEl).land();
    expect(write).toHaveBeenCalledTimes(1);
    expect(last(lineEl).keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(lineEl.hidden).toBe(false);
  });

  it("asked back while folding, with nothing new: it turns round at once", () => {
    const { card, cardEl } = setup();
    card.hide();
    const fold = last(cardEl);
    card.show();
    expect(fold.cancelled).toBe(true);
    expect(card.current).toBe("showing");
    expect(cardEl.hidden).toBe(false);
  });

  it("asked back while folding, with new words: the old fold away first", async () => {
    const { line, card, cardEl, lineEl } = setup();
    card.hide();
    line.show(vi.fn());
    await last(cardEl).land();
    await last(lineEl).land();
    line.hide();
    const write = vi.fn();
    line.show(write);
    // The old words leave under the fold; the new ones wait for it.
    expect(write).not.toHaveBeenCalled();
    expect(line.current).toBe("hiding");
    await last(lineEl).land();
    expect(write).toHaveBeenCalledTimes(1);
    expect(line.current).toBe("showing");
  });

  it("an overtaken move never finishes: hidden mid-unfold, the unfold's end does nothing", async () => {
    const { card, line, cardEl, lineEl } = setup();
    card.hide();
    line.show(vi.fn());
    await last(cardEl).land();
    const unfold = last(lineEl);
    line.hide();
    expect(unfold.cancelled).toBe(true);
    const fold = last(lineEl);
    const count = lineEl.animations.length;
    await unfold.land();
    // Still folding, the same fold: the overtaken unfold neither marked it
    // shown nor stopped the fold to start another.
    expect(line.current).toBe("hiding");
    expect(fold.cancelled).toBe(false);
    expect(lineEl.animations).toHaveLength(count);
    expect(lineEl.moving).toBe(true);
    await fold.land();
    expect(line.current).toBe("hidden");
    expect(lineEl.hidden).toBe(true);
  });

  it("hiding a part that is not there does nothing", () => {
    const { line, lineEl } = setup();
    line.hide();
    expect(lineEl.animations).toHaveLength(0);
    expect(lineEl.hidden).toBe(true);
  });
});

describe("the note slot: when nothing moves", () => {
  it("before the panel has painted, every change is instant", () => {
    const { card, line, cardEl, lineEl } = setup({ armed: false });
    const write = vi.fn();
    card.hide();
    line.show(write);
    expect(cardEl.hidden).toBe(true);
    expect(lineEl.hidden).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cardEl.animations).toHaveLength(0);
    expect(lineEl.animations).toHaveLength(0);
  });

  it("under reduced motion, every change is instant — and a move under way stops where it is wanted", async () => {
    const { card, line, cardEl, lineEl, setReduce } = setup();
    card.hide();
    line.show(vi.fn());
    const fold = last(cardEl);
    setReduce(true);
    line.show(vi.fn());
    expect(fold.cancelled).toBe(true);
    expect(cardEl.hidden).toBe(true);
    expect(lineEl.hidden).toBe(false);
    expect(lineEl.animations).toHaveLength(0);
    card.show();
    line.hide();
    expect(cardEl.hidden).toBe(false);
    expect(lineEl.hidden).toBe(true);
  });
});
