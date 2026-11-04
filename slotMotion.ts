/**
 * Gentle motion for the panel's note slot (0.7.1): the focus note card and the
 * "Last time" line take turns in one place under the task button. When a
 * focus starts the card folds away and the line unfolds after it; when a
 * session ends the line folds away and the card unfolds. Never both at once,
 * never a jump: the one leaving fades, then gives back its height, its
 * margins and the column's row gap; only then does the other take them.
 *
 * Why the Web Animations API and not a CSS transition: the card's height is
 * whatever its words make it (the box grows with them), and a transition to
 * `max-height` either cuts it off or runs at a speed set by a guessed cap.
 * `el.animate` goes from the measured height to 0 and back, then lets go
 * (no fill), so nothing written by the animation stays on the element and no
 * static style is ever assigned (the obsidianmd lint rule).
 *
 * Pure apart from what the host gives it, so the order rules are testable.
 * Each part is a SlotPart; a SlotGroup holds the parts that share a place.
 */

/** What a part needs from the page. */
export interface SlotMotionHost {
  /** prefers-reduced-motion: every change is instant. */
  reduceMotion(): boolean;
  /** The element's box as laid out now (height, margins, opacity — mid-animation too). */
  measure(el: HTMLElement): SlotBox;
  /** The column's row gap the element takes up while shown. */
  rowGap(el: HTMLElement): number;
}

/**
 * The vertical box: everything that takes room in the column. A fold takes
 * each to 0 (margins to what cancels the row gap) — a card with padding and a
 * border, folded by its height alone, would stop at those and then jump.
 */
export interface SlotBox {
  height: number;
  marginTop: number;
  marginBottom: number;
  paddingTop: number;
  paddingBottom: number;
  borderTop: number;
  borderBottom: number;
  opacity: number;
}

/** A box as keyframe values. */
function boxFrame(box: SlotBox): Keyframe {
  return {
    height: `${box.height}px`,
    marginTop: `${box.marginTop}px`,
    marginBottom: `${box.marginBottom}px`,
    paddingTop: `${box.paddingTop}px`,
    paddingBottom: `${box.paddingBottom}px`,
    borderTopWidth: `${box.borderTop}px`,
    borderBottomWidth: `${box.borderBottom}px`,
  };
}

/** Folded: no room at all, the row gap given back by the bottom margin. */
function foldedBox(gap: number): SlotBox {
  return {
    height: 0,
    marginTop: 0,
    marginBottom: -gap,
    paddingTop: 0,
    paddingBottom: 0,
    borderTop: 0,
    borderBottom: 0,
    opacity: 0,
  };
}

/** The slot's timing. A fold is the height and margins; the fade runs inside it. */
export const SLOT_OUT_MS = 300;
export const SLOT_IN_MS = 380;
/** A note swapped in a line that stays: the words dip out and back. */
export const SLOT_DIP_OUT_MS = 140;
export const SLOT_DIP_IN_MS = 220;
/** No overshoot: a bounce on a height reads as a jolt, not as gentle. */
export const SLOT_EASE = "cubic-bezier(0.25, 0.8, 0.3, 1)";
/** The class a part wears while it moves: its content is clipped to the fold. */
export const SLOT_MOVING_CLASS = "gp-slot-moving";
const HIDDEN_CLASS = "gp-hidden";

type State = "hidden" | "showing" | "shown" | "hiding";

/** The minimal Animation the parts use (the DOM's, or a test's). */
interface RunningAnimation {
  finished: Promise<unknown>;
  cancel(): void;
}

/** One element that shows and hides in the slot. */
export class SlotPart {
  private state: State;
  private wanted: boolean;
  /** Written when this part starts to show (a line's words), not before. */
  private pendingWrite: (() => void) | null = null;
  private animation: RunningAnimation | null = null;
  /** Bumped by every new move: a move overtaken by another does not finish it. */
  private moveId = 0;

  constructor(
    readonly el: HTMLElement,
    private readonly group: SlotGroup
  ) {
    const shown = !el.classList.contains(HIDDEN_CLASS);
    this.state = shown ? "shown" : "hidden";
    this.wanted = shown;
    group.add(this);
  }

  /** Shown, or on its way: what takes the place. */
  get occupying(): boolean {
    return this.state !== "hidden";
  }

  /** The state as it is now, for tests and the group. */
  get current(): State {
    return this.state;
  }

  /**
   * Show this part. `write` puts its content in; it runs as the part starts to
   * show (so words never change under a fade-out), or — the part already shown
   * and the content new — in the middle of a short dip.
   */
  show(write?: () => void): void {
    this.wanted = true;
    if (this.group.instant()) {
      this.stop();
      write?.();
      this.pendingWrite = null;
      this.setHidden(false);
      this.state = "shown";
      this.group.settle();
      return;
    }
    switch (this.state) {
      case "shown":
        if (write) this.dip(write);
        return;
      case "showing":
        write?.();
        return;
      case "hiding":
        if (write) {
          // New content: let the old fold away, then show the new.
          this.pendingWrite = write;
          return;
        }
        this.unfold();
        return;
      case "hidden":
        if (write) this.pendingWrite = write;
        this.group.settle();
        return;
    }
  }

  /** Hide this part. */
  hide(): void {
    this.wanted = false;
    this.pendingWrite = null;
    if (this.group.instant()) {
      this.stop();
      this.setHidden(true);
      this.state = "hidden";
      this.group.settle();
      return;
    }
    if (this.state === "shown" || this.state === "showing") this.fold();
  }

