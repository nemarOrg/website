/**
 * Signal-viewer orchestration (website#99). `mountEegViewer` builds a compact
 * "clinical oscilloscope" panel into a slot, opens the recording's Zarr store,
 * and drives the render loop: pick the pyramid level for the window, dequantize
 * only the visible channel rows, optional DC removal, overlay events, draw.
 *
 * Design intent (embeds inline under one recording in the BIDS tree):
 * - The scope has a FIXED height. Channels share it, so "show all" squeezes the
 *   montage rather than growing the box (stable embed boundary).
 * - Two zoom axes mirror MNE/EEGLAB: a time window (horizontal) with a time
 *   scrubber, and a channel zoom (vertical magnifier). The vertical scrollbar
 *   only appears once you zoom past the full montage into a portion — so the
 *   128-channel "see all" and "inspect a slice" use cases both work.
 * - The canvas reads the page design tokens, so it matches light/dark exactly.
 */
import { type Modality, channelColor, defaultScaling, formatClock, formatSi, removeBandDc, removeDcInPlace } from "./dsp";
import { type EventType, buildEventTypes, eventsInWindow } from "./events";
import { type FilterSpec, designFilters, filtfilt, hasFilters } from "./filters";
import {
  DEFAULT_RENDER,
  type FrameChannel,
  type ViewerFrame,
  renderFrame,
  renderMessage,
  traceLayout,
} from "./render";
import {
  type ChannelWindow,
  type GroupHandle,
  type RecordingStore,
  type WindowData,
  openRecording,
  readOverview,
  readWindow,
} from "./store";
import { zarrStoreUrl } from "../zarr-base";

export interface ViewerOptions {
  datasetId: string;
  version: string | null;
  filePath: string;
  /** Data-plane URL for the "download instead" fallback when no store exists. */
  downloadUrl?: string;
}

const WINDOW_CHOICES = [2, 5, 10, 20, 30];
const HP_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["0.1", "0.1"],
  ["0.5", "0.5"],
  ["1", "1"],
  ["2", "2"],
];
const LP_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["15", "15"],
  ["30", "30"],
  ["45", "45"],
  ["70", "70"],
];
const NOTCH_CHOICES: Array<[string, string]> = [
  ["0", "off"],
  ["50", "50"],
  ["60", "60"],
];
const ELECTRIC = new Set<Modality>(["EEG", "EMG", "IEEG", "MISC"]);
/** Scope height cap (CSS px). The height fits the embed (tracks width, capped by
 * this and the viewport) but never varies with channel count. */
const MAX_PLOT_HEIGHT = 540;
const MIN_VISIBLE_CHANNELS = 4;

