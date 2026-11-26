/**
 * `nemar.ic-activity.v1` and the display filter of the kind `nemar.ic-activity` version 1
 * (neuroschema 0.6.0 `docs/views/ic-activity.md`, normative; nemar-cli ADR 0137 decision 9 as
 * amended; the live-views plan's C9). A lazy chunk of the map worker (`worker.ts`), so the page's
 * main thread never carries it; the page runs it here only when the worker cannot start.
 *
 * The browser applies no preprocessing: the activations are one multiply, A = W · x, of the matrix
 * the recipe wrote (`_servingunmixing.tsv`: the unmixing with the average reference and the store
 * unit's factor folded in) by the serving copy's physical values of the decomposition's channels.
 * The kind then passes each component through a zero-phase Butterworth high-pass of order 2, for
 * display only, over the window and up to a second of real context on each side.
 *
 * Two steps, so the page reads the store's samples only for a view that passed every check:
 * - `planActivity`: checks 2 to 13 of the specification, in its order (the page has run the first,
 *   the kind and the declaration, and fetched the files without reading them), the first that fails
 *   giving the word: the inputs' locations, the decomposition's store, each file's declared size
 *   against the cap, presence, size and SHA-256, the store digest, the rate, the window, the
 *   matrix, the components, the bad segments, the channel match, the units, the filter.
 * - `computeActivity`: the multiply and the filter over the stretch the plan names.
 *
 * Arithmetic follows the specification's order in binary64, each product and sum rounded, no
 * fused multiply-add. `views/vectors/ic-activity.v1.json` holds it to `neuroschema.views.ic_activity`
 * (`test/quality-views-ic-activity.test.ts`).
 */

import { readSegments, recipeLabel, tableIsRecordings } from "../floor-tables";
import { KindRefused, cellValue, cells, readTsv } from "../read";
import { subtleSha256 } from "../verify";

/** The factor to microvolts of each unit a store row or a matrix may state. */
export const MICROVOLTS_PER: Readonly<Record<string, number>> = {
  V: 1e6,
  mV: 1e3,
  uV: 1,
  µV: 1,
  μV: 1,
};

/** scipy's `filtfilt` pad for order 2, 3 · (order + 1). */
const PADDING = 9;

/** One channel group of a recording's serving copy, without its samples. */
export interface ActivityStoreMeta {
  /** One entry per store row, in store order; null where the store states none. */
  readonly labels: readonly (string | null)[];
  readonly units: readonly (string | null)[];
  readonly rate: number;
  /** Samples per row. */
  readonly samples: number;
  /** The group's `nemar.store-content.v1` digest as the serving copy publishes it, or null. */
  readonly published_sha256: string | null;
}

/** The file inputs' bytes by role, as fetched (null when not there, or not fetched because the
 *  declared size is over the cap), not yet checked. */
export type ActivityFiles = Readonly<Record<string, Uint8Array | null>>;

export interface PlanInput {
  /** The declaration, its kind and its schema checked (check 1). */
  readonly view: unknown;
  readonly files: ActivityFiles;
  readonly store: ActivityStoreMeta;
  /** Samples `[start, start + count)` of the store. */
  readonly start: number;
  readonly count: number;
  /** Whether the record says ASR repaired a span of the decomposition's input; null unknown. */
  readonly burstsRepaired: boolean | null;
  readonly caps: {
    readonly bytes_per_role: number;
    readonly entries_per_dim: number;
    readonly cells_per_role: number;
  };
}

export interface ActivityPlan {
  readonly state: "matches" | "not_checked";
  /** The components table's `component` cells: the series' labels. */
  readonly components: string[];
  /** The matrix's columns and the store row of each. */
  readonly channels: string[];
  readonly rows: number[];
  readonly factors: number[];
  /** The matrix, components by channels, row after row. */
  readonly weights: Float64Array;
  /** The bad segments whose label is `shaded.label`, in file order. */
  readonly shaded: { onset: number; duration: number }[];
  readonly notes: string[];
  readonly start: number;
  readonly count: number;
  /** Samples of real context read before and after the window. */
  readonly before: number;
  readonly after: number;
  /** Whether the stretch begins at the recording's first sample, and ends at its last: only
   *  there is it padded by the odd extension. */
  readonly padStart: boolean;
  readonly padEnd: boolean;
  readonly rate: number;
  readonly highpassHz: number;
}

