"""
skyline.py — generates the Rooftop Skyline theme's plates.

This is the artwork's source. The ten PNGs in plates/ are its output and are
what the plugin bundles; edit this file (or the PNGs in Aseprite) and re-run:

    cd art/rooftop && python3 skyline.py

The design is a merge the user chose from six generated candidates:
  buildings and cat   from "soft-dusk"  — eleven blocks with a 1px slate left
                                          edge, stepped towers, a sitting cat;
                                          then, per the user, "two-plane"'s
                                          navy far row behind them, and all
                                          of it a few rows shorter
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
MID_X0, MID_X1, MID_MIN_ROOF = 40, 88, 96  # the centre dip: roofs (both planes) no higher than this
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
# Buildings: TWO PLANES.
#   FAR   a lower, wider row in navy, drawn first. It shows in the gaps and
#         above the near row's shorter blocks, and reads as distance with
#         nothing more than a second shade.
#   NEAR  the ink row with a 1px slate left edge, drawn over it.
# Each plane is a list of blocks: x0/x1 inclusive columns, roof row, optional
# caps (x0, x1, top) stacked on the roof. Every block reaches the bottom edge.
# The shipped arrangement is "downtown behind", chosen by the user from four
# generated layouts: a modest near row (roofs 99..112 apart from the two
# towers) so the far plane shows almost everywhere — nine slate blocks, four
# of them at or near the 84 ceiling on the flanks, four low ones under the
# clock where the centre dip holds both planes at row 96 or below. One-pixel
# slits of sky separate the far blocks so they read as separate distant
# buildings rather than one stepped slab; the far row breaks around the cat
# so nothing but sky stands behind its sprite. Everything is lower than the
# first (single-plane) cut; MAX_ROOF below is the ceiling.
#
# A layout module can replace FAR, NEAR, CAT_X and CAT_ROOF (see --layout)
# for trying alternatives; the shipped layout is the one inline here.
# ---------------------------------------------------------------------------
FAR_SHADE = C["slate"]  # the far plane: lighter than ink, as distance is, and still darker than every sky band it meets
MAX_ROOF = 78  # no building pixel above this row (towers' caps included)
FAR_MAX_ROOF = 84  # the far plane stays lower than the towers

FAR = [
    dict(x0=0, x1=10, roof=90),  # rises out of the clipped corner, left of the tower
    dict(x0=16, x1=27, roof=86, caps=[(20, 24, 84)]),  # distant tower peeking past the near one
    dict(x0=29, x1=38, roof=88),
    dict(x0=41, x1=50, roof=97),  # ---- centre dip: far roofs at 96 or below ----
    dict(x0=52, x1=66, roof=100),
    dict(x0=68, x1=76, roof=96),
    dict(x0=78, x1=84, roof=100),  # ---- end dip; a row under the cat's roof, so no lip shows over it ----
    dict(x0=100, x1=106, roof=86, caps=[(102, 105, 84)]),  # tall again, right of the cat, a sky slit each side
    dict(x0=117, x1=127, roof=93),  # rises out of the clipped corner, right of the tower
]

NEAR = [
    dict(x0=0, x1=6, roof=105),  # low sliver at the clipped corner
    dict(x0=7, x1=18, roof=82, caps=[(9, 16, 80), (12, 13, 78)]),  # LEFT TOWER
    dict(x0=19, x1=29, roof=101),
    dict(x0=30, x1=39, roof=107),
    dict(x0=40, x1=52, roof=110, caps=[(43, 47, 108)]),  # ---- centre dip ----
    dict(x0=53, x1=68, roof=112),  # the lowest, widest block
    dict(x0=69, x1=84, roof=108, caps=[(78, 81, 106)]),  # ---- end dip ----
    dict(x0=85, x1=98, roof=99),  # the cat's roof
    dict(x0=99, x1=107, roof=104),
    dict(x0=108, x1=121, roof=84, caps=[(110, 119, 82), (113, 115, 79)]),  # RIGHT TOWER
    dict(x0=122, x1=127, roof=108),  # low sliver at the clipped corner
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
CAT_X = 89  # left column of the sprite
CAT_ROOF = 99  # the sprite's bottom row sits directly on this NEAR roof


def draw_block(c: Canvas, x0: int, x1: int, top: int, bottom: int, shade: int, edge: bool) -> None:
    """One solid rect, top..bottom inclusive, with an optional slate left edge.
    The canvas's own left edge (x0 == 0) never gets one: it is clipped."""
    c.rect(x0, top, x1 - x0 + 1, bottom - top + 1, shade)
    if edge and x0 > 0:
        c.vline(x0, top, bottom, EDGE)


def draw_plane(c: Canvas, blocks: list[dict], shade: int, edge: bool) -> None:
    for blk in blocks:
        draw_block(c, blk["x0"], blk["x1"], blk["roof"], H - 1, shade, edge)
        for cx0, cx1, ctop in blk.get("caps", []):
            draw_block(c, cx0, cx1, ctop, blk["roof"] - 1, shade, edge)


