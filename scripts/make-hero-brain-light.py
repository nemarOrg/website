# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "numpy"]
# ///
"""Derive public/hero-brain-light.png from public/hero-brain.png.

hero-brain.png is built for a dark ground: its alpha is a constant 46/255 over
the whole brain silhouette, and the line work lives in the RGB brightness
(near-white lines, dark-teal gaps). The dark hero screen-blends it, so brightness
becomes glow. On a light ground that same image cannot be blended into ink:
inverting it and multiplying leaves at most ~7% ink (18% alpha at 40% opacity),
which is why the brain was nearly invisible in light mode.

This script reads the line work out of the brightness and writes it as the alpha
of a solid ink color, so lines become ink and gaps become transparent. The page
then uses it with normal blending (src/pages/index.astro, --hero-brain-image).

Run from the repo root:  uv run scripts/make-hero-brain-light.py
Options tune the look; the defaults are what ships.
"""

import argparse

import numpy as np
from PIL import Image


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="public/hero-brain.png")
    p.add_argument("--out", default="public/hero-brain-light.png")
    p.add_argument("--ink", default="1e4a8f", help="ink color, hex rgb")
    p.add_argument("--lo", type=float, default=60, help="brightness at or below this is a gap")
    p.add_argument("--hi", type=float, default=250, help="brightness at or above this is full line")
    p.add_argument("--gamma", type=float, default=1.6, help="above 1 favors the brightest lines")
    p.add_argument("--peak", type=float, default=0.95, help="alpha of the strongest line, 0..1")
    p.add_argument("--levels", type=int, default=64, help="distinct alpha steps (smaller file)")
    p.add_argument("--fill", type=float, default=0.0, help="alpha of the silhouette between lines, 0..1")
    args = p.parse_args()

    im = Image.open(args.src).convert("RGBA")
    px = np.asarray(im).astype(np.float64)
    rgb, alpha = px[..., :3], px[..., 3]
    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]

    inside = alpha > 0  # the brain silhouette; outside stays fully transparent
    t = np.clip((lum - args.lo) / (args.hi - args.lo), 0.0, 1.0) ** args.gamma
    out_alpha = np.where(inside, args.fill + (args.peak - args.fill) * t, 0.0)

    ink = tuple(int(args.ink[i : i + 2], 16) for i in (0, 2, 4))
    # One ink color, varying alpha: an indexed PNG whose palette is the ink at
    # every index and whose transparency table is the index itself. The same
    # picture as RGBA is about three times the size.
    levels = np.round(out_alpha * (args.levels - 1)).astype(np.uint8)
    out = Image.fromarray(levels, "P")
    out.putpalette(list(ink) * 256)
    table = bytes(round(i * 255 / (args.levels - 1)) if i < args.levels else 255 for i in range(256))
    out.save(args.out, optimize=True, transparency=table)
    print(f"wrote {args.out}: ink #{args.ink}, {args.levels} alpha levels, lines up to {table[levels.max()]}/255")


if __name__ == "__main__":
    main()
