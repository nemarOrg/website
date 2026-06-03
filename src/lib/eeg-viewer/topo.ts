/**
 * 2D scalp topomap (website#99, P2). Renders a channel-value field over the head
 * as a thin-plate-spline interpolation, the EEGLAB/MNE standard. Grounded in the
 * eegdash electrode-explorer (`eegdash/electrodes` topo2d.js + bids-loader.js) for
 * the projection, and the deep-research report for the interpolation.
 *
 * Pipeline (electrode positions -> screen):
 *   raw (x,y,z) [BIDS electrodes.tsv]
 *     -> axis-rotate to RAS+ (EEGLAB/ALS frames: (x,y,z) -> (-y, x, z))
 *     -> least-squares sphere fit -> unit-sphere (ux,uy,uz), +uy=nasion, +uz=vertex
 *     -> azimuthal-equidistant projection: r = acos(uz)/(pi/2), az = atan2(ux,uy)
 *        -> (r*sin az, -r*cos az) on the [-1,1] disc, nose at the top.
 *
 * The value field uses a thin-plate spline phi(r)=r^2 ln r with a small ridge for
 * stability; hidden/bad channels are simply dropped from the electrode set before
 * solving (the spline fills the gap from the surviving neighbours).
 *
 * The math (project/sphere-fit/tps/colormap) is pure and unit-tested; the
 * `renderTopomap` canvas pass is the integration.
 */

export type Vec3 = [number, number, number];
export type Pt2 = [number, number];

const ALS_SYSTEMS = new Set(["EEGLAB", "ALS", "CTF", "4D", "KIT"]);

/** Rotate a position into RAS+ (+X right, +Y anterior, +Z up). EEGLAB/ALS frames
 *  are (+X anterior, +Y left, +Z up), so (x,y,z) -> (-y, x, z); others pass through. */
export function alsToRas(system: string, p: Vec3): Vec3 {
  return ALS_SYSTEMS.has((system || "").toUpperCase()) ? [-p[1], p[0], p[2]] : [p[0], p[1], p[2]];
}

/** Solve A x = b (A is n-by-n, row-major arrays) by Gaussian elimination with
 *  partial pivoting. Returns x; a singular pivot is nudged to keep it finite. */
export function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12));
}

/** Least-squares sphere fit: center + radius from points roughly on a sphere. */
export function fitSphere(pts: Vec3[]): { center: Vec3; radius: number } {
  const AtA = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const Atf = [0, 0, 0, 0];
  for (const [x, y, z] of pts) {
    const row = [2 * x, 2 * y, 2 * z, 1];
    const f = x * x + y * y + z * z;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) AtA[i][j] += row[i] * row[j];
      Atf[i] += row[i] * f;
    }
  }
  const [a, b, c, d] = gaussSolve(AtA, Atf);
  return { center: [a, b, c], radius: Math.sqrt(Math.max(1e-9, d + a * a + b * b + c * c)) };
}

/** Outermost electrode is scaled to this radius, leaving a margin to the head edge
 *  (r=1) for the zero-boundary fade. So every electrode sits inside the scalp and
 *  is covered by the interpolated field, rather than clamped onto the rim. */
export const ELECTRODE_RAD = 0.9;

/** Azimuthal-equidistant projection of a unit-sphere point (RAS+) to the disc; nose
 *  (+uy) at the top, +x to the right. NOT clamped here -- below-equator points get
 *  r>1 and the whole cap is rescaled in projectPositions so they stay inside. */
export function projectUnit(ux: number, uy: number, uz: number): Pt2 {
  const uzC = Math.max(-1, Math.min(1, uz));
  const theta = Math.acos(uzC);
  const az = Math.atan2(ux, uy);
  const r = theta / (Math.PI / 2);
  return [r * Math.sin(az), -r * Math.cos(az)];
}

/** Project raw electrode positions to 2D disc coords keyed by label, scaled so the
 *  outermost electrode lands at ELECTRODE_RAD (inside the head circle). */
