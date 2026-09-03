import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PIXEL_CITY_LAYERS } from "../pixelCityArt";

/**
 * The Pixel City plates: the list in pixelCityArt.ts, the files on disk,
 * the classes styles.css animates, and the build config that puts them in
 * main.js. Four things that must agree and that nothing else checks — a plate
 * missing from the list simply never appears, a class the CSS animates but
 * the view never builds is a fade nobody sees, and a PNG the bundler does not
 * include is a build error only on the machine that lacks the loose file.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platesDir = resolve(root, "art/pixel-city/plates");
const css = readFileSync(resolve(root, "styles.css"), "utf8");
const source = readFileSync(resolve(root, "pixelCityArt.ts"), "utf8");

const EXPECTED_ORDER = [
  "sky-1",
  "sky-2",
  "sky-3",
  "sky-4",
  "sky-5",
  "sky-6",
  "sky-7",
  "sky-8",
  "stars",
  "buildings",
  "windows-1",
  "windows-2",
  "windows-3",
  "windows-4",
  "windows-5",
  "windows-6",
];

/**
 * The IHDR chunk — always first, at a fixed offset: width, height, bit depth,
 * colour type. Colour type 3 is indexed (a palette); 2 and 6 are truecolor.
 */
function ihdr(bytes: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
} {
  const signature = "89504e470d0a1a0a";
  expect(bytes.subarray(0, 8).toString("hex")).toBe(signature);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
  };
}

const INDEXED = 3;

describe("the plate list", () => {
  it("names the sixteen plates, bottom to top, in the order the CSS stacks them", () => {
    expect(PIXEL_CITY_LAYERS.map((l) => l.cls)).toEqual(
      EXPECTED_ORDER.map((n) => `gp-pixel-city-${n}`)
    );
  });

  it("imports every plate file on disk exactly once, and nothing else", () => {
    const onDisk = readdirSync(platesDir)
      .filter((f) => f.endsWith(".png") && f !== "preview.png")
      .sort();
    const imported = [...source.matchAll(/from "\.\/art\/pixel-city\/plates\/([a-z0-9-]+\.png)"/g)]
      .map((m) => m[1])
      .sort();
    expect(imported).toEqual(onDisk);
    expect(new Set(imported).size).toBe(imported.length);
  });

  it("resolves every plate to a non-empty source", () => {
    for (const layer of PIXEL_CITY_LAYERS) {
      expect(typeof layer.src, layer.cls).toBe("string");
      expect(layer.src.length, layer.cls).toBeGreaterThan(0);
    }
  });
});

describe("the plate files", () => {
  const files = EXPECTED_ORDER.map((n) => ({
    name: n,
    bytes: readFileSync(resolve(platesDir, `${n}.png`)),
  }));

  it("are all 128 x 128", () => {
    for (const { name, bytes } of files) {
      const { width, height } = ihdr(bytes);
      expect({ width, height }, name).toEqual({ width: 128, height: 128 });
    }
  });

  // An export from Aseprite in RGB or RGBA mode is a different file type, not
  // a bigger one — flat pixel art compresses well in any mode, so no byte
  // budget can tell them apart. The IHDR colour type can. Indexed is what
  // keeps the palette editable and the plates small.
  it("are indexed PNGs at 8 bits or fewer", () => {
    for (const { name, bytes } of files) {
      const { bitDepth, colourType } = ihdr(bytes);
      expect(colourType, `${name}.png is not an indexed PNG`).toBe(INDEXED);
      expect(bitDepth, `${name}.png bit depth`).toBeLessThanOrEqual(8);
    }
  });

  // Every byte here is base64-expanded by a third and shipped inside main.js
  // to every device. Sixteen indexed plates come to about 6.7 KB, under 500 B
  // each; the budget leaves room for a busier redraw and catches the two
  // things that actually inflate a plate: a padded 256-entry palette (which
  // the first cut shipped — 60% of every file was zeros) and a plate saved
  // with the preview's 4x upscale.
  it("stay inside the size budget", () => {
    let total = 0;
    for (const { name, bytes } of files) {
      expect(bytes.length, `${name}.png`).toBeLessThanOrEqual(1024);
      total += bytes.length;
    }
    expect(total).toBeLessThanOrEqual(10 * 1024);
  });
});

