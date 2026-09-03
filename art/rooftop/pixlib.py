"""
pixlib — the small, strict toolkit the Rooftop Skyline plates are generated with.

Every pixel is a palette index. Nothing in here can produce an off-palette
colour or an anti-aliased edge, which is the whole reason it exists: a general
image library will happily blend, and a blended pixel is what breaks pixel art.

Output is indexed PNG (mode "P") with one transparent slot, so the files open
in Aseprite with the palette intact and can be hand-edited afterwards.

Requires Pillow only (pip install pillow). Python 3.9+.
"""

from __future__ import annotations

import os
from typing import Iterable, Sequence

from PIL import Image

# --------------------------------------------------------------------------
# Palette: Endesga 32 (by Endesga; palettes are not copyrightable).
# Index order is the canonical Lospec order. Named aliases below.
# --------------------------------------------------------------------------
ENDESGA32: list[str] = [
    "#be4a2f", "#d77643", "#ead4aa", "#e4a672", "#b86f50", "#733e39", "#3e2731", "#a22633",
    "#e43b44", "#f77622", "#feae34", "#fee761", "#63c74d", "#3e8948", "#265c42", "#193c3e",
    "#124e89", "#0099db", "#2ce8f5", "#ffffff", "#c0cbdc", "#8b9bb4", "#5a6988", "#3a4466",
    "#262b44", "#181425", "#ff0044", "#68386c", "#b55088", "#f6757a", "#e8b796", "#c28569",
]

# Readable names for the indices the skyline actually uses.
C = {
    "rust": 0, "orange_brown": 1, "cream": 2, "sand": 3, "tan": 4, "brown": 5, "dark_brown": 6,
    "dark_red": 7, "red": 8, "orange": 9, "amber": 10, "yellow": 11, "green": 12,
    "dark_green": 13, "forest": 14, "teal_dark": 15, "blue_deep": 16, "blue": 17, "cyan": 18,
    "white": 19, "grey_light": 20, "grey": 21, "grey_blue": 22, "slate": 23, "navy": 24,
    "ink": 25, "hot_pink": 26, "plum": 27, "magenta": 28, "salmon": 29, "peach": 30,
    "clay": 31,
}

T = -1  # the transparent "index"
TRANSPARENT_SLOT = len(ENDESGA32)  # palette entry used for T when saving

# Suggested sky ramps, top -> horizon, one per plate, day -> night.
# Variants may use their own, but must stay inside ENDESGA32.
SKY_RAMPS: dict[str, list[int]] = {
    "day": [C["blue_deep"], C["blue"], C["cyan"]],
    "afternoon": [C["blue_deep"], C["blue"], C["grey_light"]],
    "dusk": [C["slate"], C["plum"], C["magenta"], C["salmon"], C["amber"]],
    "late_dusk": [C["ink"], C["navy"], C["plum"], C["magenta"]],
    "night": [C["ink"], C["navy"], C["slate"]],
}

# --------------------------------------------------------------------------
# The timeline every plate set is previewed on, and that the CSS implements.
# progress p runs 0 (day) -> 1 (night); breaks play it backwards.
#   sky      plate 1 is the base; plate k (2..n) rises over the (k-1)th of
#            n-1 equal spans of the session, on top of the one before
#   windows  wave j (1..m) eases on around its threshold, thresholds spaced
#            evenly from WINDOW_FIRST_AT to WINDOW_LAST_AT, each over
#            1/WINDOW_RAMP of the session (1% — a glow-up, not a snap)
#   stars    fade in across STARS_FADE
# The plate and wave counts are whatever the set provides; the formulas
# below and the rules in styles.css must agree for the counts shipped.
# --------------------------------------------------------------------------
WINDOW_FIRST_AT = 0.40
WINDOW_LAST_AT = 0.80
WINDOW_RAMP = 100
STARS_FADE = (0.65, 1.0)  # stars fade in across this range


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def sky_opacity(plate: int, p: float, n: int) -> float:
    """Opacity of sky plate `plate` (1-based, of n) at progress p. Plate 1 is the base."""
    if plate == 1:
        return 1.0
    return clamp01(p * (n - 1) - (plate - 2))


def window_at(wave: int, m: int) -> float:
    """The progress at which window wave `wave` (1-based, of m) starts to light."""
    if m == 1:
        return WINDOW_FIRST_AT
    return WINDOW_FIRST_AT + (wave - 1) * (WINDOW_LAST_AT - WINDOW_FIRST_AT) / (m - 1)


def window_opacity(wave: int, p: float, m: int) -> float:
    return clamp01((p - window_at(wave, m)) * WINDOW_RAMP)


