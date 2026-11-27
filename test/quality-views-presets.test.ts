/**
 * The presets' own checks and drawings (`src/lib/quality-views/presets.ts`, `signal-window.ts`)
 * against neuroschema's vectors: every case of `views/vectors/preset-checks.v1.json`
 * (`nemar.preset-checks.v1`, the word and its outcome, and for a signal window its state, window,
 * bad channels, segments and notes), and the `maps` and `preset` of every `nemar.spectrum` case of
 * `kinds-models.v1.json` (the rows the initial frequencies snap to and the scalp maps' model, by
 * `Object.is`), the two parts of the model vectors phase W4 left to the panel.
 */

import { describe, expect, it } from "vitest";
import { localChecks } from "../src/lib/quality-views/local-checks";
import type { FileDecl, SensorFieldModel } from "../src/lib/quality-views/model";
import { type Montage, parseMontage } from "../src/lib/quality-views/montages";
import { icClassesContent, icMapsRows } from "../src/lib/quality-views/preset-components";
import { spectrumMaps } from "../src/lib/quality-views/preset-spectrum";
import { type SignalStore, checkPreset } from "../src/lib/quality-views/presets";
import {
  productStem,
  tableIsRecordings,
  windowSamples,
} from "../src/lib/quality-views/signal-window";
import { nodeFs, repoPath } from "./node";
import { MONTAGES_DIR, mapOutcome, same } from "./quality-views-vectors";

type Files = Record<string, { text?: string; base64?: string } | string>;
const fs = await nodeFs();
const read = (name: string) =>
  JSON.parse(fs.readFileSync(repoPath(`test/fixtures/quality-views/vectors/${name}`), "utf8"));

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
    if (held === undefined) return null;
    if (typeof held === "string") return new TextEncoder().encode(held);
    if (held.text !== undefined) return new TextEncoder().encode(held.text);
    return Uint8Array.from(atob(held.base64!), (c) => c.charCodeAt(0));
  };
}

const options = (caps?: Record<string, number>) => ({
  checks: localChecks,
  montage,
  mapOutcome,
  caps: caps
    ? { bytes_per_role: 4194304, entries_per_dim: 1024, cells_per_role: 262144, ...caps }
    : undefined,
});

describe("nemar.preset-checks.v1", () => {
  const vectors = read("preset-checks.v1.json") as {
    format: string;
    cases: {
      name: string;
      covers: string;
      view: unknown;
      files: Files;
      store?: SignalStore;
      caps?: Record<string, number>;
      expected: Record<string, unknown>;
    }[];
  };
  it("is the vectors' format, with every preset", () => {
    expect(vectors.format).toBe("nemar.preset-checks.v1");
    expect(vectors.cases.length).toBeGreaterThanOrEqual(79);
  });
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await checkPreset(c.view, source(c.files), options(c.caps), c.store);
    expect(same(outcome, c.expected), c.covers).toBeNull();
  });
});

describe("nemar.spectrum's scalp maps (kinds-models.v1)", () => {
  const vectors = read("kinds-models.v1.json") as {
    cases: {
      name: string;
      covers: string;
      view: { kind: string };
      files: Files;
      maps: { hz: number[]; rows: number[] | null; refused: string | null; model: unknown };
      preset: Record<string, unknown>;
    }[];
  };
  const spectra = vectors.cases.filter((c) => c.view.kind === "nemar.spectrum");
  it("holds the spectrum cases, one placed by name", () => {
    expect(spectra.length).toBe(8);
    const byName = spectra.filter(
      (c) => (c.maps.model as SensorFieldModel | null)?.placement.source === "names",
    );
    expect(byName.map((c) => c.name)).toEqual(["spectrum_maps_names"]);
  });
  it.each(spectra.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const maps = await spectrumMaps(c.view as never, source(c.files), { hz: c.maps.hz }, options());
    const expected = c.maps.model as SensorFieldModel | null;
    if (c.maps.rows === null) {
      expect(maps, c.covers).toBeNull();
    } else {
      expect(maps?.rows).toEqual(c.maps.rows);
      expect(maps?.refused ?? null).toBe(c.maps.refused);
      expect(same(maps?.model ?? null, c.maps.model), c.covers).toBeNull();
    }
    expect(same(await checkPreset(c.view, source(c.files), options()), c.preset)).toBeNull();
  });

  it("draws a picked row as one map, labeled by the row's stored frequency", async () => {
    const c = spectra.find((s) => s.name === "spectrum_maps_layout")!;
    const maps = await spectrumMaps(c.view as never, source(c.files), { rows: [7] }, options());
    expect(maps?.rows).toEqual([7]);
    expect(maps?.model?.maps.items.map((m) => m.label)).toHaveLength(1);
  });
});

