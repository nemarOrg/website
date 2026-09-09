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

from pathlib import Path

import drawsvg as dw
from svg_primitives import Annotation, Arrow, Canvas, LabeledBox, Pill


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "figures"
FONT = ROOT / "src" / "assets" / "fonts" / "Inter.ttf"
LOGO = ROOT / "src" / "assets" / "nemar-logo.svg"

# The same palette is used by every figure. The dark ground gives the figures
# a shared technical-atlas feel while the accent colors preserve the semantics
# documented in .context/website-bible.md.
INK = "#06112A"
INK_SOFT = "#0B1A3A"
PANEL = "#10254A"
PANEL_ALT = "#163762"
WHITE = "#F5F7FB"
MUTED = "#A8BCD5"
TEAL = "#5BBAD5"
VIOLET = "#A78BFA"
GOLD = "#F4D06B"
GRID = "#214064"


def panel(*, x: float, y: float, text: str, stroke: str, width: float,
          height: float, fill: str = PANEL, font_size: float = 8.2,
          padding: float = 2.0) -> LabeledBox:
    return LabeledBox(
        x=x,
        y=y,
        text=text,
        min_width=width,
        min_height=height,
        fill=fill,
        stroke=stroke,
        stroke_width=0.65,
        rx=2.8,
        padding=padding,
        font_size=font_size,
        font_path=str(FONT),
        strict_metrics=True,
    )


def tag(*, x: float, y: float, text: str, stroke: str = TEAL,
        width: float = 42.0) -> Pill:
    return Pill(
        x=x,
        y=y,
        text=text,
        min_width=width,
        min_height=9.0,
        fill=INK_SOFT,
        stroke=stroke,
        stroke_width=0.65,
        padding=1.8,
        font_size=8.0,
        font_path=str(FONT),
        strict_metrics=True,
    )


def canvas(height: float = 112.0) -> Canvas:
    result = Canvas(width_mm=180, height_mm=height, background=INK)
    background = result.layer("background")
    background.add(
        dw.Raw(
            "<defs>"
            '<linearGradient id="nemar-surface" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{INK_SOFT}" />'
            f'<stop offset="1" stop-color="{INK}" />'
            "</linearGradient>"
            "</defs>"
        )
    )
    background.add(
        dw.Rectangle(
            4, 4, 172, height - 8, rx=6, ry=6,
            fill="url(#nemar-surface)", stroke=GRID, stroke_width=0.45,
        )
    )
    for y in (17, 42, 67, 92):
        background.add(dw.Line(7, y, 173, y, stroke=GRID, stroke_width=0.22, opacity=0.75))
    for x in (28, 58, 88, 118, 148):
        background.add(dw.Line(x, 8, x, height - 9, stroke=GRID, stroke_width=0.18, opacity=0.45))
    result.layer("connectors")
    result.layer("boxes")
    result.layer("labels")
    result.layer("brand")
    return result


def figure_title(result: Canvas, text: str) -> None:
    """Add the short standalone title shared by the SVG and PNG exports."""
    result.layer("labels").add(
        Annotation(
            x=7,
            y=13.5,
            text=text,
            font_size=9.2,
            text_anchor="start",
            fill=WHITE,
            font_path=str(FONT),
            strict_metrics=True,
        )
    )


def logo_lockup(result: Canvas, height: float = 112.0) -> None:
    """Embed the actual NEMAR mark and wordmark in the lower-right corner."""
    logo_svg = LOGO.read_text(encoding="utf-8")
    logo_svg = logo_svg.replace('var(--brand-accent, currentColor)', TEAL)
    logo_svg = logo_svg.replace('var(--brand-electrode, currentColor)', GOLD)
    logo_svg = logo_svg.replace("currentColor", WHITE)
    result.layer("brand").add(
        dw.Image(
            147, height - 11.0, 25.5, 5.35,
            data=logo_svg.encode("utf-8"),
            mime_type="image/svg+xml",
            preserveAspectRatio="xMaxYMid meet",
        )
    )


def system_map() -> Canvas:
    result = canvas()
    figure_title(result, "NEMAR platform architecture")

    people = tag(x=69, y=8, text="People + research agents", stroke=WHITE, width=43)
    cli = panel(x=7, y=30, text="nemar-cli\nrepeatable workflows", stroke=TEAL, width=42, height=22, font_size=8.4)
    web = panel(x=7, y=68, text="NEMAR web\nbrowser shell", stroke=VIOLET, width=42, height=22, font_size=8.4)
    core = panel(
        x=60, y=37, text="NEMAR platform\nshared contracts\nAPI · data · citation",
        stroke=WHITE, fill=PANEL_ALT, width=59, height=29, font_size=8.4,
    )
    api = panel(x=128, y=16, text="API\ncatalog + accounts", stroke=GOLD, width=45, height=19, font_size=8.2)
    data = panel(x=128, y=41, text="DATA\ncanonical BIDS view", stroke=TEAL, width=45, height=19, font_size=8.2)
    zarr = panel(x=128, y=66, text="ZARR\nchunked access", stroke=VIOLET, width=45, height=19, font_size=8.2)
    doi = panel(x=61, y=84, text="DOI record · versioned citation", stroke=GOLD, width=57, height=12, font_size=7.8, padding=1.6)

    connectors = result.layer("connectors")
    connectors.add(Arrow.connect(people, core, src_side="S", dst_side="N", stroke=MUTED, stroke_width=0.45))
    connectors.add(Arrow.connect(cli, core, src_side="E", dst_side="W", stroke=TEAL))
    connectors.add(Arrow.connect(web, core, src_side="E", dst_side="W", stroke=VIOLET))
    connectors.add(Arrow.connect(core, api, curve="cubic", bow=5, src_side="E", dst_side="W", stroke=GOLD))
    connectors.add(Arrow.connect(core, data, src_side="E", dst_side="W", stroke=TEAL))
    connectors.add(Arrow.connect(core, zarr, curve="cubic", bow=-5, src_side="E", dst_side="W", stroke=VIOLET))
    connectors.add(Arrow.connect(core, doi, src_side="S", dst_side="N", stroke=GOLD))

    boxes = result.layer("boxes")
    for item in (people, cli, web, core, api, data, zarr, doi):
        boxes.add(item)
    logo_lockup(result)
    return result


