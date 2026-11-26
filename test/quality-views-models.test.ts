/**
 * Model parity (`src/lib/quality-views/model.ts`) against neuroschema's model vectors,
 * `views/vectors/kinds-models.v1.json` (`nemar.kinds-models.v1`; neuroschema 0.6.0
 * `docs/views/generic-kinds.md`, The model vectors): for every case, the drawing, the refusal, the
 * downloads and the model are the vector's, texts exactly and numbers by `Object.is` (so a -0 the
 * model should have made 0 fails); every refusal is refused with its word and still offers its
 * downloads; every pointer snaps to the vector's row and every value lands in the vector's bin.
 *
 * Scalp maps placed by sensor name run `nemar.sensor-labels.v1` (`sensor-labels.ts`) on the
 * montage files, and are compared whole like every other case (counted below, so a vectors update
 * that drops them is seen).
 */

import { describe, expect, it, vi } from "vitest";
import { localChecks } from "../src/lib/quality-views/local-checks";
import {
  type FileDecl,
  type SensorFieldModel,
  ViewRefused,
  buildModel,
  locateBin,
  snapRow,
} from "../src/lib/quality-views/model";
import { type Montage, parseMontage } from "../src/lib/quality-views/montages";
import { nodeFs, repoPath } from "./node";
import { MONTAGES_DIR, mapOutcome, same } from "./quality-views-vectors";

type Files = Record<string, { text?: string; base64?: string }>;
interface ModelCase {
  readonly name: string;
  readonly covers: string;
  readonly view: unknown;
  readonly files: Files;
  readonly caps?: Record<string, number>;
  readonly model: Record<string, unknown> & { model: Record<string, unknown> };
  readonly snaps?: { x: number; row: number }[];
  readonly locates?: { value: number; bin: number }[];
}
interface RefusalCase {
  readonly name: string;
  readonly covers: string;
  readonly view: unknown;
  readonly files: Files;
  readonly caps?: Record<string, number>;
  readonly word: string;
  readonly downloads: unknown[];
}

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/kinds-models.v1.json"), "utf8"),
) as { format: string; cases: ModelCase[]; refusals: RefusalCase[] };

const montages = new Map<string, Montage>();
async function montage(name: string): Promise<Montage> {
  let held = montages.get(name);
  if (!held) {
    const raw = JSON.parse(fs.readFileSync(repoPath(`${MONTAGES_DIR}/${name}.json`), "utf8"));
    held = parseMontage(raw, name);
    montages.set(name, held);
  }
  return held;
}

function source(files: Files) {
  return async (file: FileDecl): Promise<Uint8Array | null> => {
    const held = files[file.location];
    if (!held) return null;
    if (held.text !== undefined) return new TextEncoder().encode(held.text);
    const binary = atob(held.base64!);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };
}

function options(caps?: Record<string, number>) {
  return {
    checks: localChecks,
    montage,
    mapOutcome,
    caps: caps
      ? { bytes_per_role: 4194304, entries_per_dim: 1024, cells_per_role: 262144, ...caps }
      : undefined,
  };
}

const placedByName = (c: ModelCase): boolean => {
  const model = c.model.model as Partial<SensorFieldModel>;
  return model.type === "sensor-field" && model.placement?.source === "names";
};

describe("model vectors", () => {
  it("are nemar.kinds-models.v1", () => {
    expect(vectors.format).toBe("nemar.kinds-models.v1");
  });

  it("hold 21 cases placed by name (nemar.sensor-labels.v1)", () => {
    expect(vectors.cases.filter(placedByName).length).toBe(21);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const built = await buildModel(c.view, source(c.files), options(c.caps));
    const { layout: _layout, ...comparable } = built;
    expect(same(comparable, c.model), c.covers).toBeNull();
  });

  // A montage file or lazy chunk that cannot load (offline, or redeployed) leaves the maps undrawn
  // with the site's word, never the view: kills the catch in placeSensors removed.
  it.each([
    ["sensor_field_names", "biosemi256"],
    ["sensor_field_positions_template", "standard_1005"],
    ["sensor_field_positions_flat_names", "GSN-HydroCel-32"],
  ])("%s with %s unavailable still draws, its maps montage_unavailable", async (name, missing) => {
    const c = vectors.cases.find((v) => v.name === name)!;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const built = await buildModel(c.view, source(c.files), {
        ...options(c.caps),
        montage: (n: string) =>
          n === missing ? Promise.reject(new TypeError("Failed to fetch")) : montage(n),
      });
      expect(same(built.drawing, c.model.drawing)).toBeNull();
      expect(same(built.refused, c.model.refused)).toBeNull();
      expect(same(built.downloads, c.model.downloads)).toBeNull();
      const model = built.model as SensorFieldModel;
      expect(model.placement.word).toBe("montage_unavailable");
      expect(model.sensors.drawn.every((d) => !d)).toBe(true);
      expect(model.maps.items.every((item) => item.word === "montage_unavailable")).toBe(true);
      expect(built.layout).toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("refuses too few channels by name without fetching a montage", async () => {
    const c = vectors.cases.find((v) => v.name === "sensor_field_names_too_few")!;
    const asked: string[] = [];
    const built = await buildModel(c.view, source(c.files), {
      ...options(c.caps),
      montage: (n: string) => {
        asked.push(n);
        return montage(n);
      },
    });
    const { layout: _layout, ...comparable } = built;
    expect(same(comparable, c.model)).toBeNull();
    expect(asked).toEqual([]);
  });

  it.each(vectors.refusals.map((c) => [c.name, c] as const))("refusal %s", async (_name, c) => {
    const refusal = await buildModel(c.view, source(c.files), options(c.caps)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ViewRefused);
    expect((refusal as ViewRefused).word).toBe(c.word);
    expect(same((refusal as ViewRefused).downloads, c.downloads)).toBeNull();
  });
});

describe("readouts read stored rows", () => {
  const lines = vectors.cases.filter((c) => c.snaps);
  it("has pointer cases", () => expect(lines.length).toBeGreaterThan(0));
  it.each(lines.map((c) => [c.name, c] as const))("%s: each pointer snaps to its row", (_n, c) => {
    const xs = (c.model.model as { x: { values: number[] } }).x.values;
    for (const { x, row } of c.snaps!) expect(snapRow(xs, x), `x = ${x}`).toBe(row);
  });

  const bins = vectors.cases.filter((c) => c.locates);
  it("has bin cases", () => expect(bins.length).toBeGreaterThan(0));
  it.each(bins.map((c) => [c.name, c] as const))("%s: each value lands in its bin", (_n, c) => {
    const items = (c.model.model as { items: { lower: number; upper: number }[] }).items;
    const edges = [items[0].lower, ...items.map((item) => item.upper)];
    for (const { value, bin } of c.locates!)
      expect(locateBin(edges, value), `value ${value}`).toBe(bin);
  });

  it("marks nothing for NaN", () => {
    expect(locateBin([0, 1, 2], Number.NaN)).toBeNull();
  });
});
