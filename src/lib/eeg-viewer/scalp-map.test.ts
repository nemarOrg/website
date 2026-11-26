/**
 * The signal viewer's scalp map on NEMAR's one algorithm (website ADR 0035 decision 5; website#588
 * phase W3): where the sensors go, with no frame assumed, and that every refusal leaves the map
 * undrawn with its sentence. The montages are the files this site ships, loaded through the page's
 * own loader; the maps are drawn by the real worker handler on this thread (`inThreadWorker`).
 */

import { describe, expect, it, vi } from "vitest";
import { loadMontage } from "../quality-views/montage-loader";
import type { Montage } from "../quality-views/montages";
import { sensorField } from "../quality-views/sensor-field";
import { sensorLayout } from "../quality-views/sensor-layout";
import { inThreadWorker } from "../quality-views/worker";
import { SensorFieldClient } from "../quality-views/worker-client";
import {
  NO_EEG_POSITIONED_SENTENCE,
  type Placement,
  SCALP_MAP_SENTENCES,
  type ScalpInput,
  mapFrame,
  markerPoints,
  placeByPositions,
  placeScalpSensors,
  refusalSentence,
  rowValues,
  scalpPlacer,
  templateNote,
  toCanvas,
  viewOfDraw,
  viewOfPlacement,
} from "./scalp-map";
import { topoToggleTitle } from "./viewer";

const TEN_TWENTY = "Fp1 Fp2 F7 F3 Fz F4 F8 T7 C3 Cz C4 T8 P7 P3 Pz P4 P8 O1 O2".split(" ");

/** The 10-05 file lists T3, T4, T5 and T6 beside T7, T8, P7 and P8 on the same sites; a recording
 *  naming both is `duplicate_label` by name, so the recordings below carry the modern names only. */
const LEGACY = new Set(["T3", "T4", "T5", "T6"]);

/** A recording's input from a montage's own positions, as if its electrodes file held them. */
async function measured(
  name: string,
  frame: string,
  type: (label: string) => string = () => "EEG",
): Promise<ScalpInput> {
  const montage = await loadMontage(name);
  const positions: Record<string, [number, number, number]> = {};
  const labels = montage.names.filter((label) => !LEGACY.has(label));
  for (const label of labels) {
    const [x, y, z] = montage.positions[montage.names.indexOf(label)];
    positions[label] = [x, y, z];
  }
  return {
    positions,
    coordinateSystem: frame,
    channels: labels.map((label) => ({ label, channelType: type(label) })),
  };
}

const byName = (labels: readonly string[], type = "EEG"): ScalpInput => ({
  positions: {},
  coordinateSystem: "",
  channels: labels.map((label) => ({ label, channelType: type })),
});

const placed = (p: Placement): Placement & { kind: "placed" } => {
  if (p.kind !== "placed") throw new Error(`refused: ${p.word} (${p.detail})`);
  return p;
};

