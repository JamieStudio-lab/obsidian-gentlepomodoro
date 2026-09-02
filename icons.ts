// Inline SVG icons for the day/night indicator. Kept hand-coded (rather than
// using setIcon from Obsidian) so the four shapes share a single stack and
// don't introduce a separate icon-stylesheet dependency.
//
// The badge's PHASE lives here too, beside the glyphs it selects. It used to be
// derived independently in GentlePomoView from raw remainingMs while the
// artwork was driven by skyPhase — and the two disagreed, badly: the badge
// showed a sun for the entire first half of a focus session and its moon was
// unreachable outside overtime, so it ran a whole phase behind the square it
// sits on. One function now feeds both, which is the only way they cannot
// drift again.

import type { TimerState } from "./types";

export type DayNightIcon = "sun" | "sunset" | "moon" | "sunrise";

export const DAY_NIGHT_ICON_ORDER: DayNightIcon[] = ["sun", "sunset", "moon", "sunrise"];

/**
 * The theme contract's scalar: 0 = day, 1 = night.
 *
 * Mode-flipped, so a focus session runs 0 -> 1 and a break runs 1 -> 0 and no
 * consumer has to know which it is in. Published to CSS as `--gp-progress`, and
 * split into the two layer opacities the classic theme cross-fades.
 */
export function skyPhase(state: TimerState): number {
  const progress = state.totalMs > 0 ? 1 - state.remainingMs / state.totalMs : 0;
  const clamped = Math.max(0, Math.min(1, progress));
  return state.mode === "focus" ? clamped : 1 - clamped;
}

/**
 * Which glyph the badge shows, quantised from the same scalar the artwork uses.
 *
 * Thirds, not halves: the square passes through day, dusk and night, so the
 * badge needs three bands to track it. The middle glyph is the only thing that
 * depends on direction — a break climbs back toward day, so it rises.
 */
export function dayNightIconFor(state: TimerState): DayNightIcon {
  const phase = skyPhase(state);
  if (phase < 1 / 3) return "sun";
  if (phase < 2 / 3) return state.mode === "focus" ? "sunset" : "sunrise";
  return "moon";
}

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  activeDocument.createElementNS(SVG_NS, tag);

interface DayNightShape {
  /** Drawn before the paths, for shapes with a solid disc at their centre. */
  circles?: { cx: number; cy: number; r: number }[];
  paths: string[];
}

/**
 * A record rather than a branch, so a theme that needs its own glyph set (a
 * pixel theme cannot use smooth vector line art) supplies data instead of code.
 *
 * Redrawn in 0.6.1 to sit at 16px instead of 14px, with a heavier stroke. The
 * pair that needed it most was sunset/sunrise: they differed only in whether
 * two tiny side ticks were diagonal or horizontal, which at this size was not a
 * distinction anyone could see. They now carry an arrow that points the way the
 * sun is going, and the fussy ray clusters that read as noise are gone.
 */
const DAY_NIGHT_SHAPES: Record<DayNightIcon, DayNightShape> = {
  sun: {
    circles: [{ cx: 12, cy: 12, r: 4.5 }],
    paths: [
      "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41",
    ],
  },
  sunset: {
    paths: ["M5 18h14", "M7.5 18a4.5 4.5 0 0 1 9 0", "M12 3v5", "M9.5 5.5 12 8l2.5-2.5"],
  },
  sunrise: {
    paths: ["M5 18h14", "M7.5 18a4.5 4.5 0 0 1 9 0", "M12 8V3", "M9.5 5.5 12 3l2.5 2.5"],
  },
  moon: {
    paths: ["M21 12.6A8.5 8.5 0 0 1 11.4 3a7 7 0 1 0 9.6 9.6Z"],
  },
};