export async function mountEegViewer(slot: HTMLElement, opts: ViewerOptions): Promise<void> {
  slot.innerHTML = `<div class="eegv"><p class="eegv__msg">Loading viewer…</p></div>`;
  const url = zarrStoreUrl(opts.datasetId, opts.filePath);

  let store: RecordingStore;
  try {
    store = await openRecording(url);
  } catch (err) {
    renderUnavailable(slot, opts, err);
    return;
  }
  if (store.groups.length === 0) {
    renderUnavailable(slot, opts, new Error("store has no channel groups"));
    return;
  }

  const eventTypes: EventType[] = store.events ? buildEventTypes(store.events) : [];

  // --- state ---------------------------------------------------------------
  let groupIndex = 0;
  let windowStartS = 0;
  let windowLengthS = 10;
  let gain = 1;
  let dcRemove = true;
  let showEvents = true;
  let chanStart = 0;
  let chanCount = store.groups[0].nChannels; // default: whole montage (overview)
  const filters: FilterSpec = { hp: null, lp: null, notch: null };
  let renderSeq = 0;
  let firstPaint = true;
  let timeClock = false;
  let butterfly = false;
  const badChannels = new Set<string>();

  // Cursor readout state: the last rendered frame and layout geometry.
  let lastFrame: ViewerFrame | null = null;
  let lastPlotLeft = DEFAULT_RENDER.gutter;
  let lastPlotTop = 4;
  let lastPlotWidth = 0;
  let lastPlotHeight = 0;

  // Overview minimap state (one coarse read, cached).
  let overviewData: Float32Array | null = null;
  let overviewLoaded = false;

  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup?.();
  slot.innerHTML = "";
  const ui = buildDom(slot, store, eventTypes);
  const cleanups: Array<() => void> = [];
  const maybeCtx = ui.canvas.getContext("2d");
  if (!maybeCtx) {
    renderUnavailable(slot, opts, new Error("canvas 2D unavailable"));
    return;
  }
  const ctx = maybeCtx; // non-null for the closures below

  function group(): GroupHandle {
    return store.groups[groupIndex];
  }

  function clamp(): void {
    const g = group();
    chanCount = Math.min(Math.max(MIN_VISIBLE_CHANNELS, chanCount), g.nChannels);
    chanStart = Math.max(0, Math.min(chanStart, g.nChannels - chanCount));
    windowStartS = Math.min(Math.max(0, windowStartS), Math.max(0, g.durationS - windowLengthS));
  }

  function sizeCanvas(): { w: number; h: number } {
    const rectW = ui.canvas.getBoundingClientRect().width || ui.root.getBoundingClientRect().width;
    const cssW = Math.max(320, Math.round(rectW) || 800);
    // Fit the area the preview opens into: height tracks width (a ~2:1 scope) and
    // is capped by MAX_PLOT_HEIGHT and 70% of the viewport, so it never overflows.
    // It does NOT vary with channel count (stable embed boundary).
    const vpCap = Math.round((globalThis.innerHeight || 900) * 0.7);
    const cssH = Math.max(280, Math.min(Math.round(cssW * 0.5), MAX_PLOT_HEIGHT, vpCap));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    ui.canvas.style.height = `${cssH}px`;
    ui.canvas.width = Math.round(cssW * dpr);
    ui.canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  function syncControls(): void {
    const g = group();
    ui.hscroll.min = "0";
    ui.hscroll.max = String(Math.max(0.001, g.durationS - windowLengthS));
    ui.hscroll.step = String(Math.max(0.01, windowLengthS / 50));
    ui.hscroll.value = String(windowStartS);
    const zoomed = g.nChannels > chanCount;
    ui.vscroll.min = "0";
    ui.vscroll.max = String(Math.max(0, g.nChannels - chanCount));
    ui.vscroll.step = "1";
    ui.vscroll.value = String(chanStart);
    ui.plot.classList.toggle("eegv__plot--scroll", zoomed);
  }

  // Read the window for rendering. With filters on we read level-0 (the actual
  // samples; filtering the min/max envelope would be wrong) for a slightly padded
  // span, apply the zero-phase filtfilt cascade, then crop the filter-transient
  // pad back off. If the window is too wide for level-0 the read falls back to the
  // pyramid band and filtering is skipped (the caller greys the indicator).
  async function readFrame(
    g: GroupHandle,
    start: number,
    end: number,
    plotWidth: number,
  ): Promise<{ win: WindowData; filtered: boolean }> {
    if (!hasFilters(filters)) {
      return { win: await readWindow(g, start, end, plotWidth, chanStart, chanCount, false), filtered: false };
    }
    const padS = Math.min(2, (end - start) * 0.5);
    const pStart = Math.max(0, start - padS);
    const pEnd = Math.min(g.durationS, end + padS);
    const w = await readWindow(g, pStart, pEnd, plotWidth, chanStart, chanCount, true);
    if (w.channels.length === 0 || w.channels[0].kind !== "line") return { win: w, filtered: false };
    const biquads = designFilters(filters, g.rate);
    const padCols = Math.round((start - pStart) * g.rate);
    const visCols = Math.max(1, Math.round((end - start) * g.rate));
    const channels: ChannelWindow[] = w.channels.map((cw) =>
      cw.kind === "line"
        ? { kind: "line", line: filtfilt(cw.line, biquads).subarray(padCols, padCols + visCols) }
        : cw,
    );
    return { win: { level: w.level, nCols: visCols, channels }, filtered: true };
  }

  async function render(): Promise<void> {
    const seq = ++renderSeq;
    clamp();
    const g = group();
    const { w, h } = sizeCanvas();
    syncControls();
    const plotWidth = Math.max(64, w - DEFAULT_RENDER.gutter - 8);
    const start = windowStartS;
    const end = Math.min(g.durationS, start + windowLengthS);
    const visEnd = Math.min(g.nChannels, chanStart + chanCount);

    // Store geometry for cursor readout.
    lastPlotLeft = DEFAULT_RENDER.gutter;
    lastPlotTop = 4;
    lastPlotWidth = plotWidth;
    lastPlotHeight = Math.max(1, h - DEFAULT_RENDER.axisHeight - lastPlotTop);

    if (timeClock) {
      ui.time.textContent = `${formatClock(start)}–${formatClock(end)}`;
    } else {
      ui.time.textContent = `${start.toFixed(1)}–${end.toFixed(1)} s`;
    }
    ui.chanInfo.textContent =
      visEnd - chanStart >= g.nChannels ? `all ${g.nChannels}` : `${chanStart + 1}–${visEnd}/${g.nChannels}`;

    // Paint a "loading" state immediately so the scope never sits blank while a
    // read (or its retries) is in flight; the first paint also covers the gap
    // before any frame exists. Subsequent scrolls keep the prior frame.
    if (firstPaint) renderMessage(ctx, w, h, themeColors(ui.root), "Signal loading…");
    ui.status.textContent = "Signal loading…";

    let win: WindowData;
    let filtered = false;
    try {
      ({ win, filtered } = await readFrame(g, start, end, plotWidth));
    } catch (err) {
      if (seq === renderSeq) {
        firstPaint = false;
        const msg = err instanceof Error ? err.message : String(err);
        renderMessage(ctx, w, h, themeColors(ui.root), `Signal unavailable: ${msg}`);
        ui.status.textContent = `signal unavailable: ${msg}`;
      }
      return;
    }
    if (seq !== renderSeq) return; // a newer render superseded this one
    firstPaint = false;

    const visible = g.channelsByRow.slice(chanStart, visEnd);
    const n = Math.min(visible.length, win.channels.length);
    const channels: FrameChannel[] = visible.slice(0, n).map((ch, i) => {
      const color =
        ch.channelType && ch.channelType !== "OTHER"
          ? channelColor(ch.channelType)
          : channelColor(ch.modality);
      const cw = win.channels[i];
      const dim = badChannels.has(ch.label);
      if (cw.kind === "line") {
        const line = dcRemove ? removeDcInPlace(cw.line.slice()) : cw.line;
        return { label: ch.label, color, kind: "line" as const, line, dim };
      }
      let { min, max } = cw;
      if (dcRemove) ({ min, max } = removeBandDc(min, max));
      return { label: ch.label, color, kind: "band" as const, min, max, dim };
    });

    const modality = (g.modality as Modality) ?? "MISC";
    const frame: ViewerFrame = {
      channels,
      nCols: win.nCols,
      windowStartS: start,
      windowEndS: end,
      events: showEvents && store.events ? eventsInWindow(store.events, eventTypes, start, end) : [],
      physPerDiv: defaultScaling(modality),
      unitBase: ELECTRIC.has(modality) ? "V" : "T",
      timeClock,
    };
    lastFrame = frame;
    renderFrame(ctx, frame, { ...DEFAULT_RENDER, ...themeColors(ui.root), width: w, height: h, gain, butterfly });

    const filterNote = hasFilters(filters) ? (filtered ? " · filtered" : " · filters need zoom-in") : "";
    ui.status.textContent =
      `${g.name} · ${g.nChannels} ch @ ${g.rate} Hz (orig ${g.originalRate}) · ` +
      `${g.durationS.toFixed(0)} s · level ${win.level === 0 ? "0 (full)" : `view/${win.level}`}${filterNote} · ` +
      `${eventTypes.length} event type(s)`;

    // Load and draw the overview minimap once.
    if (!overviewLoaded) {
      overviewLoaded = true;
      loadOverview(g);
    } else {
      drawOverview();
    }
  }

  // --- Overview minimap ----------------------------------------------------

  async function loadOverview(g: GroupHandle): Promise<void> {
    overviewData = await readOverview(g);
    if (overviewData && overviewData.length > 0) {
      ui.minimap.style.display = "block";
    } else {
      ui.minimap.style.display = "none";
    }
    drawOverview();
  }

  function drawOverview(): void {
    const canvas = ui.minimap;
    if (!overviewData || overviewData.length === 0) return;
    const g = group();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cssW = canvas.getBoundingClientRect().width || ui.root.getBoundingClientRect().width || 600;
    const cssH = 40;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const mctx = canvas.getContext("2d");
    if (!mctx) return;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = themeColors(ui.root);
    mctx.fillStyle = colors.background;
    mctx.fillRect(0, 0, cssW, cssH);

    // Normalize the activity envelope.
    const data = overviewData;
    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (maxVal <= 0) maxVal = 1;

    // Draw the activity bar chart.
    const colW = cssW / data.length;
    for (let i = 0; i < data.length; i++) {
      const frac = data[i] / maxVal;
      const barH = Math.max(1, Math.round(frac * (cssH - 12)));
      mctx.fillStyle = colors.grid;
      mctx.fillRect(i * colW, cssH - barH - 6, Math.max(1, colW - 0.5), barH);
    }

    // Event tick marks colored by type.
    if (store.events && eventTypes.length > 0) {
      const dur = g.durationS;
      for (let i = 0; i < store.events.onsetS.length; i++) {
        const t = store.events.onsetS[i];
        const x = (t / dur) * cssW;
        const code = store.events.code[i];
        const evType = eventTypes.find((et) => et.code === code);
        mctx.strokeStyle = evType?.color ?? "#888888";
        mctx.lineWidth = 1;
        mctx.beginPath();
        mctx.moveTo(Math.round(x) + 0.5, 0);
        mctx.lineTo(Math.round(x) + 0.5, 6);
        mctx.stroke();
      }
    }

    // Current window box.
    const dur = g.durationS || 1;
    const wStart = windowStartS;
    const wEnd = Math.min(dur, windowStartS + windowLengthS);
    const x1 = (wStart / dur) * cssW;
    const x2 = (wEnd / dur) * cssW;
    mctx.fillStyle = "rgba(0,114,178,0.18)";
    mctx.fillRect(x1, 0, x2 - x1, cssH);
    mctx.strokeStyle = "#0072B2";
    mctx.lineWidth = 1.5;
    mctx.strokeRect(x1, 0, x2 - x1, cssH);
  }

  // --- controls ------------------------------------------------------------
  const timeStep = () => windowLengthS * 0.2;
  const scroll = (dt: number) => {
    windowStartS += dt;
    render();
  };
  const scrollChan = (dc: number) => {
    chanStart += dc;
    render();
  };
  const zoomChan = (factor: number) => {
    const g = group();
    const center = chanStart + chanCount / 2;
    chanCount = Math.max(MIN_VISIBLE_CHANNELS, Math.min(g.nChannels, Math.round(chanCount * factor)));
    chanStart = Math.round(center - chanCount / 2);
    render();
  };
  ui.on("page-back", () => scroll(-windowLengthS));
  ui.on("step-back", () => scroll(-timeStep()));
  ui.on("step-fwd", () => scroll(timeStep()));
  ui.on("page-fwd", () => scroll(windowLengthS));
  ui.on("gain-up", () => {
    gain *= 1.5;
    render();
  });
  ui.on("gain-down", () => {
    gain /= 1.5;
    render();
  });
  ui.on("chan-zoom-in", () => zoomChan(0.5));
  ui.on("chan-zoom-out", () => zoomChan(2));
  ui.win.addEventListener("change", () => {
    windowLengthS = Number(ui.win.value) || 10;
    render();
  });
  ui.dc.addEventListener("change", () => {
    dcRemove = ui.dc.checked;
    render();
  });
  ui.events.addEventListener("change", () => {
    showEvents = ui.events.checked;
    render();
  });
  ui.butterflyCheck.addEventListener("change", () => {
    butterfly = ui.butterflyCheck.checked;
    render();
  });
  ui.clockCheck.addEventListener("change", () => {
    timeClock = ui.clockCheck.checked;
    render();
  });
  ui.hp.addEventListener("change", () => {
    filters.hp = Number(ui.hp.value) || null;
    render();
  });
  ui.lp.addEventListener("change", () => {
    filters.lp = Number(ui.lp.value) || null;
    render();
  });
  ui.notch.addEventListener("change", () => {
    filters.notch = Number(ui.notch.value) || null;
    render();
  });
  ui.hscroll.addEventListener("input", () => {
    windowStartS = Number(ui.hscroll.value);
    render();
  });
  ui.vscroll.addEventListener("input", () => {
    chanStart = Math.round(Number(ui.vscroll.value));
    render();
  });
  if (ui.groupSel) {
    ui.groupSel.addEventListener("change", () => {
      groupIndex = Number(ui.groupSel?.value) || 0;
      windowStartS = 0;
      chanStart = 0;
      chanCount = group().nChannels;
      overviewLoaded = false;
      overviewData = null;
      render();
    });
  }

  // Minimap click: set window start to clicked time (centered).
  ui.minimap.addEventListener("click", (e) => {
    const rect = ui.minimap.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const g = group();
    const targetCenter = frac * g.durationS;
    windowStartS = Math.max(0, targetCenter - windowLengthS / 2);
    render();
  });

  ui.canvas.addEventListener(
    "wheel",
    (e) => {
      // Vertical wheel scrolls the montage when zoomed; Shift+wheel scrolls time.
      if (e.shiftKey) scroll(Math.sign(e.deltaY) * timeStep());
      else if (group().nChannels > chanCount) {
        scrollChan(Math.sign(e.deltaY) * Math.max(1, Math.round(chanCount / 4)));
      } else return;
      e.preventDefault();
    },
    { passive: false },
  );

  // --- Bad-channel click in stacked mode (gutter label hit-test) -----------
  ui.canvas.addEventListener("click", (e) => {
    if (butterfly) return; // butterfly has no per-slot geometry
    if (!lastFrame || lastFrame.channels.length === 0) return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= lastPlotLeft) return; // only gutter (x < gutter)
    const slots = traceLayout(lastFrame.channels.length, lastPlotTop, lastPlotHeight);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const top = slot.baseline - slot.halfHeight;
      const bot = slot.baseline + slot.halfHeight;
      if (y >= top && y < bot) {
        const label = lastFrame.channels[i].label;
        if (badChannels.has(label)) badChannels.delete(label);
        else badChannels.add(label);
        render();
        break;
      }
    }
  });

  // --- Cursor readout (mousemove) -----------------------------------------
  ui.canvas.addEventListener("mousemove", (e) => {
    if (!lastFrame) return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < lastPlotLeft || x > lastPlotLeft + lastPlotWidth) {
      ui.cursor.textContent = "";
      return;
    }
    const frame = lastFrame;
    const span = frame.windowEndS - frame.windowStartS;
    const tAtX = frame.windowStartS + ((x - lastPlotLeft) / lastPlotWidth) * span;

    let chanLabel = "";
    let valueStr = "";
    if (!butterfly && frame.channels.length > 0) {
      const slots = traceLayout(frame.channels.length, lastPlotTop, lastPlotHeight);
      let hitIdx = -1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (y >= s.baseline - s.halfHeight && y < s.baseline + s.halfHeight) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        const ch = frame.channels[hitIdx];
        chanLabel = ch.label;
        const col = Math.round(((x - lastPlotLeft) / lastPlotWidth) * (frame.nCols - 1));
        const clamped = Math.max(0, Math.min(frame.nCols - 1, col));
        if (ch.kind === "line" && ch.line.length > 0) {
          valueStr = formatSi(ch.line[clamped] ?? 0, frame.unitBase);
        } else if (ch.kind === "band") {
          const mid = ((ch.min[clamped] ?? 0) + (ch.max[clamped] ?? 0)) / 2;
          valueStr = formatSi(mid, frame.unitBase);
        }
      }
    }

    const timeStr = timeClock ? formatClock(tAtX) : `${tAtX.toFixed(2)} s`;
    if (chanLabel) {
      ui.cursor.textContent = `${chanLabel} · ${timeStr} · ${valueStr}`;
    } else {
      ui.cursor.textContent = timeStr;
    }
  });

  ui.canvas.addEventListener("mouseleave", () => {
    ui.cursor.textContent = "";
  });

  // --- Help overlay toggle -------------------------------------------------
  let helpVisible = false;
  function toggleHelp(): void {
    helpVisible = !helpVisible;
    ui.helpOverlay.style.display = helpVisible ? "block" : "none";
  }

  ui.root.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight") scroll(e.shiftKey ? windowLengthS : windowLengthS / 4);
    else if (k === "ArrowLeft") scroll(e.shiftKey ? -windowLengthS : -windowLengthS / 4);
    else if (k === "ArrowDown") scrollChan(1);
    else if (k === "ArrowUp") scrollChan(-1);
    else if (k === "PageDown") scrollChan(chanCount);
    else if (k === "PageUp") scrollChan(-chanCount);
    else if (k === "Home") {
      // Step window length down (shorter window).
      const idx = WINDOW_CHOICES.indexOf(windowLengthS);
      if (idx > 0) {
        windowLengthS = WINDOW_CHOICES[idx - 1];
        ui.win.value = String(windowLengthS);
        render();
      }
    } else if (k === "End") {
      // Step window length up (longer window).
      const idx = WINDOW_CHOICES.indexOf(windowLengthS);
      if (idx >= 0 && idx < WINDOW_CHOICES.length - 1) {
        windowLengthS = WINDOW_CHOICES[idx + 1];
        ui.win.value = String(windowLengthS);
        render();
      }
    } else if (k === "+" || k === "=") {
      gain *= 1.5;
      render();
    } else if (k === "-") {
      gain /= 1.5;
      render();
    } else if (k === "d") {
      dcRemove = !dcRemove;
      ui.dc.checked = dcRemove;
      render();
    } else if (k === "b") {
      butterfly = !butterfly;
      ui.butterflyCheck.checked = butterfly;
      render();
    } else if (k === "t") {
      timeClock = !timeClock;
      ui.clockCheck.checked = timeClock;
      render();
    } else if (k === "?") {
      toggleHelp();
    } else return;
    e.preventDefault();
  });

  if (typeof ResizeObserver !== "undefined") {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => render());
    });
    ro.observe(ui.root);
    cleanups.push(() => ro.disconnect());
  }
  // Repaint when the site theme flips (the canvas reads CSS vars, so a light/dark
  // toggle on <html> must trigger a re-render to stay homogeneous).
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => render());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    cleanups.push(() => mo.disconnect());
  }
  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup = () => {
    for (const c of cleanups) c();
  };

  await render();
}

