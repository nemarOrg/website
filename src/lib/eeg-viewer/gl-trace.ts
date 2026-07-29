/**
 * WebGL2 trace renderer for the signal viewer (website#99, P2). The Canvas 2D
 * path (`render.ts`) rebuilds and strokes one polyline per channel on every
 * pan/zoom/cursor-move; with 64 channels over a ~2000 px window that is hundreds
 * of thousands of `lineTo` segments per frame on the CPU. This module offloads
 * exactly that hot path to the GPU: it maps each channel's samples to pixel-space
 * vertices (identical math to `render.ts`) and draws them as 1 px `LINE_STRIP`s,
 * one draw call per channel, with the background as the GL clear color.
 *
 * The chrome (labels, dividers, event lines, axis, scale bar) stays on a 2D
 * overlay canvas (`renderChrome`) layered on top — GPU text/dashed-line drawing
 * is not worth the complexity, and the chrome is cheap. WebGL draws only the
 * data. When WebGL2 is unavailable, `createGlTraceRenderer` returns null and the
 * viewer falls back to the all-2D `renderFrame`.
 *
 * Line width is fixed at 1 px (WebGL `lineWidth > 1` is unsupported on most
 * drivers), which matches the 2D renderer's `lineWidth = 1` exactly, so the GL
 * and fallback paths look the same.
 */

import type { RenderOptions, ViewerFrame } from "./render";
import { traceLayout } from "./render";

/** A contiguous run of vertices in the shared buffer = one channel's polyline. */
export interface TraceRun {
  /** First vertex index (each vertex is an [x, y] pair). */
  offset: number;
  /** Number of vertices in this LINE_STRIP. */
  count: number;
  /** Stroke color, linear 0-1 RGB. */
  color: [number, number, number];
  /** Stroke alpha (carries the dim factor, matching the 2D globalAlpha). */
  alpha: number;
}

export interface TraceGeometry {
  /** Interleaved x,y vertices in CSS pixels (length = 2 * total vertices). */
  verts: Float32Array;
  /** One run per channel, in channel order. */
  runs: TraceRun[];
}

/** Parse "#rrggbb" to linear 0-1 RGB. Falls back to mid-grey on a bad string. */
export function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex === "string" && hex.length === 7 && hex[0] === "#") {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r / 255, g / 255, b / 255];
    }
  }
  return [0.5, 0.5, 0.5];
}

/** Map a column index [0, nCols) to an x pixel within the plot area. */
function colToX(col: number, nCols: number, plotLeft: number, plotWidth: number): number {
  if (nCols <= 1) return plotLeft;
  return plotLeft + (col / (nCols - 1)) * plotWidth;
}

/**
 * Build pixel-space vertices for every channel in a frame. This is the GPU twin
 * of `render.ts`'s `drawTrace` + the stacked/butterfly slot math; the mapping
 * (slot baseline, pxPerPhys, clip, colToX, band max/min zigzag) is kept identical
 * so the GL output is pixel-equivalent to the 2D fallback. Pure + exported for
 * unit tests (no GL context required).
 */
