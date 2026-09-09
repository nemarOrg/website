"""Generate the NEMAR scientific SVG masters.

The layout is deliberately deterministic: the figures use the svg-primitives
tool for measured labels, edge-snapped arrows, and validation. Image-generation
outputs are not used as scientific evidence or as a source of labels.

Run with the figures plugin on PYTHONPATH:

  PYTHONPATH=/path/to/svg-primitives/scripts \
    uv run --with drawsvg --with svgpathtools --with Pillow --with fonttools \
    --with lxml python scripts/generate-nemar-figures.py
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import drawsvg as dw
from svg_primitives import Annotation, Arrow, Canvas, LabeledBox, Pill


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "figures"
FONT = ROOT / "src" / "assets" / "fonts" / "Inter.ttf"
LOGO = ROOT / "src" / "assets" / "nemar-logo.svg"

@dataclass(frozen=True)
class Palette:
    """Theme colors shared by every figure variant."""

    ink: str
    ink_soft: str
    panel: str
    panel_alt: str
    text: str
    muted: str
    teal: str
    violet: str
    gold: str
    grid: str


DARK = Palette(
    ink="#06112A",
    ink_soft="#0B1A3A",
    panel="#10254A",
    panel_alt="#163762",
    text="#F5F7FB",
    muted="#A8BCD5",
    teal="#5BBAD5",
    violet="#A78BFA",
    gold="#F4D06B",
    grid="#214064",
)

# The light variant is the default for detached PNGs and presentation slides.
# Accent values are darkened where necessary so the same semantic colors remain
# legible on paper rather than relying on a dark background for contrast.
LIGHT = Palette(
    ink="#F7F8FB",
    ink_soft="#FFFFFF",
    panel="#FFFFFF",
    panel_alt="#EEF1F6",
    text="#0F172A",
    muted="#475569",
    teal="#0E7490",
    violet="#603CBA",
    gold="#B8860B",
    grid="#CBD5E1",
)


def panel(*, x: float, y: float, text: str, stroke: str, width: float,
          height: float, palette: Palette, fill: str | None = None,
          font_size: float = 8.2, padding: float = 2.0) -> LabeledBox:
    return LabeledBox(
        x=x,
        y=y,
        text=text,
        min_width=width,
        min_height=height,
        fill=fill or palette.panel,
        stroke=stroke,
        stroke_width=0.65,
        rx=2.8,
        padding=padding,
        font_size=font_size,
        font_path=str(FONT),
        strict_metrics=True,
    )


def tag(*, x: float, y: float, text: str, palette: Palette,
        stroke: str | None = None, width: float = 42.0) -> Pill:
    return Pill(
        x=x,
        y=y,
        text=text,
        min_width=width,
        min_height=9.0,
        fill=palette.ink_soft,
        stroke=stroke or palette.teal,
        stroke_width=0.65,
        padding=1.8,
        font_size=8.0,
        font_path=str(FONT),
        strict_metrics=True,
    )


def canvas(palette: Palette, height: float = 112.0) -> Canvas:
    result = Canvas(width_mm=180, height_mm=height, background=palette.ink)
    background = result.layer("background")
    background.add(
        dw.Raw(
            "<defs>"
            '<linearGradient id="nemar-surface" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{palette.ink_soft}" />'
            f'<stop offset="1" stop-color="{palette.ink}" />'
            "</linearGradient>"
            "</defs>"
        )
    )
    background.add(
        dw.Rectangle(
            4, 4, 172, height - 8, rx=6, ry=6,
            fill="url(#nemar-surface)", stroke=palette.grid, stroke_width=0.45,
        )
    )
    for y in (17, 42, 67, 92):
        background.add(dw.Line(7, y, 173, y, stroke=palette.grid, stroke_width=0.22, opacity=0.75))
    for x in (28, 58, 88, 118, 148):
        background.add(dw.Line(x, 8, x, height - 9, stroke=palette.grid, stroke_width=0.18, opacity=0.45))
    result.layer("connectors")
    result.layer("boxes")
    result.layer("labels")
    result.layer("brand")
    return result


def figure_title(result: Canvas, text: str, palette: Palette) -> None:
    """Add the short standalone title shared by the SVG and PNG exports."""
    result.layer("labels").add(
        Annotation(
            x=7,
            y=13.5,
            text=text,
            font_size=9.2,
            text_anchor="start",
            fill=palette.text,
            font_path=str(FONT),
            strict_metrics=True,
        )
    )


def logo_lockup(result: Canvas, palette: Palette, height: float = 112.0) -> None:
    """Embed the actual NEMAR mark and wordmark in the lower-right corner."""
    logo_svg = LOGO.read_text(encoding="utf-8")
    logo_svg = logo_svg.replace('var(--brand-accent, currentColor)', palette.teal)
    logo_svg = logo_svg.replace('var(--brand-electrode, currentColor)', palette.gold)
    logo_svg = logo_svg.replace("currentColor", palette.text)
    result.layer("brand").add(
        dw.Image(
            147, height - 11.0, 25.5, 5.35,
            data=logo_svg.encode("utf-8"),
            mime_type="image/svg+xml",
            preserveAspectRatio="xMaxYMid meet",
        )
    )


def system_map(palette: Palette) -> Canvas:
    result = canvas(palette)
    figure_title(result, "NEMAR platform architecture", palette)

    people = tag(x=69, y=8, text="People + research agents", stroke=palette.text, width=43, palette=palette)
    cli = panel(x=7, y=30, text="nemar-cli\nrepeatable workflows", stroke=palette.teal, width=42, height=22, font_size=8.4, palette=palette)
    web = panel(x=7, y=68, text="NEMAR web\nbrowser shell", stroke=palette.violet, width=42, height=22, font_size=8.4, palette=palette)
    core = panel(
        x=60, y=37, text="NEMAR platform\nshared contracts\nAPI · data · citation",
        stroke=palette.text, fill=palette.panel_alt, width=59, height=29, font_size=8.4, palette=palette,
    )
    api = panel(x=128, y=16, text="api.nemar.org\ncatalog + accounts", stroke=palette.gold, width=45, height=19, font_size=7.6, palette=palette)
    data = panel(x=128, y=41, text="data.nemar.org\ncanonical BIDS view", stroke=palette.teal, width=45, height=19, font_size=7.6, palette=palette)
    zarr = panel(x=128, y=66, text="zarr.nemar.org\nderived chunk reads", stroke=palette.violet, width=45, height=19, font_size=7.6, palette=palette)
    doi = panel(x=61, y=84, text="DOI record · versioned citation", stroke=palette.gold, width=57, height=12, font_size=7.8, padding=1.6, palette=palette)

    connectors = result.layer("connectors")
    connectors.add(Arrow.connect(people, core, src_side="S", dst_side="N", stroke=palette.muted, stroke_width=0.45))
    connectors.add(Arrow.connect(cli, core, src_side="E", dst_side="W", stroke=palette.teal))
    connectors.add(Arrow.connect(web, core, src_side="E", dst_side="W", stroke=palette.violet))
    connectors.add(Arrow.connect(core, api, curve="cubic", bow=5, src_side="E", dst_side="W", stroke=palette.gold))
    connectors.add(Arrow.connect(core, data, src_side="E", dst_side="W", stroke=palette.teal))
    connectors.add(Arrow.connect(core, zarr, curve="cubic", bow=-5, src_side="E", dst_side="W", stroke=palette.violet))
    connectors.add(Arrow.connect(core, doi, src_side="S", dst_side="N", stroke=palette.gold))

    boxes = result.layer("boxes")
    for item in (people, cli, web, core, api, data, zarr, doi):
        boxes.add(item)
    logo_lockup(result, palette)
    return result


def lifecycle(palette: Palette) -> Canvas:
    result = canvas(palette)
    figure_title(result, "NEMAR dataset lifecycle", palette)

    prepare = panel(x=6, y=35, text="01  Prepare\nBIDS + README", stroke=palette.text, width=31, height=23, font_size=8.4, palette=palette)
    validate = panel(x=41, y=35, text="02  Validate\nstructure + metadata", stroke=palette.teal, width=32, height=23, font_size=8.0, palette=palette)
    publish = panel(x=77, y=35, text="03  Publish\nreview + DOI", stroke=palette.gold, width=31, height=23, font_size=8.4, palette=palette)
    reuse = panel(x=112, y=35, text="04  Reuse\nsearch + compute", stroke=palette.violet, width=32, height=23, font_size=8.0, palette=palette)
    improve = panel(x=148, y=35, text="05  Improve\nPR → new version", stroke=palette.teal, width=26, height=23, font_size=7.8, palette=palette)
    concept = panel(x=48, y=72, text="Concept DOI\nstable identity", stroke=palette.gold, width=40, height=14, font_size=8.0, padding=1.5, palette=palette)
    version = panel(x=98, y=72, text="Version DOI\nexact manifest", stroke=palette.gold, width=43, height=14, font_size=8.0, padding=1.5, palette=palette)
    # Match the rule bar to the DOI pair above: its left and right edges land
    # on the Concept DOI and Version DOI edges respectively.
    rule = panel(x=48, y=94, text="released state = fixed manifest + citable DOI", stroke=palette.muted, width=93, height=9, font_size=7.6, padding=1.2, palette=palette)

    connectors = result.layer("connectors")
    for left, right, color in (
        (prepare, validate, palette.text),
        (validate, publish, palette.teal),
        (publish, reuse, palette.gold),
        (reuse, improve, palette.violet),
    ):
        connectors.add(Arrow.connect(left, right, src_side="E", dst_side="W", stroke=color, stroke_width=0.7))
    connectors.add(Arrow.connect(improve, validate, curve="cubic", src_side="N", dst_side="N", bow=18, stroke=palette.violet))
    connectors.add(Arrow.connect(publish, concept, src_side="S", dst_side="N", stroke=palette.gold, stroke_width=0.55))
    connectors.add(Arrow.connect(publish, version, src_side="S", dst_side="N", stroke=palette.gold, stroke_width=0.55))

    boxes = result.layer("boxes")
    for item in (prepare, validate, publish, reuse, improve, concept, version, rule):
        boxes.add(item)
    logo_lockup(result, palette)
    return result


def edge_and_compute(palette: Palette) -> Canvas:
    result = canvas(palette)
    figure_title(result, "BIDS to Zarr: edge and browser analysis", palette)
    background = result.layer("background")
    # Keep the current/derived boundary centered in the seven-millimetre gap
    # between the conversion and edge panels, rather than crowding the
    # conversion panel's right edge.
    background.add(dw.Line(86.5, 14, 86.5, 91, stroke=palette.gold, stroke_width=0.35, opacity=0.5, stroke_dasharray="2,2"))

    source = panel(x=6, y=34, text="Canonical BIDS\nsource archive", stroke=palette.text, width=34, height=23, font_size=8.2, palette=palette)
    convert = panel(x=46, y=34, text="Zarr conversion\none store / recording", stroke=palette.teal, width=37, height=23, font_size=8.0, palette=palette)
    edge = panel(x=90, y=34, text="Edge worker\nCORS + cache", stroke=palette.teal, width=35, height=23, font_size=8.4, palette=palette)
    browser = panel(x=132, y=34, text="Browser analysis\nread needed chunks", stroke=palette.violet, width=40, height=23, font_size=8.0, palette=palette)
    note = panel(x=7, y=68, text="BIDS stays authoritative.\nZarr is a derived access layer.", stroke=palette.muted, width=70, height=18, font_size=8.0, palette=palette)
    roadmap = panel(x=89, y=68, text="PLANNED NEMAR INTEGRATION\nTapis via OneSciencePlace · national HPC", stroke=palette.gold, width=82, height=18, font_size=7.3, palette=palette)
    output = panel(x=89, y=94, text="Versioned derivative + DOI", stroke=palette.gold, width=55, height=9, font_size=7.6, padding=1.2, palette=palette)

    connectors = result.layer("connectors")
    connectors.add(Arrow.connect(source, convert, stroke=palette.text))
    connectors.add(Arrow.connect(convert, edge, stroke=palette.teal))
    connectors.add(Arrow.connect(edge, browser, stroke=palette.violet))
    connectors.add(Arrow.connect(edge, roadmap, curve="cubic", src_side="S", dst_side="N", bow=-4, stroke=palette.gold))
    connectors.add(Arrow.connect(roadmap, output, src_side="S", dst_side="N", stroke=palette.gold, stroke_width=0.55))

    boxes = result.layer("boxes")
    for item in (source, convert, edge, browser, note, roadmap, output):
        boxes.add(item)
    logo_lockup(result, palette)
    return result


def save(result: Canvas, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    result.save(OUT / f"{name}.svg", output_png=False, validate="strict")


def main() -> None:
    figures = (
        ("nemar-system-map", system_map),
        ("nemar-dataset-lifecycle", lifecycle),
        ("nemar-edge-compute", edge_and_compute),
    )
    for name, builder in figures:
        save(builder(LIGHT), name)
        save(builder(LIGHT), f"{name}-light")
        save(builder(DARK), f"{name}-dark")
    print(f"Wrote light and dark SVG masters to {OUT}")


if __name__ == "__main__":
    main()
