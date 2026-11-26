/**
 * The model a renderer builds from a view declaration and its files before it draws anything
 * (`nemar.kinds-models.v1`; neuroschema 0.6.0 `docs/views/generic-kinds.md` and
 * `docs/views/sensor-field.md`, The model; website ADR 0035 decisions 3 and 4).
 *
 * `buildModel` follows `neuroschema.views.models.build_model` step for step, and
 * `test/quality-views-models.test.ts` holds it to every case of `views/vectors/kinds-models.v1.json`:
 *
 * 1. The declaration is checked (`guards.ts`); an invalid one is refused, `declaration_invalid`,
 *    and nothing is drawn or offered.
 * 2. The drawing is chosen by the renderer rule (`kinds.ts`): the kind, its base, or the table.
 * 3. The kind's model is built from the files. Each file the model reads is checked before it is
 *    parsed: its declared size against the cap on bytes before it is fetched (`cap_exceeded`, the
 *    view falls back), then present, of its size and of its SHA-256 (`file_missing`,
 *    `file_size_mismatch`, `file_digest_mismatch`: nothing is drawn, every other file is offered).
 * 4. When the kind's rules refuse the files, the fallback's tables are built instead, and `refused`
 *    keeps the kind and the word, so the page can say why.
 *
 * Every number in a model is a stored value read from a file (or a rule's arithmetic on them: a
 * histogram's totals and densities, a heatmap's `absmax` limits), and every readout prints the
 * stored text. A scalp map's sensors are placed here (`placement`); its maps are drawn in the worker,
 * and with `mapOutcome` (the tests) each map's word and notes are computed here too.
 */

import { type Drawing, HISTOGRAM_CONTENT, TABLE, type ViewChecks } from "./checks";
import type { Montage } from "./montages";
import {
  type CellType,
  KindRefused,
  MAX_SAFE,
  type Tsv,
  cellValue,
  cells,
  numberText,
  readJson,
  readTsv,
} from "./read";
import { MONTAGE_NAMES, clean, finish, typeClass } from "./sensor-names";
import { type ColumnDecl, declaredColumns, typedColumn } from "./tsv";
import { subtleSha256 } from "./verify";
// A named import, so the build keeps only the caps of the registry.
import { caps as registryCaps } from "./vocabulary/registry.json";

export interface Caps {
  readonly bytes_per_role: number;
  readonly entries_per_dim: number;
  readonly cells_per_role: number;
}
export const CAPS: Caps = registryCaps;

// ── Declarations ────────────────────────────────────────────────────────

export type { ColumnDecl };
export type CoordsDecl =
  | { readonly column: string }
  | { readonly header: true }
  | { readonly role: string; readonly column: string };
export interface DimDecl {
  readonly name: string;
  readonly axis: "rows" | "columns";
  readonly type: CellType;
  readonly unit?: string;
  readonly coords: CoordsDecl;
}
export interface DataDecl {
  readonly role: string;
  readonly location: string;
  readonly format: string;
  readonly size: number;
  readonly sha256: string;
  readonly columns?: readonly ColumnDecl[];
  readonly dims?: readonly DimDecl[];
  readonly coordinate_system?: string;
  readonly position_source?: "measured" | "template";
  readonly montage?: string;
  readonly cap_model?: string;
  readonly reference?: string;
}
export interface FileDecl {
  readonly location: string;
  readonly size: number;
  readonly sha256: string;
}
export interface ViewDecl {
  readonly key: string;
  readonly kind: string;
  readonly kind_version: number;
  readonly base?: string;
  readonly base_version?: number;
  readonly caption: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly data?: readonly DataDecl[];
  readonly inputs?: readonly { readonly role: string; readonly file?: FileDecl }[];
}

// ── Models ──────────────────────────────────────────────────────────────

export interface Download {
  readonly role: string;
  readonly location: string;
  readonly size: number;
  readonly sha256: string;
}
interface Axis {
  readonly dim: string | null;
  readonly type: string | null;
  readonly unit: string | null;
}
export interface TableModel {
  readonly type: "table";
  readonly columns: readonly { name: string; type: CellType; unit: string | null }[];
  readonly rows: readonly (readonly string[])[];
}
export interface LinesModel {
  readonly type: "lines";
  readonly x: Axis & { column: string; values: number[]; text: string[] };
  readonly y: { unit: string | null; min: number; max: number };
  readonly series: Axis & {
    items: { label: string; column: string; values: number[]; text: string[] }[];
  };
}
export interface HeatmapModel {
  readonly type: "heatmap";
  readonly rows: Axis & { labels: string[] };
  readonly columns: Axis & { labels: string[]; names: string[] };
  readonly unit: string | null;
  readonly values: number[][];
  readonly text: string[][];
  readonly limits: { rule: "minmax" | "absmax"; min: number; max: number };
}
export interface Bin {
  readonly label: string;
  readonly count: number;
  readonly lower?: number;
  readonly upper?: number;
  readonly upper_closed?: boolean;
  readonly width?: number;
  readonly density?: number;
}
export interface HistogramModel {
  readonly type: "histogram";
  readonly bins: "edges" | "categories";
  readonly heights: "count" | "density";
  readonly unit: string | null;
  readonly items: Bin[];
  readonly underflow: { label: string; count: number } | null;
  readonly overflow: { label: string; count: number } | null;
  readonly missing: { label: string; count: number } | null;
  readonly total: number;
  readonly max_count: number;
  readonly max_density: number | null;
}
export interface Placement {
  source: "layout" | "positions" | "names";
  role: string | null;
  coordinate_system: string;
  position_source: string;
  montage: string | null;
  unused_positions: string | null;
  reference: string | null;
  word: string | null;
}
export interface SensorFieldMapItem {
  readonly label: string;
  readonly values: number[];
  readonly text: string[];
  /** The word that takes this map's place, or null when it is drawn (or not yet drawn). */
  word: string | null;
  notes: string[];
}
export interface SensorFieldModel {
  readonly type: "sensor-field";
  readonly limits: "absmax" | "minmax";
  readonly unit: string | null;
  readonly placement: Placement;
  readonly sensors: Axis & {
    axis: "rows" | "columns";
    labels: string[];
    types: string[] | null;
    drawn: boolean[];
    electrodes: (string | null)[] | null;
    theta_deg: (number | null)[] | null;
    radius: (number | null)[] | null;
    x: (number | null)[] | null;
    y: (number | null)[] | null;
    z: (number | null)[] | null;
  };
  readonly maps: Axis & { items: SensorFieldMapItem[] };
}
export interface FallbackModel {
  readonly type: "fallback";
  readonly tables: {
    readonly role: string;
    readonly location: string;
    readonly header: string[];
    readonly rows: string[][];
  }[];
}
export type KindModel = TableModel | LinesModel | HeatmapModel | HistogramModel | SensorFieldModel;
export type Model = KindModel | FallbackModel;

