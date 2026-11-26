/**
 * What the panel draws of a preset beyond its base, and the checks it runs first (neuroschema 0.6.0
 * `docs/views/presets.md`; `neuroschema.views.presets` is the Python reference, and
 * `views/vectors/preset-checks.v1.json` and the `nemar.spectrum` cases of `kinds-models.v1.json`
 * hold this file to it):
 *
 * - `nemar.spectrum`: the lines of its base, and scalp maps of the sensors' values at frequency
 *   rows (`spectrumMaps`), after the layout's names are found to be the sensor columns
 *   (`sensors_mismatch`, shown as the fallback's tables);
 * - `nemar.ic-maps`: the maps of its base, and a text row per component from the components
 *   table, once that table names the values' components in order (`components_mismatch` and the
 *   table's own words draw the maps without rows);
 * - `nemar.ic-classes`: the histogram of its base, with each class's count and summed variance as
 *   stored, once the content meets `content.nemar.ic-classes.v1` (`content_invalid`,
 *   `variance_length`, `components_total` draw the histogram alone);
 * - `nemar.signal-window`: `signal-window.ts`, loaded with the Signal tab.
 *
 * The base model is the one `buildModel` builds (a registered preset with no builder of its own is
 * drawn by its base there); a file that is not the one recorded raises `ViewRefused` and nothing is
 * drawn.
 */

import {
  type BuiltModel,
  CAPS,
  type FileSource,
  type LinesModel,
  type MapSpec,
  type ModelOptions,
  Reader,
  type SensorFieldModel,
  type SensorLayoutPlaces,
  type Sensors,
  type ViewDecl,
  ViewRefused,
  buildModel,
  placeSensors,
  sensorRole,
  snapRow,
  subtleSha256,
} from "./model";
import { KindRefused, cells, readJson } from "./read";

export const IC_CLASSES_CONTENT = "content.nemar.ic-classes.v1.schema.json";

/** A preset's own check failed: drawn by its base with the word, shown as the fallback's tables,
 *  or nothing drawn. */
export class PresetRefused extends Error {
  constructor(
    readonly word: string,
    readonly outcome: "base" | "fallback" | "nothing",
  ) {
    super(word);
    this.name = "PresetRefused";
  }
}

const readerOf = (view: ViewDecl, source: FileSource, options: ModelOptions): Reader =>
  new Reader(view, source, options.caps ?? CAPS, options.sha256 ?? subtleSha256, options.checks);

const sensorDimOf = (view: ViewDecl, reader: Reader) =>
  reader.entry("values")?.dims?.find((d) => d.name === "sensor");

