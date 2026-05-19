// Inline SVG icons for the day/night indicator. Kept hand-coded (rather than
// using setIcon from Obsidian) so the four shapes share a single stack and
// don't introduce a separate icon-stylesheet dependency.

export type DayNightIcon = "sun" | "sunset" | "moon" | "sunrise";

export const DAY_NIGHT_ICON_ORDER: DayNightIcon[] = ["sun", "sunset", "moon", "sunrise"];

const SVG_NS = "http://www.w3.org/2000/svg";

const createSvgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag);

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
