import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ROOFTOP_LAYERS } from "../rooftopArt";

/**
 * The Rooftop Skyline plates: the list in rooftopArt.ts, the files on disk,
 * the classes styles.css animates, and the build config that puts them in
 * main.js. Four things that must agree and that nothing else checks — a plate
 * missing from the list simply never appears, a class the CSS animates but
 * the view never builds is a fade nobody sees, and a PNG the bundler does not
 * include is a build error only on the machine that lacks the loose file.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platesDir = resolve(root, "art/rooftop/plates");
const css = readFileSync(resolve(root, "styles.css"), "utf8");
const source = readFileSync(resolve(root, "rooftopArt.ts"), "utf8");

const EXPECTED_ORDER = [
  "sky-1",
  "sky-2",
  "sky-3",
  "sky-4",
  "sky-5",
  "stars",
  "buildings",
  "windows-1",
  "windows-2",
  "windows-3",
];

/** Width and height from a PNG's IHDR chunk — the first chunk, at a fixed offset. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  expect(bytes.subarray(0, 8).toString("hex")).toBe(signature);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the plate list", () => {
  it("names the ten plates, bottom to top, in the order the CSS stacks them", () => {
    expect(ROOFTOP_LAYERS.map((l) => l.cls)).toEqual(EXPECTED_ORDER.map((n) => `gp-rooftop-${n}`));
  });

  it("imports every plate file on disk exactly once, and nothing else", () => {
    const onDisk = readdirSync(platesDir)
      .filter((f) => f.endsWith(".png") && f !== "preview.png")
      .sort();
    const imported = [...source.matchAll(/from "\.\/art\/rooftop\/plates\/([a-z0-9-]+\.png)"/g)]
      .map((m) => m[1])
      .sort();
    expect(imported).toEqual(onDisk);
    expect(new Set(imported).size).toBe(imported.length);
  });

  it("resolves every plate to a non-empty source", () => {
    for (const layer of ROOFTOP_LAYERS) {
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
      expect(pngSize(bytes), name).toEqual({ width: 128, height: 128 });
    }
  });

  // Every byte here is base64-expanded by a third and shipped inside main.js
  // to every device. Ten indexed plates come to about 11 KB; the budget is
  // loose enough for a redraw and tight enough that a truecolor export from
  // Aseprite (roughly 4x the size) fails here rather than in a release.
  it("stay inside the size budget", () => {
    let total = 0;
    for (const { name, bytes } of files) {
      expect(bytes.length, `${name}.png`).toBeLessThanOrEqual(2048);
      total += bytes.length;
    }
    expect(total).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("agreement with the stylesheet and the build", () => {
  it("only animates classes the view actually builds", () => {
    const built = new Set(ROOFTOP_LAYERS.map((l) => l.cls));
    const animated = new Set([...css.matchAll(/\.(gp-rooftop-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(animated.size, "the Rooftop Skyline block animates nothing").toBeGreaterThan(0);
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