/** With a layout, the values' sensor columns are the layout's names in order (`sensors_mismatch`). */
export async function checkSpectrum(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<void> {
  const reader = readerOf(view, source, options);
  const values = reader.entry("values");
  const coords = sensorDimOf(view, reader)?.coords;
  if (!values || !coords || !("role" in coords)) return;
  const names = (values.columns ?? []).map((c) => c.name).filter((name) => name !== "freq_hz");
  const layout = reader.entry(coords.role);
  if (!layout) return;
  const labels = cells(await reader.tsv(layout), coords.column);
  if (labels.length !== names.length || labels.some((label, i) => label !== names[i])) {
    throw new PresetRefused("sensors_mismatch", "fallback");
  }
}

/** The scalp maps below a spectrum's lines, or null when there are no lines (presets.md). */
export interface SpectrumMaps {
  /** The stored rows the frequencies snap to. */
  readonly rows: number[];
  /** The word in every map's place when the layout's place columns are at fault. */
  readonly refused: string | null;
  readonly model: SensorFieldModel | null;
  readonly layout?: SensorLayoutPlaces;
}

/**
 * `spectrum_maps`: the `nemar.sensor-field` model of the series' stored cells at the rows
 * `frequencies` snap to (or at `rows`, a row the reader picked), with `minmax` limits. Null when
 * the base refuses the values, draws them as tables, or `sensors_mismatch` applies. Raises
 * `ViewRefused` when a file is not the one recorded.
 */
export async function spectrumMaps(
  view: ViewDecl,
  source: FileSource,
  frequencies: { readonly hz?: readonly number[]; readonly rows?: readonly number[] },
  options: ModelOptions,
  base?: BuiltModel,
): Promise<SpectrumMaps | null> {
  const built = base ?? (await buildModel(view, source, options));
  if (built.refused !== null || built.drawing.via === "table" || built.model.type !== "lines") {
    return null;
  }
  try {
    await checkSpectrum(view, source, options);
  } catch (error) {
    if (error instanceof PresetRefused) return null;
    throw error;
  }
  const lines = built.model as LinesModel;
  const rows = frequencies.rows
    ? [...frequencies.rows]
    : (frequencies.hz ?? []).map((hz) => snapRow(lines.x.values, hz));
  const reader = readerOf(view, source, options);
  const entry = reader.entry("values")!;
  const sensorDim = sensorDimOf(view, reader)!;
  const freqDim = (entry.dims ?? []).find((d) => d !== sensorDim) ?? null;
  const series = lines.series.items;
  let sensors: Sensors;
  try {
    sensors =
      "role" in sensorDim.coords
        ? await sensorRole(
            reader,
            sensorDim,
            series.length,
            series.map((item) => item.column),
          )
        : {
            labels: series.map((item) => item.label),
            role: null,
            entry: null,
            places: null,
            types: null,
          };
  } catch (error) {
    if (error instanceof KindRefused) return { rows, refused: error.word, model: null };
    throw error;
  }
  const maps: MapSpec[] = rows.map((row) => [
    lines.x.text[row],
    series.map((item) => item.values[row]),
    series.map((item) => item.text[row]),
  ]);
  const labelEntry = (sensors.role ? sensors.entry : entry) ?? {};
  const inputs = {
    cap_model: typeof labelEntry.cap_model === "string" ? labelEntry.cap_model : null,
    reference: typeof labelEntry.reference === "string" ? labelEntry.reference : null,
  };
  const placed = await placeSensors(
    sensors,
    maps,
    "minmax",
    lines.y.unit,
    sensorDim,
    freqDim,
    inputs,
    options,
  );
  return { rows, refused: null, ...placed };
}

/** One component's text row: its cells of the components table, by column, as stored text. */
export interface ComponentRow {
  readonly component: string;
  readonly cells: readonly {
    readonly name: string;
    readonly unit: string | null;
    readonly text: string;
  }[];
}

/** `nemar.ic-maps`: the components table, read as a data file, names the values' components in
 *  order. Returns each component's text row; `PresetRefused` (outcome `base`) otherwise. */
export async function icMapsRows(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<ComponentRow[]> {
  const reader = readerOf(view, source, options);
  const names = (reader.entry("values")?.columns ?? []).map((c) => c.name);
  const entry = reader.entry("components");
  let table: Awaited<ReturnType<Reader["tsv"]>>;
  try {
    if (!entry) throw new KindRefused("column_missing", "component");
    table = await reader.tsv(entry);
    if (table.rows.length * table.header.length > reader.caps.cells_per_role) {
      throw new KindRefused("cap_exceeded", `${table.rows.length} rows`);
    }
    if (!table.header.includes("component")) throw new KindRefused("column_missing", "component");
  } catch (error) {
    if (error instanceof KindRefused) throw new PresetRefused(error.word, "base");
    throw error;
  }
  const labels = cells(table, "component");
  if (labels.length !== names.length || labels.some((label, i) => label !== names[i])) {
    throw new PresetRefused("components_mismatch", "base");
  }
  const declared = (entry.columns ?? []).filter(
    (c) => c.name !== "component" && table.header.includes(c.name),
  );
  return labels.map((component, k) => ({
    component,
    cells: declared.map((c) => ({
      name: c.name,
      unit: c.unit ?? null,
      text: cells(table, c.name)[k],
    })),
  }));
}

/** The content of an ic-classes view, with what the preset prints per class. */
export interface IcClasses {
  readonly classifier: string;
  readonly categories: readonly string[];
  readonly counts: readonly number[];
  readonly summed_variance_pct: readonly number[];
  readonly n_components: number;
}

/** `nemar.ic-classes`: the content meets its schema, has one summed variance per category, and its
 *  counts sum to `n_components`. `PresetRefused` (outcome `base`) otherwise. */
export async function icClassesContent(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<IcClasses> {
  const reader = readerOf(view, source, options);
  const entry = reader.entry("histogram");
  if (!entry) throw new PresetRefused("content_invalid", "base");
  const content = readJson(await reader.verified(entry)) as IcClasses;
  if (!(await options.checks.content(IC_CLASSES_CONTENT, content))) {
    throw new PresetRefused("content_invalid", "base");
  }
  if (content.summed_variance_pct.length !== content.categories.length) {
    throw new PresetRefused("variance_length", "base");
  }
  if (content.counts.reduce((a, b) => a + b, 0) !== content.n_components) {
    throw new PresetRefused("components_total", "base");
  }
  return content;
}

/** A signal window's store, as the serving copy holds it (`signal-window.ts`). */
export interface SignalStore {
  readonly labels: readonly (string | null)[];
  readonly samples: number;
  readonly rate: number;
  /** The digest the serving copy publishes for the store, or null when it publishes none. */
  readonly published_sha256: string | null;
}

export type PresetOutcome =
  | ({ readonly word: null } & Record<string, unknown>)
  | { readonly word: string; readonly outcome: "base" | "fallback" | "nothing" };

/** `check_preset`: the outcome of a preset's own checks, as the vectors state it. */
export async function checkPreset(
  view: unknown,
  source: FileSource,
  options: ModelOptions,
  store?: SignalStore,
): Promise<PresetOutcome> {
  try {
    const check = await options.checks.view(view);
    if (!check.valid) throw new PresetRefused("declaration_invalid", "nothing");
    const decl = view as ViewDecl;
    if (decl.kind === "nemar.signal-window") {
      const { checkSignalWindow } = await import("./signal-window");
      return { word: null, ...(await checkSignalWindow(decl, source, store!, options)) };
    }
    if (["nemar.spectrum", "nemar.ic-maps", "nemar.ic-classes"].includes(decl.kind)) {
      const base = await buildModel(decl, source, options);
      if (base.refused !== null) return { word: base.refused.word, outcome: "fallback" };
      if (decl.kind === "nemar.spectrum") await checkSpectrum(decl, source, options);
      else if (decl.kind === "nemar.ic-maps") await icMapsRows(decl, source, options);
      else await icClassesContent(decl, source, options);
    }
  } catch (error) {
    if (error instanceof PresetRefused) return { word: error.word, outcome: error.outcome };
    if (error instanceof ViewRefused) return { word: error.word, outcome: "nothing" };
    throw error;
  }
  return { word: null };
}