export function buildDayNightIcon(icon: DayNightIcon): SVGSVGElement {
  const shape = DAY_NIGHT_SHAPES[icon];
  const svg = createSvgEl("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  // Nothing in styles.css sets stroke-width for these (unlike .gp-icon-btn svg,
  // where a CSS rule beats the attribute), so this value is the one that lands.
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  for (const c of shape.circles ?? []) {
    const el = createSvgEl("circle");
    el.setAttribute("cx", String(c.cx));
    el.setAttribute("cy", String(c.cy));
    el.setAttribute("r", String(c.r));
    svg.appendChild(el);
  }
  for (const d of shape.paths) {
    const el = createSvgEl("path");
    el.setAttribute("d", d);
    svg.appendChild(el);
  }
  return svg;
}

/* =========================================================================
   Music-row control icons
   -------------------------------------------------------------------------
   Hand-built for the same reason as the day/night set above, plus one of its
   own: Obsidian's addIcon() wraps whatever it is given in a 0 0 100 100
   viewBox, so registering this artwork through it would mean rescaling every
   path by hand.

   BOTH SHARE THE 24-UNIT viewBox EVERY LUCIDE GLYPH USES, and that is
   load-bearing rather than tidiness. styles.css sets stroke-width on
   `.gp-icon-btn svg`, and a CSS rule beats a presentation attribute — so a
   per-icon stroke-width set here is simply discarded, and that one css width
   resolves against each icon's own user-space. Art drawn in a 16-unit box
   therefore renders 1.5x thicker than its neighbours. (The next-link button
   used to carry such a glyph; it now reuses Lucide's skip-forward, the same one
   the timer's own Skip button uses.)

   The `svg-icon` class is deliberate: the mobile CSS floor that works around
   WebKit's flex-SVG sliver bug is written against `.gp-icon-btn svg.svg-icon`.
   ========================================================================= */

export type MusicIcon = "station-list" | "next-video";

interface MusicIconShape {
  paths: string[];
}

const MUSIC_ICON_SHAPES: Record<MusicIcon, MusicIconShape> = {
  "station-list": {
    paths: [
      "M21 12L9 12M21 6L9 6M21 18L9 18M5 12C5 12.5523 4.55228 13 4 13C3.44772 13 3 12.5523 3 12C3 11.4477 3.44772 11 4 11C4.55228 11 5 11.4477 5 12ZM5 6C5 6.55228 4.55228 7 4 7C3.44772 7 3 6.55228 3 6C3 5.44772 3.44772 5 4 5C4.55228 5 5 5.44772 5 6ZM5 18C5 18.5523 4.55228 19 4 19C3.44772 19 3 18.5523 3 18C3 17.4477 3.44772 17 4 17C4.55228 17 5 17.4477 5 18Z",
    ],
  },
  "next-video": {
    paths: [
      "M13 16.437C13 17.567 13 18.1321 13.2283 18.4091C13.4266 18.6497 13.7258 18.7841 14.0374 18.7724C14.3961 18.759 14.8184 18.3836 15.663 17.6329L20.6547 13.1958C21.12 12.7822 21.3526 12.5754 21.4383 12.3312C21.5136 12.1168 21.5136 11.8831 21.4383 11.6687C21.3526 11.4245 21.12 11.2177 20.6547 10.8041L15.663 6.36706C14.8184 5.61631 14.3961 5.24093 14.0374 5.22751C13.7258 5.21584 13.4266 5.35021 13.2283 5.59086C13 5.86787 13 6.43288 13 7.56291V16.437Z",
      "M2 16.437C2 17.567 2 18.1321 2.22827 18.4091C2.42657 18.6497 2.72579 18.7841 3.0374 18.7724C3.39609 18.759 3.81839 18.3836 4.66298 17.6329L9.65466 13.1958C10.12 12.7822 10.3526 12.5754 10.4383 12.3312C10.5136 12.1168 10.5136 11.8831 10.4383 11.6687C10.3526 11.4245 10.12 11.2177 9.65466 10.8041L4.66298 6.36706C3.81839 5.61631 3.39609 5.24093 3.0374 5.22751C2.72579 5.21584 2.42657 5.35021 2.22827 5.59086C2 5.86787 2 6.43288 2 7.56291V16.437Z",
    ],
  },
};

/**
 * Build one of the music-row icons: themed, screen-reader-invisible, and the
 * same visual weight and size as Obsidian's own 24-unit Lucide glyphs beside
 * it. Stroke is `currentColor`, so it follows the button's text colour in both
 * themes — the supplied artwork hard-coded black, invisible on a dark control.
 */
export function buildMusicIcon(icon: MusicIcon): SVGSVGElement {
  const shape = MUSIC_ICON_SHAPES[icon];
  const svg = createSvgEl("svg");
  svg.addClass("svg-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  // Same value for every icon, and only a fallback: Obsidian's .svg-icon CSS
  // overrides it. Consistency comes from the shared viewBox, not from here.
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of shape.paths) {
    const path = createSvgEl("path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
