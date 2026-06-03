import { zarrStoreUrl } from "../zarr-base";
/**
 * Signal-viewer orchestration (website#99). `mountEegViewer` builds the toolbar +
 * canvas into a slot, opens the recording's Zarr store, and drives the render
 * loop: pick the pyramid level for the window, dequantize, optional DC removal,
 * overlay events, draw. P0 controls: window length, scroll/step/page, gain, DC,
 * events toggle, channel-group switch, and the MNE-style nav keys.
 *
 * Events are a first-class, recording-level layer (one `events/` group shared by
 * all channel groups): read once, shown as a type legend + vertical lines.
 */
import { type Modality, channelColor, defaultScaling, removeDcInPlace } from "./dsp";
import { type EventType, buildEventTypes, eventsInWindow } from "./events";
import { DEFAULT_RENDER, type FrameChannel, type ViewerFrame, renderFrame } from "./render";
import {
  type GroupHandle,
  type RecordingStore,
  type WindowData,
  openRecording,
  readWindow,
} from "./store";

export interface ViewerOptions {
  datasetId: string;
  version: string | null;
  filePath: string;
  /** Data-plane URL for the "download instead" fallback when no store exists. */
  downloadUrl?: string;
}

const WINDOW_CHOICES = [2, 5, 10, 20, 30];
const ELECTRIC = new Set<Modality>(["EEG", "EMG", "IEEG", "MISC"]);

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
  let renderSeq = 0;

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

  function clampStart(): void {
    const max = Math.max(0, group().durationS - windowLengthS);
    windowStartS = Math.min(Math.max(0, windowStartS), max);
  }

  function sizeCanvas(): { w: number; h: number } {
    const cssW = Math.max(320, ui.canvas.clientWidth || ui.root.clientWidth || 800);
    const cssH = Math.max(240, Math.min(640, group().nChannels * 22 + 48));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    ui.canvas.style.height = `${cssH}px`;
    ui.canvas.width = Math.round(cssW * dpr);
    ui.canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  async function render(): Promise<void> {
    const seq = ++renderSeq;
    clampStart();
    const g = group();
    const { w, h } = sizeCanvas();
    const plotWidth = Math.max(64, w - DEFAULT_RENDER.gutter - 8);
    const start = windowStartS;
    const end = Math.min(g.durationS, start + windowLengthS);

    ui.time.textContent = `${start.toFixed(1)}–${end.toFixed(1)} s of ${g.durationS.toFixed(0)} s`;

    let win: WindowData;
    try {
      win = await readWindow(g, start, end, plotWidth);
    } catch (err) {
      if (seq === renderSeq) ui.status.textContent = `read error: ${(err as Error).message}`;
      return;
    }
    if (seq !== renderSeq) return; // a newer render superseded this one

    const channels: FrameChannel[] = g.channelsByRow.map((ch, row) => {
      const color =
        ch.channelType && ch.channelType !== "OTHER"
          ? channelColor(ch.channelType)
          : channelColor(ch.modality);
      const cw = win.channels[row];
      if (cw.line) {
        const line = dcRemove ? removeDcInPlace(cw.line.slice()) : cw.line;
        return { label: ch.label, color, line };
      }
      let { min, max } = cw;
      if (dcRemove && min && max) {
        ({ min, max } = removeBandDc(min, max));
      }
      return { label: ch.label, color, min, max };
    });

    const modality = (g.modality as Modality) ?? "MISC";
    const frame: ViewerFrame = {
      channels,
      nCols: win.nCols,
      windowStartS: start,
      windowEndS: end,
      events:
        showEvents && store.events ? eventsInWindow(store.events, eventTypes, start, end) : [],
      physPerDiv: defaultScaling(modality),
      unitBase: ELECTRIC.has(modality) ? "V" : "T",
    };
    renderFrame(ctx, frame, { ...DEFAULT_RENDER, width: w, height: h, gain });

    ui.status.textContent =
      `${g.name} · ${g.nChannels} ch @ ${g.rate} Hz (orig ${g.originalRate}) · ` +
      `level ${win.level === 0 ? "0 (full)" : `view/${win.level}`} · ` +
      `${eventTypes.length} event type(s)`;
  }

  // --- controls ------------------------------------------------------------
  const step = () => windowLengthS * 0.2;
  ui.on("page-back", () => {
    windowStartS -= windowLengthS;
    render();
  });
  ui.on("step-back", () => {
    windowStartS -= step();
    render();
  });
  ui.on("step-fwd", () => {
    windowStartS += step();
    render();
  });
  ui.on("page-fwd", () => {
    windowStartS += windowLengthS;
    render();
  });
  ui.on("gain-up", () => {
    gain *= 1.5;
    render();
  });
  ui.on("gain-down", () => {
    gain /= 1.5;
    render();
  });
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
  if (ui.groupSel) {
    ui.groupSel.addEventListener("change", () => {
      groupIndex = Number(ui.groupSel?.value) || 0;
      windowStartS = 0;
      render();
    });
  }

  ui.root.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight") windowStartS += e.shiftKey ? windowLengthS : windowLengthS / 4;
    else if (k === "ArrowLeft") windowStartS -= e.shiftKey ? windowLengthS : windowLengthS / 4;
    else if (k === "+" || k === "=") gain *= 1.5;
    else if (k === "-") gain /= 1.5;
    else if (k === "d") {
      dcRemove = !dcRemove;
      ui.dc.checked = dcRemove;
    } else return;
    e.preventDefault();
    render();
  });

  if (typeof ResizeObserver !== "undefined") {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => render());
    });
    ro.observe(ui.root);
  }

  await render();
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
  canvas: HTMLCanvasElement;
  time: HTMLElement;
  status: HTMLElement;
  win: HTMLSelectElement;
  dc: HTMLInputElement;
  events: HTMLInputElement;
  groupSel: HTMLSelectElement | null;
  on(action: string, fn: () => void): void;
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
    bar.append(groupSel);
  }

  const navBtn = (action: string, label: string, title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "eegv__btn";
    b.dataset.act = action;
    b.textContent = label;
    b.title = title;
    return b;
  };
  bar.append(navBtn("page-back", "«", "Page back"), navBtn("step-back", "‹", "Step back"));
  const time = el("span", "eegv__time");
  bar.append(
    time,
    navBtn("step-fwd", "›", "Step forward"),
    navBtn("page-fwd", "»", "Page forward"),
  );

  const win = labeledSelect(
    "Window",
    WINDOW_CHOICES.map((s) => [String(s), `${s} s`]),
    "10",
  );
  bar.append(win.wrap);

  bar.append(navBtn("gain-down", "−", "Scale down"), navBtn("gain-up", "+", "Scale up"));

  const dc = labeledCheck("DC", true);
  const events = labeledCheck("Events", true);
  bar.append(dc.wrap, events.wrap);

  const canvas = document.createElement("canvas");
  canvas.className = "eegv__canvas";

  const legend = el("div", "eegv__legend");
  for (const t of eventTypes.slice(0, 16)) {
    const chip = el("span", "eegv__chip");
    const dot = el("span", "eegv__dot");
    dot.style.background = t.color;
    chip.append(dot, document.createTextNode(`${t.label} (${t.count})`));
    legend.append(chip);
  }

  const status = el("div", "eegv__status");
  root.append(bar, canvas, legend, status);
  slot.append(root);

  return {
    root,
    canvas,
    time,
    status,
    win: win.select,
    dc: dc.input,
    events: events.input,
    groupSel,
    on(action, fn) {
      root
        .querySelector<HTMLButtonElement>(`[data-act="${action}"]`)
        ?.addEventListener("click", fn);
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

function labeledSelect(
  label: string,
  options: Array<[string, string]>,
  value: string,
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = el("label", "eegv__field");
  wrap.append(document.createTextNode(`${label} `));
  const select = document.createElement("select");
  select.className = "eegv__sel";
  for (const [v, t] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (v === value) o.selected = true;
    select.append(o);
  }
  wrap.append(select);
  return { wrap, select };
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
