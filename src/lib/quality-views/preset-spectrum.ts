/** `nemar.spectrum`'s check and scalp maps (presets.md; `neuroschema.views.presets`). */

import {
  type BuiltModel,
  CAPS,
  type DataDecl,
  type FileSource,
  type LinesModel,
  type MapSpec,
  type ModelOptions,
  Reader,
  type SensorFieldModel,
  type SensorLayoutPlaces,
  type Sensors,
  type ViewDecl,
  buildModel,
  placeSensors,
  sensorRole,
  snapRow,
  subtleSha256,
} from "./model";
import { PresetRefused } from "./preset-refused";
import { KindRefused, cells } from "./read";

const readerOf = (view: ViewDecl, source: FileSource, options: ModelOptions): Reader =>
  new Reader(view, source, options.caps ?? CAPS, options.sha256 ?? subtleSha256, options.checks);

const sensorDimOf = (reader: Reader) =>
  reader.entry("values")?.dims?.find((d) => d.name === "sensor");

/** With a layout, the values' sensor columns are the layout's names in order (`sensors_mismatch`). */
export async function checkSpectrum(
  view: ViewDecl,
  source: FileSource,
  options: ModelOptions,
): Promise<void> {
  const reader = readerOf(view, source, options);
  const values = reader.entry("values");
  const coords = sensorDimOf(reader)?.coords;
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
  const sensorDim = sensorDimOf(reader)!;
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
  const labelEntry: Partial<DataDecl> = (sensors.role ? sensors.entry : entry) ?? {};
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