def stars_opacity(p: float) -> float:
    a, b = STARS_FADE
    return clamp01((p - a) / (b - a))


# --------------------------------------------------------------------------
# Canvas
# --------------------------------------------------------------------------
class Canvas:
    def __init__(self, w: int = 128, h: int = 128, fill: int = T):
        self.w, self.h = w, h
        self.data = [fill] * (w * h)

    # --- pixels ---------------------------------------------------------
    def px(self, x: int, y: int, c: int) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            self.data[y * self.w + x] = c

    def get(self, x: int, y: int) -> int:
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.data[y * self.w + x]
        return T

    def rect(self, x: int, y: int, w: int, h: int, c: int) -> None:
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.px(xx, yy, c)

    def hline(self, x0: int, x1: int, y: int, c: int) -> None:
        for x in range(min(x0, x1), max(x0, x1) + 1):
            self.px(x, y, c)

    def vline(self, x: int, y0: int, y1: int, c: int) -> None:
        for y in range(min(y0, y1), max(y0, y1) + 1):
            self.px(x, y, c)

    def blit(self, other: "Canvas", ox: int = 0, oy: int = 0) -> None:
        """Paste `other` on top; its transparent pixels leave this canvas alone."""
        for y in range(other.h):
            for x in range(other.w):
                c = other.data[y * other.w + x]
                if c != T:
                    self.px(x + ox, y + oy, c)

    def copy(self) -> "Canvas":
        c = Canvas(self.w, self.h)
        c.data = list(self.data)
        return c

    def count(self, c: int) -> int:
        return sum(1 for v in self.data if v == c)

    def is_opaque(self) -> bool:
        return all(v != T for v in self.data)

    # --- files ----------------------------------------------------------
    def to_image(self, palette: Sequence[str] = ENDESGA32) -> Image.Image:
        img = Image.new("P", (self.w, self.h))
        flat: list[int] = []
        for hexv in palette:
            flat.extend(int(hexv[i : i + 2], 16) for i in (1, 3, 5))
        flat.extend((0, 0, 0))  # the transparent slot
        # No padding to 256 entries: Pillow writes a PLTE of exactly the
        # entries given, Aseprite opens a 33-entry palette intact, and the
        # padding was 60% of every plate's bytes — zeros shipped in main.js.
        img.putpalette(flat)
        img.putdata([TRANSPARENT_SLOT if v == T else v for v in self.data])
        img.info["transparency"] = TRANSPARENT_SLOT
        return img

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.to_image().save(path, optimize=True, transparency=TRANSPARENT_SLOT)

    def to_rgba(self, palette: Sequence[str] = ENDESGA32) -> Image.Image:
        img = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        out = []
        for v in self.data:
            if v == T:
                out.append((0, 0, 0, 0))
            else:
                h = palette[v]
                out.append((int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255))
        img.putdata(out)
        return img


def load(path: str, palette: Sequence[str] = ENDESGA32) -> Canvas:
    """Read a PNG back into palette indices (nearest colour; alpha < 128 = transparent)."""
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    rgb = [(int(p[1:3], 16), int(p[3:5], 16), int(p[5:7], 16)) for p in palette]
    c = Canvas(w, h)
    for i, (r, g, b, a) in enumerate(img.getdata()):
        if a < 128:
            c.data[i] = T
        else:
            c.data[i] = min(range(len(rgb)), key=lambda k: (rgb[k][0] - r) ** 2 + (rgb[k][1] - g) ** 2 + (rgb[k][2] - b) ** 2)
    return c


# --------------------------------------------------------------------------
# Dithering
# --------------------------------------------------------------------------
BAYER2 = [[0, 2], [3, 1]]
BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
BAYER8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]


def dither_gradient(
    canvas: Canvas,
    y0: int,
    y1: int,
    stops: Sequence[int],
    x0: int = 0,
    x1: int | None = None,
    matrix: Sequence[Sequence[int]] = BAYER4,
    bias: float = 0.0,
) -> None:
    """
    Vertical ordered-dither gradient from row y0 (top) to y1 (exclusive, bottom)
    through the palette indices in `stops`, in order. Pattern is anchored to
    canvas coordinates, so two plates dithered with the same matrix share the
    same dot positions and only differ in colour — which is what keeps a
    cross-fade between them clean.
    `bias` shifts the whole gradient up (negative) or down (positive), in stops.
    """
    if x1 is None:
        x1 = canvas.w
    m = len(matrix)
    n = len(stops) - 1
    span = max(1, y1 - y0 - 1)
    for y in range(y0, y1):
        f = (y - y0) / span * n + bias
        f = max(0.0, min(float(n), f))
        i = min(int(f), n - 1)
        frac = f - i
        row = matrix[y % m]
        for x in range(x0, x1):
            thr = (row[x % m] + 0.5) / (m * m)
            canvas.px(x, y, stops[i + 1] if frac > thr else stops[i])


