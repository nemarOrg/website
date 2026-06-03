/**
 * Canvas 2D renderer for the signal viewer (website#99). Draws one rendered
 * `ViewerFrame` (already-dequantized, window-sized data produced by the store
 * reader) in the EEGLAB/MNE idiom: stacked traces, flush-left labels colored by
 * channel type, a time axis, event lines, and a µV scale bar.
 *
 * The renderer is intentionally dumb: no fetching, no DSP. It maps physical
 * values to pixels with the caller's gain (`physPerDiv`) and draws. A view-level
 * channel carries a min/max envelope (drawn as a filled band); a level-0 channel
 * carries a single line. Pure drawing keeps it cheap to re-render on pan/zoom and
 * testable layout math (see `traceLayout`).
 */

import { formatSi } from "./dsp";

export type FrameChannel =
  | { label: string; color: string; kind: "line"; line: Float32Array }
  | { label: string; color: string; kind: "band"; min: Float32Array; max: Float32Array };

export interface FrameEvent {
  onsetS: number;
  durationS: number;
  label: string;
  color: string;
}

export interface ViewerFrame {
  channels: FrameChannel[];
  /** Horizontal sample columns in this frame (~ plot width in CSS px). */
  nCols: number;
  windowStartS: number;
  windowEndS: number;
  events: FrameEvent[];
  /** SI value (V or T) that spans half a channel slot at gain 1 (scale-bar div). */
  physPerDiv: number;
  /** Dimension of the data: "V" (EEG/EMG/iEEG) or "T" (MEG). */
  unitBase: "V" | "T";
}

export interface RenderOptions {
  /** Device-independent CSS pixel size of the plot. */
  width: number;
  height: number;
  /** Left gutter for channel labels. */
  gutter: number;
  /** Bottom strip for the time axis. */
  axisHeight: number;
  /** Extra gain multiplier from the +/- controls (1 = default scalings). */
  gain: number;
  /** Clip a trace at this many slot-halves so a hot channel doesn't smear (MNE clipping). */
  clip: number;
  background: string;
  foreground: string;
  grid: string;
}

export const DEFAULT_RENDER: Omit<RenderOptions, "width" | "height"> = {
  gutter: 72,
  axisHeight: 22,
  gain: 1,
  clip: 1.5,
  background: "#ffffff",
  foreground: "#1a1a1a",
  grid: "#e6e6e6",
};

export interface TraceSlot {
  baseline: number;
  halfHeight: number;
}

/** Paint a centered status message (e.g. "Signal loading…") on the scope. */
export function renderMessage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  colors: { background: string; foreground: string },
  text: string,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = colors.foreground;
  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);
  ctx.restore();
}

/** Per-channel vertical slot geometry (exported for unit tests). */
export function traceLayout(
  channelCount: number,
  plotTop: number,
  plotHeight: number,
): TraceSlot[] {
  const slots: TraceSlot[] = [];
  if (channelCount <= 0) return slots;
  const slotHeight = plotHeight / channelCount;
  for (let i = 0; i < channelCount; i++) {
    slots.push({
      baseline: plotTop + slotHeight * (i + 0.5),
      halfHeight: slotHeight / 2,
    });
  }
  return slots;
}

/** Map a column index [0, nCols) to an x pixel within the plot area. */
function colToX(col: number, nCols: number, plotLeft: number, plotWidth: number): number {
  if (nCols <= 1) return plotLeft;
  return plotLeft + (col / (nCols - 1)) * plotWidth;
}

/** Map a time in seconds to an x pixel within the plot area. */
function timeToX(
  t: number,
  startS: number,
  endS: number,
  plotLeft: number,
  plotWidth: number,
): number {
  if (endS <= startS) return plotLeft;
  return plotLeft + ((t - startS) / (endS - startS)) * plotWidth;
}