export function buildTraceVertices(frame: ViewerFrame, opts: RenderOptions): TraceGeometry {
  const { width, height, gutter, axisHeight, clip } = opts;
  const g = opts.gain > 0 ? opts.gain : 1;
  const plotLeft = gutter;
  const plotTop = 4;
  const plotWidth = Math.max(1, width - gutter - 8);
  const plotHeight = Math.max(1, height - axisHeight - plotTop);
  const channels = frame.channels;
  const n = channels.length;

  // First pass: total vertex count so we allocate the buffer once.
  let total = 0;
  for (const ch of channels) total += ch.kind === "band" ? frame.nCols * 2 : ch.line.length;
  const verts = new Float32Array(total * 2);
  const runs: TraceRun[] = [];
  if (n === 0) return { verts, runs };

  // Slot geometry: stacked = one slot per channel; butterfly = all share the
  // full-height center slot. pxPerPhys + clip match render.ts exactly.
  const butterfly = !!opts.butterfly;
  const slots = butterfly ? null : traceLayout(n, plotTop, plotHeight);
  const halfFull = plotHeight / 2;
  const baseFull = plotTop + halfFull;
  const pxPerPhysStacked =
    slots && slots.length > 0 ? slots[0].halfHeight / (frame.physPerDiv / g) : 0;
  const pxPerPhysButterfly = halfFull / (frame.physPerDiv / g);

  let v = 0; // running vertex index
  for (let i = 0; i < n; i++) {
    const ch = channels[i];
    const baseline = butterfly ? baseFull : (slots as ReturnType<typeof traceLayout>)[i].baseline;
    const halfHeight = butterfly
      ? halfFull
      : (slots as ReturnType<typeof traceLayout>)[i].halfHeight;
    const pxPerPhys = butterfly ? pxPerPhysButterfly : pxPerPhysStacked;
    const clipPx = halfHeight * clip;
    const lo = baseline - clipPx;
    const hi = baseline + clipPx;
    const yOf = (val: number): number => {
      const y = baseline - val * pxPerPhys;
      return y < lo ? lo : y > hi ? hi : y;
    };

    const offset = v;
    if (ch.kind === "band") {
      // Zigzag max[c] -> min[c] across columns (matches drawTrace's band path).
      // Clamp to the shortest array so a boundary-truncated band never reads
      // past its data and writes NaN vertices (the buffer is sized for the
      // nCols*2 upper bound, so a shorter run just leaves the tail unused).
      const nc = Math.min(frame.nCols, ch.max.length, ch.min.length);
      for (let c = 0; c < nc; c++) {
        const x = colToX(c, nc, plotLeft, plotWidth);
        verts[v * 2] = x;
        verts[v * 2 + 1] = yOf(ch.max[c]);
        v++;
        verts[v * 2] = x;
        verts[v * 2 + 1] = yOf(ch.min[c]);
        v++;
      }
    } else {
      const line = ch.line;
      const nc = line.length;
      for (let c = 0; c < nc; c++) {
        verts[v * 2] = colToX(c, nc, plotLeft, plotWidth);
        verts[v * 2 + 1] = yOf(line[c]);
        v++;
      }
    }
    runs.push({
      offset,
      count: v - offset,
      color: hexToRgb(ch.color),
      alpha: ch.dim ? (butterfly ? 0.15 : 0.3) : butterfly ? 0.75 : 1,
    });
  }
  return { verts, runs };
}