# --------------------------------------------------------------------------
# Preview rendering (RGBA; for looking at, never for shipping)
# --------------------------------------------------------------------------
def render(layers: Iterable[tuple[Canvas, float]], bg: tuple[int, int, int] = (30, 30, 30)) -> Image.Image:
    """Alpha-composite (canvas, opacity) pairs bottom-up over a flat background."""
    base: Image.Image | None = None
    for canvas, opacity in layers:
        layer = canvas.to_rgba()
        if base is None:
            base = Image.new("RGBA", layer.size, (*bg, 255))
        if opacity <= 0:
            continue
        if opacity < 1:
            a = layer.getchannel("A").point(lambda v: int(v * opacity))
            layer.putalpha(a)
        base = Image.alpha_composite(base, layer)
    assert base is not None
    return base


def upscale(img: Image.Image, factor: int) -> Image.Image:
    return img.resize((img.width * factor, img.height * factor), Image.NEAREST)


def sheet(images: Sequence[Image.Image], gap: int = 8, bg: tuple[int, int, int] = (18, 18, 18)) -> Image.Image:
    w = sum(i.width for i in images) + gap * (len(images) + 1)
    h = max(i.height for i in images) + gap * 2
    out = Image.new("RGBA", (w, h), (*bg, 255))
    x = gap
    for i in images:
        out.alpha_composite(i.convert("RGBA"), (x, gap))
        x += i.width + gap
    return out


# --------------------------------------------------------------------------
# The theme's layer set
# --------------------------------------------------------------------------
class ThemeLayers:
    """
    Exactly what the plugin ships for this theme, in stacking order:
      sky[1..n]     opaque, cross-faded on progress
      stars         transparent, fades in late
      buildings     transparent, static (the only layer with the cat)
      windows[1..m] transparent, each eases on at its wave threshold
    """

    def __init__(self, sky: Sequence[Canvas], stars: Canvas, buildings: Canvas, windows: Sequence[Canvas]):
        assert len(sky) >= 2, "need at least two sky plates"
        assert len(windows) >= 1, "need at least one window wave"
        self.sky, self.stars, self.buildings, self.windows = list(sky), stars, buildings, list(windows)

    def validate(self) -> list[str]:
        problems = []
        for i, s in enumerate(self.sky, 1):
            if not s.is_opaque():
                problems.append(f"sky-{i} has transparent pixels")
        if self.buildings.is_opaque():
            problems.append("buildings layer is fully opaque (it must show the sky)")
        for i, w in enumerate(self.windows, 1):
            if w.count(T) == w.w * w.h:
                problems.append(f"windows-{i} is empty")
            # every lit window must sit on a building pixel
            for y in range(w.h):
                for x in range(w.w):
                    if w.get(x, y) != T and self.buildings.get(x, y) == T:
                        problems.append(f"windows-{i} has a pixel off the buildings at ({x},{y})")
                        break
                else:
                    continue
                break
        return problems

    def layers_at(self, p: float) -> list[tuple[Canvas, float]]:
        n, m = len(self.sky), len(self.windows)
        out: list[tuple[Canvas, float]] = [(s, sky_opacity(i, p, n)) for i, s in enumerate(self.sky, 1)]
        out.append((self.stars, stars_opacity(p)))
        out.append((self.buildings, 1.0))
        out.extend((w, window_opacity(i, p, m)) for i, w in enumerate(self.windows, 1))
        return out

    def save(self, outdir: str) -> None:
        for i, s in enumerate(self.sky, 1):
            s.save(os.path.join(outdir, f"sky-{i}.png"))
        self.stars.save(os.path.join(outdir, "stars.png"))
        self.buildings.save(os.path.join(outdir, "buildings.png"))
        for i, w in enumerate(self.windows, 1):
            w.save(os.path.join(outdir, f"windows-{i}.png"))

    def preview(self, outdir: str, steps: Sequence[float] = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)) -> str:
        """A strip of the timeline at 4x (craft) over a strip at 2x (about real retina size)."""
        frames = [render(self.layers_at(p)) for p in steps]
        big = sheet([upscale(f, 4) for f in frames])
        small = sheet([upscale(f, 2) for f in frames])
        out = Image.new("RGBA", (max(big.width, small.width), big.height + small.height), (18, 18, 18, 255))
        out.alpha_composite(big, (0, 0))
        out.alpha_composite(small, (0, big.height))
        path = os.path.join(outdir, "preview.png")
        os.makedirs(outdir, exist_ok=True)
        out.save(path)
        return path
