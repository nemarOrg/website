import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { parseColor } from "./brain-gl";
import { buildDrawList, buildFigure, buildSvg } from "./export";
import {
  type GeometryInput,
  type RecordingGeometry,
  type Units,
  type Vec3,
  resolveRecordingGeometry,
} from "./geometry";
import {
  type GroupInfo,
  type PanelEvent,
  type PanelState,
  contactColors,
  drawnPositions,
  initialState,
  reduce,
  templatePlacementFor,
  templateRuleOf,
  viewModel,
} from "./panel";
import { UNITS_BANNER_MIN_DISTANCE_MM, unitsBanner } from "./units-banner";

/**
 * The banner on a dataset whose declared unit disagrees with its numbers. Real recordings only:
 * on004100 (declares meters, writes millimeter-sized numbers: its contacts lie 28 to 62 meters out
 * once the declared unit is applied) and on004473 (declares meters and means it: its contacts lie
 * 29 to 115 millimeters out), read by the module's own resolver over the committed files of
 * test/fixtures/ieeg-geometry. Known-answer inputs, said where used: unit records and positions for
 * the threshold's two sides.
 */

const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

function geometryOf(datasetId: string, version: string, recording: string) {
  const at = (rel: string) => repoPath(`${FIXTURES}/${datasetId}/${version}/${rel}`);
  const reader: Pick<GeometryInput, "listDir" | "readText"> = {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) => (fs.existsSync(at(path)) ? fs.readFileSync(at(path), "utf8") : null),
  };
  return resolveRecordingGeometry({ datasetId, version, recording, ...reader });
}

const ON4100 =
  "sub-HUP060/ses-presurgery/ieeg/sub-HUP060_ses-presurgery_task-ictal_acq-seeg_run-01_ieeg.edf";
const ON4473 = "sub-1/ieeg/sub-1_task-SlowFast_ieeg.edf";
const NM485 = "sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.vhdr";

const on4100 = await geometryOf("on004100", "v1.0.0", ON4100);
const on4473 = await geometryOf("on004473", "v1.0.0", ON4473);
const nm485 = await geometryOf("nm000485", "v1.0.2", NM485);

const positionsOf = (g: RecordingGeometry, space = 0): Vec3[] =>
  g.spaces[space].contacts.flatMap((c) => (c.position ? [c.position] : []));
const norm = (p: Vec3) => Math.hypot(p[0], p[1], p[2]);

const METERS: Units = { declared: "m", unit: "mm", scaleToMm: 1000, unitsDeclared: true };
const CENTIMETERS: Units = { declared: "cm", unit: "mm", scaleToMm: 10, unitsDeclared: true };
const MILLIMETERS: Units = { declared: "mm", unit: "mm", scaleToMm: 1, unitsDeclared: true };
const UNDECLARED: Units = { declared: null, unit: null, scaleToMm: null, unitsDeclared: false };

describe("the rule", () => {
  it("fixes the distance at 300 mm", () => {
    expect(UNITS_BANNER_MIN_DISTANCE_MM).toBe(300);
  });

  it("on004100: every contact lies far past it, so the banner says so, in the declared unit and the largest distance", () => {
    const space = on4100.spaces[0];
    expect(space.units).toMatchObject({ declared: "m", scaleToMm: 1000 });
    const norms = positionsOf(on4100).map(norm);
    expect(Math.min(...norms)).toBeGreaterThan(300);
    const b = unitsBanner(space.units, positionsOf(on4100));
    expect(b).not.toBeNull();
    expect(b?.declared).toBe("m");
    expect(b?.largestMm).toBe(Math.max(...norms));
    expect(b?.text).toBe(
      "Declared unit m, but the values look millimeter-sized (largest distance 61,924 mm from the origin). Positions are shown as declared and are not placed on any template.",
    );
  });

  it("on004473: a dataset in meters that means meters has none", () => {
    for (const i of [0, 1]) {
      const positions = positionsOf(on4473, i);
      expect(Math.max(...positions.map(norm))).toBeLessThan(300);
      expect(unitsBanner(on4473.spaces[i].units, positions)).toBeNull();
    }
  });

  it("a dataset in millimeters, or with no declared unit, never has one, however far its contacts are", () => {
    expect(unitsBanner(nm485.spaces[0].units, positionsOf(nm485))).toBeNull();
    const far: Vec3[] = [
      [900, 0, 0],
      [0, 900, 0],
    ];
    expect(unitsBanner(MILLIMETERS, far)).toBeNull();
    expect(unitsBanner(UNDECLARED, far)).toBeNull();
    expect(unitsBanner({ ...UNDECLARED, declared: "n/a" }, far)).toBeNull();
  });

  it("needs every contact past 300 mm: one inside is a plausible head, and a distance of exactly 300 is not past it", () => {
    const past = positionsOf(on4100);
    expect(unitsBanner(METERS, past)).not.toBeNull();
    expect(unitsBanner(METERS, [...past, [0, 0, 0]])).toBeNull();
    expect(unitsBanner(METERS, [...past, [120, 0, 0]])).toBeNull();
    expect(unitsBanner(METERS, [[300, 0, 0]])).toBeNull();
    expect(unitsBanner(METERS, [[300.001, 0, 0]])).not.toBeNull();
    expect(unitsBanner(METERS, [])).toBeNull();
  });

  it("any non-mm unit that was converted can trigger it, and names the unit the file wrote", () => {
    expect(unitsBanner(CENTIMETERS, [[500, 0, 0]])?.text).toMatch(/^Declared unit cm, but /);
  });

  it("reads the positions and never changes them (a 3-4-5 triangle gives the known distance 5000 mm)", () => {
    const positions: Vec3[] = [
      [3000, 4000, 0],
      [0, -300, 400],
    ];
    const copy = positions.map((p) => [...p]);
    const b = unitsBanner(METERS, positions);
    expect(positions).toEqual(copy);
    expect(b?.largestMm).toBe(5000);
    expect(Object.keys(b ?? {}).sort()).toEqual(["declared", "largestMm", "text"]);
  });

  it("writes the distance with thousands separators and whole millimeters", () => {
    expect(unitsBanner(METERS, [[1234567.4, 0, 0]])?.text).toContain(
      "largest distance 1,234,567 mm",
    );
    expect(unitsBanner(METERS, [[400, 0, 0]])?.text).toContain("largest distance 400 mm");
  });
});