export type PlanOutcome =
  | { readonly word: string; readonly plan?: undefined }
  | { readonly word: null; readonly plan: ActivityPlan };

export interface ActivityResult {
  /** Components by window samples, row after row. */
  readonly activations: Float64Array;
  readonly filtered: Float64Array;
  /** Each window sample's time in seconds, `(start + k) / rate`. */
  readonly time: Float64Array;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

/** The display filter's coefficients: `b`, `a` and the steady state `zi` (ic-activity.md,
 *  Coefficients), each line one binary64 expression evaluated left to right. */
export function highpass(cutoffHz: number, rate: number) {
  const k = Math.tan((Math.PI * cutoffHz) / rate);
  const kk = k * k;
  const sk = Math.SQRT2 * k;
  const norm = 1 / (1 + sk + kk);
  const b = [norm, -2 * norm, norm] as const;
  const a = [1, 2 * (kk - 1) * norm, (1 - sk + kk) * norm] as const;
  return { b, a, zi: [-b[0], b[2]] as const };
}

/** Direct form II transposed over `e` from the state `zi · e[0]`, in scipy's order. */
function lfilter(
  b: readonly number[],
  a: readonly number[],
  zi: readonly number[],
  e: Float64Array,
): Float64Array {
  const out = new Float64Array(e.length);
  let z0 = zi[0] * e[0];
  let z1 = zi[1] * e[0];
  for (let k = 0; k < e.length; k++) {
    const x = e[k];
    const y = z0 + b[0] * x;
    z0 = z1 + b[1] * x - a[1] * y;
    z1 = b[2] * x - a[2] * y;
    out[k] = y;
  }
  return out;
}

/**
 * One series through the zero-phase high-pass over its own samples: the odd extension of
 * p = min(9, m - 1) samples at each end the flags name, forward, then backward over the reversed
 * output, reversed again and cut to the series (scipy's `filtfilt(b, a, x, padtype="odd",
 * padlen=p)` with both flags).
 */
export function displayFilter(
  x: Float64Array,
  rate: number,
  cutoffHz: number,
  padStart = true,
  padEnd = true,
): Float64Array {
  const { b, a, zi } = highpass(cutoffHz, rate);
  const m = x.length;
  const p = Math.min(PADDING, m - 1);
  const head = padStart ? p : 0;
  const tail = padEnd ? p : 0;
  const e = new Float64Array(head + m + tail);
  for (let i = 0; i < head; i++) e[i] = 2 * x[0] - x[p - i];
  e.set(x, head);
  for (let i = 0; i < tail; i++) e[head + m + i] = 2 * x[m - 1] - x[m - 2 - i];
  const forward = lfilter(b, a, zi, e).reverse();
  return lfilter(b, a, zi, forward)
    .reverse()
    .slice(head, head + m);
}

/** The matrix's channel labels and its values, components by channels, row after row. */
function readMatrix(bytes: Uint8Array, caps: PlanInput["caps"]) {
  const tsv = readTsv(bytes);
  const rows = tsv.rows.length;
  const columns = tsv.header.length;
  if (rows === 0) throw new KindRefused("empty");
  if (
    rows > caps.entries_per_dim ||
    columns > caps.entries_per_dim ||
    rows * columns > caps.cells_per_role
  ) {
    throw new KindRefused("cap_exceeded", `${rows} rows, ${columns} columns`);
  }
  const weights = new Float64Array(rows * columns);
  // Column by column from the first, each from top to bottom: the first bad cell gives the word.
  tsv.header.forEach((name, j) => {
    cells(tsv, name).forEach((text, i) => {
      weights[i * columns + j] = cellValue(text, "number") as number;
    });
  });
  return { header: [...tsv.header], weights, components: rows };
}

/** The store row of each column (`channel_set_mismatch` when a column has none, or two). */
function matchRows(
  header: readonly string[],
  labels: readonly (string | null)[],
  transform: Json,
): number[] {
  const columns = transform.columns as unknown;
  if (
    !Array.isArray(columns) ||
    columns.length !== header.length ||
    columns.some((c, j) => c !== header[j])
  ) {
    throw new KindRefused("channel_set_mismatch", "the header is not the transform's columns");
  }
  if (transform.match === "store_row") {
    const rows = transform.rows as unknown;
    if (!Array.isArray(rows) || rows.length !== header.length) {
      throw new KindRefused("channel_set_mismatch", "rows and columns differ");
    }
    return header.map((column, j) => {
      const row = rows[j] as number;
      if (!(Number.isInteger(row) && row >= 0 && row < labels.length && labels[row] === column)) {
        throw new KindRefused("channel_set_mismatch", `${column} at ${row}`);
      }
      return row;
    });
  }
  return header.map((column) => {
    const at: number[] = [];
    labels.forEach((label, row) => {
      if (label === column) at.push(row);
    });
    if (at.length !== 1) throw new KindRefused("channel_set_mismatch", `${column}: ${at.length}`);
    return at[0];
  });
}

/** Checks 2 to 13, in order; the plan of the multiply, or the first fault's word. */
export async function planActivity(input: PlanInput): Promise<PlanOutcome> {
  try {
    return { word: null, plan: await plan(input) };
  } catch (error) {
    if (error instanceof KindRefused) return { word: error.word };
    throw error;
  }
}

const ROLES = ["unmixing", "components", "badsegments"];

async function plan(input: PlanInput): Promise<ActivityPlan> {
  const { store, start, count, caps } = input;
  const view = obj(input.view);
  const parameters = obj(view.parameters);
  const transform = obj(obj(view.transform).parameters);
  const shading = obj(transform.shaded);
  const of = (role: string) =>
    obj((view.inputs as unknown[] | undefined)?.find((i) => obj(i).role === role));
  const signal = obj(of("signal").store);
  const file = (role: string) =>
    of(role).file as { location: string; size: number; sha256: string } | undefined;
  // 2. The inputs' locations: the matrix and the bad segments where the record names them, and
  // all three tables the recording's, under the stem of the recipe that wrote the view.
  const where = (refused: boolean) => {
    if (refused) throw new KindRefused("table_location_mismatch");
  };
  where(file("unmixing")?.location !== transform.matrix);
  const segments = file("badsegments");
  where(!!segments && segments.location !== (shading.files as string[] | null)?.[0]);
  const label = recipeLabel(view);
  for (const role of ROLES) {
    const at = file(role)?.location;
    where(!!at && (label === null || !tableIsRecordings(at, String(signal.recording), label)));
  }
  // 3. The decomposition's store is the signal store: its path (or recording), group and digest.
  const read = obj(parameters.decomposition_input).store;
  if (read !== undefined) {
    const r = obj(read);
    if (
      r.path !== (signal.path ?? signal.recording) ||
      r.group !== signal.group ||
      r.content_sha256 !== signal.content_sha256
    ) {
      throw new KindRefused("store_mismatch");
    }
  }
  // 4. The files, in order: the declared size within the cap (before any fetch), present, then
  // their size and SHA-256.
  for (const role of ROLES) {
    const declared = file(role);
    if (!declared) continue;
    const bytes = input.files[role];
    if (declared.size > caps.bytes_per_role) throw new KindRefused("cap_exceeded", role);
    if (!bytes) throw new KindRefused("file_missing", role);
    if (bytes.length !== declared.size) throw new KindRefused("file_size_mismatch", role);
    if ((await subtleSha256(bytes)) !== declared.sha256) {
      throw new KindRefused("file_digest_mismatch", role);
    }
  }
  // 5. The store digest: two present digests that differ refuse; either absent is not checked.
  const declared = (signal.content_sha256 as string | null | undefined) ?? null;
  const published = store.published_sha256;
  let state: ActivityPlan["state"] = "not_checked";
  if (declared !== null && published !== null) {
    if (declared !== published) throw new KindRefused("store_digest_mismatch");
    state = "matches";
  }
  // 6. The rate.
  const { rate, samples } = store;
  if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) {
    throw new KindRefused("rate_invalid", String(rate));
  }
  // 7. The window: in the store, then at most floor(max_window_s · rate) samples.
  if (!(count >= 1 && start >= 0 && start + count <= samples)) {
    throw new KindRefused("window_outside_store", `[${start}, ${start + count}) of ${samples}`);
  }
  if (count > Math.floor((parameters.max_window_s as number) * rate)) {
    throw new KindRefused("window_too_long", `${count} samples`);
  }
  // 8. The matrix; 9. the components.
  const matrix = readMatrix(input.files.unmixing!, caps);
  const components = readTsv(input.files.components!);
  if (components.rows.length * components.header.length > caps.cells_per_role) {
    throw new KindRefused("cap_exceeded", `${components.rows.length} component rows`);
  }
  if (!components.header.includes("component"))
    throw new KindRefused("column_missing", "component");
  const labels = cells(components, "component");
  if (labels.length !== matrix.components) {
    throw new KindRefused("coords_length", `${labels.length} != ${matrix.components}`);
  }
  // 10. The bad segments: the rows labeled `shaded.label`, or a word when none is.
  const shaded = !segments
    ? null
    : readSegments(readTsv(input.files.badsegments!), caps.cells_per_role)
        .filter((row) => row.label === shading.label)
        .map(({ onset, duration }) => ({ onset, duration }));
  const notes: string[] = [];
  if (!shaded?.length) {
    if (input.burstsRepaired === true) throw new KindRefused("label_unmatched");
    notes.push(shaded === null ? "no_bad_segment_table" : "no_shaded_rows");
  }
  // 11. The channel match; 12. the units.
  const rows = matchRows(matrix.header, store.labels, transform);
  const unit = MICROVOLTS_PER[transform.unit as string];
  if (unit === undefined) throw new KindRefused("unit_unknown", String(transform.unit));
  const factors = rows.map((row) => {
    const own = MICROVOLTS_PER[store.units[row] ?? ""];
    if (own === undefined) throw new KindRefused("unit_unknown", `row ${row}`);
    return own / unit;
  });
  // 13. The display filter's cutoff.
  const highpassHz = obj(parameters.display_filter).highpass_hz as number;
  if (!(highpassHz > 0 && highpassHz < rate / 2)) {
    throw new KindRefused("filter_out_of_range", `${highpassHz} Hz at ${rate} Hz`);
  }
  const c = Math.ceil(rate);
  const before = Math.min(c, start);
  const after = Math.min(c, samples - (start + count));
  return {
    state,
    components: labels,
    channels: matrix.header,
    rows,
    factors,
    weights: matrix.weights,
    shaded: shaded ?? [],
    notes,
    start,
    count,
    before,
    after,
    padStart: start - before === 0,
    padEnd: start + count + after === samples,
    rate,
    highpassHz,
  };
}

