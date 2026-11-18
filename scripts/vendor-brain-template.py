# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "numpy==2.5.5",
#   "scipy==1.18.1",
#   "nibabel==5.5.0",
#   "scikit-image==0.26.0",
#   "fast-simplification==0.2.0",
# ]
# [tool.uv]
# exclude-newer = "2026-11-17T00:00:00Z"
# ///
"""Vendor a light MNI152NLin2009cAsym brain surface (card IS-T1, website ADR 0028 pattern).

    uv run scripts/vendor-brain-template.py                  write the committed folder
    uv run scripts/vendor-brain-template.py --out DIR        write somewhere else (empty, or holding only this script's files)
    uv run scripts/vendor-brain-template.py --known-answer   print the pinned format example

What it does. It downloads the TemplateFlow gray matter and white matter probability maps of the
MNI ICBM 2009c nonlinear asymmetric template and its LICENSE, refuses any file whose SHA-256 is not
the one written below, sums the two maps, takes the 0.5 isosurface (marching cubes at 1 mm), cuts it
at x = 0 into a left and a right hemisphere, keeps the largest connected piece of each, smooths it
(Taubin, 10 iterations), decimates it, and writes `brain-mesh v1` files (the format is documented at
the top of `src/lib/ieeg-spatial/mesh-format.ts`, which this script's writer must match byte for
byte). It also writes the three-view outlines the 2D view draws, the MNI notice, a `provenance.json`,
a `SHA256SUMS` and a README.

Continuous integration never runs this. `test/brain-template-vendor.test.ts` checks the committed
bytes against `SHA256SUMS` and that `provenance.json` names this file's own SHA-256, so editing the
script without rerunning it fails there. The same pins (this file, its versions, the download
hashes) give the same bytes on the same platform; another CPU architecture may differ in the last
floating-point bit of a vertex.

Downloaded files are untrusted data: they land in a fresh temporary directory, are parsed by
nibabel as data only, and are never executed. This script never changes into that directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from importlib import metadata
from pathlib import Path
from typing import NamedTuple

import nibabel as nib
import numpy as np
from fast_simplification import simplify
from scipy import sparse
from scipy.sparse import csgraph
from skimage import draw, measure

# The public TemplateFlow bucket. The address lives here and not in provenance.json on purpose:
# the leak check on that file allows only a short list of host names.
SOURCE_BASE = "https://templateflow.s3.amazonaws.com/tpl-MNI152NLin2009cAsym/"
TEMPLATE = "tpl-MNI152NLin2009cAsym"
REFERENCE_DOI = "10.1016/j.neuroimage.2010.07.033"
REFERENCE_CITATION = (
    "Fonov V, Evans AC, Botteron K, Almli CR, McKinstry RC, Collins DL, "
    "Brain Development Cooperative Group. Unbiased average age-appropriate atlases for "
    "pediatric studies. NeuroImage 54(1), 313-327 (2011)."
)

# name -> (bytes, sha256), recorded at the first download (2026-11-17) and checked on every run.
GM_FILE = f"{TEMPLATE}_res-01_label-GM_probseg.nii.gz"
WM_FILE = f"{TEMPLATE}_res-01_label-WM_probseg.nii.gz"
SOURCES = {
    "LICENSE": (682, "46e280fe1a24c6f37feef2445ed288435e0ad063504a06030b206b12fdd2629d"),
    GM_FILE: (7566494, "662b18e83dddc554b19c621d9750af3454b54d4e103df03633eacced3884805a"),
    WM_FILE: (6911720, "b2f80e29f5a1ef55325215d1716ef611f5b1a3cd97b4a49ef4e9564e9564e945"),
}
# The voxel-to-millimeter map both maps must carry (RAS, 1 mm, voxel centers on integers).
EXPECTED_SHAPE = (193, 229, 193)
EXPECTED_AFFINE = [[1, 0, 0, -96], [0, 1, 0, -132], [0, 0, 1, -78], [0, 0, 0, 1]]

NAME = "mni152nlin2009casym@1"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "public/vendor/brain-templates" / NAME
SCRIPT = "scripts/vendor-brain-template.py"
REGENERATE = f"uv run {SCRIPT}"

# Surface parameters.
LEVEL = 0.5
SMOOTH_ITERATIONS = 10
TAUBIN_LAMBDA = 0.5
TAUBIN_PASSBAND = 0.1
TAUBIN_MU = 1.0 / (TAUBIN_PASSBAND - 1.0 / TAUBIN_LAMBDA)  # about -0.5263
MAX_VERTICES = 15000
DECIMATION_START_FACES = 30000
OUTLINE_RESOLUTION_MM = 0.5
OUTLINE_TOLERANCE_MM = 0.4
OUTLINE_MIN_AREA_MM2 = 100.0
VIEWS_BUDGET_BYTES = 40 * 1024

# brain-mesh v1 constants (src/lib/ieeg-spatial/mesh-format.ts).
MAGIC = b"NMBM"
VERSION = 1
HEADER_BYTES = 40
Q_MAX = 32767

OUTPUT_FILES = {
    "lh.mesh.bin",
    "rh.mesh.bin",
    "views.json",
    "LICENSE.txt",
    "README.md",
    "provenance.json",
    "SHA256SUMS",
}

LICENSE_ADDENDUM = (
    "This folder holds a brain surface derived from the TemplateFlow template "
    f"{TEMPLATE} (its gray matter and white matter probability maps), built by "
    f"{SCRIPT}; the notice above applies to every copy of it."
)

README = f"""# Template brain surface, MNI152NLin2009cAsym, version 1