/** Where a scalp map's drawn rows are placed: theta and radius for every sensor row, NaN for a row
 *  with no place. Not part of the model (whose numbers are stored values); the maps are drawn from
 *  it. */
export interface SensorLayoutPlaces {
  readonly thetaDeg: Float64Array;
  readonly radius: Float64Array;
}

export interface BuiltModel {
  readonly drawing: Drawing;
  readonly refused: { kind: string; kind_version: number; word: string } | null;
  readonly downloads: Download[];
  readonly model: Model;
  /** For a scalp map that places its sensors: where. */
  readonly layout?: SensorLayoutPlaces;
}

/** Nothing is drawn: an invalid declaration, or a file not the one recorded. */
export class ViewRefused extends Error {
  downloads: Download[] = [];
  constructor(
    readonly word: string,
    readonly location: string | null = null,
  ) {
    super(location ? `${word}: ${location}` : word);
    this.name = "ViewRefused";
  }
}

// ── Placing sensors by name (nemar.sensor-labels.v1) ─────────────────────

export interface NamePlacement {
  readonly outcome: "placed" | "refused";
  /** The refusal's word when `outcome` is `refused`. */
  readonly reason: string | null;
  readonly montage: string | null;
  /** The reference channel's name, as given, when the algorithm reports one. */
  readonly reference: string | null;
  /** One per channel given, in order: its montage electrode and RAS position in meters, or nulls. */
  readonly channels: readonly {
    readonly name: string;
    readonly electrode: string | null;
    readonly position: readonly [number, number, number] | null;
  }[];
}
/** `nemar.sensor-labels.v1`'s `infer_positions`: phase W2b provides it. */
export type PlaceByNames = (
  channels: readonly { readonly name: string; readonly type: string | null }[],
  inputs: { readonly cap_model: string | null; readonly reference: string | null },
) => Promise<NamePlacement>;

/** The word a scalp map placed by name shows while this site has no `nemar.sensor-labels.v1`
 *  (phase W2b): the site's own, not the specification's. */
export const LABELS_PENDING = "labels_pending";

// ── Options ─────────────────────────────────────────────────────────────

/** A file's bytes by its declaration, or null when it is not there. */
export type FileSource = (file: FileDecl) => Promise<Uint8Array | null>;

export interface ModelOptions {
  /** The declaration and content checks: the worker's (`SensorFieldClient.checks()`) on a page,
   *  `localChecks` from `kinds.ts` in the tests. */
  readonly checks: ViewChecks;
  readonly caps?: Caps;
  /** The montage `name` (`montage-loader.ts` in the browser). */
  readonly montage: (name: string) => Promise<Montage>;
  /** The SHA-256 of bytes, lowercase hex; SubtleCrypto's by default. */
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
  readonly placeByNames?: PlaceByNames;
  /** Called once with a scalp map's drawn places as soon as its layout file is read (`warmInput`),
   *  before its values may have arrived: the page prepares the geometry with it. */
  readonly onLayout?: (places: {
    readonly thetaDeg: Float64Array;
    readonly radius: Float64Array;
  }) => void;
  /**
   * Run `nemar.sensor-field.v1` on one map for its word and notes (the tests pass the algorithm,
   * `sensorField`). Without it each map's word and notes are left null and empty for the worker's
   * answer, so the page's main thread never loads the interpolation.
   */
  readonly mapOutcome?: (
    thetaDeg: number[],
    radius: number[],
    values: number[],
  ) => { readonly word: string | null; readonly notes: readonly string[] };
}

/** The page's SHA-256 (`verify.ts`), named here too for the callers that build models. */
export { subtleSha256 };

class Reader {
  private readonly tsvs = new Map<string, Tsv>();
  private readonly digests = new Map<string, Promise<string>>();
  private readonly bytes = new Map<string, Promise<Uint8Array | null>>();

  constructor(
    readonly view: ViewDecl,
    private readonly source: FileSource,
    readonly caps: Caps,
    private readonly hash: (bytes: Uint8Array) => Promise<string>,
    readonly checks: ViewChecks,
  ) {}

  /** Start fetching a file the model will read, so it downloads beside the others. */
  prefetch(entry: FileDecl | null): void {
    if (!entry || entry.size > this.caps.bytes_per_role || this.bytes.has(entry.location)) return;
    const pending = this.source(entry);
    // A prefetched file the model never reads (it was refused first) must not leave an unhandled
    // rejection; a reader that does read it still gets the rejection.
    pending.catch(() => {});
    this.bytes.set(entry.location, pending);
  }

  entry(role: string): DataDecl | null {
    const found = (this.view.data ?? []).filter((entry) => entry.role === role);
    return found.length === 1 ? found[0] : null;
  }