/**
 * Canvas paint colors pulled from the page's design tokens so the plot matches
 * light/dark and the surrounding UI exactly. Falls back to the renderer defaults
 * if a token is absent.
 */
function themeColors(root: HTMLElement): { background: string; foreground: string; grid: string } {
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--color-bg", "#ffffff"),
    foreground: v("--color-fg", "#1a1a1a"),
    grid: v("--color-border", "#e6e6e6"),
  };
}

// --- DOM scaffold ----------------------------------------------------------

interface ViewerUi {
  root: HTMLElement;
  plot: HTMLElement;
  canvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  time: HTMLElement;
  chanInfo: HTMLElement;
  cursor: HTMLElement;
  status: HTMLElement;
  win: HTMLSelectElement;
  dc: HTMLInputElement;
  events: HTMLInputElement;
  butterflyCheck: HTMLInputElement;
  clockCheck: HTMLInputElement;
  hp: HTMLSelectElement;
  lp: HTMLSelectElement;
  notch: HTMLSelectElement;
  hscroll: HTMLInputElement;
  vscroll: HTMLInputElement;
  groupSel: HTMLSelectElement | null;
  helpOverlay: HTMLElement;
  on(action: string, fn: () => void): void;
}

function navBtn(action: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "eegv__btn";
  b.dataset.act = action;
  b.textContent = label;
  b.title = title;
  return b;
}