A light left and right hemisphere surface of the Montreal Neurological Institute (MNI) ICBM 2009c
nonlinear asymmetric template, for the intracranial electroencephalography (iEEG) spatial view.
The page fetches it from the same origin, only when a template frame is shown.

## Files

| File | What it is |
|---|---|
| `lh.mesh.bin`, `rh.mesh.bin` | Left and right hemisphere in `brain-mesh v1` (see `src/lib/ieeg-spatial/mesh-format.ts`), millimeters, right-anterior-superior (RAS), the template's own frame |
| `views.json` | Outline of the pair projected on the left, top and front planes, millimeters, for the 2D view |
| `LICENSE.txt` | The MNI copyright notice, verbatim, which must travel with every copy of the surface |
| `provenance.json` | Source files and their hashes, tool versions, parameters, and the hash of the script that built this folder |
| `SHA256SUMS` | `sha256sum -c` format, for every other file here |

## Source and reference

TemplateFlow, template `{TEMPLATE}`, the gray matter and white matter probability maps at 1 mm.
Reference: {REFERENCE_CITATION} doi:{REFERENCE_DOI}.
No FreeSurfer, RAVE, threeBrain or N27 asset is used.

## How it was made

The two probability maps are summed, the 0.5 isosurface is extracted at 1 mm, cut at x = 0 into
hemispheres, reduced to the largest connected piece of each, smoothed (Taubin, {SMOOTH_ITERATIONS} iterations) and
decimated to at most {MAX_VERTICES} vertices per hemisphere.
The hemispheres are open at the midline where the cut crosses tissue; nothing is capped.
The surface is a template brain, not any subject's anatomy.

## Rebuild

`{REGENERATE}` downloads the sources, checks them against the hashes written in the script, and
rewrites this folder.
Continuous integration never rebuilds it: `test/brain-template-vendor.test.ts` checks the committed
bytes against `SHA256SUMS`.
"""


class Mesh(NamedTuple):
    """Vertices (n, 3) in millimeters and triangles (m, 3), counter-clockwise from outside."""

    v: np.ndarray
    f: np.ndarray


class VendorError(Exception):
    """A condition the script refuses to continue past."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------------------------
# brain-mesh v1 writer (must match encodeBrainMesh in src/lib/ieeg-spatial/mesh-format.ts)
# ---------------------------------------------------------------------------------------------