describe("placement from a recording's own positions", () => {
  it("lays them out with nemar.sensor-layout.v1 in their declared frame", async () => {
    const input = await measured("biosemi64", "CapTrak");
    const p = placed(await placeScalpSensors(input, loadMontage));
    expect(p.source).toBe("positions");
    expect(p.unusedPositions).toBeNull();
    const labels = Object.keys(input.positions);
    const direct = sensorLayout(
      {
        x: labels.map((l) => input.positions[l][0]),
        y: labels.map((l) => input.positions[l][1]),
        z: labels.map((l) => input.positions[l][2]),
      },
      "CapTrak",
      { names: labels, sensorTypes: labels.map(() => "EEG") },
    );
    if (direct.kind !== "layout") throw new Error("the direct layout refused");
    expect([...p.thetaDeg]).toEqual([...direct.layout.thetaDeg]);
    expect([...p.radius]).toEqual([...direct.layout.radius]);
    expect(p.labels).toEqual(labels);
  });

  it.each(["Pixels", "ACPC", "ScanRAS"])(
    "draws no scalp map from positions in %s, and never falls back to names",
    async (frame) => {
      const p = await placeScalpSensors(await measured("standard_1005", frame), loadMontage);
      expect(p).toMatchObject({ kind: "refused", word: "frame_not_scalp" });
    },
  );

  it("draws none when no positioned row is typed EEG, untyped rows included", async () => {
    for (const type of ["EOG", "SEEG", "OTHER", "n/a"]) {
      const p = await placeScalpSensors(
        await measured("biosemi64", "CapTrak", () => type),
        loadMontage,
      );
      expect(p, type).toMatchObject({ kind: "refused", word: "no_eeg_sensors" });
    }
  });

  it("places by name, saying why, when the frame is unknown and every row is EEG", async () => {
    const p = placed(
      await placeScalpSensors(await measured("standard_1005", "Other"), loadMontage),
    );
    expect(p.source).toBe("names");
    expect(p.montage).toBe("standard_1005");
    expect(p.unusedPositions).toBe("frame_unknown");
    expect(templateNote(p)).toContain("this recording's own positions were not used");
  });

  it("falls back to names from the drawn rows only, past positioned EOG, ECG, MISC and unmatched rows", async () => {
    const input = await measured("standard_1005", "Other", (label) =>
      label === "Fp1" ? "EOG" : label === "Fp2" ? "ECG" : label === "Fpz" ? "MISC" : "EEG",
    );
    const withUnmatched: ScalpInput = {
      ...input,
      positions: { ...input.positions, GND: [0, 0.05, 0.08], REF: [0, -0.05, 0.08] },
    };
    const step = placeByPositions(withUnmatched);
    if (step.kind !== "names") throw new Error(`not sent to names: ${JSON.stringify(step)}`);
    expect(step.unusedPositions).toBe("frame_unknown");
    expect(step.labels).not.toContain("Fp1");
    expect(step.labels).not.toContain("GND");
    expect(step.labels).toContain("Cz");
    const p = placed(await placeScalpSensors(withUnmatched, loadMontage));
    expect(p.source).toBe("names");
    expect(p.labels).not.toContain("Fpz");
    expect(p.labels).not.toContain("REF");
  });

  it("says the positioned channels are not EEG when unpositioned ones are (the review's case)", async () => {
    const montage = await loadMontage("standard_1005");
    const at = (label: string) => {
      const [x, y, z] = montage.positions[montage.names.indexOf(label)];
      return [x, y, z] as [number, number, number];
    };
    const input: ScalpInput = {
      positions: { HEOG: [0.07, 0.07, -0.02], VEOG: [0.03, 0.09, -0.03], FP1: at("Fp1") },
      coordinateSystem: "CapTrak",
      channels: [
        ...TEN_TWENTY.map((label) => ({ label, channelType: "EEG" })),
        { label: "HEOG", channelType: "EOG" },
        { label: "VEOG", channelType: "EOG" },
      ],
    };
    const p = await placeScalpSensors(input, loadMontage);
    expect(p).toMatchObject({ kind: "refused", word: "no_eeg_sensors" });
    expect(viewOfPlacement(p)).toEqual({ kind: "undrawn", sentence: NO_EEG_POSITIONED_SENTENCE });
    // With no channel typed EEG at all, the general sentence holds.
    const none = await placeScalpSensors(
      { ...input, channels: input.channels.map((c) => ({ ...c, channelType: "EOG" })) },
      loadMontage,
    );
    expect(viewOfPlacement(none)).toEqual({
      kind: "undrawn",
      sentence: SCALP_MAP_SENTENCES.no_eeg_sensors,
    });
  });

  it("places only the drawn rows: no unpositioned EEG channel, no OTHER channel with an electrode's name", async () => {
    const input = await measured("standard_1005", "Other", (label) =>
      label === "Cz" ? "OTHER" : "EEG",
    );
    const withUnpositioned: ScalpInput = {
      ...input,
      positions: Object.fromEntries(Object.entries(input.positions).filter(([l]) => l !== "Oz")),
    };
    const p = placed(await placeScalpSensors(withUnpositioned, loadMontage));
    expect(p.source).toBe("names");
    expect(p.unusedPositions).toBe("frame_unknown");
    expect(p.labels).toContain("Pz");
    expect(p.labels).not.toContain("Oz");
    expect(p.labels).not.toContain("Cz");
  });

  it("names its own word when the electrodes file names no channel of the recording", async () => {
    const input = await measured("standard_1005", "CapTrak");
    const renamed: ScalpInput = {
      ...input,
      channels: input.channels.map((c) => ({ ...c, label: `X${c.label}` })),
    };
    const p = await placeScalpSensors(renamed, loadMontage);
    expect(p).toMatchObject({ kind: "refused", word: "positions_unmatched" });
    expect(SCALP_MAP_SENTENCES.positions_unmatched).not.toBe(SCALP_MAP_SENTENCES.no_eeg_sensors);
  });

  it("places by name when the positions are flat, keeping positions_flat", async () => {
    const input = await measured("standard_1005", "CapTrak");
    const flat: ScalpInput = {
      ...input,
      positions: Object.fromEntries(
        Object.entries(input.positions).map(([l, [x, y]]) => [
          l,
          [x, y, 0.05] as [number, number, number],
        ]),
      ),
    };
    expect(placeByPositions(flat)).toMatchObject({
      kind: "names",
      unusedPositions: "positions_flat",
    });
  });

  it("goes to names when the recording has no positions", () => {
    expect(placeByPositions(byName(TEN_TWENTY))).toEqual({
      kind: "names",
      unusedPositions: null,
      labels: null,
    });
  });
});

