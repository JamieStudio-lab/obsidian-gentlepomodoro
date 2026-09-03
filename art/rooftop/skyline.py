"""
skyline.py — generates the Rooftop Skyline theme's plates.

This is the artwork's source. The ten PNGs in plates/ are its output and are
what the plugin bundles; edit this file (or the PNGs in Aseprite) and re-run:

    cd art/rooftop && python3 skyline.py

The design is a merge the user chose from six generated candidates:
  buildings and cat   from "soft-dusk"  — eleven blocks with a 1px slate left
                                          edge, stepped towers, a sitting cat
  window grid         from "lofi-cozy"  — 2x2 panes on a 3px / 4px pitch, a
                                          yellow / amber mix, ~55% lit
  sky colours         from "lofi-cozy"  — flat mid blue behind the clock, a
                                          warm haze at the horizon, amber dusk
The sky uses soft-dusk's BAYER8 rendering, though, as row-keyed ramps whose
segments share one dot pattern, because lofi-cozy's two-segment BAYER4 skies
drew a hard dotted seam across the day plates. Same colours, no seam, and
every light band pushed below the clock text (see SKY_KEYS).

Layer set (see pixlib.ThemeLayers): sky-1..8 opaque, stars / buildings /
windows-1..6 transparent. Every pixel is an Endesga 32 index.
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pixlib import BAYER8, C, T, Canvas, ThemeLayers, dither_gradient  # noqa: E402

SEED = 20260903
W = H = 128
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plates")

# ---------------------------------------------------------------------------
# Rules from the brief, as numbers the checks below read.
# ---------------------------------------------------------------------------
BAND_TOP, BAND_BOTTOM = 24, 70  # clock rows: sky only (a few stars allowed)
SAFE_X0, SAFE_X1 = 4, 123  # detail stays inside these columns
MID_X0, MID_X1, MID_MIN_ROOF = 40, 88, 94  # the centre dip: roofs no higher than this
STAR_MAX_Y = 60
STAR_MIN_DIST = 4

# The square is clipped with the plugin's 35px squircle (--gp-radius-shape).
# At 128px on ~220px that is a corner arc of about 20 art pixels. Windows
# and stars keep clear of it so nothing lit is sliced in half by the corner.
CORNER_R = 21

INK = C["ink"]  # the silhouette
EDGE = C["slate"]  # the one secondary shade: a 1px lit edge on every block's left side
YELLOW = C["yellow"]
AMBER = C["amber"]


def inside_clip(x: int, y: int) -> bool:
    """True when pixel (x, y) survives the rounded-corner clip."""
    cx = CORNER_R - 1 if x < CORNER_R else W - CORNER_R if x >= W - CORNER_R else x
    cy = CORNER_R - 1 if y < CORNER_R else H - CORNER_R if y >= H - CORNER_R else y
    return (x - cx) ** 2 + (y - cy) ** 2 <= (CORNER_R - 1) ** 2


# ---------------------------------------------------------------------------
# Sky: eight plates, top -> horizon, as row-keyed colour ramps. Every segment
# between two keys is one BAYER8 dither, and the matrix is anchored to canvas
# coordinates, so segments and plates all share one dot pattern. Colours are
# lofi-cozy's five, with three designed in-betweens (late day, golden hour,
# twilight) added at the user's request so that no cross-fade has to bridge
# a large hue jump: an opacity blend of blue and magenta passes through a
# grey nothing chose, while a designed plate keeps the saturation.
#
# The rule that placed the keys: the white text runs to about row 90 (the
# clock digits end near row 80, the "Ends" line under them near 90), so no
# stop lighter than the mid tone may begin above row 92. The first cut had
# the cyan haze starting at row 77, straight behind the end-time line, and
# white on that cyan is nearly invisible.
# ---------------------------------------------------------------------------
SKY_KEYS = [
    # 1 day: deep at the very top, flat blue, a cyan haze in the dip
    [(0, C["blue_deep"]), (22, C["blue"]), (94, C["blue"]), (116, C["cyan"]), (128, C["cyan"])],
    # 2 late day: the haze goes pale
    [(0, C["blue_deep"]), (26, C["blue"]), (94, C["blue"]), (112, C["grey_light"]), (128, C["grey_light"])],
    # 3 afternoon: grey, then peach and sand at the horizon
    [(0, C["blue_deep"]), (22, C["blue"]), (92, C["blue"]), (106, C["grey_light"]), (118, C["peach"]), (128, C["sand"])],
    # 4 golden hour: the blue dusts over, salmon and orange low
    [(0, C["blue_deep"]), (28, C["grey_blue"]), (84, C["grey_blue"]), (100, C["salmon"]), (116, C["amber"]), (128, C["orange"])],
    # 5 dusk: slate -> plum -> magenta, salmon and amber on the horizon
    [(0, C["slate"]), (30, C["plum"]), (72, C["magenta"]), (104, C["salmon"]), (128, C["amber"])],
    # 6 late dusk: ink arriving at the top, the dusk colours lower, clay low
    [(0, C["ink"]), (28, C["navy"]), (66, C["plum"]), (102, C["magenta"]), (128, C["clay"])],
    # 7 twilight: navy, a last plum glow just above the roofs
    [(0, C["ink"]), (30, C["ink"]), (70, C["navy"]), (104, C["slate"]), (120, C["plum"]), (128, C["plum"])],
    # 8 night: ink / navy, a slate glow above the rooftops
    [(0, C["ink"]), (40, C["ink"]), (84, C["navy"]), (112, C["navy"]), (128, C["slate"])],
]


def keyed_gradient(c: Canvas, keys: list[tuple[int, int]]) -> None:
    """Dither between consecutive (row, colour) keys; the last key's row is exclusive."""
    for (y0, c0), (y1, c1) in zip(keys, keys[1:]):
        dither_gradient(c, y0, y1, [c0, c1], matrix=BAYER8)