def encode_brain_mesh(positions: np.ndarray, indices: np.ndarray) -> bytes:
    """Write a brain-mesh v1 file with 16-bit indices.

    The arithmetic mirrors the TypeScript encoder: positions are float32, the offset and scale are
    rounded to float32 first, and the quantizer rounds halves up (`floor(x + 0.5)`, JavaScript's
    `Math.round`), not to even.
    """
    pos = np.ascontiguousarray(positions, dtype=np.float32).reshape(-1, 3)
    idx = np.ascontiguousarray(indices, dtype=np.int64).reshape(-1)
    nv = len(pos)
    ni = len(idx)
    if ni % 3:
        raise VendorError("index count is not a multiple of three")
    if nv >= 1 << 16:
        raise VendorError(f"{nv} vertices do not fit 16-bit indices")
    if ni and (idx.min() < 0 or idx.max() >= nv):
        raise VendorError("an index points past the last vertex")
    if not np.isfinite(pos).all():
        raise VendorError("a coordinate is not finite")
    wide = pos.astype(np.float64)
    if nv:
        lo = wide.min(axis=0)
        hi = wide.max(axis=0)
        offset = ((lo + hi) / 2).astype(np.float32)
        scale = ((hi - lo) / (2 * Q_MAX)).astype(np.float32)
    else:
        offset = np.zeros(3, dtype=np.float32)
        scale = np.zeros(3, dtype=np.float32)
    off64 = offset.astype(np.float64)
    sc64 = scale.astype(np.float64)
    safe = np.where(sc64 > 0, sc64, 1.0)
    q = np.floor((wide - off64) / safe + 0.5)
    q = np.where(sc64 > 0, q, 0.0)
    q = np.clip(q, -Q_MAX, Q_MAX).astype("<i2")

    out = bytearray()
    out += MAGIC
    out += np.array([VERSION, 16], dtype="<u2").tobytes()
    out += np.array([nv, ni], dtype="<u4").tobytes()
    out += scale.astype("<f4").tobytes()
    out += offset.astype("<f4").tobytes()
    out += q.tobytes()
    out += idx.astype("<u2").tobytes()
    if len(out) != HEADER_BYTES + 6 * nv + 2 * ni:
        raise VendorError("brain-mesh writer produced the wrong size")
    return bytes(out)


# The format example the TypeScript test pins: five vertices whose coordinates are not exactly
# representable in float32, and four triangles.
KNOWN_ANSWER_POSITIONS = [
    [-12.3, 4.5, -7.25],
    [20.1, -33.7, 15.9],
    [0.0, 61.37, -2.5],
    [-45.6, -10.2, 38.8],
    [33.3, 12.0, 70.125],
]
KNOWN_ANSWER_INDICES = [[0, 1, 2], [1, 3, 2], [0, 2, 4], [2, 3, 4]]


def known_answer_hex() -> str:
    return encode_brain_mesh(
        np.array(KNOWN_ANSWER_POSITIONS, dtype=np.float32),
        np.array(KNOWN_ANSWER_INDICES),
    ).hex()


# ---------------------------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------------------------


def download(directory: Path) -> dict[str, Path]:
    """Fetch every source into `directory`, refusing a size or hash that is not the pinned one."""
    paths: dict[str, Path] = {}
    for name, (size, digest) in SOURCES.items():
        with urllib.request.urlopen(SOURCE_BASE + name, timeout=120) as response:
            data = response.read(size + 1)
        got = sha256_hex(data)
        if len(data) != size or got != digest:
            raise VendorError(
                f"{name}: expected {size} bytes with SHA-256 {digest}, got {len(data)} bytes "
                f"with SHA-256 {got}. Stop and report both values; do not update the pin."
            )
        target = directory / name
        target.write_bytes(data)
        paths[name] = target
    return paths


def check_license(text: str) -> None:
    """The source must carry the MNI notice and no other license text."""
    required = [
        "Copyright (C) 1993–2004 Louis Collins, McConnell Brain Imaging Centre",
        "Montreal Neurological Institute, McGill University",
        "provided that the above copyright notice appear in all copies",
    ]
    if any(phrase not in text for phrase in required):
        raise VendorError("the source LICENSE is not the MNI notice; stop and report it")
    for other in ("MIT License", "Apache", "Creative Commons", "GNU", "BSD", "CC0"):
        if other.lower() in text.lower():
            raise VendorError(f"the source LICENSE names {other}; stop and report it")


# ---------------------------------------------------------------------------------------------
# Surface
# ---------------------------------------------------------------------------------------------


def load_field(gm_path: Path, wm_path: Path) -> tuple[np.ndarray, np.ndarray]:
    images = [nib.load(str(p)) for p in (gm_path, wm_path)]
    for image in images:
        if tuple(image.shape) != EXPECTED_SHAPE:
            raise VendorError(f"unexpected volume shape {image.shape}")
        if not np.allclose(image.affine, EXPECTED_AFFINE):
            raise VendorError(f"unexpected affine {image.affine.tolist()}")
    field = sum(np.asarray(image.dataobj, dtype=np.float32) for image in images)
    return field.astype(np.float32), np.asarray(images[0].affine, dtype=np.float64)


def signed_volume(mesh: Mesh) -> float:
    """Positive when the triangles wind counter-clockwise seen from outside."""
    a, b, c = (mesh.v[mesh.f[:, k]] for k in range(3))
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def drop_degenerate(mesh: Mesh) -> Mesh:
    a, b, c = (mesh.v[mesh.f[:, k]] for k in range(3))
    area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    return Mesh(mesh.v, mesh.f[area2 > 1e-12])


