/**
 * neuroschema's montages (`views/montages`, format `nemar.montage.v1`): the standard electrode
 * positions that `nemar.sensor-labels.v1` places sensors with by name, and whose centers
 * `nemar.sensor-layout.v1` centers template positions on (nemar-cli ADR 0137 decision 3; website
 * ADR 0035 decisions 2 and 5).
 *
 * The files are copied by digest from nemar-cli into `vocabulary/montages/`, with PROVENANCE.json,
 * which records each one's source and license (`scripts/copy-quality-views-vocabulary.mjs`,
 * `test/quality-views-vocabulary-drift.test.ts`); their licenses ship in
 * `public/licenses/quality-views/NOTICE.txt` (`MONTAGES_NOTICE`). This module reads one file's
 * contents and imports none: `montage-loader.ts` fetches a file in the browser, and the tests read
 * them from disk, so a montage costs a page nothing until it is needed.
 */

import type { Vec3 } from "./sensor-layout";

export const MONTAGE_FORMAT = "nemar.montage.v1";

/** Where the montages' licenses are served, beside the color maps' (the same file). */
export const MONTAGES_NOTICE = "/licenses/quality-views/NOTICE.txt";

export interface Montage {
  readonly name: string;
  readonly family: string;
  /** The montage's own center, right-anterior-superior (RAS) meters. */
  readonly center: Vec3;
  /** Electrode names in file order, as the file spells them. */
  readonly names: readonly string[];
  /** One RAS position in meters per name, in the same order. */
  readonly positions: readonly Vec3[];
}

/** A montage file that is not what `nemar.montage.v1` says, or is not the montage it was asked for. */
export class MontageFileInvalid extends Error {
  constructor(
    readonly montage: string,
    reason: string,
  ) {
    super(`montage ${JSON.stringify(montage)}: ${reason}`);
    this.name = "MontageFileInvalid";
  }
}

const isPoint = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(v));

/** Read one montage file's parsed JSON, checking it is `name` in `nemar.montage.v1`. */
export function parseMontage(raw: unknown, name: string): Montage {
  const fail = (reason: string): never => {
    throw new MontageFileInvalid(name, reason);
  };
  if (typeof raw !== "object" || raw === null) return fail("the file is not a JSON object");
  const file = raw as Record<string, unknown>;
  if (file.format !== MONTAGE_FORMAT) return fail(`format ${JSON.stringify(file.format)}`);
  if (file.name !== name) return fail(`the file names ${JSON.stringify(file.name)}`);
  if (file.orientation !== "RAS") return fail(`orientation ${JSON.stringify(file.orientation)}`);
  if (file.unit !== "m") return fail(`unit ${JSON.stringify(file.unit)}`);
  if (typeof file.family !== "string") return fail("no family");
  if (!isPoint(file.center)) return fail("its center is not three finite numbers");
  if (!Array.isArray(file.electrodes) || file.electrodes.length === 0) {
    return fail("no electrodes");
  }
  const names: string[] = [];
  const positions: Vec3[] = [];
  const seen = new Set<string>();
  for (const entry of file.electrodes as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 4 || typeof entry[0] !== "string") {
      return fail("an electrode is not [name, x, y, z]");
    }
    const point = entry.slice(1);
    if (!isPoint(point))
      return fail(`electrode ${JSON.stringify(entry[0])} has no finite position`);
    if (seen.has(entry[0])) return fail(`electrode ${JSON.stringify(entry[0])} is listed twice`);
    seen.add(entry[0]);
    names.push(entry[0]);
    positions.push([point[0], point[1], point[2]]);
  }
  const [cx, cy, cz] = file.center as Vec3;
  return { name, family: file.family, center: [cx, cy, cz], names, positions };
}

/** `sensorLayout`'s `montageCenter` over the montages a caller has loaded; undefined for any other,
 *  which `sensorLayout` turns into `MontageCenterUnavailable`. */
export function centersOf(montages: Iterable<Montage>): (montage: string) => Vec3 | undefined {
  const centers = new Map<string, Vec3>();
  for (const montage of montages) centers.set(montage.name, montage.center);
  return (montage) => centers.get(montage);
}
