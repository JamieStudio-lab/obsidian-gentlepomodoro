// Inline SVG icons for the day/night indicator. Kept hand-coded (rather than
// using setIcon from Obsidian) so the four shapes share a single stack and
// don't introduce a separate icon-stylesheet dependency.

export type DayNightIcon = "sun" | "sunset" | "moon" | "sunrise";

export const DAY_NIGHT_ICON_ORDER: DayNightIcon[] = ["sun", "sunset", "moon", "sunrise"];

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  activeDocument.createElementNS(SVG_NS, tag);

export function buildDayNightIcon(icon: DayNightIcon): SVGSVGElement {
  const svg = createSvgEl("svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const addPath = (d: string) => {
    const p = createSvgEl("path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  };

  if (icon === "sun") {
    const c = createSvgEl("circle");
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", "4");
    svg.appendChild(c);
    addPath(
      "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
    );
    return svg;
  }

  if (icon === "sunset") {
    addPath("M6 18h12");
    addPath("M7 18a5 5 0 0 1 10 0");
    addPath("M12 3v3");
    addPath("M5 12h2M17 12h2");
    addPath("M7 9l1.2 1.2M17 9l-1.2 1.2");
    return svg;
  }

  if (icon === "sunrise") {
    addPath("M6 18h12");
    addPath("M7 18a5 5 0 0 1 10 0");
    addPath("M12 3v3");
    addPath("M5 12h2M17 12h2");
    addPath("M4 15h2M18 15h2");
    return svg;
  }

  // moon
  addPath("M21 12.6A8.5 8.5 0 0 1 11.4 3a7 7 0 1 0 9.6 9.6Z");
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