def compact(mesh: Mesh) -> Mesh:
    """Drop vertices no face uses, keeping the old order of the rest."""
    used = np.unique(mesh.f)
    remap = np.full(len(mesh.v), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return Mesh(mesh.v[used], remap[mesh.f])


def whole_brain_surface(field: np.ndarray, affine: np.ndarray) -> Mesh:
    """Marching cubes at 1 mm, in template millimeters, faces counter-clockwise from outside."""
    padded = np.pad(field, 1)
    verts, faces, _normals, _values = measure.marching_cubes(padded, level=LEVEL)
    xyz = (verts.astype(np.float64) - 1.0) @ affine[:3, :3].T + affine[:3, 3]
    mesh = Mesh(xyz, faces.astype(np.int64))
    if signed_volume(mesh) < 0:  # inside out: flip the winding
        mesh = Mesh(xyz, mesh.f[:, ::-1].copy())
    if not signed_volume(mesh) > 0:
        raise VendorError("could not orient the whole-brain surface outward")
    return mesh


def largest_piece(mesh: Mesh) -> Mesh:
    n = len(mesh.v)
    f = mesh.f
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    graph = sparse.coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n))
    count, label = csgraph.connected_components(graph, directed=False)
    sizes = np.bincount(label[f[:, 0]], minlength=count)
    keep = label[f[:, 0]] == int(np.argmax(sizes))
    return compact(Mesh(mesh.v, f[keep]))


def clip_at_plane(mesh: Mesh, side: str) -> Mesh:
    """Keep the part of the surface with x <= 0 (left) or x >= 0 (right), cutting triangles that
    cross the plane. Cut points are shared per edge and lie exactly on x = 0. Nothing is capped."""
    sign = -1.0 if side == "left" else 1.0
    d = sign * mesh.v[:, 0]  # inside when d >= 0
    vertices = [row for row in mesh.v]
    cut_vertex: dict[tuple[int, int], int] = {}

    def crossing(p: int, q: int) -> int:
        """Index of the point on edge p-q where d is zero (p is inside, q outside)."""
        if d[p] == 0.0:
            return p
        key = (min(p, q), max(p, q))
        if key not in cut_vertex:
            t = d[p] / (d[p] - d[q])
            point = mesh.v[p] + t * (mesh.v[q] - mesh.v[p])
            point[0] = 0.0
            cut_vertex[key] = len(vertices)
            vertices.append(point)
        return cut_vertex[key]

    faces: list[list[int]] = []
    for tri in mesh.f:
        flags = d[tri] >= 0.0
        if flags.all():
            faces.append([int(i) for i in tri])
            continue
        if not flags.any():
            continue
        polygon: list[int] = []
        for k in range(3):
            p, q = int(tri[k]), int(tri[(k + 1) % 3])
            inside_p, inside_q = d[p] >= 0.0, d[q] >= 0.0
            if inside_p:
                polygon.append(p)
            if inside_p and not inside_q:
                polygon.append(crossing(p, q))
            elif inside_q and not inside_p:
                polygon.append(crossing(q, p))
        deduped = [i for k, i in enumerate(polygon) if i != polygon[k - 1]]
        for k in range(1, len(deduped) - 1):
            faces.append([deduped[0], deduped[k], deduped[k + 1]])
    return Mesh(np.array(vertices, dtype=np.float64), np.array(faces, dtype=np.int64))


def hemisphere(whole: Mesh, side: str) -> Mesh:
    """Cut at x = 0 and keep the largest connected piece. Left is x < 0 (RAS)."""
    return largest_piece(drop_degenerate(clip_at_plane(whole, side)))


def taubin_smooth(mesh: Mesh) -> Mesh:
    """Taubin lambda-mu smoothing. Vertices on the cut plane keep their x, so the cut stays flat."""
    n = len(mesh.v)
    f = mesh.f
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    adjacency = sparse.coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n))
    adjacency = ((adjacency + adjacency.T).tocsr() > 0).astype(np.float64)
    degree = np.asarray(adjacency.sum(axis=1)).ravel()
    walk = sparse.diags(1.0 / np.maximum(degree, 1.0)) @ adjacency
    v = mesh.v.copy()
    on_plane = v[:, 0] == 0.0
    for _ in range(SMOOTH_ITERATIONS):
        for step in (TAUBIN_LAMBDA, TAUBIN_MU):
            moved = v + step * (walk @ v - v)
            moved[on_plane, 0] = 0.0
            v = moved
    return Mesh(v, f)