/**
 * The activations over the plan's window, and the same filtered for display.
 *
 * `digital` holds the stored integers of the plan's rows, column after column (column j is store
 * row `rows[j]`), each over the stretch `[start - before, start + count + after)`; `scale` and
 * `offset` are those rows' own, by column.
 */
export function computeActivity(
  plan: ActivityPlan,
  digital: ArrayLike<number>,
  scale: readonly number[],
  offset: readonly number[],
): ActivityResult {
  const { weights, factors, start, count, before, after, rate } = plan;
  const columns = factors.length;
  const components = weights.length / columns;
  const m = before + count + after;
  if (digital.length !== columns * m) {
    throw new RangeError(`${digital.length} samples for ${columns} rows of ${m}`);
  }
  // x'[j][k] = (d · scale + offset) · f_j: two roundings, then the factor.
  const x = new Float64Array(columns * m);
  for (let j = 0; j < columns; j++) {
    for (let k = 0; k < m; k++) {
      x[j * m + k] = (digital[j * m + k] * scale[j] + offset[j]) * factors[j];
    }
  }
  const activations = new Float64Array(components * count);
  const filtered = new Float64Array(components * count);
  const series = new Float64Array(m);
  for (let i = 0; i < components; i++) {
    // Summed in column order from column 0's product.
    const w0 = weights[i * columns];
    for (let k = 0; k < m; k++) series[k] = w0 * x[k];
    for (let j = 1; j < columns; j++) {
      const w = weights[i * columns + j];
      const at = j * m;
      for (let k = 0; k < m; k++) series[k] = series[k] + w * x[at + k];
    }
    activations.set(series.subarray(before, before + count), i * count);
    const shown = displayFilter(series, rate, plan.highpassHz, plan.padStart, plan.padEnd);
    filtered.set(shown.subarray(before, before + count), i * count);
  }
  const time = new Float64Array(count);
  for (let k = 0; k < count; k++) time[k] = (start + k) / rate;
  return { activations, filtered, time };
}