describe("placement by name", () => {
  it("places 10-20 labels on the 10-05 montage, centered on the montage file's own center", async () => {
    const montage = await loadMontage("standard_1005");
    const p = placed(await placeScalpSensors(byName(TEN_TWENTY), loadMontage));
    expect(p.source).toBe("names");
    expect(p.montage).toBe("standard_1005");
    expect(p.labels).toEqual(TEN_TWENTY);
    const rows = TEN_TWENTY.map((l) => montage.positions[montage.names.indexOf(l)]);
    const direct = sensorLayout(
      { x: rows.map((r) => r[0]), y: rows.map((r) => r[1]), z: rows.map((r) => r[2]) },
      "n/a",
      { montage: "standard_1005", names: TEN_TWENTY, montageCenter: () => montage.center },
    );
    if (direct.kind !== "layout") throw new Error("refused");
    expect(direct.layout.centerMethod).toBe("montage");
    expect([...p.thetaDeg]).toEqual([...direct.layout.thetaDeg]);
  });

  it("reads the 10-20 aliases and leaves out other signals and fiducials", async () => {
    const labels = [
      ...TEN_TWENTY.filter((l) => !["T7", "T8"].includes(l)),
      "T3",
      "T4",
      "EOG1",
      "Nz",
    ];
    const p = placed(await placeScalpSensors(byName(labels, "n/a"), loadMontage));
    expect(p.labels).toContain("T3");
    expect(p.labels).not.toContain("EOG1");
    expect(p.labels).not.toContain("Nz");
  });

  it("places an EGI net's numbered channels only on the HydroCel net the cap model names", async () => {
    const labels = [...Array.from({ length: 128 }, (_, i) => `E${i + 1}`), "Cz"];
    // The store carries no cap model: names alone never decide an EGI net.
    const p = await placeScalpSensors(byName(labels), loadMontage);
    expect(p).toMatchObject({ kind: "refused", word: "cap_model_unknown" });
    expect(viewOfPlacement(p)).toEqual({
      kind: "undrawn",
      sentence: SCALP_MAP_SENTENCES.cap_model_unknown,
    });
    const named = placed(
      await placeScalpSensors({ ...byName(labels), capModel: "HydroCel GSN 128 1.0" }, loadMontage),
    );
    expect(named.montage).toBe("GSN-HydroCel-129");
    expect(named.labels).toHaveLength(129);
  });

  it("needs 8 matched names: three 10-20 names, which drew a map before, draw none", async () => {
    const three = await placeScalpSensors(byName(["Fz", "Cz", "Pz"]), loadMontage);
    expect(three).toMatchObject({ kind: "refused", word: "too_few_channels" });
    expect(viewOfPlacement(three)).toEqual({
      kind: "undrawn",
      sentence:
        "No scalp map: fewer than 8 channels could be EEG electrodes, and placing sensors by their names needs 8.",
    });
  });

  it("reads the store's OTHER as untyped, so channels all OTHER and no positions place by name", async () => {
    const p = placed(await placeScalpSensors(byName(TEN_TWENTY, "OTHER"), loadMontage));
    expect(p.source).toBe("names");
    expect(p.montage).toBe("standard_1005");
    expect(p.labels).toEqual(TEN_TWENTY);
  });

  it("says too_few_channels when no channel could be an electrode", async () => {
    for (const input of [byName([]), byName(["EOG1", "ECG", "Status"], "n/a")]) {
      const p = await placeScalpSensors(input, loadMontage);
      expect(p).toMatchObject({ kind: "refused", word: "too_few_channels" });
    }
  });

  it("says no_eeg_sensors when every scalp channel is typed, and none EEG", async () => {
    const p = await placeScalpSensors(byName(TEN_TWENTY, "MISC"), loadMontage);
    expect(p).toMatchObject({ kind: "refused", word: "no_eeg_sensors" });
  });

  it("fetches no montage for a recording with too few candidate channels", async () => {
    const asked: string[] = [];
    const counting = (name: string): Promise<Montage> => {
      asked.push(name);
      return loadMontage(name);
    };
    const three = await placeScalpSensors(byName(["Fz", "Cz", "Pz"]), counting);
    expect(three).toMatchObject({ kind: "refused", word: "too_few_channels" });
    const excluded = await placeScalpSensors(
      byName(["EOG1", "ECG", "Status", "Fz", "Cz", "Pz", "Oz", "Fp1", "Fp2"], "n/a"),
      counting,
    );
    expect(excluded).toMatchObject({ kind: "refused", word: "too_few_channels" });
    expect(asked).toEqual([]);
  });

  it("says too_few_matched when 7 of 8 names match", async () => {
    const p = await placeScalpSensors(byName([...TEN_TWENTY.slice(0, 7), "X1"]), loadMontage);
    expect(p).toMatchObject({ kind: "refused", word: "too_few_matched" });
    expect(viewOfPlacement(p)).toEqual({
      kind: "undrawn",
      sentence: SCALP_MAP_SENTENCES.too_few_matched,
    });
  });

  it("refuses labels no montage names", async () => {
    const p = await placeScalpSensors(
      byName(Array.from({ length: 8 }, (_, i) => `ch${i + 1}`)),
      loadMontage,
    );
    expect(p).toMatchObject({ kind: "refused", word: "labels_unrecognized" });
  });

  it("leaves the map undrawn when the montage cannot be loaded", async () => {
    const offline = (): Promise<Montage> => Promise.reject(new TypeError("Failed to fetch"));
    const p = await placeScalpSensors(byName(TEN_TWENTY), offline);
    expect(p).toMatchObject({ kind: "refused", word: "montage_unavailable" });
    expect(viewOfPlacement(p)).toEqual({
      kind: "undrawn",
      sentence: SCALP_MAP_SENTENCES.montage_unavailable,
    });
  });

  it("never rejects, even when the loader throws before it answers", async () => {
    const broken = (): Promise<Montage> => {
      throw new Error("loader bug");
    };
    await expect(placeScalpSensors(byName(TEN_TWENTY), broken)).resolves.toMatchObject({
      kind: "refused",
    });
  });
});