  async verified(entry: FileDecl): Promise<Uint8Array> {
    const { location } = entry;
    if (entry.size > this.caps.bytes_per_role) {
      throw new KindRefused("cap_exceeded", `${location}: ${entry.size} bytes`);
    }
    let pending = this.bytes.get(location);
    if (!pending) {
      pending = this.source(entry);
      this.bytes.set(location, pending);
    }
    const data = await pending;
    if (data === null) throw new ViewRefused("file_missing", location);
    if (data.length !== entry.size) throw new ViewRefused("file_size_mismatch", location);
    let digest = this.digests.get(location);
    if (digest === undefined) {
      digest = this.hash(data);
      this.digests.set(location, digest);
    }
    if ((await digest) !== entry.sha256) throw new ViewRefused("file_digest_mismatch", location);
    return data;
  }

  async tsv(entry: DataDecl): Promise<Tsv> {
    const data = await this.verified(entry);
    let tsv = this.tsvs.get(entry.location);
    if (!tsv) {
      tsv = readTsv(data);
      this.tsvs.set(entry.location, tsv);
    }
    return tsv;
  }
}

// ── The generic kinds ───────────────────────────────────────────────────

const declared = (entry: DataDecl, tsv: Tsv): ColumnDecl[] => declaredColumns(entry.columns, tsv);

/** A coordinate column's declared type and unit are its dimension's. */
function match(dim: DimDecl, column: ColumnDecl): void {
  if (
    column.type !== dim.type ||
    (column.unit !== undefined && column.unit !== (dim.unit ?? null))
  ) {
    throw new KindRefused("coords_mismatch", dim.name);
  }
}

function coordinateColumn(dim: DimDecl, columns: readonly ColumnDecl[]): ColumnDecl {
  const name = (dim.coords as { column: string }).column;
  const column = columns.find((c) => c.name === name);
  if (!column) throw new KindRefused("coords_unresolved", `${dim.name}: ${name}`);
  match(dim, column);
  return column;
}

function valueUnit(columns: readonly ColumnDecl[]): string | null {
  for (const column of columns) {
    if (column.type !== "number" && column.type !== "integer") {
      throw new KindRefused("value_type", column.name);
    }
  }
  const units = new Set(columns.map((column) => column.unit ?? null));
  if (units.size > 1) throw new KindRefused("value_units_differ");
  return units.size === 0 ? null : [...units][0];
}

function checkCaps(caps: Caps, rows: number, values: number, read: number): void {
  if (
    rows > caps.entries_per_dim ||
    values > caps.entries_per_dim ||
    rows * read > caps.cells_per_role
  ) {
    throw new KindRefused("cap_exceeded", `${rows} rows, ${values} value columns`);
  }
}

const parseColumn = typedColumn;

async function roleLabels(reader: Reader, dim: DimDecl, count: number): Promise<string[]> {
  const { role, column: name } = dim.coords as { role: string; column: string };
  const other = reader.entry(role);
  if (!other || other.format !== "tsv") {
    throw new KindRefused("coords_unresolved", `${dim.name}: role ${role}`);
  }
  const column = (other.columns ?? []).find((c) => c.name === name);
  if (!column) throw new KindRefused("coords_unresolved", `${dim.name}: ${role}.${name}`);
  const tsv = await reader.tsv(other);
  if (tsv.rows.length * tsv.header.length > reader.caps.cells_per_role) {
    throw new KindRefused("cap_exceeded", `${role}: ${tsv.rows.length} rows`);
  }
  if (!tsv.header.includes(name)) throw new KindRefused("column_missing", `${role}.${name}`);
  match(dim, column);
  const texts = cells(tsv, name);
  if (texts.length !== count) {
    throw new KindRefused("coords_length", `${dim.name}: ${texts.length} != ${count}`);
  }
  for (const text of texts) cellValue(text, dim.type);
  return texts;
}

/** Start the files of the roles whose columns label this entry's dimensions (a scalp map's
 *  layout), so the small layout never waits behind the values. */
function prefetchCoordinateRoles(reader: Reader, entry: DataDecl): void {
  for (const dim of entry.dims ?? []) {
    if (!("role" in dim.coords)) continue;
    const other = reader.entry(dim.coords.role);
    if (other?.format === "tsv") reader.prefetch(other);
  }
}

const axisOf = (dim: DimDecl): Axis => ({ dim: dim.name, type: dim.type, unit: dim.unit ?? null });
const NO_AXIS: Axis = { dim: null, type: null, unit: null };

function twoDims(entry: DataDecl): [DimDecl, DimDecl] {
  const dims = entry.dims ?? [];
  return [dims.find((d) => d.axis === "rows")!, dims.find((d) => d.axis === "columns")!];
}

function minOf(values: number[]): number {
  let low = Number.POSITIVE_INFINITY;
  for (const v of values) if (v < low) low = v;
  return low;
}
function maxOf(values: number[]): number {
  let high = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > high) high = v;
  return high;
}

async function tableModel(reader: Reader): Promise<TableModel> {
  const entry = reader.entry("table")!;
  const tsv = await reader.tsv(entry);
  const columns = declared(entry, tsv);
  if (tsv.rows.length * columns.length > reader.caps.cells_per_role) {
    throw new KindRefused("cap_exceeded", `${tsv.rows.length} rows`);
  }
  for (const column of columns) parseColumn(tsv, column);
  const indexes = columns.map((c) => tsv.header.indexOf(c.name));
  return {
    type: "table",
    columns: columns.map((c) => ({ name: c.name, type: c.type, unit: c.unit ?? null })),
    rows: tsv.rows.map((row) => indexes.map((i) => row[i])),
  };
}