function buildDom(slot: HTMLElement, store: RecordingStore, eventTypes: EventType[]): ViewerUi {
  const root = el("div", "eegv");
  root.tabIndex = 0;

  const bar = el("div", "eegv__toolbar");

  let groupSel: HTMLSelectElement | null = null;
  if (store.groups.length > 1) {
    groupSel = document.createElement("select");
    groupSel.className = "eegv__sel";
    store.groups.forEach((g, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = g.name;
      groupSel?.append(o);
    });
    bar.append(grouped("Group", groupSel));
  }

  // Time group.
  const time = el("span", "eegv__readout");
  const win = compactSelect(
    WINDOW_CHOICES.map((s) => [String(s), `${s} s`]),
    "10",
  );
  bar.append(
    grouped(
      "Time",
      navBtn("page-back", "«", "Page back"),
      navBtn("step-back", "‹", "Step back"),
      time,
      navBtn("step-fwd", "›", "Step forward"),
      navBtn("page-fwd", "»", "Page forward"),
      win,
    ),
  );

  // Amplitude group.
  bar.append(
    grouped("Scale", navBtn("gain-down", "−", "Scale down (less µV/div)"), navBtn("gain-up", "+", "Scale up")),
  );

  // Channel-zoom group (magnifier).
  const chanInfo = el("span", "eegv__readout");
  bar.append(
    grouped(
      "Channels",
      navBtn("chan-zoom-out", magnifierGlyph("-"), "Show more channels"),
      chanInfo,
      navBtn("chan-zoom-in", magnifierGlyph("+"), "Zoom into fewer channels"),
    ),
  );

  // Filter group (client-side zero-phase display filters).
  const hp = compactSelect(HP_CHOICES, "0");
  const lp = compactSelect(LP_CHOICES, "0");
  const notch = compactSelect(NOTCH_CHOICES, "0");
  bar.append(
    grouped("Filter (Hz)", fieldLabel("HP", hp), fieldLabel("LP", lp), fieldLabel("Notch", notch)),
  );

  // Display toggles.
  const dc = labeledCheck("DC", true);
  const events = labeledCheck("Events", true);
  const butterflyLc = labeledCheck("Butterfly", false);
  const clockLc = labeledCheck("Clock", false);
  bar.append(grouped("Display", dc.wrap, events.wrap, butterflyLc.wrap, clockLc.wrap));

  // Cursor readout (below toolbar, above scope).
  const cursor = el("div", "eegv__cursor");
  cursor.setAttribute("aria-live", "polite");

  // Help overlay (absolutely positioned inside the eegv root).
  const helpOverlay = el("div", "eegv__help");
  helpOverlay.style.display = "none";
  helpOverlay.innerHTML = `
    <div class="eegv__help-inner">
      <strong>Keyboard shortcuts</strong>
      <ul>
        <li><kbd>←</kbd> / <kbd>→</kbd> &mdash; scroll time (small step)</li>
        <li><kbd>Shift+←</kbd> / <kbd>Shift+→</kbd> &mdash; scroll time (page)</li>
        <li><kbd>↑</kbd> / <kbd>↓</kbd> &mdash; scroll channels</li>
        <li><kbd>+</kbd> / <kbd>-</kbd> &mdash; scale up / down</li>
        <li><kbd>Home</kbd> / <kbd>End</kbd> &mdash; window shorter / longer</li>
        <li><kbd>d</kbd> &mdash; toggle DC removal</li>
        <li><kbd>b</kbd> &mdash; toggle butterfly mode</li>
        <li><kbd>t</kbd> &mdash; toggle clock time format</li>
        <li><kbd>?</kbd> &mdash; toggle this help</li>
      </ul>
      <p style="margin:0;font-size:10px;color:var(--color-fg-subtle)">Click a channel label to mark it bad (dimmed)</p>
    </div>
  `.trim();

  // Scope: canvas + (conditional) vertical channel scrollbar.
  const plot = el("div", "eegv__plot");
  const canvas = document.createElement("canvas");
  canvas.className = "eegv__canvas";
  const vscroll = document.createElement("input");
  vscroll.type = "range";
  vscroll.className = "eegv__vscroll";
  vscroll.title = "Scroll channels";
  plot.append(canvas, vscroll);

  const hscroll = document.createElement("input");
  hscroll.type = "range";
  hscroll.className = "eegv__hscroll";
  hscroll.title = "Scrub time";

  // Overview minimap canvas (hidden until data loads).
  const minimap = document.createElement("canvas");
  minimap.className = "eegv__minimap";
  minimap.style.display = "none";
  minimap.title = "Overview — click to jump";

  const legend = el("div", "eegv__legend");
  for (const t of eventTypes.slice(0, 16)) {
    const chip = el("span", "eegv__chip");
    const dot = el("span", "eegv__dot");
    dot.style.background = t.color;
    chip.append(dot, document.createTextNode(`${t.label} (${t.count})`));
    legend.append(chip);
  }

  const status = el("div", "eegv__status");
  root.append(bar, cursor, plot, hscroll, minimap, legend, status, helpOverlay);
  slot.append(root);

  return {
    root,
    plot,
    canvas,
    minimap,
    time,
    chanInfo,
    cursor,
    status,
    win,
    dc: dc.input,
    events: events.input,
    butterflyCheck: butterflyLc.input,
    clockCheck: clockLc.input,
    hp,
    lp,
    notch,
    hscroll,
    vscroll,
    groupSel,
    helpOverlay,
    on(action, fn) {
      root.querySelector<HTMLButtonElement>(`[data-act="${action}"]`)?.addEventListener("click", fn);
    },
  };
}