  /** The group's turn: start showing if wanted and the place is free. */
  tryStart(): boolean {
    if (!this.wanted || this.state !== "hidden") return false;
    const write = this.pendingWrite;
    this.pendingWrite = null;
    write?.();
    this.unfold();
    return true;
  }

  /** Called when nothing may animate (instant): jump to what is wanted. */
  snap(): void {
    this.stop();
    if (this.wanted) {
      this.pendingWrite?.();
      this.pendingWrite = null;
    }
    this.setHidden(!this.wanted);
    this.state = this.wanted ? "shown" : "hidden";
  }

  private fold(): void {
    const host = this.group.host;
    const from = host.measure(this.el);
    const gap = host.rowGap(this.el);
    this.stop();
    this.state = "hiding";
    const id = ++this.moveId;
    const fadeEnd = from.opacity > 0 ? 0.55 : 0;
    this.run(
      [
        { offset: 0, ...boxFrame(from), opacity: from.opacity },
        { offset: fadeEnd, opacity: 0 },
        { offset: 1, ...boxFrame(foldedBox(gap)), opacity: 0 },
      ],
      SLOT_OUT_MS * Math.max(0.35, from.opacity),
      id,
      () => {
        this.setHidden(true);
        this.state = "hidden";
        // The place is free: the other part's turn — or this one's again,
        // when it was asked back with new content while it folded.
        this.group.settle();
      }
    );
  }

  private unfold(): void {
    const host = this.group.host;
    const gap = host.rowGap(this.el);
    // Where it is now: folded (hidden, or caught mid-fold), else from nothing.
    const wasHidden = this.el.classList.contains(HIDDEN_CLASS);
    const from = wasHidden ? foldedBox(gap) : host.measure(this.el);
    this.stop();
    this.setHidden(false);
    const to = host.measure(this.el);
    this.state = "showing";
    const id = ++this.moveId;
    this.run(
      [
        {
          offset: 0,
          ...boxFrame(from),
          opacity: from.opacity,
          transform: `translateY(${from.opacity >= 1 ? 0 : -4}px)`,
        },
        // The room opens first; the content fades in once there is some.
        { offset: 0.35, opacity: from.opacity },
        { offset: 1, ...boxFrame(to), opacity: 1, transform: "translateY(0px)" },
      ],
      SLOT_IN_MS,
      id,
      () => {
        this.state = "shown";
        if (!this.wanted) this.hide();
      }
    );
  }

  /** New words in a line that stays: fade them out, swap, fade back. */
  private dip(write: () => void): void {
    this.stop();
    const id = ++this.moveId;
    this.run([{ opacity: 1 }, { opacity: 0 }], SLOT_DIP_OUT_MS, id, () => {
      write();
      this.run([{ opacity: 0 }, { opacity: 1 }], SLOT_DIP_IN_MS, ++this.moveId, () => {
        this.state = "shown";
      });
    });
  }

  private run(keyframes: Keyframe[], duration: number, id: number, done: () => void): void {
    this.el.classList.add(SLOT_MOVING_CLASS);
    const animation = this.el.animate(keyframes, { duration, easing: SLOT_EASE });
    this.animation = animation;
    animation.finished.then(
      () => {
        if (id !== this.moveId) return;
        this.animation = null;
        this.el.classList.remove(SLOT_MOVING_CLASS);
        animation.cancel();
        done();
      },
      () => undefined
    );
  }

  /** Stop whatever runs, where it is; the next move starts from there. */
  private stop(): void {
    this.moveId++;
    const animation = this.animation;
    this.animation = null;
    this.el.classList.remove(SLOT_MOVING_CLASS);
    animation?.cancel();
  }

  private setHidden(hidden: boolean): void {
    this.el.classList.toggle(HIDDEN_CLASS, hidden);
  }
}

/**
 * The parts that share a place. One occupies it at a time: a part that wants
 * to show waits until every other has folded away.
 */
export class SlotGroup {
  private readonly parts: SlotPart[] = [];
  private armed = false;

  constructor(readonly host: SlotMotionHost) {}

  add(part: SlotPart): void {
    this.parts.push(part);
  }

  /**
   * Allow motion from now on. Until then (the panel being built, its first
   * paint) every change is instant: a panel that opens with a note showing
   * must not play it in.
   */
  arm(): void {
    this.armed = true;
  }

  instant(): boolean {
    return !this.armed || this.host.reduceMotion();
  }

  /** Let the next waiting part in, once the place is free. */
  settle(): void {
    if (this.instant()) {
      for (const part of this.parts) part.snap();
      return;
    }
    if (this.parts.some((part) => part.occupying)) return;
    for (const part of this.parts) if (part.tryStart()) return;
  }
}

/** The page's host: the real layout and the user's motion setting. */
export function domSlotHost(win: Window = window): SlotMotionHost {
  return {
    reduceMotion: () => win.matchMedia("(prefers-reduced-motion: reduce)").matches,
    measure: (el) => {
      const cs = win.getComputedStyle(el);
      const px = (value: string) => parseFloat(value) || 0;
      return {
        height: el.getBoundingClientRect().height,
        marginTop: px(cs.marginTop),
        marginBottom: px(cs.marginBottom),
        paddingTop: px(cs.paddingTop),
        paddingBottom: px(cs.paddingBottom),
        borderTop: px(cs.borderTopWidth),
        borderBottom: px(cs.borderBottomWidth),
        opacity: px(cs.opacity),
      };
    },
    rowGap: (el) => {
      const parent = el.parentElement;
      if (!parent) return 0;
      return parseFloat(win.getComputedStyle(parent).rowGap) || 0;
    },
  };
}