def lifecycle() -> Canvas:
    result = canvas()
    figure_title(result, "NEMAR dataset lifecycle")

    prepare = panel(x=6, y=35, text="01  Prepare\nBIDS + README", stroke=WHITE, width=31, height=23, font_size=8.4)
    validate = panel(x=41, y=35, text="02  Validate\nstructure + metadata", stroke=TEAL, width=32, height=23, font_size=8.0)
    publish = panel(x=77, y=35, text="03  Publish\nreview + DOI", stroke=GOLD, width=31, height=23, font_size=8.4)
    reuse = panel(x=112, y=35, text="04  Reuse\nsearch + compute", stroke=VIOLET, width=32, height=23, font_size=8.0)
    improve = panel(x=148, y=35, text="05  Improve\nPR → new version", stroke=TEAL, width=26, height=23, font_size=7.8)
    concept = panel(x=48, y=72, text="Concept DOI\nstable identity", stroke=GOLD, width=40, height=14, font_size=8.0, padding=1.5)
    version = panel(x=98, y=72, text="Version DOI\nexact manifest", stroke=GOLD, width=43, height=14, font_size=8.0, padding=1.5)
    # Match the rule bar to the DOI pair above: its left and right edges land
    # on the Concept DOI and Version DOI edges respectively.
    rule = panel(x=48, y=94, text="released state = fixed manifest + citable DOI", stroke=MUTED, width=93, height=9, font_size=7.6, padding=1.2)

    connectors = result.layer("connectors")
    for left, right, color in (
        (prepare, validate, WHITE),
        (validate, publish, TEAL),
        (publish, reuse, GOLD),
        (reuse, improve, VIOLET),
    ):
        connectors.add(Arrow.connect(left, right, src_side="E", dst_side="W", stroke=color, stroke_width=0.7))
    connectors.add(Arrow.connect(improve, validate, curve="cubic", src_side="N", dst_side="N", bow=18, stroke=VIOLET))
    connectors.add(Arrow.connect(publish, concept, src_side="S", dst_side="N", stroke=GOLD, stroke_width=0.55))
    connectors.add(Arrow.connect(publish, version, src_side="S", dst_side="N", stroke=GOLD, stroke_width=0.55))

    boxes = result.layer("boxes")
    for item in (prepare, validate, publish, reuse, improve, concept, version, rule):
        boxes.add(item)
    logo_lockup(result)
    return result


def edge_and_compute() -> Canvas:
    result = canvas()
    figure_title(result, "BIDS to Zarr: edge and browser analysis")
    background = result.layer("background")
    # Keep the current/derived boundary centered in the seven-millimetre gap
    # between the conversion and edge panels, rather than crowding the
    # conversion panel's right edge.
    background.add(dw.Line(86.5, 14, 86.5, 91, stroke=GOLD, stroke_width=0.35, opacity=0.5, stroke_dasharray="2,2"))

    source = panel(x=6, y=34, text="Canonical BIDS\nsource archive", stroke=WHITE, width=34, height=23, font_size=8.2)
    convert = panel(x=46, y=34, text="Zarr conversion\none store / recording", stroke=TEAL, width=37, height=23, font_size=8.0)
    edge = panel(x=90, y=34, text="Edge worker\nCORS + cache", stroke=TEAL, width=35, height=23, font_size=8.4)
    browser = panel(x=132, y=34, text="Browser analysis\nread needed chunks", stroke=VIOLET, width=40, height=23, font_size=8.0)
    note = panel(x=7, y=68, text="BIDS stays authoritative.\nZarr is a derived access layer.", stroke=MUTED, width=70, height=18, font_size=8.0)
    roadmap = panel(x=89, y=68, text="PLANNED NEMAR INTEGRATION\nTapis via OneSciencePlace · national HPC", stroke=GOLD, width=82, height=18, font_size=7.3)
    output = panel(x=89, y=94, text="Versioned derivative + DOI", stroke=GOLD, width=55, height=9, font_size=7.6, padding=1.2)

    connectors = result.layer("connectors")
    connectors.add(Arrow.connect(source, convert, stroke=WHITE))
    connectors.add(Arrow.connect(convert, edge, stroke=TEAL))
    connectors.add(Arrow.connect(edge, browser, stroke=VIOLET))
    connectors.add(Arrow.connect(edge, roadmap, curve="cubic", src_side="S", dst_side="N", bow=-4, stroke=GOLD))
    connectors.add(Arrow.connect(roadmap, output, src_side="S", dst_side="N", stroke=GOLD, stroke_width=0.55))

    boxes = result.layer("boxes")
    for item in (source, convert, edge, browser, note, roadmap, output):
        boxes.add(item)
    logo_lockup(result)
    return result


def save(result: Canvas, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    result.save(OUT / f"{name}.svg", output_png=False, validate="strict")


def main() -> None:
    save(system_map(), "nemar-system-map")
    save(lifecycle(), "nemar-dataset-lifecycle")
    save(edge_and_compute(), "nemar-edge-compute")
    print(f"Wrote SVG masters to {OUT}")


if __name__ == "__main__":
    main()