async function linesModel(reader: Reader): Promise<LinesModel> {
  const entry = reader.entry("values")!;
  prefetchCoordinateRoles(reader, entry);
  const tsv = await reader.tsv(entry);
  const columns = declared(entry, tsv);
  const [xDim, seriesDim] = twoDims(entry);
  const xColumn = coordinateColumn(xDim, columns);
  const valueColumns = columns.filter((c) => c.name !== xColumn.name);
  const unit = valueUnit(valueColumns);
  if (tsv.rows.length === 0 || valueColumns.length === 0) throw new KindRefused("empty");
  checkCaps(reader.caps, tsv.rows.length, valueColumns.length, columns.length);
  const x = parseColumn(tsv, xColumn);
  const series = valueColumns.map((column) => parseColumn(tsv, column));
  for (let i = 1; i < x.values.length; i++) {
    if (!(x.values[i] > x.values[i - 1])) throw new KindRefused("x_not_increasing");
  }
  const labels =
    "header" in seriesDim.coords
      ? valueColumns.map((c) => c.name)
      : await roleLabels(reader, seriesDim, valueColumns.length);
  const every = series.flatMap((s) => s.values);
  return {
    type: "lines",
    x: { ...axisOf(xDim), column: xColumn.name, values: x.values, text: x.text },
    y: { unit, min: minOf(every), max: maxOf(every) },
    series: {
      ...axisOf(seriesDim),
      items: valueColumns.map((column, i) => ({
        label: labels[i],
        column: column.name,
        values: series[i].values,
        text: series[i].text,
      })),
    },
  };
}

async function heatmapModel(reader: Reader, own: boolean): Promise<HeatmapModel> {
  const entry = reader.entry("values")!;
  prefetchCoordinateRoles(reader, entry);
  const tsv = await reader.tsv(entry);
  const columns = declared(entry, tsv);
  const [rowDim, columnDim] = twoDims(entry);
  const labelColumn = "role" in rowDim.coords ? null : coordinateColumn(rowDim, columns);
  const valueColumns = columns.filter((c) => c !== labelColumn);
  const unit = valueUnit(valueColumns);
  if (tsv.rows.length === 0 || valueColumns.length === 0) throw new KindRefused("empty");
  checkCaps(reader.caps, tsv.rows.length, valueColumns.length, columns.length);
  let rowLabels = labelColumn ? parseColumn(tsv, labelColumn).text : null;
  const parsed = valueColumns.map((column) => parseColumn(tsv, column));
  rowLabels ??= await roleLabels(reader, rowDim, tsv.rows.length);
  const columnLabels =
    "header" in columnDim.coords
      ? valueColumns.map((c) => c.name)
      : await roleLabels(reader, columnDim, valueColumns.length);
  const values = tsv.rows.map((_, r) => parsed.map((p) => p.values[r]));
  const text = tsv.rows.map((_, r) => parsed.map((p) => p.text[r]));
  const parameters = own ? (reader.view.parameters ?? {}) : {};
  const rule = parameters.limits === "absmax" ? "absmax" : "minmax";
  const every = values.flat();
  let low: number;
  let high: number;
  if (rule === "absmax") {
    const largest = maxOf(every.map(Math.abs));
    [low, high] = largest ? [-largest, largest] : [0, 0];
  } else {
    [low, high] = [minOf(every), maxOf(every)];
  }
  return {
    type: "heatmap",
    rows: { ...axisOf(rowDim), labels: rowLabels },
    columns: { ...axisOf(columnDim), labels: columnLabels, names: valueColumns.map((c) => c.name) },
    unit,
    values,
    text,
    limits: { rule, min: low, max: high },
  };
}

/** Bins are of equal width when every width differs from the first by at most this share of the
 *  widest. */
export const EQUAL_WIDTHS = 1e-9;

function checkTotal(total: number): void {
  if (total > MAX_SAFE) throw new KindRefused("cap_exceeded", `total ${total}`);
}
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

async function histogramModel(reader: Reader): Promise<HistogramModel> {
  const entry = reader.entry("histogram")!;
  const content = readJson(await reader.verified(entry));
  if (!(await reader.checks.content(HISTOGRAM_CONTENT, content))) {
    throw new KindRefused("content_invalid");
  }
  const c = content as {
    counts: number[];
    categories?: string[];
    edges?: number[];
    underflow?: number;
    overflow?: number;
    unit?: string;
    missing?: number;
  };
  const counts = c.counts.map((n) => n + 0);
  const missing = c.missing === undefined ? null : { label: "missing", count: c.missing + 0 };
  const lacking = missing?.count ?? 0;
  if (c.categories) {
    if (counts.length !== c.categories.length) throw new KindRefused("counts_length");
    checkTotal(sum(counts) + lacking);
    return {
      type: "histogram",
      bins: "categories",
      heights: "count",
      unit: null,
      items: c.categories.map((label, i) => ({ label, count: counts[i] })),
      underflow: null,
      overflow: null,
      missing,
      total: sum(counts),
      max_count: maxOf(counts),
      max_density: null,
    };
  }
  const edges = c.edges!.map((e) => e + 0);
  for (let i = 1; i < edges.length; i++) {
    if (!(edges[i] > edges[i - 1])) throw new KindRefused("edges_not_increasing");
  }
  if (counts.length !== edges.length - 1) throw new KindRefused("counts_length");
  const under = c.underflow! + 0;
  const over = c.overflow! + 0;
  checkTotal(sum(counts) + under + over + lacking);
  const widths = counts.map((_, i) => edges[i + 1] - edges[i]);
  if (!widths.every(Number.isFinite)) throw new KindRefused("cap_exceeded", "a bin too wide");
  const widest = maxOf(widths);
  const equal = widths.every((w) => Math.abs(w - widths[0]) <= EQUAL_WIDTHS * widest);
  const last = counts.length - 1;
  const items: Bin[] = counts.map((count, i) => ({
    label: `[${numberText(edges[i])}, ${numberText(edges[i + 1])}${i === last ? "]" : ")"}`,
    lower: edges[i],
    upper: edges[i + 1],
    upper_closed: i === last,
    count,
    width: widths[i],
    density: count / widths[i],
  }));
  if (!items.every((item) => Number.isFinite(item.density))) {
    throw new KindRefused("cap_exceeded", "a density beyond binary64");
  }
  return {
    type: "histogram",
    bins: "edges",
    heights: equal ? "count" : "density",
    unit: c.unit ?? null,
    items,
    underflow: { label: `< ${numberText(edges[0])}`, count: under },
    overflow: { label: `> ${numberText(edges[edges.length - 1])}`, count: over },
    missing,
    total: sum(counts) + under + over,
    max_count: maxOf([...counts, under, over]),
    max_density: maxOf(items.map((item) => item.density!)),
  };
}