def buildings_layer() -> Canvas:
    c = Canvas(W, H)
    draw_plane(c, FAR, FAR_SHADE, edge=False)
    draw_plane(c, NEAR, INK, edge=True)
    oy = CAT_ROOF - len(CAT)
    for dy, row in enumerate(CAT):
        for dx, ch in enumerate(row):
            if ch == "#":
                c.px(CAT_X + dx, oy + dy, INK)
    return c


# ---------------------------------------------------------------------------
# Windows: 2x2 panes, 1px between columns, 2px between floors, the grid
# centred on each block. A pane is placed only where all four pixels are that
# plane's plain shade, so it keeps clear of the slate edge, the roof, and —
# on the far plane — anything the near plane covers; caps carry none.
# Near: ~55% of cells light, ~62% of those yellow, the rest the dimmer amber.
# Far: fewer lit and mostly amber, so distance reads in the light as well as
# in the shade. Same panes, same grid — the window STYLE is unchanged.
# Lit panes are shuffled and dealt round-robin into WINDOW_WAVES waves, so
# each wave is spread across the whole skyline.
# ---------------------------------------------------------------------------
PANE = 2
PITCH_X, PITCH_Y = 3, 4
WINDOW_BOTTOM = 124  # last row a pane may occupy
WINDOW_WAVES = 6
# (blocks, shade the pane must sit on, lit fraction, yellow fraction of lit)
PLANES = [
    ("near", NEAR, INK, 0.55, 0.62),
    ("far", FAR, FAR_SHADE, 0.45, 0.25),
]


def window_grid(x0: int, x1: int, roof: int) -> tuple[list[int], list[int]]:
    w = x1 - x0 + 1
    ncols = (w + PITCH_X - 4) // PITCH_X
    span = ncols * PITCH_X - (PITCH_X - PANE)
    off = (w - span) // 2
    cols = [x0 + off + i * PITCH_X for i in range(ncols)]
    floors = list(range(roof + 2, WINDOW_BOTTOM - PANE + 2, PITCH_Y))
    return cols, floors


def pane_fits(bld: Canvas, x: int, y: int, shade: int) -> bool:
    for dy in range(PANE):
        for dx in range(PANE):
            if bld.get(x + dx, y + dy) != shade:
                return False
            if not inside_clip(x + dx, y + dy):
                return False
            if not SAFE_X0 <= x + dx <= SAFE_X1:
                return False
    return True


def windows_layers(bld: Canvas, rng: random.Random) -> list[Canvas]:
    lit: list[tuple[int, int, int]] = []
    for _name, blocks, shade, lit_fraction, yellow_fraction in PLANES:
        for b in blocks:
            cols, floors = window_grid(b["x0"], b["x1"], b["roof"])
            for fy in floors:
                for cx in cols:
                    if not pane_fits(bld, cx, fy, shade):
                        continue
                    if rng.random() < lit_fraction:
                        lit.append((cx, fy, YELLOW if rng.random() < yellow_fraction else AMBER))
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
        roofs = [b["roof"] for b in NEAR + FAR if b["x0"] <= x <= b["x1"]]
        for y in range(H):
            if t.buildings.get(x, y) != T and roofs and y < min(roofs):
                out.append(f"detail inside the edge margin at ({x},{y})")
                break
    for y in range(0, MAX_ROOF):
        if any(t.buildings.get(x, y) != T for x in range(W)):
            out.append(f"a building reaches row {y}, above MAX_ROOF {MAX_ROOF}")
            break
    for b in FAR:
        top = min([b["roof"]] + [cap[2] for cap in b.get("caps", [])])
        if top < FAR_MAX_ROOF:
            out.append(f"far block at x{b['x0']} reaches row {top}, above FAR_MAX_ROOF {FAR_MAX_ROOF}")
    # the cat needs sky behind it, not the far plane
    oy = CAT_ROOF - len(CAT)
    for dy, row in enumerate(CAT):
        for dx, ch in enumerate(row):
            if ch == "." and t.buildings.get(CAT_X + dx, oy + dy) != T:
                out.append(f"something behind the cat at ({CAT_X + dx},{oy + dy})")
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


def load_layout(path: str) -> None:
    """Replace the planes and the cat's seat from a module that defines FAR, NEAR, CAT_X, CAT_ROOF."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("layout", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    globals().update({k: getattr(mod, k) for k in ("FAR", "NEAR", "CAT_X", "CAT_ROOF")})
    PLANES[0] = ("near", NEAR, INK, PLANES[0][3], PLANES[0][4])
    PLANES[1] = ("far", FAR, FAR_SHADE, PLANES[1][3], PLANES[1][4])


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--layout", help="a .py defining FAR, NEAR, CAT_X, CAT_ROOF (default: the inline layout)")
    ap.add_argument("--out", default=OUT, help="output directory (default: plates/)")
    args = ap.parse_args()
    if args.layout:
        load_layout(args.layout)
    rng = random.Random(SEED)
    bld = buildings_layer()
    t = ThemeLayers(sky_plates(), stars_layer(rng), bld, windows_layers(bld, rng))
    problems = t.validate() + brief_checks(t)
    t.save(args.out)
    preview = t.preview(args.out)
    print("validate:", problems)
    print("panes per wave:", [(w.w * w.h - w.count(T)) // 4 for w in t.windows])
    print("stars:", t.stars.w * t.stars.h - t.stars.count(T))
    print("preview:", preview)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
