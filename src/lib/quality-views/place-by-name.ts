/**
 * The half of `placeSensors` (`model.ts`) that places a scalp map's sensors by name, with
 * `nemar.sensor-labels.v1` (neuroschema 0.6.0 `docs/views/sensor-field.md`, The model): it runs only
 * for a map with neither a layout nor positions it can use, so it is a lazy chunk with the
 * algorithm, and a panel's first screen carries none of it (website ADR 0035 decision 1).
 *
 * Step for step what `placeSensors` did in place, held by the same cases of
 * `views/vectors/kinds-models.v1.json` (`test/quality-views-models.test.ts`).
 */

import type { MapSpec, Placement, SensorFieldModel, Sensors } from "./model";
import type { Montage } from "./montages";
import { MIN_CHANNELS, countCandidates, inferPositions, loadNameMontages } from "./sensor-labels";

type Layout = [number[], number[]];

export interface ByName {
  readonly sensors: Sensors;
  /** The rows to place, in row order. */
  readonly rows: readonly number[];
  readonly maps: readonly MapSpec[];
  readonly inputs: { readonly cap_model: string | null; readonly reference: string | null };
  /** Written here: the montage, the reference channel, and a refusal's word. */
  readonly placement: Placement;
  /** Written here when the sensors are placed: their electrodes and positions. */
  readonly places: Pick<SensorFieldModel["sensors"], "electrodes" | "x" | "y" | "z">;
  readonly montage: (name: string) => Promise<Montage>;
  /** `model.ts`'s guard: a load that fails as a fetch or a chunk does leaves the maps
   *  `montage_unavailable`. */
  readonly loaded: <T>(load: () => Promise<T>) => Promise<T>;
  /** `model.ts`'s projection of positions in meters onto the head. */
  readonly project: (
    xyz: (readonly [number, number, number])[],
    frame: string,
    montageName: string | null,
    rows: number[],
  ) => Promise<Layout | { word: string }>;
}

/**
 * Place the sensors by name. Null when the algorithm refuses (its word is in `placement.word`, and
 * its sentence is loaded);
 * otherwise the rows drawn and the layout, which is null when the projection refuses (its word is
 * in `placement.word`).
 */
export async function placeByName(x: ByName): Promise<[boolean[], Layout | null] | null> {
  const { sensors, placement, places } = x;
  const count = sensors.labels.length;
  const types = sensors.types ?? new Array<string | null>(count).fill(null);
  const given = x.rows.map((k) => [sensors.labels[k], types[k]] as const);
  const sidecar = { capModel: x.inputs.cap_model, reference: x.inputs.reference };
  // Too few candidates is refused before any montage is fetched (the algorithm's own answer).
  const inference =
    countCandidates(given) < MIN_CHANNELS
      ? inferPositions(given, [], sidecar)
      : inferPositions(given, await x.loaded(() => loadNameMontages(x.montage)), sidecar);
  if (inference.outcome !== "placed") {
    // The refusal's sentence (`sensor-labels-copy.ts`) loads here, under the same guard: a copy that
    // cannot be fetched leaves the maps `montage_unavailable`, which says to reload, never a bare
    // word; once loaded, the renderer's `mapSentences` reads it from the module cache.
    await x.loaded(() => import("./sensor-labels-copy"));
    placement.montage = inference.montage;
    placement.word = inference.reason;
    return null;
  }
  placement.montage = inference.montage;
  const electrodes = new Array<string | null>(count).fill(null);
  const xyz = new Array<readonly [number, number, number] | null>(count).fill(null);
  let reference: number | null = null;
  x.rows.forEach((k, i) => {
    const channel = inference.channels[i];
    if (channel.electrode !== null && channel.position !== null) {
      electrodes[k] = channel.electrode;
      xyz[k] = [channel.position[0] + 0, channel.position[1] + 0, channel.position[2] + 0];
      if (channel.name === inference.reference) reference = k;
    }
  });
  const drawn = electrodes.map((e) => e !== null);
  if (reference !== null) {
    const ref: number = reference;
    placement.reference = sensors.labels[ref];
    if (x.maps.every(([, values]) => values[ref] === 0)) drawn[ref] = false;
  }
  const rows = drawn.flatMap((d, k) => (d ? [k] : []));
  places.electrodes = electrodes;
  places.x = xyz.map((p) => (p ? p[0] : null));
  places.y = xyz.map((p) => (p ? p[1] : null));
  places.z = xyz.map((p) => (p ? p[2] : null));
  const projected = await x.project(
    rows.map((k) => xyz[k]!),
    "n/a",
    inference.montage,
    rows,
  );
  if ("word" in projected) {
    placement.word = projected.word;
    return [drawn, null];
  }
  return [drawn, projected];
}