// ── nemar.sensor-field ──────────────────────────────────────────────────

/** Coordinate systems no scalp map is drawn in (`frame_not_scalp`). */
export const NOT_SCALP_FRAMES: ReadonlySet<string> = new Set(["Pixels", "ACPC", "ScanRAS"]);
const PLACE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  layout: ["theta_deg", "radius"],
  positions: ["x", "y", "z"],
};
const NO_PLACE = "n/a";

/** Which sensor rows a scalp map draws, by their types (sensor-field.md, Sensors). */
export function drawnRows(
  types: readonly string[] | null,
  count: number,
  measured: boolean,
): boolean[] {
  const classes = Array.from({ length: count }, (_, k) => typeClass(types ? types[k] : null));
  if (!measured && classes.every((c) => c === "untyped")) return classes.map(() => true);
  return classes.map((c) => c === "eeg");
}

interface Sensors {
  readonly labels: string[];
  readonly role: "layout" | "positions" | null;
  readonly entry: DataDecl | null;
  readonly places: Record<string, (number | null)[]> | null;
  readonly types: string[] | null;
}

async function sensorRole(
  reader: Reader,
  dim: DimDecl,
  count: number,
  names: string[] | null,
): Promise<Sensors> {
  const { role, column: name } = dim.coords as { role: string; column: string };
  const entry = reader.entry(role);
  if (!entry || entry.format !== "tsv" || !(role in PLACE_COLUMNS)) {
    throw new KindRefused("coords_unresolved", `${dim.name}: role ${role}`);
  }
  const column = (entry.columns ?? []).find((c) => c.name === name);
  if (!column) throw new KindRefused("coords_unresolved", `${dim.name}: ${role}.${name}`);
  const tsv = await reader.tsv(entry);
  const columns = declared(entry, tsv);
  match(dim, column);
  if (tsv.rows.length !== count) {
    throw new KindRefused("coords_length", `${role}: ${tsv.rows.length} != ${count}`);
  }
  if (tsv.rows.length * columns.length > reader.caps.cells_per_role) {
    throw new KindRefused("cap_exceeded", `${role}: ${tsv.rows.length} rows`);
  }
  let types: string[] | null = null;
  const places: Record<string, (number | null)[]> = {};
  for (const c of columns) {
    const texts = cells(tsv, c.name);
    if (PLACE_COLUMNS[role].includes(c.name)) {
      places[c.name] = texts.map((t) =>
        t === NO_PLACE ? null : (cellValue(t, "number") as number),
      );
      continue;
    }
    const type = c.name === name ? dim.type : c.type;
    for (const t of texts) cellValue(t, type);
    if (c.name === "sensor_type") types = texts;
  }
  const labels = cells(tsv, name);
  if (names !== null) checkSensorNames(role, labels, names);
  return { labels, role: role as "layout" | "positions", entry, places, types };
}

/** `sensors_mismatch`: a role's name cells, top to bottom, are the value columns' names. */
export function checkSensorNames(
  role: string,
  labels: readonly string[],
  names: readonly string[],
): void {
  if (labels.length !== names.length || labels.some((label, i) => label !== names[i])) {
    throw new KindRefused("sensors_mismatch", `${role}: names differ from the header`);
  }
}

function labelColumn(dims: readonly DimDecl[], columns: readonly ColumnDecl[]): ColumnDecl | null {
  let column: ColumnDecl | null = null;
  for (const dim of dims) {
    const coords = dim.coords;
    if ("role" in coords) continue;
    if ("header" in coords) {
      if (dim.axis !== "columns") throw new KindRefused("coords_unresolved", `${dim.name}: header`);
    } else if (dim.axis !== "rows") {
      throw new KindRefused("coords_unresolved", `${dim.name}: column`);
    } else {
      column = coordinateColumn(dim, columns);
    }
  }
  return column;
}

type MapSpec = [label: string, values: number[], text: string[]];

async function sensorFieldModel(
  reader: Reader,
  own: boolean,
  options: ModelOptions,
): Promise<{ model: SensorFieldModel; layout?: SensorLayoutPlaces }> {
  const entry = reader.entry("values")!;
  prefetchCoordinateRoles(reader, entry);
  announceLayout(reader, options);
  const tsv = await reader.tsv(entry);
  const columns = declared(entry, tsv);
  const dimsDeclared = entry.dims ?? [];
  const sensorDim = dimsDeclared.find((d) => d.name === "sensor")!;
  const mapsDim = dimsDeclared.find((d) => d !== sensorDim) ?? null;
  const dims = mapsDim ? [sensorDim, mapsDim] : [sensorDim];
  const label = labelColumn(dims, columns);
  const valueColumns = columns.filter((c) => c !== label);
  const unit = valueUnit(valueColumns);
  if (tsv.rows.length === 0 || valueColumns.length === 0) throw new KindRefused("empty");
  checkCaps(reader.caps, tsv.rows.length, valueColumns.length, columns.length);
  const labelTexts = label ? parseColumn(tsv, label).text : null;
  const parsed = valueColumns.map((column) => parseColumn(tsv, column));
  const names = valueColumns.map((c) => c.name);
  const counts = { rows: tsv.rows.length, columns: valueColumns.length };
  let sensors: Sensors | null = null;
  let mapLabels: string[] | null = null;
  for (const dim of [...dims].sort(
    (a, b) => Number(a.axis !== "rows") - Number(b.axis !== "rows"),
  )) {
    const coords = dim.coords;
    if (dim === sensorDim && "role" in coords) {
      sensors = await sensorRole(
        reader,
        dim,
        counts[dim.axis],
        dim.axis === "columns" ? names : null,
      );
    } else if (dim === sensorDim) {
      sensors = {
        labels: "header" in coords ? names : labelTexts!,
        role: null,
        entry: null,
        places: null,
        types: null,
      };
    } else if ("role" in coords) {
      mapLabels = await roleLabels(reader, dim, counts[dim.axis]);
    } else {
      mapLabels = "header" in coords ? names : labelTexts;
    }
  }
  const alongRows = sensorDim.axis === "rows";
  mapLabels ??= alongRows ? names : Array.from({ length: counts.rows }, (_, k) => String(k + 1));
  const maps: MapSpec[] = alongRows
    ? parsed.map((p, m) => [mapLabels![m], p.values, p.text])
    : mapLabels.map((m, k) => [m, parsed.map((p) => p.values[k]), parsed.map((p) => p.text[k])]);
  const parameters = own ? (reader.view.parameters ?? {}) : {};
  const limits = parameters.limits === "minmax" ? "minmax" : "absmax";
  const labelEntry: Partial<DataDecl> = (sensors!.role ? sensors!.entry : entry) ?? {};
  const inputs = {
    cap_model: typeof labelEntry.cap_model === "string" ? labelEntry.cap_model : null,
    reference: typeof labelEntry.reference === "string" ? labelEntry.reference : null,
  };
  return placeSensors(sensors!, maps, limits, unit, sensorDim, mapsDim, inputs, options);
}

