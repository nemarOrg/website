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
import { type Modality, channelColor, defaultScaling, removeDcInPlace } from "./dsp";
import { type EventType, buildEventTypes, eventsInWindow } from "./events";
import {
  DEFAULT_RENDER,
  type FrameChannel,
  type ViewerFrame,
  renderFrame,
  renderMessage,
} from "./render";
import {
  type GroupHandle,
  type RecordingStore,
  type WindowData,
  openRecording,
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
  let renderSeq = 0;
  let firstPaint = true;

  slot.innerHTML = "";
  const ui = buildDom(slot, store, eventTypes);
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

    ui.time.textContent = `${start.toFixed(1)}–${end.toFixed(1)} s`;
    ui.chanInfo.textContent =
      visEnd - chanStart >= g.nChannels ? `all ${g.nChannels}` : `${chanStart + 1}–${visEnd}/${g.nChannels}`;

    // Paint a "loading" state immediately so the scope never sits blank while a
    // read (or its retries) is in flight; the first paint also covers the gap
    // before any frame exists. Subsequent scrolls keep the prior frame.
    if (firstPaint) renderMessage(ctx, w, h, themeColors(ui.root), "Signal loading…");
    ui.status.textContent = "Signal loading…";

    let win: WindowData;
    try {
      win = await readWindow(g, start, end, plotWidth, chanStart, chanCount);
    } catch (err) {
      if (seq === renderSeq) ui.status.textContent = `signal unavailable: ${(err as Error).message}`;
      return;
    }
    if (seq !== renderSeq) return; // a newer render superseded this one
    firstPaint = false;

    const visible = g.channelsByRow.slice(chanStart, visEnd);
    const channels: FrameChannel[] = visible.map((ch, i) => {
      const color =
        ch.channelType && ch.channelType !== "OTHER"
          ? channelColor(ch.channelType)
          : channelColor(ch.modality);
      const cw = win.channels[i];
      if (cw?.line) {
        const line = dcRemove ? removeDcInPlace(cw.line.slice()) : cw.line;
        return { label: ch.label, color, line };
      }
      let min = cw?.min;
      let max = cw?.max;
      if (dcRemove && min && max) ({ min, max } = removeBandDc(min, max));
      return { label: ch.label, color, min, max };
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
    };
    renderFrame(ctx, frame, { ...DEFAULT_RENDER, ...themeColors(ui.root), width: w, height: h, gain });

    ui.status.textContent =
      `${g.name} · ${g.nChannels} ch @ ${g.rate} Hz (orig ${g.originalRate}) · ` +
      `${g.durationS.toFixed(0)} s · level ${win.level === 0 ? "0 (full)" : `view/${win.level}`} · ` +
      `${eventTypes.length} event type(s)`;
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
      render();
    });
  }

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

  ui.root.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight") scroll(e.shiftKey ? windowLengthS : windowLengthS / 4);
    else if (k === "ArrowLeft") scroll(e.shiftKey ? -windowLengthS : -windowLengthS / 4);
    else if (k === "ArrowDown") scrollChan(1);
    else if (k === "ArrowUp") scrollChan(-1);
    else if (k === "PageDown") scrollChan(chanCount);
    else if (k === "PageUp") scrollChan(-chanCount);
    else if (k === "+" || k === "=") {
      gain *= 1.5;
      render();
    } else if (k === "-") {
      gain /= 1.5;
      render();
    } else if (k === "d") {
      dcRemove = !dcRemove;
      ui.dc.checked = dcRemove;
      render();
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
  }
  // Repaint when the site theme flips (the canvas reads CSS vars, so a light/dark
  // toggle on <html> must trigger a re-render to stay homogeneous).
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => render());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
  }

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

function removeBandDc(
  min: Float32Array,
  max: Float32Array,
): { min: Float32Array; max: Float32Array } {
  let sum = 0;
  for (let i = 0; i < min.length; i++) sum += (min[i] + max[i]) / 2;
  const mean = sum / Math.max(1, min.length);
  const outMin = new Float32Array(min.length);
  const outMax = new Float32Array(max.length);
  for (let i = 0; i < min.length; i++) {
    outMin[i] = min[i] - mean;
    outMax[i] = max[i] - mean;
  }
  return { min: outMin, max: outMax };
}

// --- DOM scaffold ----------------------------------------------------------

interface ViewerUi {
  root: HTMLElement;
  plot: HTMLElement;
  canvas: HTMLCanvasElement;
  time: HTMLElement;
  chanInfo: HTMLElement;
  status: HTMLElement;
  win: HTMLSelectElement;
  dc: HTMLInputElement;
  events: HTMLInputElement;
  hscroll: HTMLInputElement;
  vscroll: HTMLInputElement;
  groupSel: HTMLSelectElement | null;
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

  // Display toggles.
  const dc = labeledCheck("DC", true);
  const events = labeledCheck("Events", true);
  bar.append(grouped("Display", dc.wrap, events.wrap));

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

  const legend = el("div", "eegv__legend");
  for (const t of eventTypes.slice(0, 16)) {
    const chip = el("span", "eegv__chip");
    const dot = el("span", "eegv__dot");
    dot.style.background = t.color;
    chip.append(dot, document.createTextNode(`${t.label} (${t.count})`));
    legend.append(chip);
  }

  const status = el("div", "eegv__status");
  root.append(bar, plot, hscroll, legend, status);
  slot.append(root);

  return {
    root,
    plot,
    canvas,
    time,
    chanInfo,
    status,
    win,
    dc: dc.input,
    events: events.input,
    hscroll,
    vscroll,
    groupSel,
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