def decimate(mesh: Mesh, side: str) -> Mesh:
    """Quadric decimation to the largest face target that gives at most MAX_VERTICES vertices."""
    target = DECIMATION_START_FACES
    while True:
        points, faces = simplify(mesh.v, mesh.f, target_count=target)
        simplified = Mesh(np.asarray(points, dtype=np.float64), np.asarray(faces, dtype=np.int64))
        out = compact(drop_degenerate(simplified))
        if len(out.v) <= MAX_VERTICES:
            break
        target = int(target * 0.98)
    # Decimation may place a border vertex a hair past the cut; put it back on its own side.
    v = out.v.copy()
    v[:, 0] = np.minimum(v[:, 0], 0.0) if side == "left" else np.maximum(v[:, 0], 0.0)
    return Mesh(v, out.f)


def build_hemispheres(field: np.ndarray, affine: np.ndarray) -> dict[str, Mesh]:
    whole = whole_brain_surface(field, affine)
    return {
        side: decimate(taubin_smooth(hemisphere(whole, side)), side) for side in ("left", "right")
    }


# ---------------------------------------------------------------------------------------------
# Three-view outlines
# ---------------------------------------------------------------------------------------------

VIEWS = {  # name: (horizontal axis, vertical axis) as indexes into x, y, z
    "left": (1, 2),
    "top": (0, 1),
    "front": (0, 2),
}
AXIS_NAMES = "xyz"


def outline(meshes: list[Mesh], axes: tuple[int, int]) -> list[list[list[float]]]:
    """Silhouette of the meshes on the plane of two axes: raster fill, contour, simplify."""
    a, b = axes
    pts = np.concatenate([m.v for m in meshes])[:, [a, b]]
    lo = np.floor(pts.min(axis=0)) - 2.0
    hi = np.ceil(pts.max(axis=0)) + 2.0
    res = OUTLINE_RESOLUTION_MM
    shape = tuple(int(np.ceil((hi[k] - lo[k]) / res)) + 1 for k in (0, 1))
    image = np.zeros(shape, dtype=np.float64)
    for m in meshes:
        tri = (m.v[m.f][:, :, [a, b]] - lo) / res
        for t in tri:
            rr, cc = draw.polygon(t[:, 0], t[:, 1], shape)
            image[rr, cc] = 1.0
    polylines: list[list[list[float]]] = []
    for contour in measure.find_contours(image, 0.5):
        simple = measure.approximate_polygon(contour, tolerance=OUTLINE_TOLERANCE_MM / res)
        if np.allclose(simple[0], simple[-1]):
            simple = simple[:-1]
        mm = simple * res + lo
        if len(mm) < 3:
            continue
        x, y = mm[:, 0], mm[:, 1]
        area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
        if area < OUTLINE_MIN_AREA_MM2:
            continue
        polylines.append([[round(float(p), 1), round(float(q), 1)] for p, q in mm])
    polylines.sort(key=lambda line: (-len(line), line[0]))
    return polylines


def views_json(meshes: list[Mesh]) -> bytes:
    views = {}
    for name, axes in VIEWS.items():
        lines = outline(meshes, axes)
        if not lines:
            raise VendorError(f"the {name} outline is empty")
        views[name] = {
            "axes": [AXIS_NAMES[axes[0]], AXIS_NAMES[axes[1]]],
            "polylines": lines,
        }
    doc = {
        "format": "brain-template-views v1",
        "frame": "MNI152NLin2009cAsym, RAS, millimeters",
        "note": (
            "Each polyline is a closed outline (the last point joins the first and is not "
            "repeated); coordinates are [horizontal, vertical] in the named axes, unflipped. A "
            "polyline inside another is a hole: fill all polylines together with the even-odd rule."
        ),
        "views": views,
    }
    data = (json.dumps(doc, separators=(",", ":"), sort_keys=True) + "\n").encode()
    if len(data) > VIEWS_BUDGET_BYTES:
        raise VendorError(f"views.json is {len(data)} bytes, over {VIEWS_BUDGET_BYTES}")
    return data


# ---------------------------------------------------------------------------------------------
# Folder
# ---------------------------------------------------------------------------------------------


def tool_versions() -> dict[str, str]:
    names = ["numpy", "scipy", "nibabel", "scikit-image", "fast-simplification"]
    versions = {name: metadata.version(name) for name in names}
    versions["python"] = ".".join(str(part) for part in sys.version_info[:3])
    return dict(sorted(versions.items()))