describe("the viewer's placer: positions at once, names when the map is first shown", () => {
  const counting = () => {
    const asked: string[] = [];
    return {
      asked,
      load: (name: string): Promise<Montage> => {
        asked.push(name);
        return loadMontage(name);
      },
    };
  };

  it("places a recording's own positions at mount, so the toggle's title says so before it opens", async () => {
    const input = await measured("biosemi64", "CapTrak");
    const { asked, load } = counting();
    const seen: Placement[] = [];
    const placer = scalpPlacer(input, load, (p) => seen.push(p));
    // Synchronously, before any show(): the placement and its title.
    expect(seen).toHaveLength(1);
    expect(placer.placement).toMatchObject({ kind: "placed", source: "positions" });
    const provenance = {
      electrodePositionsSource: "subject" as const,
      electrodePositionsFile: "sub-01/eeg/sub-01_electrodes.tsv",
    };
    expect(topoToggleTitle(placer.placement!, provenance)).toContain(
      "sub-01/eeg/sub-01_electrodes.tsv",
    );
    placer.show();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("says a positions refusal at mount too (frame_not_scalp), with no montage", () => {
    const input: ScalpInput = {
      positions: { Cz: [0, 0, 0.09] },
      coordinateSystem: "ACPC",
      channels: [{ label: "Cz", channelType: "EEG" }],
    };
    const { asked, load } = counting();
    const placer = scalpPlacer(input, load, () => {});
    expect(placer.placement).toMatchObject({ kind: "refused", word: "frame_not_scalp" });
    expect(
      topoToggleTitle(placer.placement!, {
        electrodePositionsSource: null,
        electrodePositionsFile: null,
      }),
    ).toContain(SCALP_MAP_SENTENCES.frame_not_scalp);
    expect(asked).toEqual([]);
  });

  it("fetches no montage for a names-only recording until the map is first shown, then places once", async () => {
    const { asked, load } = counting();
    let placed: (p: Placement) => void = () => {};
    const done = new Promise<Placement>((resolve) => {
      placed = resolve;
    });
    const calls: Placement[] = [];
    const placer = scalpPlacer(byName(TEN_TWENTY), load, (p) => {
      calls.push(p);
      placed(p);
    });
    expect(placer.placement).toBeNull();
    await Promise.resolve();
    expect(asked).toEqual([]);
    // The map is shown (a click, or the restored view state): the placement starts, once.
    placer.show();
    placer.show();
    const p = await done;
    expect(p).toMatchObject({ kind: "placed", source: "names", montage: "standard_1005" });
    expect(placer.placement).toBe(p);
    expect(calls).toHaveLength(1);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("never rejects: a placement that throws is a refusal handed to onPlaced", async () => {
    const broken = (): Promise<Montage> => {
      throw new Error("loader bug");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const done = new Promise<Placement>((resolve) => {
        scalpPlacer(byName(TEN_TWENTY), broken, resolve).show();
      });
      await expect(done).resolves.toMatchObject({ kind: "refused" });
    } finally {
      error.mockRestore();
    }
  });
});

describe("what the panel shows", () => {
  const client = new SensorFieldClient(inThreadWorker);
  const draw = (p: Placement & { kind: "placed" }, values: Float64Array) =>
    client.draw(
      { layoutKey: "test", thetaDeg: p.thetaDeg, radius: p.radius, maps: [values] },
      { contours: "none" },
    );

  it("says, for every placement refusal, its sentence in place of the map", () => {
    for (const word of [
      "frame_not_scalp",
      "no_eeg_sensors",
      "frame_unknown",
      "positions_flat",
      "positions_partial",
      "labels_unrecognized",
      "too_few_matched",
      "positions_unmatched",
      "too_few_channels",
      "montage_unavailable",
      "worker",
    ] as const) {
      const view = viewOfPlacement({ kind: "refused", word, detail: "", unusedPositions: null });
      expect(view, word).toEqual({ kind: "undrawn", sentence: SCALP_MAP_SENTENCES[word] });
      expect(SCALP_MAP_SENTENCES[word]).toMatch(/^No scalp map: /);
    }
    expect(viewOfPlacement(null)).toMatchObject({ kind: "undrawn" });
  });

  it("draws the map the algorithm draws, through the worker", async () => {
    const p = placed(await placeScalpSensors(byName(TEN_TWENTY), loadMontage));
    const values = Float64Array.from(TEN_TWENTY, (_, i) => Math.sin(i) * 1e-5);
    const view = viewOfDraw(await draw(p, values));
    if (view.kind !== "map") throw new Error(`not drawn: ${JSON.stringify(view)}`);
    const direct = sensorField(p.thetaDeg, p.radius, values);
    if (direct.kind !== "map") throw new Error("refused");
    expect([...view.map.grid]).toEqual([...direct.map.z]);
    expect(view.map.colorAxis.minmax).toEqual(direct.map.colorAxis.minmax);
  });

  it("leaves the map undrawn with too_few_sensors below 8 channels with a value", async () => {
    const p = placed(await placeScalpSensors(byName(TEN_TWENTY), loadMontage));
    const values = Float64Array.from(TEN_TWENTY, (_, i) => (i < 7 ? i : Number.NaN));
    expect(viewOfDraw(await draw(p, values))).toEqual({
      kind: "undrawn",
      sentence: SCALP_MAP_SENTENCES.too_few_sensors,
    });
  });

  it("says the worker could not draw, and leaves a cancelled draw's picture alone", () => {
    expect(viewOfDraw({ kind: "unavailable", reason: "x" })).toEqual({
      kind: "undrawn",
      sentence: refusalSentence("worker"),
    });
    expect(viewOfDraw({ kind: "done", maps: [], stats: {} as never })).toMatchObject({
      kind: "undrawn",
    });
    expect(viewOfDraw({ kind: "cancelled" })).toEqual({ kind: "unchanged" });
    for (const word of ["head_outside_grid", "interpolation_failed"] as const) {
      expect(
        viewOfDraw({
          kind: "done",
          maps: [{ kind: "refused", index: 0, word, detail: "" }],
          stats: {} as never,
        }),
      ).toEqual({ kind: "undrawn", sentence: SCALP_MAP_SENTENCES[word] });
    }
  });
});

describe("rowValues", () => {
  it("leaves out a dimmed channel, one not on screen and a value that is not finite", () => {
    const values = rowValues(
      ["A", "B", "C", "D", "E"],
      [
        { label: "A", dim: false, value: 1 },
        { label: "B", dim: true, value: 2 },
        { label: "D", value: Number.NaN },
        { label: "E", value: 5 },
      ],
    );
    expect([...values]).toEqual([1, Number.NaN, Number.NaN, Number.NaN, 5]);
  });
});

describe("the canvas frame", () => {
  it("puts the nose up and the right ear to the right, and fits the nose and every marker", async () => {
    const p = placed(await placeScalpSensors(byName(TEN_TWENTY), loadMontage));
    const values = Float64Array.from(TEN_TWENTY, (_, i) => i);
    const view = viewOfDraw(
      await new SensorFieldClient(inThreadWorker).draw(
        { layoutKey: "frame", thetaDeg: p.thetaDeg, radius: p.radius, maps: [values] },
        { contours: "none" },
      ),
    );
    if (view.kind !== "map") throw new Error("not drawn");
    const markers = markerPoints(view.map, p.thetaDeg, p.radius);
    expect(markers).toHaveLength(view.map.geometry.plotted.length);
    const frame = mapFrame(view.map, markers, 200);
    const [nx, ny] = toCanvas(frame, 0.5, 0);
    expect(nx).toBeCloseTo(100, 9);
    expect(ny).toBeLessThan(100);
    const [ex] = toCanvas(frame, 0, 0.5);
    expect(ex).toBeGreaterThan(100);
    for (const [x, y] of [...view.map.geometry.head.nose, ...markers]) {
      const [cx, cy] = toCanvas(frame, x, y);
      for (const c of [cx, cy]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(200);
      }
    }
    // Fz is in front of Pz: higher on the canvas.
    const fz = markers[view.map.geometry.plotted.indexOf(TEN_TWENTY.indexOf("Fz"))];
    const pz = markers[view.map.geometry.plotted.indexOf(TEN_TWENTY.indexOf("Pz"))];
    expect(toCanvas(frame, ...fz)[1]).toBeLessThan(toCanvas(frame, ...pz)[1]);
  });
});

/**
 * Regression fixtures captured from the real stores (test/fixtures/scalp-placement/): each has an
 * electrodes file in the frame `Other`, which the projection refuses, and positioned non-EEG rows
 * (EOG, ECG, VEOG, HEOG, MISC). Their EEG rows are placed by name on standard_1005.
 */
describe("recordings in an unknown frame with positioned non-EEG rows", () => {
  interface Fixture {
    readonly electrode_coordinate_system: string;
    readonly electrode_positions: Record<string, [number, number, number]>;
    readonly channels: readonly { label: string; channel_type: string; modality: string }[];
  }
  const fixture = async (dataset: string): Promise<ScalpInput> => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(
      readFileSync(
        new URL(`../../../test/fixtures/scalp-placement/${dataset}.json`, import.meta.url),
        "utf8",
      ),
    ) as Fixture;
    return {
      positions: raw.electrode_positions,
      coordinateSystem: raw.electrode_coordinate_system,
      channels: raw.channels
        .filter((c) => c.modality === "EEG")
        .map((c) => ({ label: c.label, channelType: c.channel_type })),
    };
  };

  it.each(["nm000254", "on003690", "on003039"])("%s places on standard_1005", async (dataset) => {
    const input = await fixture(dataset);
    expect(input.coordinateSystem).toBe("Other");
    const p = placed(await placeScalpSensors(input, loadMontage));
    expect(p.source).toBe("names");
    expect(p.montage).toBe("standard_1005");
    expect(p.unusedPositions).toBe("frame_unknown");
    expect(p.labels.length).toBeGreaterThanOrEqual(8);
    const typeOf = new Map(input.channels.map((c) => [c.label, c.channelType]));
    for (const label of p.labels) expect(typeOf.get(label), label).toBe("EEG");
  });
});