// ---------------------------------------------------------------------------

function groupOf(labels: readonly string[]): GroupInfo {
  return {
    index: 0,
    modality: "IEEG",
    labels,
    units: labels.map(() => "V"),
    rateHz: 500,
    nativeRateHz: 500,
    durationS: 600,
  };
}

function play(events: PanelEvent[]) {
  let state: PanelState = initialState();
  const effects: ReturnType<typeof reduce>["effects"] = [];
  for (const e of events) {
    const t = reduce(state, e);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

function opened(datasetId: string, version: string, path: string, g: RecordingGeometry) {
  const labels = g.spaces[0].contacts.map((c) => c.name);
  return play([
    { type: "recording_changed", recording: { datasetId, version, path }, group: groupOf(labels) },
    { type: "geometry_resolved", token: 1, geometry: g },
    { type: "toggle_open" },
    { type: "window_changed", startS: 0, lengthS: 10 },
  ]);
}

describe("in the panel", () => {
  const rec = opened("on004100", "v1.0.0", ON4100, on4100);

  it("on004100: the model carries the banner, and the stage is the flat views, with the 3D switch off and saying why", () => {
    const model = viewModel(rec.state);
    // The 3D spheres are true-size millimeters, so at this distance a canvas would draw nothing;
    // the flat views size their dots in pixels and fit the contacts as declared.
    expect(model.stage.kind).toBe("views2d");
    expect(model.view).toMatchObject({
      shown: true,
      on: true,
      enabled: false,
      title:
        "3D view is off while the units banner shows; the three flat views draw every contact as declared",
    });
    expect(model.banner).toBe(
      "Declared unit m, but the values look millimeter-sized (largest distance 61,924 mm from the origin). Positions are shown as declared and are not placed on any template.",
    );
    expect(model.contacts).toHaveLength(38);
  });

  it("asking for the 3D view changes nothing under the banner, and without WebGL2 the stage says so as before", () => {
    const asked = reduce(rec.state, { type: "view_changed", view2d: false }).state;
    expect(viewModel(asked).stage.kind).toBe("views2d");
    expect(viewModel(asked).banner).toBe(viewModel(rec.state).banner);
    const noGl = reduce(rec.state, { type: "webgl_unavailable" }).state;
    expect(viewModel(noGl).stage.kind).toBe("no_webgl");
    expect(viewModel(noGl).banner).toBe(viewModel(rec.state).banner);
    expect(viewModel(noGl).view.title).toBe("3D view needs WebGL2");
  });

  it("the banner is said while contacts are drawn, and not where nothing is", () => {
    // More contacts than the renderer draws: a refusal, nothing drawn, so no banner on it.
    const refused = viewModel(rec.state, { maxContacts: 2 });
    expect(refused.stage.kind).toBe("refusal");
    expect(refused.banner).toBeNull();
  });

  it("the surface and outlines are never asked for, and no contact is moved onto a template", () => {
    expect(rec.effects.map((e) => e.type)).not.toContain("load_template");
    expect(rec.effects.map((e) => e.type)).not.toContain("load_outlines");
    expect(rec.state.template).toBe("idle");
    expect(rec.state.outlines).toBe("idle");
    // fsaverage has a registered row, but the banner withholds it: nothing is placed.
    expect(rec.state.placement?.space.frame).toMatchObject({ identifier: "fsaverage" });
    expect(templateRuleOf(rec.state)).toBeNull();
    expect(templatePlacementFor(rec.state, null)).toBeNull();
    expect(viewModel(rec.state).template).toBeNull();
  });

  it("positions are drawn as declared: the declared unit applied, nothing else", () => {
    const placed = rec.state.placement?.contacts ?? [];
    expect(placed.length).toBe(positionsOf(on4100).length);
    const drawn = drawnPositions(rec.state) ?? [];
    placed.forEach((c, i) => {
      const file = on4100.spaces[0].contacts.find((f) => f.name === c.name);
      expect(c.position).toEqual(file?.position);
      expect(drawn[i]).toEqual(file?.position);
      // The file's own numbers are in meters-by-declaration: 1000 times what is written.
      expect(file?.position?.[0]).toBe(Number(file?.raw.x) * 1000);
    });
  });

  it("the recorded line still says what the file wrote, in the file's own unit word", () => {
    const row = viewModel(rec.state).contacts[0];
    expect(row.recorded).toMatch(
      /^recorded \(-?[\d.e-]+, -?[\d.e-]+, -?[\d.e-]+\) m, frame: fsaverage/,
    );
    expect(row.template).toBeNull();
  });

  it("on004473 and nm000485 have no banner", () => {
    expect(viewModel(opened("on004473", "v1.0.0", ON4473, on4473).state).banner).toBeNull();
    expect(viewModel(opened("nm000485", "v1.0.2", NM485, nm485).state).banner).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const THEME = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#475569",
  border: "#e2e8f0",
  contact: "#f5b82e",
};
const PALETTE = { neutral: parseColor(THEME.contact), noData: parseColor("#64748b") };

function inputOf(state: PanelState) {
  return {
    state,
    model: viewModel(state),
    colors: contactColors(state, PALETTE),
    theme: THEME,
    template: templatePlacementFor(state, null),
    frameLabel: "fsaverage",
  };
}

describe("in the files", () => {
  const BANNER =
    "Declared unit m, but the values look millimeter-sized (largest distance 61,924 mm from the origin). Positions are shown as declared and are not placed on any template.";
  const rec = opened("on004100", "v1.0.0", ON4100, on4100);

  it("the SVG says it in a banner of its own, in the metadata, and still ends with the credit", () => {
    const svg = buildSvg(buildFigure(inputOf(rec.state), null));
    const group = /<g id="banner">(.*?)<\/g>/s.exec(svg);
    expect(group).not.toBeNull();
    expect((group?.[1] ?? "").replace(/<[^>]+>/g, "")).toBe(BANNER);
    expect(group?.[1]).toContain('data-role="banner"');
    expect(svg).toContain(`<dc:description>${BANNER}</dc:description>`);
    expect(svg.indexOf('<g id="banner">')).toBeLessThan(svg.indexOf('<g id="views">'));
    expect(svg.lastIndexOf('class="eegv-credit"')).toBeGreaterThan(svg.indexOf('<g id="banner">'));
  });

  it("the PNG draw list paints it as bold foreground text under the title, before the picture", () => {
    for (const image of [null, { width: 360, height: 288 }]) {
      const figure = buildFigure(inputOf(rec.state), image);
      const ops = buildDrawList(figure);
      const texts = ops.flatMap((o) => (o.op === "text" && o.label === "banner" ? [o] : []));
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.map((t) => t.text).join("")).toBe(BANNER);
      for (const t of texts) {
        expect(t.bold).toBe(true);
        expect(t.fill).toBe(THEME.foreground);
      }
      const firstBanner = ops.findIndex((o) => o.op === "text" && o.label === "banner");
      const firstPicture = ops.findIndex((o) => o.op === "image" || o.op === "frame");
      const title = ops.findIndex((o) => o.op === "text" && o.label === "title");
      expect(title).toBeLessThan(firstBanner);
      expect(firstBanner).toBeLessThan(firstPicture);
      expect(ops[ops.length - 1]).toEqual({ op: "credit" });
      // The picture starts below the last banner line.
      const lastBannerY = Math.max(...texts.map((t) => t.y));
      const top = figure.image?.y ?? figure.views?.cells[0].frame.y ?? 0;
      expect(top).toBeGreaterThan(lastBannerY);
    }
  });

  it("a figure of a dataset with no banner has none of it", () => {
    const ok = opened("on004473", "v1.0.0", ON4473, on4473).state;
    const input = { ...inputOf(ok), frameLabel: "ACPC" };
    const svg = buildSvg(buildFigure(input, null));
    expect(svg).not.toContain('id="banner"');
    expect(svg).not.toContain("Declared unit");
    const ops = buildDrawList(buildFigure(input, null));
    expect(ops.some((o) => o.op === "text" && o.label === "banner")).toBe(false);
  });
});
