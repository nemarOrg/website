/**
 * Activations on the page's main thread (website phase W7; neuroschema 0.6.0
 * `docs/views/ic-activity.md`; nemar-cli ADR 0137 decision 9 as amended): the view's kind and
 * declaration (check 1), its files fetched but not read, the serving copy's level-0 samples read
 * from the Zarr store, the hand-off to the worker's transform (`transforms/ic-activity.ts`, which
 * runs checks 2 to 13 and the multiply) with the samples transferred, and the drawing through the
 * signal viewer's WebGL trace renderer, the spans ASR repaired shaded (`shadedRects`, through
 * `renderChrome`). Only a plan that passed every check makes the page read the store's samples.
 *
 * The store reader, zarrita and the trace renderer are the signal viewer's own modules, loaded
 * with a dynamic import (the page's viewer loads the same chunks), so the panel's first screen
 * carries none of them.
 */

import { CAPS, type FileSource, type ViewDecl } from "./model";
import type { ServingStore } from "./panel-bridge";
import type {
  ActivityFiles,
  ActivityPlan,
  ActivityResult,
  PlanInput,
  PlanOutcome,
  PrepareInput,
} from "./transforms/ic-activity";
import type { SensorFieldClient } from "./worker-client";

/** The longest window drawn at once, in seconds (the view's `max_window_s` may allow up to 30). */
export const WINDOW_S = 10;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

/** A refusal of the view: nothing is drawn, the word says why. */
export class ActivityRefused extends Error {
  constructor(readonly word: string) {
    super(word);
    this.name = "ActivityRefused";
  }
}

/** Check 1: the kind, which the display filter and the window are of, then the declaration. */
export async function checkDeclaration(
  view: unknown,
  checks: { view(view: unknown): Promise<{ valid: boolean }> },
): Promise<string | null> {
  const v = obj(view);
  if (v.kind !== "nemar.ic-activity" || v.kind_version !== 1) return "kind_unsupported";
  return (await checks.view(view)).valid ? null : "declaration_invalid";
}

/** The file inputs' bytes by role, fetched together and not read: a file whose declared size is
 *  over the cap is not fetched, and the worker checks each in order (check 4). */
export async function fetchInputs(
  view: ViewDecl,
  source: FileSource,
  caps = CAPS,
): Promise<ActivityFiles> {
  const files = (view.inputs ?? []).filter((i) => i.file);
  const bytes = await Promise.all(
    files.map((i) => (i.file!.size > caps.bytes_per_role ? null : source(i.file!))),
  );
  return Object.fromEntries(files.map((i, k) => [i.role, bytes[k]]));
}

/** Whether the record says ASR repaired a span: nemar-ica's `asrBurstFraction` above 0; null
 *  when the record has no such metric. */
export function burstsRepaired(metrics: Readonly<Record<string, unknown>>): boolean | null {
  const value = obj(metrics.asrBurstFraction).value;
  return typeof value === "number" ? value > 0 : null;
}

/** The window first drawn: from the recording's start, `WINDOW_S` or `max_window_s` long. */
export function firstWindow(samples: number, rate: number, maxWindowS: number) {
  const count = Math.min(samples, Math.floor(Math.min(WINDOW_S, maxWindowS) * rate));
  return { start: 0, count };
}

/** The transform's steps, in the worker, or on this thread when the worker cannot start. */
export interface ActivityTransform {
  prepare(input: PrepareInput): Promise<{ word: string | null }>;
  plan(input: PlanInput): Promise<PlanOutcome>;
  /** The activations, or null when `signal` aborted first (the worker was told to stop). */
  compute(
    plan: ActivityPlan,
    digital: ArrayLike<number>,
    scale: number[],
    offset: number[],
    signal: AbortSignal,
  ): Promise<ActivityResult | null>;
}

const here = () => import("./transforms/ic-activity");

/** The transform's `UNPREPARED`, written here so the page's chunk does not import the transform. */
const UNPREPARED = "unprepared";

/**
 * The transform in `client`'s worker, the samples transferred. The worker's answer is the answer:
 * a failure in the worker throws its own message. Only a worker that cannot start sends a step to
 * this thread, and it says so in the console; the samples go there only if they are still here.
 */
export function workerTransform(client: SensorFieldClient): ActivityTransform {
  const ask = async <T>(
    request: Parameters<SensorFieldClient["activity"]>[0],
    transfer: Transferable[],
    signal: AbortSignal | undefined,
    fallback: () => Promise<T>,
  ): Promise<T | null> => {
    const answer = await client.activity(request, transfer, signal);
    if (answer.type === "activity-done") return answer.outcome as T;
    if (answer.type === "cancelled") return null;
    if (answer.type === "failure") throw new Error(`the map worker failed: ${answer.message}`);
    if (answer.type !== "unavailable") throw new Error(`the map worker answered ${answer.type}`);
    if (transfer.some((b) => (b as ArrayBuffer).byteLength === 0)) throw new Error(answer.reason);
    console.warn(`[quality-views] ${answer.reason}; the activations are computed on this thread.`);
    return fallback();
  };
  return {
    prepare: async (input) =>
      (await ask({ step: "prepare", input }, [], undefined, async () =>
        (await here()).prepareActivity(input),
      ))!,
    plan: async (input) =>
      (await ask({ step: "plan", input }, [], undefined, async () =>
        (await here()).planActivity(input),
      ))!,
    compute: (plan, digital, scale, offset, signal) =>
      ask(
        { step: "compute", plan, digital, scale, offset },
        ArrayBuffer.isView(digital) ? [digital.buffer as ArrayBuffer] : [],
        signal,
        async () => (await here()).computeActivity(plan, digital, scale, offset),
      ),
  };
}

