/**
 * `nemar.sensor-layout.v1` parity: this site's projection of 3D positions against every case of
 * neuroschema 0.6.0's `views/vectors/sensor-layout.v1.json` (nemar-cli ADR 0137 decision 3 and its
 * amendment of 2026-11-24; website ADR 0035 decision 5; website#588 phase W2).
 *
 * A case matches when, by `docs/views/sensor-layout.md`'s "Parity" section: a refused case is
 * refused with the same word and, for measured positions, the same six measures within 1e-6; a
 * drawn case gives a layout to the same rows, its center is within 1e-9 of the positions' scale,
 * its center method is the vector's, each radius is within 1e-12 and each planar point
 * `(cos(theta) * radius, sin(theta) * radius)` within 1e-12. Every ALS name of the frame table
 * gives `frame_als`'s layout and every RAS name `frame_ras`'s, and the `cart2topo` entries convert
 * without a fit.
 *
 * Template positions are centered on their montage's own center, a datum of `views/montages`, read
 * here from the montage files this site copies by digest (`montageCentersFromFiles`), so the
 * six template cases' centers are checked against data the vectors do not supply.
 */

import { describe, expect, it } from "vitest";
import {
  ALS_FRAMES,
  FRAME_ALIASES,
  MontageCenterUnavailable,
  RAS_FRAMES,
  cart2topo,
  orientation,
  sensorLayout,
} from "../src/lib/quality-views/sensor-layout";
import { MONTAGE_NAMES } from "../src/lib/quality-views/sensor-names";
import {
  type LayoutCase,
  compareLayout,
  loadFieldVectors,
  loadLayoutVectors,
  montageCentersFromFiles,
  numbers,
} from "./quality-views-vectors";

const vectors = await loadLayoutVectors();
const field = await loadFieldVectors();
const centers = await montageCentersFromFiles();
const byName = new Map(vectors.cases.map((c) => [c.name, c]));

function run(vectorCase: LayoutCase, frame: string = vectorCase.coordinate_system) {
  const p = vectorCase.positions;
  return sensorLayout({ x: numbers(p.x), y: numbers(p.y), z: numbers(p.z) }, frame, {
    montage: vectorCase.montage ?? null,
    names: p.name,
    sensorTypes: p.sensor_type ?? null,
    montageCenter: (name) => centers.get(name),
  });
}

describe("the sensor-layout vectors", () => {
  it("name the frames this implementation knows, by the same spelling", () => {
    expect([...ALS_FRAMES].sort()).toEqual([...vectors.frames.ALS].sort());
    expect([...RAS_FRAMES].sort()).toEqual([...vectors.frames.RAS].sort());
    expect(FRAME_ALIASES).toEqual(vectors.frames.aliases);
  });

  it("refuse with exactly the three words the specification names", () => {
    const words = new Set(vectors.cases.flatMap((c) => (c.refused ? [c.refused] : [])));
    expect([...words].sort()).toEqual(["frame_unknown", "positions_flat", "positions_partial"]);
  });
});

describe("nemar.sensor-layout.v1 parity", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, vectorCase) => {
    expect(compareLayout(vectors, vectorCase, run(vectorCase))).toEqual([]);
  });

  it.each([...vectors.frames.ALS].map((frame) => [frame]))(
    "%s gives frame_als's layout",
    (frame) => {
      const vectorCase = byName.get("frame_als")!;
      expect(compareLayout(vectors, vectorCase, run(vectorCase, frame), frame)).toEqual([]);
    },
  );

  it.each([...vectors.frames.RAS].map((frame) => [frame]))(
    "%s gives frame_ras's layout",
    (frame) => {
      const vectorCase = byName.get("frame_ras")!;
      expect(compareLayout(vectors, vectorCase, run(vectorCase, frame), frame)).toEqual([]);
    },
  );

  it("converts every cart2topo point with no fit", () => {
    for (const entry of vectors.cart2topo) {
      const got = cart2topo(entry.point);
      expect(
        Math.abs(got.thetaDeg - entry.theta_deg),
        `${entry.point}: theta ${got.thetaDeg}`,
      ).toBeLessThanOrEqual(vectors.tolerance.cart2topo_theta_deg);
      expect(Math.abs(got.radius - entry.radius), `${entry.point}`).toBeLessThanOrEqual(
        vectors.tolerance.radius,
      );
    }
  });
});

describe("frames are never assumed", () => {
  it("compares names exactly, case included, and reads the one alias", () => {
    expect(orientation("CapTrak")).toBe("RAS");
    expect(orientation("EEGLAB")).toBe("ALS");
    expect(orientation("MNI152NLin6ASym")).toBe("RAS");
    for (const name of ["captrak", "eeglab", "Other", "Pixels", "n/a", "", " CapTrak"]) {
      expect(orientation(name), JSON.stringify(name)).toMatchObject({ word: "frame_unknown" });
    }
  });

  it("takes template positions only as n/a beside one of the twenty montages, by exact name", () => {
    expect(MONTAGE_NAMES).toHaveLength(20);
    for (const montage of MONTAGE_NAMES) expect(orientation("n/a", montage)).toBe("RAS");
    expect(orientation("CapTrak", "GSN-HydroCel-32")).toMatchObject({ word: "frame_unknown" });
    expect(orientation("n/a", "gsn-hydrocel-32")).toMatchObject({ word: "frame_unknown" });
    expect(orientation("n/a", "PROVENANCE")).toMatchObject({ word: "frame_unknown" });
  });

  it("throws its own type, rather than guessing, when a template montage's center was not given", () => {
    const vectorCase = byName.get("template_montage")!;
    const p = vectorCase.positions;
    expect(() =>
      sensorLayout({ x: numbers(p.x), y: numbers(p.y), z: numbers(p.z) }, "n/a", {
        montage: vectorCase.montage,
        names: p.name,
      }),
    ).toThrow(MontageCenterUnavailable);
  });
});
