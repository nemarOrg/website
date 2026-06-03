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
import { VIRIDIS_CSS, type TopoChannel, projectPositions, renderTopomap } from "./topo";
import { type GlTraceRenderer, createGlTraceRenderer } from "./gl-trace";
import {
  DEFAULT_RENDER,
  type FrameChannel,
  type ViewerFrame,
  renderChrome,
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
  let hideBad = false;
  const badChannels = new Set<string>();
  // Topomap state. The projection is computed once (positions are fixed per
  // recording); topoTime tracks the cursor (null -> window center).
  let showTopo = false;
  let topoTime: number | null = null;
  // Only build the scalp layout for EEG/MEG with positions; non-scalp modalities
  // (iEEG/EMG/fNIRS/unknown) get no topomap so we don't render a wrong head map. A
  // bad-geometry projection is caught here so it just disables the topo, not the viewer.
  // topoScratch is this viewer's private offscreen grid buffer (never shared).
  const topoScratch = typeof document !== "undefined" ? document.createElement("canvas") : undefined;
  let topoLayout: ReturnType<typeof projectPositions> | null = null;
  try {
    if (isScalpModality(store.groups[0]?.modality) && Object.keys(store.electrodePositions).length >= 3) {
      topoLayout = projectPositions(store.electrodePositions, store.electrodeCoordinateSystem);
    }
  } catch (err) {
    console.warn("[eeg-viewer] electrode projection failed; topomap disabled:", err);
  }

  // Cursor readout state: the last rendered frame and layout geometry.
  let lastFrame: ViewerFrame | null = null;
  let lastPlotLeft = DEFAULT_RENDER.gutter;
  let lastPlotTop = 4;
  let lastPlotWidth = 0;
  let lastPlotHeight = 0;
  // Trace slot geometry for the last frame, cached so the per-pointer click/move
  // hit-tests reuse it instead of recomputing the (pure) layout on every event.
  let lastSlots: ReturnType<typeof traceLayout> = [];

  // Overview minimap state (one coarse read, cached).
  let overviewData: Float32Array | null = null;
  let overviewLoaded = false;
  let overviewSeq = 0; // guards a fire-and-forget overview load against group switches

  (slot as HTMLElement & { _eegvCleanup?: () => void })._eegvCleanup?.();
  slot.innerHTML = "";
  const ui = buildDom(slot, store, eventTypes);
  const cleanups: Array<() => void> = [];
  // Default the notch filter from the recording's PowerLineFrequency (the converter
  // embeds it in the store attrs; the Notch select already reflects it). Datasets
  // without the sidecar field stay unfiltered.
  filters.notch = Number(ui.notch.value) || null;
  const maybeCtx = ui.canvas.getContext("2d");
  if (!maybeCtx) {
    renderUnavailable(slot, opts, new Error("canvas 2D unavailable"));
    return;
  }
  const ctx = maybeCtx; // non-null for the closures below

  // WebGL trace layer: the signal polylines (the per-frame hot path) are
  // GPU-rasterized on a canvas behind the 2D one, which then carries only the
  // transparent chrome (labels/axis/events). null => WebGL unavailable, so the 2D
  // `renderFrame` path draws everything on the single canvas (glCanvas hidden).
  const glRenderer: GlTraceRenderer | null = createGlTraceRenderer(ui.glCanvas);
  if (!glRenderer) ui.glCanvas.style.display = "none";

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
    // The scope is the positioned frame; both canvases fill it (CSS inset:0). Its
    // width comes from flex (shrinks when the topo panel opens); we set its height.
    const rectW = ui.scope.getBoundingClientRect().width || ui.root.getBoundingClientRect().width;
    const cssW = Math.max(320, Math.round(rectW) || 800);
    // Fit the area the preview opens into: height tracks width (a ~2:1 scope) and
    // is capped by MAX_PLOT_HEIGHT and 70% of the viewport, so it never overflows.
    // It does NOT vary with channel count (stable embed boundary).
    const vpCap = Math.round((globalThis.innerHeight || 900) * 0.7);
    const cssH = Math.max(280, Math.min(Math.round(cssW * 0.5), MAX_PLOT_HEIGHT, vpCap));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    ui.scope.style.height = `${cssH}px`;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    // Assigning canvas.width/height clears the bitmap. Only do it on an actual size
    // change so a re-render triggered by something other than a resize (e.g. the
    // cursor readout toggling the layout height) repaints over the prior frame
    // instead of flashing white.
    if (ui.canvas.width !== pxW || ui.canvas.height !== pxH) {
      ui.canvas.width = pxW;
      ui.canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glRenderer?.resize(pxW, pxH);
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
    if (w.channels.length === 0 || w.channels[0].kind !== "line") {
      // Window too wide for level-0: the read fell back to the pyramid band, which
      // filtfilt cannot touch. Re-read the *visible* (unpadded) window so its nCols
      // and time span line up with the axis -- returning the padded band would shift
      // every trace left by padS.
      const band =
        w.channels.length === 0
          ? w
          : await readWindow(g, start, end, plotWidth, chanStart, chanCount, false);
      return { win: band, filtered: false };
    }
    const biquads = designFilters(filters, g.rate);
    const apply = biquads.length > 0; // empty when every requested cutoff is >= Nyquist
    const padCols = Math.round((start - pStart) * g.rate);
    const visCols = Math.max(1, Math.round((end - start) * g.rate));
    const channels: ChannelWindow[] = w.channels.map((cw) =>
      cw.kind === "line"
        ? {
            kind: "line",
            line: (apply ? filtfilt(cw.line, biquads) : cw.line).subarray(padCols, padCols + visCols),
          }
        : cw,
    );
    // `filtered` reflects whether a cascade was actually applied so the status note
    // does not claim "filtered" when the cutoffs were all suppressed at Nyquist.
    return { win: { level: w.level, nCols: visCols, channels }, filtered: apply };
  }

  async function render(): Promise<void> {
    // Wrapper so every fire-and-forget caller (event handlers, observers) is safe
    // from an unhandled rejection if a synchronous paint step throws.
    try {
      await renderImpl();
    } catch (err) {
      console.error("[eeg-viewer] render failed:", err);
    }
  }

  async function renderImpl(): Promise<void> {
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
    let channels: FrameChannel[] = visible.slice(0, n).map((ch, i) => {
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

    // Reject mode: drop bad channels from the montage entirely (the survivors take
    // the full height) rather than only dimming them in place. Never blank the scope
    // if every visible channel is marked bad.
    if (hideBad && badChannels.size > 0) {
      const kept = channels.filter((c) => !badChannels.has(c.label));
      const hidden = channels.length - kept.length;
      if (kept.length > 0) {
        channels = kept;
        if (hidden > 0) ui.chanInfo.textContent += ` · ${hidden} hidden`;
      }
    }

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
    lastSlots = traceLayout(frame.channels.length, lastPlotTop, lastPlotHeight);
    const renderOpts = { ...DEFAULT_RENDER, ...themeColors(ui.root), width: w, height: h, gain, butterfly };
    if (glRenderer) {
      // GPU draws background + traces; the 2D canvas adds transparent chrome on top.
      glRenderer.draw(frame, renderOpts, w, h);
      renderChrome(ctx, frame, renderOpts);
    } else {
      renderFrame(ctx, frame, renderOpts);
    }

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

    if (showTopo) drawTopo();
  }

  // --- Overview minimap ----------------------------------------------------

  async function loadOverview(g: GroupHandle): Promise<void> {
    const seq = ++overviewSeq;
    let data: Float32Array | null = null;
    try {
      data = await readOverview(g);
    } catch (err) {
      console.error("[eeg-viewer] loadOverview failed:", err);
    }
    if (seq !== overviewSeq) return; // a group switch superseded this load
    overviewData = data;
    ui.minimap.style.display = data && data.length > 0 ? "block" : "none";
    drawOverview();
  }

  function drawOverview(): void {
    const canvas = ui.minimap;
    if (!overviewData || overviewData.length === 0) return;
    const g = group();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cssW = canvas.getBoundingClientRect().width || ui.root.getBoundingClientRect().width || 600;
    const cssH = 44;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const mctx = canvas.getContext("2d");
    if (!mctx) return;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = themeColors(ui.root);
    mctx.fillStyle = colors.background;
    mctx.fillRect(0, 0, cssW, cssH);

    // Layout: events own the prominent upper band; the activity envelope is a faint
    // strip along the bottom. The envelope alone says little, so events are the focus
    // (the minimap is mainly an event-distribution indicator).
    const actBand = 11; // bottom px for the (subtle) activity envelope
    const evTop = 3;
    const evBottom = cssH - actBand - 2;

    // Subtle activity envelope along the bottom.
    const data = overviewData;
    let maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (maxVal <= 0) maxVal = 1;
    const colW = cssW / data.length;
    mctx.globalAlpha = 0.45;
    mctx.fillStyle = colors.grid;
    for (let i = 0; i < data.length; i++) {
      const barH = Math.max(1, Math.round((data[i] / maxVal) * actBand));
      mctx.fillRect(i * colW, cssH - barH - 1, Math.max(1, colW - 0.5), barH);
    }
    mctx.globalAlpha = 1;

    // The whole-recording time axis, shared by the event ticks and the window box.
    const dur = g.durationS || 1;

    // Prominent event ticks spanning the upper band; some alpha so dense clusters
    // read as density rather than a solid wall.
    if (store.events && eventTypes.length > 0) {
      const colorByCode = new Map(eventTypes.map((t) => [t.code, t.color]));
      mctx.lineWidth = 1.25;
      mctx.globalAlpha = 0.8;
      for (let i = 0; i < store.events.onsetS.length; i++) {
        const x = (store.events.onsetS[i] / dur) * cssW;
        mctx.strokeStyle = colorByCode.get(store.events.code[i]) ?? "#888888";
        mctx.beginPath();
        mctx.moveTo(Math.round(x) + 0.5, evTop);
        mctx.lineTo(Math.round(x) + 0.5, evBottom);
        mctx.stroke();
      }
      mctx.globalAlpha = 1;
    }

    // Current window box.
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

  // --- Topomap -------------------------------------------------------------
  // Scalp field at the cursor time (window centre until the pointer moves). Bad
  // (rejected) channels drop out of the interpolation, so hiding a channel removes
  // its contribution. Reads from the already-loaded frame (no extra fetch).
  function drawTopo(): void {
    if (!showTopo || !topoLayout) return;
    const canvas = ui.topoCanvas;
    const availW = Math.max(80, ui.topo.clientWidth - 8);
    const availH = Math.max(80, lastPlotTop + lastPlotHeight);
    const cssSize = Math.min(availW, availH, 360);
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    const pxW = Math.round(cssSize * dpr);
    if (canvas.width !== pxW) {
      canvas.width = pxW;
      canvas.height = pxW;
    }
    const tctx = canvas.getContext("2d");
    if (!tctx) return;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame = lastFrame;
    if (!frame || frame.nCols <= 0) {
      tctx.clearRect(0, 0, cssSize, cssSize);
      return;
    }
    const span = frame.windowEndS - frame.windowStartS;
    const t = Math.max(
      frame.windowStartS,
      Math.min(frame.windowEndS, topoTime ?? frame.windowStartS + span / 2),
    );
    const col = Math.max(
      0,
      Math.min(frame.nCols - 1, Math.round(((t - frame.windowStartS) / Math.max(1e-6, span)) * (frame.nCols - 1))),
    );
    const channels: TopoChannel[] = [];
    for (const ch of frame.channels) {
      if (ch.dim) continue; // rejected -> no contribution
      const pos = topoLayout.get(ch.label);
      if (!pos) continue;
      const value = ch.kind === "line" ? (ch.line[col] ?? 0) : ((ch.min[col] ?? 0) + (ch.max[col] ?? 0)) / 2;
      channels.push({ label: ch.label, pos, value });
    }
    const { vmax } = renderTopomap(tctx, cssSize, channels, themeColors(ui.root), topoScratch);
    if (channels.length >= 3) {
      const rng = formatSi(vmax, frame.unitBase);
      ui.topoMin.textContent = `−${rng}`;
      ui.topoMax.textContent = `+${rng}`;
      ui.topoInfo.textContent = timeClock ? formatClock(t) : `${t.toFixed(2)} s`;
    } else {
      ui.topoMin.textContent = "";
      ui.topoMax.textContent = "";
      ui.topoInfo.textContent = `${channels.length} located ch`;
    }
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
  ui.hideBadCheck.addEventListener("change", () => {
    hideBad = ui.hideBadCheck.checked;
    render();
  });
  ui.topoBtn.addEventListener("click", () => {
    if (ui.topoBtn.disabled) return;
    showTopo = !showTopo && !!topoLayout;
    ui.topo.style.display = showTopo ? "flex" : "none";
    ui.topoBtn.setAttribute("aria-pressed", String(showTopo));
    ui.topoBtn.classList.toggle("eegv__btn--active", showTopo);
    render(); // re-sizes the scope (the topo panel takes width); drawTopo runs in render
  });

  // --- Settings (gear) popover --------------------------------------------
  let menuOpen = false;
  function setMenu(open: boolean): void {
    menuOpen = open;
    ui.menu.style.display = open ? "flex" : "none";
    ui.gearBtn.setAttribute("aria-expanded", String(open));
    ui.gearBtn.classList.toggle("eegv__gear--open", open);
  }
  function syncGear(): void {
    // A dot on the gear marks an active filter so it is clear the trace is filtered
    // even while the menu is closed.
    ui.gearBtn.classList.toggle("eegv__gear--active", hasFilters(filters));
  }
  ui.gearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(!menuOpen);
  });
  ui.menu.addEventListener("click", (e) => e.stopPropagation());
  const onDocClick = (): void => {
    if (menuOpen) setMenu(false);
  };
  document.addEventListener("click", onDocClick);
  cleanups.push(() => document.removeEventListener("click", onDocClick));
  syncGear(); // reflect the PowerLineFrequency notch default

  ui.hp.addEventListener("change", () => {
    filters.hp = Number(ui.hp.value) || null;
    syncGear();
    render();
  });
  ui.lp.addEventListener("change", () => {
    filters.lp = Number(ui.lp.value) || null;
    syncGear();
    render();
  });
  ui.notch.addEventListener("change", () => {
    filters.notch = Number(ui.notch.value) || null;
    syncGear();
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
      overviewSeq++; // invalidate any in-flight overview load from the prior group
      // Topomap is scalp-only; disable + hide it when the active group is not scalp.
      const scalpNow = !!topoLayout && isScalpModality(group().modality);
      ui.topoBtn.disabled = !scalpNow;
      if (!scalpNow && showTopo) {
        showTopo = false;
        ui.topo.style.display = "none";
        ui.topoBtn.classList.remove("eegv__btn--active");
      }
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
    const slots = lastSlots;
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
      const slots = lastSlots;
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

    // Nearest event under the cursor (within a few px of its line) -> its
    // description, so hovering an event line explains the otherwise-cryptic code.
    let eventStr = "";
    const pxPerS = lastPlotWidth / Math.max(1e-6, span);
    let bestDx = 5;
    for (const ev of frame.events) {
      const dx = Math.abs(lastPlotLeft + (ev.onsetS - frame.windowStartS) * pxPerS - x);
      if (dx <= bestDx) {
        bestDx = dx;
        eventStr = ev.description ? `${ev.label}: ${ev.description}` : ev.label;
      }
    }

    const timeStr = timeClock ? formatClock(tAtX) : `${tAtX.toFixed(2)} s`;
    const base = chanLabel ? `${chanLabel} · ${timeStr} · ${valueStr}` : timeStr;
    ui.cursor.textContent = eventStr ? `${base} · ◆ ${eventStr}` : base;
    if (showTopo) {
      topoTime = tAtX;
      try {
        drawTopo();
      } catch (err) {
        console.error("[eeg-viewer] drawTopo failed:", err);
      }
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
    } else if (k === "h") {
      hideBad = !hideBad;
      ui.hideBadCheck.checked = hideBad;
      render();
    } else if (k === "?") {
      toggleHelp();
    } else if (k === "Escape" && menuOpen) {
      setMenu(false);
    } else return;
    e.preventDefault();
  });

  if (typeof ResizeObserver !== "undefined") {
    let raf = 0;
    let lastObservedW = -1; // -1 (not 0) so even a zero-width first observation renders once
    const ro = new ResizeObserver((entries) => {
      // The scope height tracks width, so only a width change needs a repaint.
      // Ignore height-only changes (e.g. the cursor readout row growing/shrinking)
      // that would otherwise re-render on every pointer enter/leave.
      const w = Math.round(entries[0]?.contentRect.width ?? ui.root.getBoundingClientRect().width);
      if (w === lastObservedW) return;
      lastObservedW = w;
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
  cleanups.push(() => glRenderer?.dispose());
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
  scope: HTMLElement;
  canvas: HTMLCanvasElement;
  glCanvas: HTMLCanvasElement;
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
  hideBadCheck: HTMLInputElement;
  topoBtn: HTMLButtonElement;
  topo: HTMLElement;
  topoCanvas: HTMLCanvasElement;
  topoInfo: HTMLElement;
  topoMin: HTMLElement;
  topoMax: HTMLElement;
  hp: HTMLSelectElement;
  lp: HTMLSelectElement;
  notch: HTMLSelectElement;
  hscroll: HTMLInputElement;
  vscroll: HTMLInputElement;
  groupSel: HTMLSelectElement | null;
  gearBtn: HTMLButtonElement;
  menu: HTMLElement;
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

  // Topomap toggle -- a primary view control (right of Channels), not a set-once
  // gear setting. Disabled when the recording has no embedded electrode positions.
  const topoBtn = document.createElement("button");
  topoBtn.type = "button";
  topoBtn.className = "eegv__btn eegv__topo-btn";
  topoBtn.title = "Scalp topomap (split panel)";
  topoBtn.setAttribute("aria-pressed", "false");
  topoBtn.innerHTML = topoGlyph();
  // Scalp topomap is only meaningful for EEG/MEG. iEEG (intracranial), EMG, fNIRS,
  // or unrecognized modalities get the toggle disabled, so we never draw a
  // misleading scalp map for non-scalp electrodes.
  const nPos = Object.keys(store.electrodePositions).length;
  if (!(isScalpModality(store.groups[0]?.modality) && nPos >= 3)) {
    topoBtn.disabled = true;
    topoBtn.title = nPos < 3 ? "no electrode positions in this recording" : "scalp topomap is EEG/MEG only";
  }
  bar.append(grouped("Topo", topoBtn));

  // Set-once controls (zero-phase filters + display toggles) live behind a gear
  // popover so the primary bar stays uncluttered -- these are typically configured
  // once per dataset and forgotten.
  const hp = compactSelect(HP_CHOICES, "0");
  const lp = compactSelect(LP_CHOICES, "0");
  const notch = compactSelect(NOTCH_CHOICES, notchDefault(store.powerLineFrequency));
  const dc = labeledCheck("DC", true);
  const events = labeledCheck("Events", true);
  const butterflyLc = labeledCheck("Butterfly", false);
  const clockLc = labeledCheck("Clock", false);
  const hideBadLc = labeledCheck("Hide bad", false);

  const gearBtn = document.createElement("button");
  gearBtn.type = "button";
  gearBtn.className = "eegv__gear";
  gearBtn.title = "Settings — filters & display";
  gearBtn.setAttribute("aria-label", "Settings");
  gearBtn.setAttribute("aria-expanded", "false");
  gearBtn.innerHTML = gearGlyph();

  const menu = el("div", "eegv__menu");
  menu.style.display = "none";
  menu.append(
    grouped("Filter (Hz)", fieldLabel("HP", hp), fieldLabel("LP", lp), fieldLabel("Notch", notch)),
    grouped("Display", dc.wrap, events.wrap, butterflyLc.wrap, clockLc.wrap, hideBadLc.wrap),
  );
  const settings = el("div", "eegv__settings");
  settings.append(gearBtn, menu);
  bar.append(settings);

  // Cursor readout: a compact overlay tucked into the bottom-right of the scope
  // (appears on hover, hidden otherwise) rather than a full-width line.
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
        <li><kbd>h</kbd> &mdash; hide channels marked bad</li>
        <li><kbd>?</kbd> &mdash; toggle this help</li>
      </ul>
      <p style="margin:0;font-size:10px;color:var(--color-fg-subtle)">Click a channel label to mark it bad (dim; <kbd>h</kbd> hides them)</p>
    </div>
  `.trim();

  // Scope: a positioned wrapper holding the WebGL trace layer (background +
  // signal, behind) and the 2D chrome layer (labels/axis/events, in front). Both
  // canvases fill the scope via CSS inset:0; JS sizes them together. Falls back to
  // the 2D canvas alone (opaque) when WebGL is unavailable.
  const plot = el("div", "eegv__plot");
  const scope = el("div", "eegv__scope");
  const glCanvas = document.createElement("canvas");
  glCanvas.className = "eegv__glcanvas";
  const canvas = document.createElement("canvas");
  canvas.className = "eegv__canvas";
  scope.append(glCanvas, canvas);
  const vscroll = document.createElement("input");
  vscroll.type = "range";
  vscroll.className = "eegv__vscroll";
  vscroll.title = "Scroll channels";
  // Topomap split-panel (right of the scope; hidden until toggled).
  const topo = el("div", "eegv__topo");
  topo.style.display = "none";
  const topoCanvas = document.createElement("canvas");
  topoCanvas.className = "eegv__topo-canvas";
  topoCanvas.title = "Scalp topography at the cursor time";
  const topoBar = el("div", "eegv__topo-bar"); // viridis colorbar
  topoBar.style.background = `linear-gradient(to right, ${VIRIDIS_CSS})`;
  const topoMin = el("span", "eegv__topo-end");
  const topoMax = el("span", "eegv__topo-end");
  const topoScale = el("div", "eegv__topo-scale");
  topoScale.append(topoMin, topoBar, topoMax);
  const topoInfo = el("div", "eegv__topo-info");
  topo.append(topoCanvas, topoScale, topoInfo);
  plot.append(scope, vscroll, topo, cursor);

  const hscroll = document.createElement("input");
  hscroll.type = "range";
  hscroll.className = "eegv__hscroll";
  hscroll.title = "Scrub time";

  // Overview minimap canvas (hidden until data loads).
  const minimap = document.createElement("canvas");
  minimap.className = "eegv__minimap";
  minimap.style.display = "none";
  minimap.title = "Overview — click to jump";

  // Event legend: a compact scrollable table. Show the human description from the
  // events.json Levels when present (the raw code is meaningless on its own); the
  // chip's title carries the code for reference. All types listed (scroll, not grow).
  const legend = el("div", "eegv__legend");
  for (const t of eventTypes) {
    const chip = el("span", "eegv__chip");
    chip.title = t.description ? `${t.label} — ${t.description}` : t.label;
    const dot = el("span", "eegv__dot");
    dot.style.background = t.color;
    chip.append(dot, document.createTextNode(`${t.description || t.label} (${t.count})`));
    legend.append(chip);
  }

  const status = el("div", "eegv__status");
  root.append(bar, plot, hscroll, minimap, legend, status, helpOverlay);
  slot.append(root);

  return {
    root,
    plot,
    scope,
    canvas,
    glCanvas,
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
    hideBadCheck: hideBadLc.input,
    topoBtn,
    topo,
    topoCanvas,
    topoInfo,
    topoMin,
    topoMax,
    hp,
    lp,
    notch,
    hscroll,
    vscroll,
    groupSel,
    gearBtn,
    menu,
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
  console.warn("[eeg-viewer] unavailable:", err);
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

/** Inline gear (settings) icon for the popover toggle. */
function gearGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
}

/** Scalp modalities a head topomap is valid for. iEEG (intracranial), EMG, fNIRS,
 *  and unrecognized modalities are excluded so we never draw a misleading head map. */
const SCALP_MODALITIES = new Set(["EEG", "MEG"]);
function isScalpModality(modality: string | undefined): boolean {
  return SCALP_MODALITIES.has((modality || "").toUpperCase());
}

/** Inline topomap icon: a head circle with a nose notch at the top. */
function topoGlyph(): string {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.5" r="8"/><path d="M9.2 6 L12 2.8 L14.8 6"/></svg>';
}

/** Default Notch select value: the recording's PowerLineFrequency when it is a
 *  supported option (50/60 Hz), else "0" (off). Datasets that do not declare one
 *  open unfiltered. */
function notchDefault(powerLineFrequency: number | null): string {
  return powerLineFrequency === 50 || powerLineFrequency === 60 ? String(powerLineFrequency) : "0";
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