const nanOf = (values: readonly (number | null)[]): number[] =>
  values.map((v) => (v === null ? Number.NaN : v));

/** A scalp map's placement and maps (sensor-field.md, The model). */
async function placeSensors(
  sensors: Sensors,
  maps: MapSpec[],
  limits: "absmax" | "minmax",
  unit: string | null,
  sensorDim: DimDecl,
  mapsDim: DimDecl | null,
  inputs: { cap_model: string | null; reference: string | null },
  options: ModelOptions,
): Promise<{ model: SensorFieldModel; layout?: SensorLayoutPlaces }> {
  const count = sensors.labels.length;
  const entry: Partial<DataDecl> = sensors.entry ?? {};
  const measured = entry.position_source === "measured";
  let drawn = drawnRows(sensors.types, count, measured);
  let rows = drawn.flatMap((d, k) => (d ? [k] : []));
  const namedEeg =
    sensors.types !== null && rows.every((k) => typeClass(sensors.types![k]) === "eeg");
  const placement: Placement = {
    source: sensors.role ?? "names",
    role: sensors.role,
    coordinate_system: entry.coordinate_system ?? "n/a",
    position_source: entry.position_source ?? "template",
    montage: entry.montage ?? null,
    unused_positions: null,
    reference: null,
    word: null,
  };
  const places: Pick<
    SensorFieldModel["sensors"],
    "electrodes" | "theta_deg" | "radius" | "x" | "y" | "z"
  > = { electrodes: null, theta_deg: null, radius: null, x: null, y: null, z: null };
  let layout: [number[], number[]] | null = null;
  const montage = entry.montage ?? null;
  const project = async (
    xyz: (readonly [number, number, number] | readonly number[])[],
    frame: string,
    montageName: string | null,
    placedRows: number[],
  ): Promise<[number[], number[]] | { word: string }> => {
    // A montage views/montages does not hold is refused by the projection (`frame_unknown`)
    // before any center is needed, so only a montage it holds is loaded.
    const center =
      montageName !== null && MONTAGE_NAMES.includes(montageName)
        ? (await options.montage(montageName)).center
        : undefined;
    // Loaded only for a view placed by positions, so other views never fetch it.
    const { sensorLayout } = await import("./sensor-layout");
    const result = sensorLayout(
      { x: xyz.map((p) => p[0]), y: xyz.map((p) => p[1]), z: xyz.map((p) => p[2]) },
      frame,
      {
        montage: montageName,
        names: placedRows.map((k) => sensors.labels[k]),
        sensorTypes: sensors.types ? placedRows.map((k) => sensors.types![k]) : null,
        montageCenter: (name) => (name === montageName ? center : undefined),
      },
    );
    if (result.kind === "refused") return { word: result.word };
    const theta = new Array<number>(count).fill(Number.NaN);
    const radius = new Array<number>(count).fill(Number.NaN);
    placedRows.forEach((k, i) => {
      theta[k] = result.layout.thetaDeg[i];
      radius[k] = result.layout.radius[i];
    });
    return [theta, radius];
  };

  if (entry.coordinate_system !== undefined && NOT_SCALP_FRAMES.has(entry.coordinate_system)) {
    placement.word = "frame_not_scalp";
  } else if (rows.length === 0) {
    placement.word = "no_eeg_sensors";
  } else if (
    sensors.role === "layout" &&
    entry.position_source === "template" &&
    !MONTAGE_NAMES.includes(montage ?? "")
  ) {
    placement.word = "montage_unknown";
  } else if (
    entry.position_source === "template" &&
    montage !== null &&
    MONTAGE_NAMES.includes(montage) &&
    !(await templateNamesKnown(sensors.labels, montage, options))
  ) {
    placement.word = "template_name_unknown";
  } else if (sensors.role === "layout") {
    places.theta_deg = [...sensors.places!.theta_deg];
    places.radius = [...sensors.places!.radius];
    layout = [nanOf(places.theta_deg), nanOf(places.radius)];
  } else if (sensors.role === "positions") {
    const p = sensors.places!;
    const xyz = rows.map((k) => nanOf([p.x[k], p.y[k], p.z[k]]));
    const projected = await project(xyz, entry.coordinate_system!, montage, rows);
    if ("word" in projected) {
      placement.unused_positions = projected.word;
      if (!namedEeg) placement.word = projected.word;
    } else {
      layout = projected;
      places.x = [...p.x];
      places.y = [...p.y];
      places.z = [...p.z];
    }
  }
  if (placement.word === null && layout === null) {
    const types = sensors.types ?? new Array<string | null>(count).fill(null);
    placement.source = "names";
    placement.coordinate_system = "n/a";
    placement.position_source = "template";
    if (!options.placeByNames) {
      placement.montage = null;
      placement.word = LABELS_PENDING;
    } else {
      const inference = await options.placeByNames(
        rows.map((k) => ({ name: sensors.labels[k], type: types[k] })),
        inputs,
      );
      placement.montage = inference.montage;
      if (inference.outcome !== "placed") {
        placement.word = inference.reason;
      } else {
        const electrodes = new Array<string | null>(count).fill(null);
        const xyz = new Array<readonly [number, number, number] | null>(count).fill(null);
        let reference: number | null = null;
        rows.forEach((k, i) => {
          const channel = inference.channels[i];
          if (channel.electrode !== null && channel.position !== null) {
            electrodes[k] = channel.electrode;
            xyz[k] = [channel.position[0] + 0, channel.position[1] + 0, channel.position[2] + 0];
            if (channel.name === inference.reference) reference = k;
          }
        });
        drawn = electrodes.map((e) => e !== null);
        if (reference !== null) {
          const ref: number = reference;
          placement.reference = sensors.labels[ref];
          if (maps.every(([, values]) => values[ref] === 0)) drawn[ref] = false;
        }
        rows = drawn.flatMap((d, k) => (d ? [k] : []));
        places.electrodes = electrodes;
        places.x = xyz.map((p) => (p ? p[0] : null));
        places.y = xyz.map((p) => (p ? p[1] : null));
        places.z = xyz.map((p) => (p ? p[2] : null));
        const projected = await project(
          rows.map((k) => xyz[k]!),
          "n/a",
          inference.montage,
          rows,
        );
        if ("word" in projected) placement.word = projected.word;
        else layout = projected;
      }
    }
  }
  if (placement.word !== null) {
    drawn = drawn.map(() => false);
  } else {
    const [theta, radius] = layout!;
    drawn = drawn.map((d, k) => d && Number.isFinite(theta[k]) && Number.isFinite(radius[k]));
  }
  rows = drawn.flatMap((d, k) => (d ? [k] : []));
  const items: SensorFieldMapItem[] = maps.map(([label, values, text]) => {
    let word = placement.word;
    let notes: string[] = [];
    if (word === null && options.mapOutcome) {
      const [theta, radius] = layout!;
      const outcome = options.mapOutcome(
        rows.map((k) => theta[k]),
        rows.map((k) => radius[k]),
        rows.map((k) => values[k]),
      );
      word = outcome.word;
      notes = [...outcome.notes];
    }
    return { label, values, text, word, notes };
  });
  const model: SensorFieldModel = {
    type: "sensor-field",
    limits,
    unit,
    placement,
    sensors: {
      ...axisOf(sensorDim),
      axis: sensorDim.axis,
      labels: [...sensors.labels],
      types: sensors.types ? [...sensors.types] : null,
      drawn,
      ...places,
    },
    maps: { ...(mapsDim ? axisOf(mapsDim) : NO_AXIS), items },
  };
  return layout
    ? {
        model,
        layout: { thetaDeg: Float64Array.from(layout[0]), radius: Float64Array.from(layout[1]) },
      }
    : { model };
}