describe("the presets' extras", () => {
  const vectors = read("preset-checks.v1.json") as {
    cases: { name: string; view: never; files: Files }[];
  };
  const byName = (name: string) => vectors.cases.find((c) => c.name === name)!;

  it("gives one text row per component, each cell its stored text", async () => {
    const c = byName("ic_maps");
    const rows = await icMapsRows(c.view, source(c.files), options());
    const values = (c.view as { data: { role: string; columns: { name: string }[] }[] }).data.find(
      (d) => d.role === "values",
    )!;
    expect(rows.map((r) => r.component)).toEqual(values.columns.map((col) => col.name));
    const components = (c.view as { data: { role: string; location: string }[] }).data.find(
      (d) => d.role === "components",
    )!;
    const text =
      (c.files[components.location] as { text: string }).text ?? c.files[components.location];
    const lines = String(text).trimEnd().split("\n");
    const header = lines[0].split("\t");
    for (const [k, row] of rows.entries()) {
      const stored = lines[k + 1].split("\t");
      for (const cell of row.cells) expect(cell.text).toBe(stored[header.indexOf(cell.name)]);
    }
  });

  it("reads an ic-classes content with its classes' counts and summed variances", async () => {
    const c = byName("ic_classes");
    const content = await icClassesContent(c.view, source(c.files), options());
    expect(content.categories.length).toBe(content.summed_variance_pct.length);
    expect(content.counts.reduce((a, b) => a + b, 0)).toBe(content.n_components);
  });

  it("finds a window by its samples' times, not a rounded product", () => {
    // At 500/7 Hz, ceil(start * rate) starts a sample late; the times rule does not.
    const rate = 500 / 7;
    const { first } = windowSamples(0.7, 1, 10_000, rate);
    expect(first / rate).toBeGreaterThanOrEqual(0.7);
    expect((first - 1) / rate).toBeLessThan(0.7);
    expect(windowSamples(1000, 2, 100, 250)).toEqual({ first: 100, count: 0 });
  });

  it("names a recording's tables by the stem nemar-process gives its products", () => {
    expect(productStem("sub-01/eeg/sub-01_task-rest_desc-clean_eeg.set", "nemarica")).toBe(
      "sub-01_task-rest_desc-cleannemarica",
    );
    expect(productStem("sub-01/eeg/sub-01_task-rest_eeg.set", "nemarica")).toBe(
      "sub-01_task-rest_desc-nemarica",
    );
    const rec = "sub-01/eeg/sub-01_task-rest_eeg.set";
    expect(
      tableIsRecordings(
        "sub-01/eeg/sub-01_task-rest_desc-nemarica_channels.tsv",
        rec,
        "nemarica",
        "channels",
      ),
    ).toBe(true);
    for (const other of [
      "sub-01/eeg/sub-01_task-rest_run-2_desc-nemarica_channels.tsv",
      "sub-01/eeg/sub-01_task-rest_desc-nemarfloor_channels.tsv",
      "sub-02/eeg/sub-01_task-rest_desc-nemarica_channels.tsv",
      "sub-01/eeg/sub-01_task-rest_desc-nemarica_badsegments.tsv",
    ]) {
      expect(tableIsRecordings(other, rec, "nemarica", "channels"), other).toBe(false);
    }
  });
});