const VERT_SRC = `#version 300 es
in vec2 a_pos;          // CSS-pixel position
uniform vec2 u_res;     // CSS-pixel resolution (plot canvas size)
void main() {
  // pixel -> clip space, with y flipped (canvas y grows downward).
  vec2 ndc = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

export interface GlTraceRenderer {
  /** Resize the drawing buffer (device px) + GL viewport. */
  resize(pxW: number, pxH: number): void;
  /** Clear the canvas to `background` (used behind loading/error overlays so no
   *  stale frame lingers under the transparent 2D chrome). */
  clear(background: string): void;
  /**
   * Clear to `background` and draw every channel's trace. `cssW`/`cssH` are the
   * CSS-pixel plot size used for the pixel->clip mapping (the buffer is DPR-scaled
   * via the viewport, so vertices stay in CSS px just like the 2D renderer).
   */
  draw(frame: ViewerFrame, opts: RenderOptions, cssW: number, cssH: number): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("[eeg-viewer] GL shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Create a WebGL2 trace renderer for `canvas`, or null when WebGL2 / shader
 * compilation is unavailable (the caller then uses the 2D fallback). `antialias`
 * is requested so 1 px lines are smoothed like the 2D path; `alpha: true` lets
 * the chrome canvas above show nothing where we don't draw (we still clear to the
 * opaque background, so the data area is filled).
 */
export function createGlTraceRenderer(canvas: HTMLCanvasElement): GlTraceRenderer | null {
  const ctxGl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!ctxGl) return null;
  const gl: WebGL2RenderingContext = ctxGl; // non-null for the nested init()/draw() closures

  // GL objects are rebuilt by init(); they go null on a lost context and are
  // recreated on restore, so they must be mutable closure state, not consts.
  let prog: WebGLProgram | null = null;
  let buf: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let uRes: WebGLUniformLocation | null = null;
  let uColor: WebGLUniformLocation | null = null;
  let lost = false;

  // Build (or rebuild, after a context restore) the program + buffer + VAO. Every
  // failure path frees what it allocated and returns false, so a partial init
  // never leaks GL objects.
  function init(): boolean {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return false;
    }
    const p = gl.createProgram();
    if (!p) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn("[eeg-viewer] GL program link failed:", gl.getProgramInfoLog(p));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(p);
      return false;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const aPos = gl.getAttribLocation(p, "a_pos");
    const b = gl.createBuffer();
    const va = gl.createVertexArray();
    if (!b || !va || aPos < 0) {
      if (b) gl.deleteBuffer(b);
      if (va) gl.deleteVertexArray(va);
      gl.deleteProgram(p);
      return false;
    }
    gl.bindVertexArray(va);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    prog = p;
    buf = b;
    vao = va;
    uRes = gl.getUniformLocation(p, "u_res");
    uColor = gl.getUniformLocation(p, "u_color");
    return true;
  }

  if (!init()) return null;

  // A lost context turns every GL call into a no-op; preventDefault() lets the
  // browser fire `webglcontextrestored`, where we rebuild the (now-invalid) GL
  // objects. While lost, draw/resize skip work so we don't spin the CPU.
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    console.warn("[eeg-viewer] WebGL context lost");
  };
  const onRestored = (): void => {
    lost = !init();
    if (!lost) console.warn("[eeg-viewer] WebGL context restored");
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    resize(pxW: number, pxH: number): void {
      if (lost) return;
      // Reassigning width/height clears the buffer; only touch it (and the
      // viewport, which only depends on buffer size) on an actual size change.
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
        gl.viewport(0, 0, pxW, pxH);
      }
    },
    clear(background: string): void {
      if (lost) return;
      const [r, g, b] = hexToRgb(background);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(frame: ViewerFrame, opts: RenderOptions, cssW: number, cssH: number): void {
      if (lost || !prog || !buf || !vao) return;
      const [br, bg, bb] = hexToRgb(opts.background);
      gl.clearColor(br, bg, bb, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const { verts, runs } = buildTraceVertices(frame, opts);
      if (runs.length === 0) return;
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.uniform2f(uRes, cssW, cssH);
      for (const run of runs) {
        if (run.count < 2) continue;
        gl.uniform4f(uColor, run.color[0], run.color[1], run.color[2], run.alpha);
        gl.drawArrays(gl.LINE_STRIP, run.offset, run.count);
      }
      gl.bindVertexArray(null);
    },
    dispose(): void {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (buf) gl.deleteBuffer(buf);
      if (vao) gl.deleteVertexArray(vao);
      if (prog) gl.deleteProgram(prog);
      prog = buf = vao = null;
      // Deleting the GL objects above does not release the *context*. Each
      // viewer mount builds a fresh <canvas>, so without this the old context
      // survives until the browser happens to GC the detached canvas — and
      // browsers cap live WebGL contexts (~16 in Chrome), evicting the oldest
      // once the cap is hit. Twenty open/close cycles were measured creating
      // twenty contexts with four already force-lost, which a user can reach
      // just by skimming recordings on one dataset page. Losing the context
      // deterministically here keeps that bounded. The fallout is benign
      // either way (`createGlTraceRenderer` returning null drops to the 2D
      // canvas path), but silently degrading to CPU rendering mid-session is
      // exactly the kind of thing nobody would think to look for.
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