/**
 * Render a frame onto a 2D context. The canvas is assumed to already be sized
 * and DPR-scaled by the caller (so we draw in CSS-pixel coordinates).
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  frame: ViewerFrame,
  opts: RenderOptions,
): void {
  const { width, height, gutter, axisHeight, clip } = opts;
  const g = opts.gain > 0 ? opts.gain : 1;
  const plotLeft = gutter;
  const plotTop = 4;
  const plotWidth = Math.max(1, width - gutter - 8);
  const plotHeight = Math.max(1, height - axisHeight - plotTop);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, width, height);

  const slots = traceLayout(frame.channels.length, plotTop, plotHeight);
  const pxPerPhys = slots.length > 0 ? slots[0].halfHeight / (frame.physPerDiv / g) : 0;

  // Slot dividers + flush-left labels.
  ctx.textBaseline = "middle";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    ctx.strokeStyle = opts.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(slot.baseline + slot.halfHeight) + 0.5);
    ctx.lineTo(plotLeft + plotWidth, Math.round(slot.baseline + slot.halfHeight) + 0.5);
    ctx.stroke();

    const ch = frame.channels[i];
    ctx.fillStyle = ch.color;
    ctx.textAlign = "left";
    ctx.fillText(ch.label.slice(0, 10), 6, slot.baseline);
  }

  // Event lines: a vertical line at each onset, colored by type, label at top.
  // A genuine annotation span (duration > 0) gets a thin top rule between
  // onset and end rather than a full-height wash (which read as noise); point
  // stimulus events (duration 0) are just the line.
  ctx.textAlign = "center";
  for (const ev of frame.events) {
    const x = timeToX(ev.onsetS, frame.windowStartS, frame.windowEndS, plotLeft, plotWidth);
    if (x < plotLeft - 1 || x > plotLeft + plotWidth + 1) continue;
    ctx.strokeStyle = ev.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, plotTop + 12);
    ctx.lineTo(Math.round(x) + 0.5, plotTop + plotHeight);
    ctx.stroke();
    if (ev.durationS > 0) {
      const x2 = timeToX(
        ev.onsetS + ev.durationS,
        frame.windowStartS,
        frame.windowEndS,
        plotLeft,
        plotWidth,
      );
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plotTop + 1);
      ctx.lineTo(Math.round(x2) + 0.5, plotTop + 1);
      ctx.stroke();
    }
    ctx.fillStyle = ev.color;
    ctx.fillText(ev.label.slice(0, 12), x, plotTop + 2);
  }

  // Traces.
  for (let i = 0; i < frame.channels.length; i++) {
    const ch = frame.channels[i];
    const slot = slots[i];
    const clipPx = slot.halfHeight * clip;
    const yOf = (v: number) => {
      const y = slot.baseline - v * pxPerPhys;
      const lo = slot.baseline - clipPx;
      const hi = slot.baseline + clipPx;
      return y < lo ? lo : y > hi ? hi : y;
    };

    ctx.strokeStyle = ch.color;
    ctx.lineWidth = 1;

    if (ch.kind === "band") {
      // Min/max decimation waveform: for each pixel-column draw the full
      // [min,max] vertical extent, connected across columns. This preserves the
      // inherent EEG texture that a centerline smooths away -- a calm channel
      // stays a thin squiggle, activity reads as dense texture -- without the
      // heavy look of a filled band.
      ctx.beginPath();
      for (let c = 0; c < frame.nCols; c++) {
        const x = colToX(c, frame.nCols, plotLeft, plotWidth);
        if (c === 0) ctx.moveTo(x, yOf(ch.max[c]));
        else ctx.lineTo(x, yOf(ch.max[c]));
        ctx.lineTo(x, yOf(ch.min[c]));
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      const n = ch.line.length;
      for (let c = 0; c < n; c++) {
        const x = colToX(c, n, plotLeft, plotWidth);
        const y = yOf(ch.line[c]);
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  drawTimeAxis(ctx, frame, opts, plotLeft, plotWidth, plotTop + plotHeight);
  drawScaleBar(ctx, frame, opts, plotLeft, plotTop, plotHeight, pxPerPhys);
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  frame: ViewerFrame,
  opts: RenderOptions,
  plotLeft: number,
  plotWidth: number,
  axisY: number,
): void {
  ctx.strokeStyle = opts.grid;
  ctx.fillStyle = opts.foreground;
  ctx.lineWidth = 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";

  const span = frame.windowEndS - frame.windowStartS;
  const step = niceTimeStep(span);
  const first = Math.ceil(frame.windowStartS / step) * step;
  for (let t = first; t <= frame.windowEndS + 1e-9; t += step) {
    const x = timeToX(t, frame.windowStartS, frame.windowEndS, plotLeft, plotWidth);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, axisY);
    ctx.lineTo(Math.round(x) + 0.5, axisY + 4);
    ctx.stroke();
    ctx.fillText(`${formatAxisTime(t)}s`, x, axisY + 6);
  }
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  frame: ViewerFrame,
  opts: RenderOptions,
  plotLeft: number,
  plotTop: number,
  plotHeight: number,
  pxPerPhys: number,
): void {
  // A vertical bar one "div" tall (physPerDiv/g) anchored lower-right.
  const g = opts.gain > 0 ? opts.gain : 1;
  const physDiv = frame.physPerDiv / g;
  const barPx = physDiv * pxPerPhys;
  if (!(barPx > 0) || !Number.isFinite(barPx)) return;
  const x = plotLeft + 12;
  const yBottom = plotTop + plotHeight - 8;
  const yTop = yBottom - barPx;
  ctx.strokeStyle = opts.foreground;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yBottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 3, yTop);
  ctx.lineTo(x + 3, yTop);
  ctx.moveTo(x - 3, yBottom);
  ctx.lineTo(x + 3, yBottom);
  ctx.stroke();

  ctx.fillStyle = opts.foreground;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(formatSi(physDiv, frame.unitBase), x + 8, (yTop + yBottom) / 2);
}

/** A "nice" axis tick step (s) for a given visible span. Exported for tests. */
export function niceTimeStep(spanSeconds: number): number {
  if (!(spanSeconds > 0)) return 1;
  const target = spanSeconds / 6; // aim for ~6 ticks
  const exp = Math.floor(Math.log10(target));
  const pow = 10 ** exp;
  const frac = target / pow;
  const nice = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return nice * pow;
}

function formatAxisTime(t: number): string {
  if (Math.abs(t) >= 100) return t.toFixed(0);
  if (Math.abs(t) >= 10) return t.toFixed(1);
  return t.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
