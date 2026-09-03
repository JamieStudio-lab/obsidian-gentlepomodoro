# Rooftop Skyline — the artwork

The plates behind the **Rooftop Skyline** timer theme, and the script that
draws them.

| Path         | What it is                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `skyline.py` | The design: sky ramps, the two planes of buildings, the cat, the window grid, the stars. Run it to redraw. |
| `pixlib.py`  | A small strict toolkit: palette-indexed canvas, ordered dither, indexed-PNG output, the timeline preview.  |
| `plates/`    | The output the plugin ships — sixteen 128×128 indexed PNGs — plus `preview.png`, a strip of the timeline.  |

Everything is MIT with the rest of the plugin. The palette is
[Endesga 32](https://lospec.com/palette-list/endesga-32) by Endesga (palettes
are not copyrightable; the credit is a courtesy).

## The plates

In stacking order, bottom first. All 128×128, every pixel an Endesga 32 index.

| File            | Layer                  | Moves on `--gp-progress` as                                   |
| --------------- | ---------------------- | ------------------------------------------------------------- |
| `sky-1.png`     | day                    | the base; always fully opaque                                 |
| `sky-2..8.png`  | late day → night       | plate _k_ rises over the (*k*−1)th seventh of the arc         |
| `stars.png`     | stars, transparent     | fades in from 65% to 100%                                     |
| `buildings.png` | both planes, the cat   | static — the one layer that never changes, so it never ghosts |
| `windows-1..6`  | lit panes, transparent | wave _j_ eases on at 40% + (*j*−1)·8%, over 1% of the arc     |

The same numbers live in `pixlib.py` (which previews them) and in the
Rooftop Skyline block of `styles.css` (which runs them). Change both.

## Redrawing

Needs Python 3.9+ and Pillow (`pip install pillow`).

```bash
cd art/rooftop && python3 skyline.py
```

That rewrites `plates/` and prints the checks. `validate: []` is the only
acceptable output: the checks cover opacity of the sky plates, every lit pane
sitting on a building, the clock band (rows 24–70) holding only sky, the
centre dip, the edge margins, the corner clip, the star spacing, the height
ceilings and the cat's backdrop.

To try a different arrangement of buildings without touching the design file:

```bash
python3 skyline.py --layout my-layout.py --out /tmp/try
```

where `my-layout.py` defines `FAR`, `NEAR`, `CAT_X` and `CAT_ROOF` in the
shape `skyline.py` uses. The winning arrangement is copied back inline.

After a redraw, run the plugin's tests and build from the repo root:

```bash
npm test && npm run build
```

`tests/rooftopArt.test.ts` holds every plate to 128×128 and the set under a
byte budget (2 KB a plate, 24 KB together) — a truecolor export is roughly
four times the size and fails there rather than in a release.

## Editing by hand

The PNGs are indexed, so they open in Aseprite with the palette intact. Rules
that keep an edit shippable:

- Keep the size (128×128) and the palette. Add no colours.
- Keep `buildings.png` identical across every other layer's intent: the sky
  plates cross-fade and the windows switch on **over** it, so a window pane
  must still sit on a building pixel, and the far (slate) plane must stay
  where the near (ink) plane leaves it visible.
- Sky plates: same dot pattern on all eight (same dither matrix, anchored to
  the canvas), or a half-faded pair shows two patterns instead of one blend.
  Nothing pale above row 92 — the clock text sits there.
- Keep lit pixels out of the corner arcs (about 20 px radius) and 4 px in from
  the left and right edges.
- Export as indexed PNG, 100% scale, one file per layer, same names.

Then `npm test && npm run build`, and reload the plugin.

## Where the design came from

Six candidate skylines were generated with this toolkit and ranked by a judge
panel; the user merged two of them (Soft Dusk's buildings and cat, Lofi Cozy's
window grid and sky colours), then asked for the light bands moved below the
clock, more in-between plates for gentler change, and finally two planes of
buildings a little shorter — the arrangement chosen from four generated
layouts. Every step is a number in `skyline.py`.