/**
 * Hand the layout's drawn rows to `options.onLayout` as soon as the layout file is read and
 * checked, while the values may still download, so the page can build the geometry ahead of the
 * maps (`SensorFieldClient.prepare`). A fault is left to the model, which words it.
 */
function announceLayout(reader: Reader, options: ModelOptions): void {
  const onLayout = options.onLayout;
  const layout = reader.entry("layout");
  if (!onLayout || !layout || layout.format !== "tsv") return;
  reader.tsv(layout).then(
    (tsv) => {
      const input = warmInput(reader.view, tsv);
      if (input) onLayout(input);
    },
    () => {},
  );
}

/**
 * The places a scalp map placed by a layout draws, from the layout file alone: the same rows, in
 * the same order, as the draw request (`fieldDrawInput`), so a geometry prepared from it is the
 * one the maps' draw finds in the worker's cache. Rows typed other than EEG (or untyped, for
 * measured positions) and rows with an `n/a` place are left out. Null when the view is not placed
 * by a layout, when no row is drawn, or when the placement refuses every map.
 */
export function warmInput(
  view: ViewDecl,
  layout: Tsv,
): { readonly thetaDeg: Float64Array; readonly radius: Float64Array } | null {
  const entry = (view.data ?? []).find((e) => e.role === "layout");
  const values = (view.data ?? []).find((e) => e.role === "values");
  const sensor = values?.dims?.find((d) => d.name === "sensor");
  if (!entry || !sensor || !("role" in sensor.coords) || sensor.coords.role !== "layout") {
    return null;
  }
  if (entry.coordinate_system !== undefined && NOT_SCALP_FRAMES.has(entry.coordinate_system)) {
    return null;
  }
  if (entry.position_source === "template" && !MONTAGE_NAMES.includes(entry.montage ?? "")) {
    return null;
  }
  const declaredNames = new Set((entry.columns ?? []).map((c) => c.name));
  const place = (name: string): number[] | null => {
    if (!declaredNames.has(name) || !layout.header.includes(name)) return null;
    // The model's own cell reader: a cell it refuses refuses the warm-up too.
    return cells(layout, name).map((t) =>
      t === NO_PLACE ? Number.NaN : (cellValue(t, "number") as number),
    );
  };
  let theta: number[] | null;
  let radius: number[] | null;
  try {
    theta = place("theta_deg");
    radius = place("radius");
  } catch (error) {
    if (error instanceof KindRefused) return null;
    throw error;
  }
  if (!theta || !radius) return null;
  const types =
    declaredNames.has("sensor_type") && layout.header.includes("sensor_type")
      ? cells(layout, "sensor_type")
      : null;
  const drawn = drawnRows(types, theta.length, entry.position_source === "measured");
  const rows = drawn.flatMap((d, k) =>
    d && Number.isFinite(theta[k]) && Number.isFinite(radius[k]) ? [k] : [],
  );
  if (rows.length === 0) return null;
  return {
    thetaDeg: Float64Array.from(rows, (k) => theta[k]),
    radius: Float64Array.from(rows, (k) => radius[k]),
  };
}

