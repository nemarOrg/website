/**
 * neuroschema's montages as this site ships them (website ADR 0035 decisions 2 and 5; nemar-cli
 * ADR 0137 decision 3): every montage `nemar.sensor-layout.v1` names is a file the page can load,
 * each file is read strictly, its center is the one the template vectors were computed about, and
 * the licenses PROVENANCE.json records ship with the site.
 */

import { describe, expect, it } from "vitest";
import { COLOR_MAPS_NOTICE } from "../src/lib/quality-views/colormap";
import { LOADABLE_MONTAGES, loadMontage } from "../src/lib/quality-views/montage-loader";
import {
  MONTAGES_NOTICE,
  MONTAGE_FORMAT,
  MontageFileInvalid,
  centersOf,
  parseMontage,
} from "../src/lib/quality-views/montages";
import {
  MontageCenterUnavailable,
  type Vec3,
  sensorLayout,
} from "../src/lib/quality-views/sensor-layout";
import { MONTAGE_NAMES } from "../src/lib/quality-views/sensor-names";
import { nodeFs, repoPath } from "./node";
import {
  MONTAGES_DIR,
  loadFieldVectors,
  loadLayoutVectors,
  montageCentersFromFiles,
  numbers,
} from "./quality-views-vectors";

const fs = await nodeFs();
const read = (name: string): unknown =>
  JSON.parse(fs.readFileSync(repoPath(`${MONTAGES_DIR}/${name}.json`), "utf8"));
/** Equal as numbers (so 0 equals -0), entry by entry. */
const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const provenance = read("PROVENANCE") as {
  mne: { license_text: string };
  eeglab: { license_text: string };
  montages: { name: string; electrodes: number }[];
};

describe("the montages a page can load", () => {
  it("are exactly the twenty montages sensor-layout names, and never PROVENANCE", () => {
    expect([...LOADABLE_MONTAGES].sort()).toEqual([...MONTAGE_NAMES].sort());
    expect(LOADABLE_MONTAGES).not.toContain("PROVENANCE");
  });

  it("load through the page's loader, each the montage asked for, with the electrodes PROVENANCE counts", async () => {
    for (const entry of provenance.montages) {
      const montage = await loadMontage(entry.name);
      expect(montage.name).toBe(entry.name);
      expect(montage.names).toHaveLength(entry.electrodes);
      expect(montage.positions).toHaveLength(entry.electrodes);
    }
  });

  it("refuses a name with no file, by exact spelling", async () => {
    await expect(loadMontage("PROVENANCE")).rejects.toThrow(/no montage is named/);
    await expect(loadMontage("Standard_1005")).rejects.toThrow(/no montage is named/);
  });
});

describe("parseMontage", () => {
  const good = read("biosemi16") as Record<string, unknown>;

  it("reads a file as it is copied", () => {
    const montage = parseMontage(good, "biosemi16");
    expect(montage.center).toEqual(good.center);
    expect(montage.names[0]).toBe((good.electrodes as unknown[][])[0][0]);
  });

  it.each([
    ["another montage's file", { ...good }, "biosemi32", /names "biosemi16"/],
    ["another format", { ...good, format: "nemar.montage.v2" }, "biosemi16", /format/],
    ["another orientation", { ...good, orientation: "ALS" }, "biosemi16", /orientation/],
    ["another unit", { ...good, unit: "mm" }, "biosemi16", /unit/],
    ["a center that is not a point", { ...good, center: [0, 0] }, "biosemi16", /center/],
    ["a center that is not finite", { ...good, center: [0, null, 0] }, "biosemi16", /center/],
    ["no electrodes", { ...good, electrodes: [] }, "biosemi16", /no electrodes/],
    [
      "an electrode without a position",
      { ...good, electrodes: [["Cz", 0, "x", 0]] },
      "biosemi16",
      /no finite position/,
    ],
    [
      "an electrode listed twice",
      {
        ...good,
        electrodes: [
          ["Cz", 0, 0, 1],
          ["Cz", 0, 0, 1],
        ],
      },
      "biosemi16",
      /listed twice/,
    ],
  ])("refuses %s", (_what, raw, name, reason) => {
    expect(() => parseMontage(raw, name)).toThrow(MontageFileInvalid);
    expect(() => parseMontage(raw, name)).toThrow(reason);
  });

  it("names the format it reads", () => {
    expect(MONTAGE_FORMAT).toBe(good.format);
  });
});