describe("agreement with the stylesheet and the build", () => {
  /** The rule body for one plate class inside the theme block, or null. */
  function pixelCityRule(cls: string): string | null {
    const m = new RegExp(`\\.gp-theme-pixel-city \\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : null;
  }

  // Sky-1 is the base and the buildings never change; every other plate must
  // move, and only on --gp-progress. Without this direction a deleted
  // opacity rule leaves the plate at opacity 1 for the whole session — sky-3
  // covering the day sky from the first second — and nothing else notices.
  it("gives every moving plate an opacity rule on --gp-progress", () => {
    const STATIC = new Set(["gp-pixel-city-sky-1", "gp-pixel-city-buildings"]);
    for (const { cls } of PIXEL_CITY_LAYERS) {
      const body = pixelCityRule(cls);
      if (STATIC.has(cls)) {
        expect(body, `${cls} is static and must not carry a rule`).toBeNull();
        continue;
      }
      expect(body, `no .gp-theme-pixel-city .${cls} rule`).not.toBeNull();
      expect(body, cls).toMatch(/opacity:\s*clamp\(/);
      expect(body, cls).toContain("var(--gp-progress)");
    }
  });

  // The thresholds are the timeline art/pixel-city/pixlib.py previews with:
  // sky plate k rises over the (k-1)th seventh, wave j at 40% + (j-1) x 8%.
  it("keeps the sky and window thresholds on the previewed timeline", () => {
    for (let k = 2; k <= 8; k++) {
      expect(pixelCityRule(`gp-pixel-city-sky-${k}`)).toContain(
        `var(--gp-progress) * 7 - ${k - 2}`
      );
    }
    for (let j = 1; j <= 6; j++) {
      const t = String(Number((0.4 + (j - 1) * 0.08).toFixed(2))); // 0.4, not 0.40: prettier's form
      expect(pixelCityRule(`gp-pixel-city-windows-${j}`)).toContain(
        `(var(--gp-progress) - ${t}) * 100`
      );
    }
    expect(pixelCityRule("gp-pixel-city-stars")).toContain("(var(--gp-progress) - 0.65) / 0.35");
  });

  it("shows the plates only inside the theme", () => {
    const shared = pixelCityRule("gp-pixel-city");
    expect(shared, "no .gp-theme-pixel-city .gp-pixel-city rule").not.toBeNull();
    expect(shared).toMatch(/display:\s*block/);
    expect(shared).toMatch(/image-rendering:\s*pixelated/);
    expect(css).toMatch(/\.gp-art\s*\{[^}]*display:\s*none/);
  });

  // The view is the third party to the agreement: it must build one <img>
  // per entry with `gp-art` (so the default-hidden rule applies) and
  // `gp-pixel-city` plus the entry's class (so the theme block finds it).
  it("is what the view builds", () => {
    const view = readFileSync(resolve(root, "GentlePomoView.ts"), "utf8");
    expect(view).toContain("for (const layer of PIXEL_CITY_LAYERS)");
    expect(view).toContain('createEl("img", {');
    expect(view).toContain("cls: `gp-art gp-pixel-city ${layer.cls}`");
    expect(view).toContain("src: layer.src");
  });

  it("only animates classes the view actually builds", () => {
    const built = new Set(PIXEL_CITY_LAYERS.map((l) => l.cls));
    const animated = new Set([...css.matchAll(/\.(gp-pixel-city-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(animated.size, "the Pixel City block animates nothing").toBeGreaterThan(0);
    for (const cls of animated) {
      expect(built.has(cls), `styles.css addresses .${cls}, which the view never builds`).toBe(
        true
      );
    }
  });

  it("is bundled into main.js by rollup", () => {
    const rollup = readFileSync(resolve(root, "rollup.config.mjs"), "utf8");
    expect(rollup).toMatch(/include:\s*\[[^\]]*"\*\*\/\*\.png"/);
  });
});