export function projectPositions(positions: Record<string, Vec3>, system: string): Map<string, Pt2> {
  const labels = Object.keys(positions);
  const ras = labels.map((l) => alsToRas(system, positions[l]));
  const { center } = fitSphere(ras);
  const raw: Pt2[] = labels.map((_, i) => {
    const dx = ras[i][0] - center[0];
    const dy = ras[i][1] - center[1];
    const dz = ras[i][2] - center[2];
    const dist = Math.hypot(dx, dy, dz) || 1;
    return projectUnit(dx / dist, dy / dist, dz / dist);
  });
  let maxR = 0;
  for (const [x, y] of raw) maxR = Math.max(maxR, Math.hypot(x, y));
  const scale = maxR > 0 ? ELECTRODE_RAD / maxR : 1;
  const out = new Map<string, Pt2>();
  labels.forEach((l, i) => out.set(l, [raw[i][0] * scale, raw[i][1] * scale]));
  return out;
}

// --- Thin-plate spline -------------------------------------------------------

const TPS_REG = 1e-5; // ridge on the kernel diagonal: tolerates near-duplicate sites

function tpsPhi(r: number): number {
  return r < 1e-10 ? 0 : r * r * Math.log(r);
}

export interface TpsModel {
  px: number[];
  py: number[];
  w: number[];
  c: [number, number, number];
}

/** Fit a thin-plate spline through (px,py,vals). null when fewer than 3 sites
 *  (the affine trend needs 3). */
export function solveTPS(px: number[], py: number[], vals: number[]): TpsModel | null {
  const N = px.length;
  if (N < 3) return null;
  const M = N + 3;
  const A = Array.from({ length: M }, () => new Array(M).fill(0));
  const b = new Array(M).fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) A[i][j] = tpsPhi(Math.hypot(px[i] - px[j], py[i] - py[j]));
    A[i][i] += TPS_REG;
    A[i][N] = 1;
    A[i][N + 1] = px[i];
    A[i][N + 2] = py[i];
    A[N][i] = 1;
    A[N + 1][i] = px[i];
    A[N + 2][i] = py[i];
    b[i] = vals[i];
  }
  const x = gaussSolve(A, b);
  return { px, py, w: x.slice(0, N), c: [x[N], x[N + 1], x[N + 2]] };
}

/** Evaluate the spline at (qx,qy). */
export function evalTPS(m: TpsModel, qx: number, qy: number): number {
  let v = m.c[0] + m.c[1] * qx + m.c[2] * qy;
  for (let i = 0; i < m.px.length; i++) v += m.w[i] * tpsPhi(Math.hypot(qx - m.px[i], qy - m.py[i]));
  return v;
}

// --- Colormap (viridis) -----------------------------------------------------
// Viridis: perceptually-uniform, colorblind-safe, public domain (from matplotlib).
// Decile stops; a signed input is mapped onto [0,1] so -max -> dark, +max -> yellow.

const VIRIDIS: Array<[number, [number, number, number]]> = [
  [0.0, [68, 1, 84]],
  [0.111, [72, 40, 120]],
  [0.222, [62, 74, 137]],
  [0.333, [49, 104, 142]],
  [0.444, [38, 130, 142]],
  [0.556, [31, 158, 137]],
  [0.667, [53, 183, 121]],
  [0.778, [110, 206, 88]],
  [0.889, [181, 222, 43]],
  [1.0, [253, 231, 37]],
];

/** CSS-gradient stops for a viridis colorbar (left = low). */
export const VIRIDIS_CSS = "#440154, #482878, #3e4a89, #31688e, #26828e, #1f9e89, #35b779, #6ece58, #b5de2b, #fde725";

/** Map a normalized signed value t in [-1,1] to a viridis color (t is rescaled to
 *  [0,1], so 0 lands at the perceptual middle). */