describe("the template centers come from the montage files", () => {
  it("give every montage a center, read from its file", async () => {
    const centers = await montageCentersFromFiles();
    expect([...centers.keys()].sort()).toEqual([...MONTAGE_NAMES].sort());
    const standard = read("standard_1005") as { center: Vec3 };
    expect(centers.get("standard_1005")).toEqual(standard.center);
  });

  it("agree with every template case's expected center, which the vectors computed independently", async () => {
    const centers = await montageCentersFromFiles();
    const layout = await loadLayoutVectors();
    const field = await loadFieldVectors();
    const templateCases = [
      ...layout.cases.flatMap((c) =>
        c.montage && c.expected
          ? [{ name: c.name, montage: c.montage, center: c.expected.center }]
          : [],
      ),
      ...field.cases.flatMap((c) => {
        const center = c.expected?.layout?.center;
        return c.montage && center ? [{ name: c.name, montage: c.montage, center }] : [];
      }),
    ];
    expect(templateCases.map((c) => c.name).sort()).toEqual(
      [
        "positions_template",
        "positions_template_midline",
        "template_coronal_9",
        "template_full_1005",
        "template_midline_9",
        "template_montage",
      ].sort(),
    );
    for (const { name, montage, center } of templateCases) {
      const [x, y, z] = centers.get(montage)!;
      // RAS (x, y, z) is ALS (y, -x, z) (sensor-layout.md step 1), and the center is stored as is.
      expect(sameNumbers([y, -x, z], center), `${name}: ${center}`).toBe(true);
    }
  });

  it("center template positions through centersOf, and leave a montage not loaded to MontageCenterUnavailable", async () => {
    const montage = await loadMontage("biosemi32");
    const p = {
      x: montage.positions.map((v) => v[0]),
      y: montage.positions.map((v) => v[1]),
      z: montage.positions.map((v) => v[2]),
    };
    const layout = sensorLayout(p, "n/a", {
      montage: "biosemi32",
      names: montage.names,
      montageCenter: centersOf([montage]),
    });
    expect(layout.kind).toBe("layout");
    if (layout.kind === "layout") {
      expect(layout.layout.centerMethod).toBe("montage");
      const [x, y, z] = montage.center;
      expect(sameNumbers(layout.layout.center, [y, -x, z])).toBe(true);
      expect([...numbers(Array.from(layout.layout.radius))].every(Number.isFinite)).toBe(true);
    }
    expect(() =>
      sensorLayout(p, "n/a", {
        montage: "biosemi32",
        names: montage.names,
        montageCenter: centersOf([]),
      }),
    ).toThrow(MontageCenterUnavailable);
  });
});

describe("the montages' licenses ship with the site", () => {
  const notice = fs.readFileSync(repoPath(`public${MONTAGES_NOTICE}`), "utf8");
  /** A license text with each line's indentation dropped, as the notice indents it. */
  const lines = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();

  it("in the quality views' notice, beside the color maps'", () => {
    expect(MONTAGES_NOTICE).toBe(COLOR_MAPS_NOTICE);
  });

  it("with MNE-Python's and EEGLAB's license texts as PROVENANCE.json records them", () => {
    const shipped = lines(notice);
    expect(shipped).toContain(lines(provenance.mne.license_text));
    expect(shipped).toContain(lines(provenance.eeglab.license_text));
    expect(notice).toContain("Copyright 2011-2025 MNE-Python authors");
    expect(notice).toContain("Copyright (c) 2024, Swartz Center for Computational Neuroscience");
  });

  it("and in THIRD_PARTY_NOTICES.md, under Required", () => {
    const notices = fs.readFileSync(repoPath("THIRD_PARTY_NOTICES.md"), "utf8");
    const required = notices.slice(
      notices.indexOf("## Required"),
      notices.indexOf("## Acknowledged"),
    );
    expect(required).toContain("### Electrode montages");
    expect(required).toContain("BSD-3-Clause");
    expect(required).toContain("BSD 2-Clause");
    expect(required).toContain(`public${MONTAGES_NOTICE}`);
  });
});