/** Whether every row of template positions names an electrode of its montage, compared as
 *  `nemar.sensor-labels.v1` compares names. */
async function templateNamesKnown(
  labels: readonly string[],
  montageName: string,
  options: ModelOptions,
): Promise<boolean> {
  const montage = await options.montage(montageName);
  const keys = new Set(montage.names.map((name) => finish(clean(name))));
  return labels.every((label) => keys.has(finish(clean(label))));
}

// ── The fallback and the whole view ─────────────────────────────────────

async function fallbackModel(reader: Reader): Promise<FallbackModel> {
  const tables: FallbackModel["tables"] = [];
  for (const entry of reader.view.data ?? []) {
    if (entry.format !== "tsv") continue;
    let tsv: Tsv;
    try {
      tsv = await reader.tsv(entry);
    } catch (error) {
      if (error instanceof KindRefused) continue;
      throw error;
    }
    if (tsv.rows.length * tsv.header.length > reader.caps.cells_per_role) continue;
    tables.push({
      role: entry.role,
      location: entry.location,
      header: [...tsv.header],
      rows: tsv.rows.map((row) => [...row]),
    });
  }
  return { type: "fallback", tables };
}

export function downloadsOf(view: ViewDecl): Download[] {
  const files: [string, FileDecl][] = (view.data ?? []).map((e) => [e.role, e]);
  for (const input of view.inputs ?? []) if (input.file) files.push([input.role, input.file]);
  return files.map(([role, f]) => ({ role, location: f.location, size: f.size, sha256: f.sha256 }));
}

/**
 * Build the model a renderer draws for one view. Throws `ViewRefused` when the declaration is
 * invalid or a file it reads is missing or not the one recorded (its `downloads` offer every other
 * file, none for an invalid declaration); every other fault falls back, with `refused`.
 */
export async function buildModel(
  view: unknown,
  files: FileSource,
  options: ModelOptions,
): Promise<BuiltModel> {
  const check = await options.checks.view(view);
  if (!check.valid) throw new ViewRefused("declaration_invalid");
  const decl = view as ViewDecl;
  try {
    return await build(decl, check.drawing, check.byBase, files, options);
  } catch (error) {
    if (error instanceof ViewRefused) {
      error.downloads = downloadsOf(decl).filter((d) => d.location !== error.location);
    }
    throw error;
  }
}

type Builder = (
  reader: Reader,
  own: boolean,
  options: ModelOptions,
) => Promise<{ model: KindModel; layout?: SensorLayoutPlaces }>;

/** The model builders, by `kind@version`: a registered kind with none (a preset, or a later
 *  version) draws by its base, or as tables. */
export const BUILDERS: ReadonlyMap<string, Builder> = new Map<string, Builder>([
  ["nemar.table@1", async (reader) => ({ model: await tableModel(reader) })],
  ["nemar.lines@1", async (reader) => ({ model: await linesModel(reader) })],
  ["nemar.heatmap@1", async (reader, own) => ({ model: await heatmapModel(reader, own) })],
  ["nemar.histogram@1", async (reader) => ({ model: await histogramModel(reader) })],
  ["nemar.sensor-field@1", sensorFieldModel],
]);

const builderOf = (drawing: Drawing): Builder | undefined =>
  BUILDERS.get(`${drawing.kind}@${drawing.kind_version}`);

async function build(
  view: ViewDecl,
  chosen: Drawing,
  byBase: Drawing,
  files: FileSource,
  options: ModelOptions,
): Promise<BuiltModel> {
  let drawing = chosen;
  if (drawing.via === "kind" && !builderOf(drawing)) {
    // A preset is drawn by its base here; its own drawing (W6) builds on the base's model.
    drawing = byBase.via === "base" && builderOf(byBase) ? byBase : TABLE;
  }
  if (drawing.via === "base" && !builderOf(drawing)) drawing = TABLE;
  const reader = new Reader(
    view,
    files,
    options.caps ?? CAPS,
    options.sha256 ?? subtleSha256,
    options.checks,
  );
  let refused: BuiltModel["refused"] = null;
  let model: Model | null = null;
  let layout: SensorLayoutPlaces | undefined;
  const builder = drawing.via === "table" ? undefined : builderOf(drawing);
  if (builder) {
    try {
      const built = await builder(reader, drawing.via === "kind", options);
      model = built.model;
      layout = built.layout;
    } catch (error) {
      if (!(error instanceof KindRefused)) throw error;
      refused = { kind: drawing.kind!, kind_version: drawing.kind_version!, word: error.word };
      drawing = TABLE;
    }
  }
  model ??= await fallbackModel(reader);
  return { drawing, refused, downloads: downloadsOf(view), model, ...(layout ? { layout } : {}) };
}

/** The stored row a pointer at `x` reads: the nearest stored x, the lower on a tie. */
export function snapRow(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return 0;
  if (i >= xs.length - 1) return xs.length - 1;
  return xs[i + 1] - x < x - xs[i] ? i + 1 : i;
}

/** The bin holding `value` by the edges' rule, `[e_i, e_i+1)` and the last bin closed: -1 below
 *  the first edge, the number of bins above the last, null for NaN (which no bin holds). */
export function locateBin(edges: readonly number[], value: number): number | null {
  if (Number.isNaN(value)) return null;
  const bins = edges.length - 1;
  if (value < edges[0]) return -1;
  if (value > edges[bins]) return bins;
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo - 1, bins - 1);
}