def sky_plates() -> list[Canvas]:
    plates = []
    for keys in SKY_KEYS:
        c = Canvas(W, H)
        keyed_gradient(c, keys)
        plates.append(c)
    return plates


# ---------------------------------------------------------------------------
# Buildings: eleven blocks edge to edge, every one reaching the bottom edge.
# The two towers stand near the far edges; the middle third stays low so the
# sky opens up under the clock. Each block:
#   x0, x1   inclusive columns
#   roof     row of the roof line (the block fills roof..127)
#   caps     optional (x0, x1, top) boxes stacked on the roof: a stepped
#            tower crown or a stair head
# ---------------------------------------------------------------------------
BLOCKS = [
    dict(x0=0, x1=5, roof=98),  # low sliver at the clipped corner
    dict(x0=6, x1=17, roof=75, caps=[(8, 15, 73), (11, 12, 71)]),  # LEFT TOWER
    dict(x0=18, x1=29, roof=86, caps=[(24, 27, 84)]),
    dict(x0=30, x1=39, roof=92),
    dict(x0=40, x1=55, roof=98, caps=[(42, 46, 96)]),  # ---- centre dip ----
    dict(x0=56, x1=73, roof=104),  # the lowest, widest block
    dict(x0=74, x1=88, roof=97, caps=[(82, 85, 95)]),  # ---- end dip ----
    dict(x0=89, x1=103, roof=90),  # the cat's roof
    dict(x0=104, x1=111, roof=94),
    dict(x0=112, x1=123, roof=79, caps=[(114, 121, 77), (117, 118, 75)]),  # RIGHT TOWER
    dict(x0=124, x1=127, roof=100),  # low sliver at the clipped corner
]