export interface Activity {
  readonly plan: ActivityPlan;
  readonly result: ActivityResult;
}

/**
 * Checks 5 to 13 for one window, then the samples, then the transform: the activations of
 * `[start, start + count)`, or null when `signal` aborted (a recording switch) first. The view was
 * prepared (checks 2 to 4); when the thread that plans no longer holds its tables, it is prepared
 * again from `files`. `ActivityRefused` carries the first fault's word.
 */
export async function activity(
  view: ViewDecl,
  files: ActivityFiles,
  store: ServingStore,
  window: { start: number; count: number },
  bursts: boolean | null,
  transform: ActivityTransform,
  signal: AbortSignal,
  caps = CAPS,
): Promise<Activity | null> {
  const input: PlanInput = {
    view,
    store: {
      labels: store.labels,
      units: store.units,
      rate: store.rate,
      samples: store.samples,
      published_sha256: store.published_sha256,
    },
    ...window,
    burstsRepaired: bursts,
    caps,
  };
  let outcome = await transform.plan(input);
  if (outcome.word === UNPREPARED) {
    const prepared = await transform.prepare({ view, files, caps });
    if (prepared.word !== null) throw new ActivityRefused(prepared.word);
    outcome = await transform.plan(input);
  }
  if (signal.aborted) return null;
  if (outcome.word !== null) throw new ActivityRefused(outcome.word);
  const { plan } = outcome;
  const first = plan.start - plan.before;
  const digital = await store.read(plan.rows, first, plan.start + plan.count + plan.after, signal);
  if (signal.aborted) return null;
  const scale = plan.rows.map((r) => store.scale[r]);
  const offset = plan.rows.map((r) => store.offset[r]);
  const result = await transform.compute(plan, digital, scale, offset, signal);
  return signal.aborted || !result ? null : { plan, result };
}

// ── The serving copy ────────────────────────────────────────────────────

type Level0 = import("zarrita").Array<"int16", import("zarrita").Readable>;

/**
 * A channel group of the Zarr serving copy at `url`, read with the viewer's store and zarrita (both
 * loaded on demand): each row's label, unit, scale and offset from the group's `channels`, in row
 * order, as the store states them (a row with none has none: an absent label matches no column and
 * an absent unit is `unit_unknown`), and level-0's stored integers. No store publishes a content
 * digest yet (nemarOrg/nemar-cli#2343), so `published_sha256` is null and every view is
 * `not_checked`. Null when the store or the group is not there.
 */
export async function openServingStore(
  url: string,
  group: string,
  signal: AbortSignal,
): Promise<ServingStore | null> {
  const { makeStore } = await import("../eeg-viewer/store");
  return servingStoreOf(makeStore(url), group, signal);
}

/** `openServingStore` on any Zarr store zarrita reads (the tests use one in memory). */
export async function servingStoreOf(
  source: import("zarrita").Readable,
  group: string,
  signal: AbortSignal,
): Promise<ServingStore | null> {
  const zarr = await import("zarrita");
  const root = zarr.root(source);
  let attrs: Json;
  let array: Level0;
  try {
    const [node, level0] = await Promise.all([
      zarr.open.v3(root.resolve(group), { kind: "group", signal } as { kind: "group" }),
      zarr.open.v3(root.resolve(`${group}/0`), { kind: "array", signal } as { kind: "array" }),
    ]);
    attrs = node.attrs as Json;
    array = level0 as Level0;
  } catch (error) {
    if (zarr.isZarritaError(error, "NotFoundError")) return null;
    throw error;
  }
  const channels = (Array.isArray(attrs.channels) ? attrs.channels : []).map(obj);
  const at = (c: Json, i: number) => (Number.isInteger(c.row_index) ? (c.row_index as number) : i);
  const rows = channels.map((c, i) => ({ c, row: at(c, i) })).sort((a, b) => a.row - b.row);
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const { shape } = array;
  return {
    labels: rows.map(({ c }) => text(c.label)),
    // A row the store cannot turn into a physical value has no unit the transform knows.
    units: rows.map(({ c }) => (finite(c.scale) && finite(c.offset) ? text(c.unit) : null)),
    scale: rows.map(({ c }) => c.scale as number),
    offset: rows.map(({ c }) => c.offset as number),
    rate: attrs.rate as number,
    samples: finite(attrs.n_samples) ? (attrs.n_samples as number) : shape[shape.length - 1],
    published_sha256: null,
    read: (wanted, from, to, abort) => readLevel0(zarr, array, wanted, from, to, abort),
  };
}