export function viridisColor(t: number): [number, number, number] {
  const u = (Math.max(-1, Math.min(1, t)) + 1) / 2;
  for (let i = 0; i < VIRIDIS.length - 1; i++) {
    const [t0, c0] = VIRIDIS[i];
    const [t1, c1] = VIRIDIS[i + 1];
    if (u <= t1) {
      const f = (u - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return VIRIDIS[VIRIDIS.length - 1][1];
}

// --- Canvas render -----------------------------------------------------------

export interface TopoChannel {
  label: string;
  pos: Pt2; // projected disc coords [-1,1]
  value: number;
}

const VB = 1.18; // viewbox half-extent (room for nose/ears past the r=1 head)

// Reused offscreen buffer for the interpolated grid (avoids per-frame allocation
// during live cursor updates). Created lazily on the client.
let _grid: HTMLCanvasElement | null = null;
function gridCanvas(g: number): HTMLCanvasElement {
  if (!_grid) _grid = document.createElement("canvas");
  if (_grid.width !== g) {
    _grid.width = g;
    _grid.height = g;
  }
  return _grid;
}

/** Render a topomap: TPS field clipped to the head circle, head outline, nose,
 *  ears, and electrode dots. `sizePx` is the CSS square size. Returns the value
 *  range used (symmetric +/-vmax) for an optional caller-drawn colorbar. */
export function renderTopomap(
  ctx: CanvasRenderingContext2D,
  sizePx: number,
  channels: TopoChannel[],
  colors: { foreground: string; grid: string; background: string },
): { vmax: number } {
  ctx.clearRect(0, 0, sizePx, sizePx);
  const cx = sizePx / 2;
  const cy = sizePx / 2;
  const rPx = sizePx / (2 * VB); // head radius in px

  if (channels.length < 3) {
    ctx.fillStyle = colors.grid;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("topomap needs ≥3 located channels", cx, cy);
    return { vmax: 0 };
  }

  let vmax = 0;
  for (const c of channels) vmax = Math.max(vmax, Math.abs(c.value));
  if (vmax <= 0) vmax = 1;

  // Anchor a ring of zero-value nodes at the head edge so the spline interpolates
  // the interior and fades to neutral at the rim, rather than extrapolating wildly
  // past the outer electrodes (which produced edge blobs). Standard topoplot trick.
  const px = channels.map((c) => c.pos[0]);
  const py = channels.map((c) => c.pos[1]);
  const vals = channels.map((c) => c.value);
  const BOUNDARY_N = 24;
  for (let k = 0; k < BOUNDARY_N; k++) {
    const a = (2 * Math.PI * k) / BOUNDARY_N;
    px.push(Math.cos(a));
    py.push(Math.sin(a));
    vals.push(0);
  }

  const model = solveTPS(px, py, vals);
  if (model) {
    // Interpolated field on a grid the size of the head box, masked to the circle.
    const g = Math.max(48, Math.min(120, Math.round(rPx)));
    const img = ctx.createImageData(g, g);
    for (let row = 0; row < g; row++) {
      for (let col = 0; col < g; col++) {
        const qx = (-1 + (2 * (col + 0.5)) / g) * VB;
        const qy = (-1 + (2 * (row + 0.5)) / g) * VB;
        const idx = (row * g + col) * 4;
        if (qx * qx + qy * qy > 1) {
          img.data[idx + 3] = 0; // outside the head -> transparent
          continue;
        }
        const [r, gg, b] = viridisColor(evalTPS(model, qx, qy) / vmax);
        img.data[idx] = r;
        img.data[idx + 1] = gg;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    // Blit the small grid scaled up over the head disc (clipped to the circle).
    const tmp = gridCanvas(g);
    const tctx = tmp.getContext("2d");
    if (tctx) {
      tctx.putImageData(img, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, cx - rPx, cy - rPx, rPx * 2, rPx * 2);
      ctx.restore();
    }
  }

  // Head outline + nose + ears (normalized coords scaled by rPx, centered at cx,cy).
  const X = (nx: number) => cx + nx * rPx;
  const Y = (ny: number) => cy + ny * rPx;
  ctx.strokeStyle = colors.foreground;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath(); // nose
  ctx.moveTo(X(-0.13), Y(-0.99));
  ctx.quadraticCurveTo(X(-0.05), Y(-1.09), X(0), Y(-1.13));
  ctx.quadraticCurveTo(X(0.05), Y(-1.09), X(0.13), Y(-0.99));
  ctx.stroke();
  for (const s of [-1, 1]) {
    ctx.beginPath(); // ear
    ctx.moveTo(X(s * 0.99), Y(-0.13));
    ctx.bezierCurveTo(X(s * 1.07), Y(-0.05), X(s * 1.07), Y(0.09), X(s * 1.04), Y(0.16));
    ctx.stroke();
  }

  // Electrode dots.
  ctx.fillStyle = colors.foreground;
  for (const ch of channels) {
    ctx.beginPath();
    ctx.arc(X(ch.pos[0]), Y(ch.pos[1]), Math.max(1.2, rPx * 0.018), 0, Math.PI * 2);
    ctx.fill();
  }
  return { vmax };
}