# A sitting cat, side on, facing left, tail hooked up behind it. 8 x 8.
# Two 1px ears on the corners of a 4-wide head, a narrower neck, a body that
# fills out toward the roof, and a tail that rises one column clear of the
# back (a column of sky between them) and bends in at the tip.
CAT = [
    ".#..#...",
    ".####...",
    ".####...",
    "..###.##",
    "..####.#",
    "..####.#",
    "..####.#",
    "..######",
]
CAT_X = 92  # left column of the sprite
CAT_ROOF = 90  # the sprite's bottom row sits directly on this roof


def draw_block(c: Canvas, x0: int, x1: int, top: int, bottom: int) -> None:
    """One solid ink rect, top..bottom inclusive, with a slate left edge.
    The canvas's own left edge (x0 == 0) gets no highlight: it is clipped."""
    c.rect(x0, top, x1 - x0 + 1, bottom - top + 1, INK)
    if x0 > 0:
        c.vline(x0, top, bottom, EDGE)


def buildings_layer() -> Canvas:
    c = Canvas(W, H)
    for b in BLOCKS:
        draw_block(c, b["x0"], b["x1"], b["roof"], H - 1)
        for cx0, cx1, ctop in b.get("caps", []):
            draw_block(c, cx0, cx1, ctop, b["roof"] - 1)
    oy = CAT_ROOF - len(CAT)
    for dy, row in enumerate(CAT):
        for dx, ch in enumerate(row):
            if ch == "#":
                c.px(CAT_X + dx, oy + dy, INK)
    return c


# ---------------------------------------------------------------------------
# Windows: 2x2 panes, 1px between columns, 2px between floors, the grid
# centred on each block. A pane is placed only where all four pixels are plain
# ink, so it keeps clear of the slate edge and the roof; caps carry none.
# About 55% of cells light; of those ~62% yellow, the rest the dimmer amber,
# so the lit city glows unevenly. Lit panes are shuffled and dealt round-robin
# into WINDOW_WAVES waves, so each wave is spread across the whole skyline.
# ---------------------------------------------------------------------------
PANE = 2
PITCH_X, PITCH_Y = 3, 4
LIT_FRACTION = 0.55
YELLOW_FRACTION = 0.62
WINDOW_BOTTOM = 124  # last row a pane may occupy
WINDOW_WAVES = 6


def window_grid(x0: int, x1: int, roof: int) -> tuple[list[int], list[int]]:
    w = x1 - x0 + 1
    ncols = (w + PITCH_X - 4) // PITCH_X
    span = ncols * PITCH_X - (PITCH_X - PANE)
    off = (w - span) // 2
    cols = [x0 + off + i * PITCH_X for i in range(ncols)]
    floors = list(range(roof + 2, WINDOW_BOTTOM - PANE + 2, PITCH_Y))
    return cols, floors


def pane_fits(bld: Canvas, x: int, y: int) -> bool:
    for dy in range(PANE):
        for dx in range(PANE):
            if bld.get(x + dx, y + dy) != INK:
                return False
            if not inside_clip(x + dx, y + dy):
                return False
            if not SAFE_X0 <= x + dx <= SAFE_X1:
                return False
    return True


def windows_layers(bld: Canvas, rng: random.Random) -> list[Canvas]:
    lit: list[tuple[int, int, int]] = []
    for b in BLOCKS:
        cols, floors = window_grid(b["x0"], b["x1"], b["roof"])
        for fy in floors:
            for cx in cols:
                if not pane_fits(bld, cx, fy):
                    continue
                if rng.random() < LIT_FRACTION:
                    lit.append((cx, fy, YELLOW if rng.random() < YELLOW_FRACTION else AMBER))
    rng.shuffle(lit)
    waves = [Canvas(W, H) for _ in range(WINDOW_WAVES)]
    for i, (cx, fy, colour) in enumerate(lit):
        waves[i % WINDOW_WAVES].rect(cx, fy, PANE, PANE, colour)
    return waves