function renderUnavailable(slot: HTMLElement, opts: ViewerOptions, err: unknown): void {
  const dl = opts.downloadUrl
    ? ` <a href="${escapeAttr(opts.downloadUrl)}" download>Download the file</a> instead.`
    : "";
  slot.innerHTML = `<div class="eegv"><p class="eegv__msg">No interactive viewer for this recording yet (the Zarr serving copy may still be generating).${dl}</p></div>`;
  console.debug("[eeg-viewer] unavailable:", err);
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/** A labeled control group: a small-caps label above a row of controls. */
function grouped(label: string, ...controls: Array<Node>): HTMLElement {
  const g = el("div", "eegv__group");
  const lab = el("span", "eegv__group-label");
  lab.textContent = label;
  const row = el("div", "eegv__group-row");
  row.append(...controls);
  g.append(lab, row);
  return g;
}

/** A small inline magnifier glyph with a +/- center, as button content. */
function magnifierGlyph(sign: "+" | "-"): string {
  return sign === "+" ? "⊕" : "⊖";
}

function compactSelect(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "eegv__sel";
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (v === value) o.selected = true;
    select.append(o);
  }
  return select;
}

function labeledCheck(
  label: string,
  checked: boolean,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "eegv__field");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  wrap.append(input, document.createTextNode(` ${label}`));
  return { wrap, input };
}

/** A small inline "Label <control>" field (for the filter selects). */
function fieldLabel(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "eegv__field");
  wrap.append(document.createTextNode(`${label} `), control);
  return wrap;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "&#x27;")
    .replace(/>/g, "&gt;");
}