/**
 * Level-0's stored integers of `rows` over samples `[from, to)`, row after row in `rows`' order:
 * one read of the rows' span, then the rows picked out into a buffer of their own (transferred to
 * the worker).
 */
export async function readLevel0(
  zarr: typeof import("zarrita"),
  array: Level0,
  rows: readonly number[],
  from: number,
  to: number,
  signal: AbortSignal,
): Promise<Int16Array> {
  const low = Math.min(...rows);
  const high = Math.max(...rows) + 1;
  const region = await zarr.get(array, [zarr.slice(low, high), zarr.slice(from, to)], {
    signal,
  } as never);
  const m = to - from;
  const out = new Int16Array(rows.length * m);
  const data = region.data as Int16Array;
  rows.forEach((row, j) => out.set(data.subarray((row - low) * m, (row - low + 1) * m), j * m));
  return out;
}

// ── Drawing ─────────────────────────────────────────────────────────────

/** The canvases an activation view draws on: WebGL traces under 2D chrome, as the viewer does. */
export interface ActivityCanvas {
  readonly gl: HTMLCanvasElement;
  readonly chrome: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly grid: string;
  };
}

/**
 * The gl-trace adapter: the filtered activations as the viewer's frame, one stacked trace per
 * component labeled by the components table, against time in seconds, the spans ASR repaired
 * shaded, and the scale bar in arbitrary units (`a.u.`): an activation has no physical unit.
 */
export function activityFrame(a: Activity, color: string, label: string) {
  const { plan, result } = a;
  const n = plan.count;
  const channels = plan.components.map((label, i) => ({
    label,
    color,
    kind: "line" as const,
    line: Float32Array.from(result.filtered.subarray(i * n, (i + 1) * n)),
  }));
  // One scale for every trace: the median of the components' largest magnitudes.
  const peaks = channels
    .map((c) => c.line.reduce((m, v) => Math.max(m, Math.abs(v)), 0))
    .sort((x, y) => x - y);
  const startS = result.time[0];
  return {
    channels,
    nCols: n,
    windowStartS: startS,
    windowEndS: result.time[n - 1] ?? startS,
    events: [],
    shaded: plan.shaded.map((s) => ({ startS: s.onset, endS: s.onset + s.duration, label })),
    physPerDiv: peaks[peaks.length >> 1] || 1,
    unitBase: "V" as const,
    unitLabel: "a.u.",
  };
}

/** Draw the frame: WebGL traces under the 2D chrome, or all in 2D without WebGL. Returns the
 *  shaded spans the window shows (`shadedRects`), for the figure's text, and the renderer's end. */
export async function drawActivity(a: Activity, canvas: ActivityCanvas, label: string) {
  const [{ createGlTraceRenderer }, render] = await Promise.all([
    import("../eeg-viewer/gl-trace"),
    import("../eeg-viewer/render"),
  ]);
  const { width, height, colors } = canvas;
  const frame = activityFrame(a, colors.foreground, label);
  const options = { ...render.DEFAULT_RENDER, ...colors, width, height };
  const dpr = globalThis.devicePixelRatio || 1;
  for (const c of [canvas.gl, canvas.chrome]) {
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
  }
  const ctx = canvas.chrome.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gl = createGlTraceRenderer(canvas.gl);
  if (gl && ctx) {
    gl.resize(canvas.gl.width, canvas.gl.height);
    gl.draw(frame, options, width, height);
    render.renderChrome(ctx, frame, options);
  } else if (ctx) {
    render.renderFrame(ctx, frame, options);
  }
  return {
    spans: render.shadedRects(frame, options.gutter, Math.max(1, width - options.gutter - 8)),
    dispose: () => gl?.dispose(),
  };
}

// ── Export (website phase W8) ───────────────────────────────────────────

/** The activations each figure shows now, by its figure: read by the view's export (W8) at each
 *  click, so it saves the window on show. */
export const shownActivity = new WeakMap<
  Element,
  () => { readonly activity: Activity; readonly label: string }
>();

/** The window an activity covers, in seconds: its first sample's time and its length. */
export const activityWindow = (a: Activity): { startS: number; lengthS: number } => ({
  startS: a.plan.start / a.plan.rate,
  lengthS: a.plan.count / a.plan.rate,
});

/** The drawn window's height for `n` components, as the page sizes it. */
export const activityHeight = (n: number): number => Math.min(640, Math.max(160, n * 18 + 30));

/**
 * A painter of the window on show, all in 2D in `colors`: the export's copy. The page draws its
 * traces with WebGL, whose drawing buffer is not kept (`preserveDrawingBuffer: false`), so the
 * export draws the same frame again with the viewer's 2D renderer (`renderFrame`) instead of
 * reading the page's canvases.
 */
export async function activityPainter(
  a: Activity,
  label: string,
  colors: ActivityCanvas["colors"],
): Promise<(ctx: CanvasRenderingContext2D, width: number, height: number) => void> {
  const render = await import("../eeg-viewer/render");
  const frame = activityFrame(a, colors.foreground, label);
  return (ctx, width, height) =>
    render.renderFrame(ctx, frame, { ...render.DEFAULT_RENDER, ...colors, width, height });
}