# ---------------------------------------------------------------------------
# Stars: sparse single pixels, most above the clock band, three inside it,
# none below y=60, none within 4px of another, all inside the safe columns
# and clear of the corner clip.
# ---------------------------------------------------------------------------
STARS_ABOVE_BAND = 17
STARS_IN_BAND = 3


def stars_layer(rng: random.Random) -> Canvas:
    c = Canvas(W, H)
    pts: list[tuple[int, int]] = []

    def scatter(ymin: int, ymax: int, n: int) -> None:
        tries = 0
        while n > 0 and tries < 10000:
            tries += 1
            x, y = rng.randint(SAFE_X0, SAFE_X1), rng.randint(ymin, ymax)
            if not inside_clip(x, y):
                continue
            if all((x - px) ** 2 + (y - py) ** 2 >= STAR_MIN_DIST**2 for px, py in pts):
                pts.append((x, y))
                n -= 1

    scatter(1, BAND_TOP - 2, STARS_ABOVE_BAND)
    scatter(BAND_TOP + 2, STAR_MAX_Y - 4, STARS_IN_BAND)
    for x, y in pts:
        c.px(x, y, C["white"] if rng.random() < 0.6 else C["grey_light"])
    return c


# ---------------------------------------------------------------------------
# Brief checks beyond validate(): the clock band, the dip, the margins, the
# star spacing, the corner clip. Printed with the validate() output; anything
# here is a bug in this file.
# ---------------------------------------------------------------------------
def brief_checks(t: ThemeLayers) -> list[str]:
    out = []
    for name, layer in [("buildings", t.buildings)] + [(f"windows-{i}", w) for i, w in enumerate(t.windows, 1)]:
        for y in range(BAND_TOP, BAND_BOTTOM + 1):
            if any(layer.get(x, y) != T for x in range(W)):
                out.append(f"{name} enters the clock band at row {y}")
                break
    for x in range(MID_X0, MID_X1 + 1):
        for y in range(0, MID_MIN_ROOF):
            if t.buildings.get(x, y) != T:
                out.append(f"centre dip broken at ({x},{y})")
                break
    for x in list(range(0, SAFE_X0)) + list(range(SAFE_X1 + 1, W)):
        for y in range(H):
            v = t.buildings.get(x, y)
            if v != T and y < min(b["roof"] for b in BLOCKS if b["x0"] <= x <= b["x1"]):
                out.append(f"detail inside the edge margin at ({x},{y})")
                break
    stars = [(x, y) for y in range(H) for x in range(W) if t.stars.get(x, y) != T]
    if not 12 <= len(stars) <= 30:
        out.append(f"{len(stars)} stars (want 12..30)")
    for i, (x, y) in enumerate(stars):
        if y > STAR_MAX_Y:
            out.append(f"star below y={STAR_MAX_Y} at ({x},{y})")
        for x2, y2 in stars[i + 1 :]:
            if (x - x2) ** 2 + (y - y2) ** 2 < STAR_MIN_DIST**2:
                out.append(f"stars too close: ({x},{y}) and ({x2},{y2})")
    for i, w in enumerate(t.windows, 1):
        for y in range(H):
            for x in range(W):
                if w.get(x, y) != T and not inside_clip(x, y):
                    out.append(f"windows-{i} pixel under the corner clip at ({x},{y})")
    counts = [w.w * w.h - w.count(T) for w in t.windows]
    if max(counts) - min(counts) > 8:
        out.append(f"window waves uneven: {counts}")
    return out


def main() -> int:
    rng = random.Random(SEED)
    bld = buildings_layer()
    t = ThemeLayers(sky_plates(), stars_layer(rng), bld, windows_layers(bld, rng))
    problems = t.validate() + brief_checks(t)
    t.save(OUT)
    preview = t.preview(OUT)
    print("validate:", problems)
    print("panes per wave:", [(w.w * w.h - w.count(T)) // 4 for w in t.windows])
    print("stars:", t.stars.w * t.stars.h - t.stars.count(T))
    print("preview:", preview)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