def build(out: Path) -> None:
    if out.exists():
        # Rewriting a folder this script made is fine; anything else in the way is not ours to delete.
        stray = sorted(entry.name for entry in out.iterdir() if entry.name not in OUTPUT_FILES)
        if stray:
            raise VendorError(f"{out} holds files this script did not write: {', '.join(stray)}")
        for entry in out.iterdir():
            entry.unlink()
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="brain-template-src-") as tmp:
        paths = download(Path(tmp))
        license_bytes = paths["LICENSE"].read_bytes()
        check_license(license_bytes.decode("utf-8"))
        field, affine = load_field(paths[GM_FILE], paths[WM_FILE])

    meshes = build_hemispheres(field, affine)
    files: dict[str, bytes] = {}
    stats: dict[str, dict[str, int]] = {}
    for side, filename in (("left", "lh.mesh.bin"), ("right", "rh.mesh.bin")):
        mesh = meshes[side]
        files[filename] = encode_brain_mesh(mesh.v, mesh.f)
        stats[filename] = {"vertices": len(mesh.v), "triangles": len(mesh.f)}
    files["views.json"] = views_json(list(meshes.values()))

    notice = license_bytes
    if not notice.endswith(b"\n"):
        notice += b"\n"
    files["LICENSE.txt"] = notice + b"\n" + LICENSE_ADDENDUM.encode() + b"\n"
    files["README.md"] = README.encode()

    provenance = {
        "name": NAME,
        "frame": "MNI152NLin2009cAsym, RAS, millimeters",
        "format": "brain-mesh v1 (src/lib/ieeg-spatial/mesh-format.ts), 16-bit indices",
        "template": {
            "archive": "TemplateFlow (https://templateflow.org)",
            "name": TEMPLATE,
            "referenceDoi": REFERENCE_DOI,
            "reference": REFERENCE_CITATION,
        },
        "sources": [
            {
                "path": f"{TEMPLATE}/{name}",
                "bytes": size,
                "sha256": digest,
                "role": "license" if name == "LICENSE" else "probability map",
            }
            for name, (size, digest) in SOURCES.items()
        ],
        "download": "the template archive's public object store; SOURCE_BASE in the script",
        "licenseSource": {
            "sha256": SOURCES["LICENSE"][1],
            "reproducedVerbatimIn": "LICENSE.txt, followed by one line naming this derived surface",
        },
        "script": {"path": SCRIPT, "sha256": sha256_hex(Path(__file__).read_bytes())},
        "regenerate": REGENERATE,
        "tools": tool_versions(),
        "parameters": {
            "field": "gray matter plus white matter probability, 1 mm",
            "isosurface": LEVEL,
            "cut": "x = 0 plane, surface cut and not capped; left is x < 0",
            "component": "largest connected piece per hemisphere",
            "smoothing": {
                "method": "Taubin",
                "iterations": SMOOTH_ITERATIONS,
                "lambda": TAUBIN_LAMBDA,
                "mu": TAUBIN_MU,
                "passband": TAUBIN_PASSBAND,
            },
            "decimation": {
                "method": "quadric edge collapse (fast-simplification)",
                "maxVerticesPerHemisphere": MAX_VERTICES,
                "startFaces": DECIMATION_START_FACES,
            },
            "outline": {
                "rasterMm": OUTLINE_RESOLUTION_MM,
                "toleranceMm": OUTLINE_TOLERANCE_MM,
                "minAreaMm2": OUTLINE_MIN_AREA_MM2,
            },
        },
        "outputs": stats,
    }
    files["provenance.json"] = (json.dumps(provenance, indent=2, sort_keys=True) + "\n").encode()

    for name, data in files.items():
        (out / name).write_bytes(data)
    sums = "".join(f"{sha256_hex(files[name])}  {name}\n" for name in sorted(files))
    (out / "SHA256SUMS").write_text(sums)

    total = sum(len(data) for data in files.values()) + len(sums)
    print(f"wrote {out} ({total} bytes in {len(files) + 1} files)")
    for filename, entry in stats.items():
        print(f"  {filename}: {entry['vertices']} vertices, {entry['triangles']} triangles")
    print(sums, end="")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="output directory, rewritten if it holds only this script's files",
    )
    parser.add_argument(
        "--known-answer", action="store_true", help="print the pinned brain-mesh v1 example"
    )
    args = parser.parse_args()
    if args.known_answer:
        print(known_answer_hex())
        return 0
    try:
        build(args.out)
    except VendorError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
