/**
 * The quality views' renderers (`src/lib/quality-views/render/`), from the models of neuroschema's
 * model vectors: every case draws without throwing, each figure carries its caption, its text
 * alternative and its data table, every readout prints a stored cell's text, an unknown kind falls
 * back to tables, and a scalp map's readout is its sensor's stored value, never a grid cell.
 *
 * The renderers are pure functions to an element tree (`tree.ts`), so this runs without a browser;
 * the tree is checked as HTML and element by element.
 */

import { describe, expect, it } from "vitest";
import { drawAs } from "../src/lib/quality-views/kinds";
import { localChecks } from "../src/lib/quality-views/local-checks";
import {
  type BuiltModel,
  type FileDecl,
  type HistogramModel,
  type LinesModel,
  type SensorFieldModel,
  buildModel,
} from "../src/lib/quality-views/model";
import { type Montage, parseMontage } from "../src/lib/quality-views/montages";
import { RENDER_FAILED } from "../src/lib/quality-views/render/fallback";
import { DATA_TABLE, safeUrl } from "../src/lib/quality-views/render/figure";
import {
  heatmapLegend,
  heatmapPixels,
  heatmapReadout,
  renderHeatmap,
} from "../src/lib/quality-views/render/heatmap";
import {
  HISTOGRAM_SIZE,
  histogramBars,
  histogramLabel,
  histogramReadout,
  histogramRows,
  histogramSvg,
  markedIndex,
} from "../src/lib/quality-views/render/histogram";
import {
  mountView,
  renderRefusal,
  renderView,
  viewContext,
} from "../src/lib/quality-views/render/index";
import { readoutWriter } from "../src/lib/quality-views/render/interact";
import {
  linesPlot,
  linesReadout,
  linesSvg,
  rowAtPointer,
  yTickTexts,
} from "../src/lib/quality-views/render/lines";
import {
  LEGEND_NOTE,
  fieldDrawInput,
  mapTextRow,
  markerReadout,
  placementStatement,
  sensorReadout,
} from "../src/lib/quality-views/render/sensor-field-view";
import { type Element, textOf, toHtml, walk } from "../src/lib/quality-views/tree";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeFs, repoPath } from "./node";
import { MONTAGES_DIR, mapOutcome } from "./quality-views-vectors";

type Files = Record<string, { text?: string; base64?: string }>;
interface ModelCase {
  readonly name: string;
  readonly view: { caption: string; kind: string; kind_version: number };
  readonly files: Files;
  readonly caps?: Record<string, number>;
}

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/kinds-models.v1.json"), "utf8"),
) as { cases: ModelCase[] };

async function montage(name: string): Promise<Montage> {
  return parseMontage(
    JSON.parse(fs.readFileSync(repoPath(`${MONTAGES_DIR}/${name}.json`), "utf8")),
    name,
  );
}

const source =
  (files: Files) =>
  async (file: FileDecl): Promise<Uint8Array | null> => {
    const held = files[file.location];
    if (!held) return null;
    if (held.text !== undefined) return new TextEncoder().encode(held.text);
    return Uint8Array.from(atob(held.base64!), (c) => c.charCodeAt(0));
  };

const caps = (c?: Record<string, number>) =>
  c ? { bytes_per_role: 4194304, entries_per_dim: 1024, cells_per_role: 262144, ...c } : undefined;

async function built(c: ModelCase, compute = false): Promise<BuiltModel> {
  return buildModel(c.view, source(c.files), {
    checks: localChecks,
    montage,
    caps: caps(c.caps),
    mapOutcome: compute ? mapOutcome : undefined,
  });
}

const byName = (name: string) => vectors.cases.find((c) => c.name === name)!;
const ctxOf = (c: ModelCase) => viewContext(c.view as never, `qv-${c.name}`);
const elements = (tree: Element, cls: string) =>
  [...walk(tree)].filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));

describe("every model vector draws", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const b = await built(c);
    const { tree } = await renderView(b, ctxOf(c));
    expect(tree.tag).toBe("figure");
    const caption = [...walk(tree)].find((e) => e.tag === "figcaption")!;
    expect(tree.attrs["aria-labelledby"]).toBe(caption.attrs.id);
    expect(textOf(caption)).toContain(c.view.caption);
    // No view hides data: every file is listed for download.
    const listed = elements(tree, "qv-downloads")[0];
    expect(listed ? listed.children.length : 0).toBe(b.downloads.length);
    // A drawing has a text alternative that starts with the caption.
    for (const drawing of elements(tree, "qv-drawing")) {
      expect(drawing.attrs["aria-label"].startsWith(c.view.caption)).toBe(true);
    }
    expect(() => toHtml(tree)).not.toThrow();
  });
});

describe("the renderer rule never throws", () => {
  const unknown = {
    key: "movie",
    kind: "acme.scalp-movie",
    kind_version: 7,
    caption: "A kind no renderer knows.",
    source: { plugin: { name: "acme", version: "1" } },
    data: [
      {
        role: "frames",
        location: "sub-01/x_frames.tsv",
        format: "tsv",
        size: 4,
        sha256: "0f1c3b3a0dcd4b5d6c3e9bd0bbcb2b9c4b04e1f7a0e3c3b0d53e3b4c3b2f1e0d",
      },
    ],
  };

  it("draws an unknown kind as tables", () => {
    expect(drawAs(unknown as never)).toEqual({ via: "table", kind: null, kind_version: null });
  });

  it("builds an unknown kind's model as the fallback", async () => {
    const b = await buildModel(unknown, async () => new TextEncoder().encode("a\tb\n"), {
      checks: localChecks,
      montage,
      sha256: async () => unknown.data[0].sha256,
    }).catch((error: unknown) => error);
    expect(b).not.toBeInstanceOf(Error);
    expect((b as BuiltModel).model.type).toBe("fallback");
  });

  it("draws a model it has no renderer for as tables, without throwing", async () => {
    const strange = {
      drawing: { via: "kind", kind: "acme.x", kind_version: 1 },
      refused: null,
      downloads: [],
      model: { type: "acme-chart" },
    } as unknown as BuiltModel;
    const { tree } = await renderView(strange, viewContext(unknown as never, "qv-strange"));
    expect(tree.tag).toBe("figure");
    expect(textOf(tree)).toContain("does not draw acme.scalp-movie version 7");
  });

  it("words a refused view and still offers its other files", () => {
    const tree = renderRefusal(
      "file_digest_mismatch",
      [{ role: "values", location: "a/b.tsv", size: 3, sha256: "0".repeat(64) }],
      viewContext(unknown as never, "qv-refused"),
    );
    expect(textOf(tree)).toContain("does not match the digest NEMAR recorded");
    expect(textOf(tree)).toContain("b.tsv");
  });
});

describe("readouts print stored text", () => {
  it("lines: a pointer reads the nearest stored row and prints its texts", async () => {
    const b = await built(byName("lines_spectrum"));
    const model = b.model as LinesModel;
    const plot = linesPlot(model);
    const row = rowAtPointer(model, plot, plot.px(0.7));
    expect(row).toBe(1); // 0.7 is nearer 0.5 than 1
    const text = linesReadout(model, row, 0);
    expect(text).toContain(model.x.text[row]);
    expect(text).toContain(model.series.items[0].text[row]);
    // The axis prints the stored texts of the smallest and largest values.
    const ticks = yTickTexts(model);
    const all = model.series.items.flatMap((item) => item.text);
    expect(all).toContain(ticks.min);
    expect(all).toContain(ticks.max);
  });

  it("lines: a value stored as 1.25e1 is read out as 1.25e1", async () => {
    const model = (await built(byName("lines_spectrum"))).model as LinesModel;
    const at = model.series.items.findIndex((item) => item.text.includes("1.25e1"));
    expect(at).toBeGreaterThanOrEqual(0);
    const row = model.series.items[at].text.indexOf("1.25e1");
    expect(linesReadout(model, row, at)).toContain("1.25e1");
  });

  it("heatmap: a cell reads its labels and its stored text", async () => {
    const c = vectors.cases.find((x) => x.view.kind === "nemar.heatmap")!;
    const b = await built(c);
    if (b.model.type !== "heatmap") throw new Error("not a heatmap");
    expect(heatmapReadout(b.model, 0, 0)).toContain(b.model.text[0][0]);
    const pixels = heatmapPixels(b.model);
    expect(pixels.length).toBe(b.model.values.length * b.model.values[0].length * 4);
  });
});

describe("the histogram is one SVG tree for the server and the page", () => {
  const cases = vectors.cases.filter(
    (c) => c.view.kind === "nemar.histogram" && c.name.startsWith("histogram"),
  );

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const b = await built(c);
    if (b.model.type !== "histogram") return;
    const model: HistogramModel = b.model;
    const svg = histogramSvg(model);
    const html = toHtml(svg);
    expect(html.startsWith("<svg")).toBe(true);
    expect(html).toContain(`viewBox="0 0 ${HISTOGRAM_SIZE.width} ${HISTOGRAM_SIZE.height}"`);
    // One bar per bin, and an end bar only for a count that is not zero.
    const bars = histogramBars(model, 100, 100);
    const ends = [model.underflow, model.overflow].filter((e) => e && e.count > 0).length;
    expect(bars.length).toBe(model.items.length + ends);
    // The data table: each item, the ends for bins by edges, then the missing count.
    const rows = histogramRows(model);
    expect(rows.length).toBe(
      model.items.length + (model.bins === "edges" ? 2 : 0) + (model.missing ? 1 : 0),
    );
    for (const [k, item] of model.items.entries()) expect(rows[k][1]).toBe(String(item.count));
  });

  it("marks a value in the bin the edges' rule gives, and nothing for NaN", async () => {
    const c = vectors.cases.find(
      (x) => x.view.kind === "nemar.histogram" && (x as { locates?: unknown }).locates,
    ) as ModelCase & { locates: { value: number; bin: number }[] };
    const model = (await built(c)).model as HistogramModel;
    for (const { value, bin } of c.locates) expect(markedIndex(model, value)).toBe(bin);
    expect(markedIndex(model, Number.NaN)).toBeNull();
    const marked = toHtml(
      histogramSvg(model, { value: c.locates[0].value, text: "stored", label: "this recording" }),
    );
    expect(marked).toContain("qv-marked");
  });
});

describe("scalp maps", () => {
  const field = vectors.cases.filter((c) => {
    if (c.view.kind !== "nemar.sensor-field" && c.view.kind !== "nemar.ic-maps") return false;
    return true;
  });

  it("text rows: one per map, from stored texts", async () => {
    let checked = 0;
    for (const c of field) {
      const b = await built(c, true);
      if (b.model.type !== "sensor-field") continue;
      const model: SensorFieldModel = b.model;
      const { tree } = await renderView(b, ctxOf(c));
      const rows = elements(tree, "qv-map-rows")[0];
      expect(rows.children.length).toBe(model.maps.items.length);
      for (const [m, item] of model.maps.items.entries()) {
        const row = mapTextRow(model, m);
        expect(row.startsWith(item.label)).toBe(true);
        if (item.word === null) {
          // Every number in the row is a stored text of the map.
          const numbers = row.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
          for (const n of numbers.filter((x) => !model.maps.items[m].label.includes(x))) {
            if (!model.sensors.labels.some((label) => label.includes(n))) {
              expect(item.text).toContain(n);
            }
          }
        }
      }
      expect(placementStatement(model).length).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("the readout is the hovered sensor's stored value, never a grid cell", async () => {
    const c = byName(
      vectors.cases.find((x) => {
        const m = (
          x as unknown as {
            model: { model: { type?: string; placement?: { source: string; word: unknown } } };
          }
        ).model.model;
        return (
          m.type === "sensor-field" && m.placement?.source === "layout" && m.placement.word === null
        );
      })!.name,
    );
    const b = await built(c);
    const model = b.model as SensorFieldModel;
    const draw = fieldDrawInput({ ...b, model })!;
    expect(draw).not.toBeNull();
    const client = new SensorFieldClient(inThreadWorker);
    const outcome = await client.draw({
      layoutKey: "render-test",
      thetaDeg: draw.thetaDeg,
      radius: draw.radius,
      maps: draw.maps,
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    const map = outcome.maps[0];
    if (map.kind !== "map") throw new Error("map refused");
    const m = draw.mapIndices[0];
    for (const [k, plotted] of map.geometry.plotted.entries()) {
      const row = draw.rows[plotted];
      const stored = `${model.sensors.labels[row]}: ${model.maps.items[m].text[row]}`;
      expect(sensorReadout(model, m, row)).toContain(stored);
      // What a pointer or a key on the k-th marker shows.
      expect(markerReadout(model, draw, map, m, k)).toContain(stored);
    }
    // The grid near a sensor is interpolated and differs from the stored value: a readout that
    // read the grid would print another number.
    const stored = new Set(model.maps.items[m].text);
    const cells = [...map.grid].filter(Number.isFinite).slice(0, 50).map(String);
    expect(cells.some((cell) => !stored.has(cell))).toBe(true);
  });

  it("asks the worker only for drawn rows and maps that a placement word did not take", async () => {
    for (const c of field) {
      const b = await built(c);
      if (b.model.type !== "sensor-field") continue;
      const model: SensorFieldModel = b.model;
      const draw = fieldDrawInput({ ...b, model });
      if (model.placement.word !== null) {
        expect(draw).toBeNull();
        continue;
      }
      if (!draw) continue;
      expect(draw.rows).toEqual(model.sensors.drawn.flatMap((d, k) => (d ? [k] : [])));
      for (const [i, m] of draw.mapIndices.entries()) {
        expect([...draw.maps[i]]).toEqual(draw.rows.map((k) => model.maps.items[m].values[k]));
      }
    }
  });

  it("each drawn map is an image with a text alternative and the color map notice is linked", async () => {
    const c = field.find((x) => x.name.includes("layout")) ?? field[0];
    const b = await built(c);
    const { tree } = await renderView(b, ctxOf(c));
    if (b.model.type !== "sensor-field") return;
    const canvases = [...walk(tree)].filter((e) => e.tag === "canvas");
    expect(canvases.length).toBe(b.model.maps.items.filter((item) => item.word === null).length);
    for (const canvas of canvases) {
      expect(canvas.attrs.role).toBe("img");
      expect(canvas.attrs["aria-label"].length).toBeGreaterThan(0);
    }
    expect(toHtml(tree)).toContain('href="/licenses/quality-views/NOTICE.txt"');
  });
});

describe("the review's fixes (#594)", () => {
  const heatmap = (
    overrides: Partial<import("../src/lib/quality-views/model").HeatmapModel> = {},
  ) =>
    ({
      type: "heatmap",
      rows: { dim: "component", type: "string", unit: null, labels: ["IC1", "IC2"] },
      columns: {
        dim: "class",
        type: "string",
        unit: null,
        labels: ["brain", "eye"],
        names: ["brain", "eye"],
      },
      unit: "%",
      values: [
        [15, -2],
        [4.25, 88],
      ],
      text: [
        ["1.50e1", "-2.0"],
        ["4.25", "8.8E1"],
      ],
      limits: { rule: "minmax", min: -2, max: 88 },
      ...overrides,
    }) as import("../src/lib/quality-views/model").HeatmapModel;

  it("heatmap: the readout prints the stored text, not the value printed again", () => {
    const model = heatmap();
    expect(heatmapReadout(model, 0, 0)).toBe("IC1, brain: 1.50e1 %");
    expect(heatmapReadout(model, 0, 0)).not.toContain(String(model.values[0][0]));
  });

  it("heatmap: the legend prints the smallest and largest cells' texts, or the largest magnitude", () => {
    expect(heatmapLegend(heatmap())).toEqual({ low: "-2.0 %", high: "8.8E1 %", note: null });
    const absmax = heatmapLegend(heatmap({ limits: { rule: "absmax", min: -88, max: 88 } }));
    expect(absmax.low).toBe("negative");
    expect(absmax.high).toBe("positive");
    expect(absmax.note).toContain("8.8E1 %");
    const tree = renderHeatmap(
      heatmap(),
      [],
      viewContext({ caption: "C.", kind: "nemar.heatmap", kind_version: 1 } as never, "h"),
    );
    expect(textOf(tree)).toContain("8.8E1 %");
  });

  it("histogram: a bar's readout carries the unit for bins by edges, and the mark its stored text", async () => {
    const c = vectors.cases.find(
      (x) => x.view.kind === "nemar.histogram" && (x as { locates?: unknown }).locates,
    ) as ModelCase & { locates: { value: number; bin: number }[] };
    const model = (await built(c)).model as HistogramModel;
    const bars = histogramBars(model, 100, 100);
    const bin = bars.find((bar) => bar.index === 0)!;
    expect(
      histogramReadout(model, bin).startsWith(
        model.unit ? `${bin.label} ${model.unit}: ${bin.count}` : `${bin.label}: ${bin.count}`,
      ),
    ).toBe(true);
    if (model.heights === "density") {
      expect(histogramReadout(model, bin)).toContain("per unit width");
    }
    expect(histogramReadout({ ...model, unit: "%" }, bin).startsWith(`${bin.label} %: `)).toBe(
      true,
    );
    const inside = c.locates.find((l) => l.bin >= 0 && l.bin < model.items.length)!;
    const mark = { value: inside.value, text: "stored-text", label: "this recording" };
    const label = histogramLabel(model, "Caption.", mark);
    expect(label).toContain("this recording: stored-text");
    expect(label).toContain(`in the bin ${model.items[inside.bin].label}`);
    expect(histogramLabel(model, "Caption.", { ...mark, value: Number.NaN })).toContain(
      "in no bin",
    );
    expect(toHtml(histogramSvg(model, mark))).toContain("this recording: stored-text");
  });

  it("builds the data table when its toggle first opens, or now on the server", async () => {
    const c = byName("lines_spectrum");
    const b = await built(c);
    const { tree, table } = await renderView(b, ctxOf(c));
    const details = [...walk(tree)].find((e) => e.tag === "details")!;
    expect([...walk(details)].some((e) => e.tag === "table")).toBe(false);
    expect(textOf(details)).toBe(DATA_TABLE);
    expect(table!().tag).toBe("table");
    const eager = await renderView(b, { ...ctxOf(c), eagerTables: true });
    const filled = [...walk(eager.tree)].find((e) => e.tag === "details")!;
    expect([...walk(filled)].some((e) => e.tag === "table")).toBe(true);
  });

  it("says a view could not be drawn, and lists its files, when its renderer fails", async () => {
    const broken = {
      drawing: { via: "kind", kind: "nemar.lines", kind_version: 1 },
      refused: null,
      downloads: [{ role: "values", location: "a/b.tsv", size: 3, sha256: "0".repeat(64) }],
      model: { type: "lines" },
    } as unknown as BuiltModel;
    const { tree } = await renderView(
      broken,
      viewContext({ caption: "C.", kind: "nemar.lines", kind_version: 1 } as never, "b"),
    );
    expect(textOf(tree)).toContain(RENDER_FAILED);
    expect(textOf(tree)).toContain("b.tsv");
  });

  it("never writes a coordinate that is not a number, even for spans past the largest double", () => {
    const model = {
      type: "lines",
      x: {
        dim: "x",
        type: "number",
        unit: null,
        column: "x",
        values: [-1.7e308, 0, 1.7e308],
        text: ["a", "b", "c"],
      },
      y: { unit: null, min: -1.7e308, max: 1.7e308 },
      series: {
        dim: "s",
        type: "string",
        unit: null,
        items: [{ label: "s", column: "s", values: [-1.7e308, 0, 1.7e308], text: ["d", "e", "f"] }],
      },
    } as unknown as LinesModel;
    const html = toHtml(linesSvg(model));
    expect(html).not.toMatch(/NaN|Infinity/);
    const plot = linesPlot(model);
    expect(rowAtPointer(model, plot, plot.width)).toBe(2);
    const histogram = {
      type: "histogram",
      bins: "edges",
      heights: "count",
      unit: null,
      items: [
        {
          label: "[-1.7e+308, 0)",
          lower: -1.7e308,
          upper: 0,
          upper_closed: false,
          count: 1,
          width: 1.7e308,
          density: 0,
        },
        {
          label: "[0, 1.7e+308]",
          lower: 0,
          upper: 1.7e308,
          upper_closed: true,
          count: 2,
          width: 1.7e308,
          density: 0,
        },
      ],
      underflow: { label: "< -1.7e+308", count: 0 },
      overflow: { label: "> 1.7e+308", count: 0 },
      missing: null,
      total: 3,
      max_count: 2,
      max_density: 0,
    } as unknown as HistogramModel;
    expect(toHtml(histogramSvg(histogram))).not.toMatch(/NaN|Infinity/);
  });

  it("links a download only by http(s), blob or a path on this site", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(" JavaScript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("vbscript:x")).toBeNull();
    expect(safeUrl("https://data.nemar.org/x.tsv")).toBe("https://data.nemar.org/x.tsv");
    expect(safeUrl("blob:https://nemar.org/1")).toBe("blob:https://nemar.org/1");
    expect(safeUrl("/api/quality/x.tsv")).toBe("/api/quality/x.tsv");
    const c = byName("table_channels");
    return built(c).then(async (b) => {
      const ctx = { ...ctxOf(c), downloadUrl: () => "javascript:alert(1)" };
      const { tree } = await renderView(b, ctx);
      expect(toHtml(tree)).not.toContain("javascript:");
    });
  });

  it("speaks a readout only when its text changes", () => {
    const output = { textContent: "" as string | null };
    const write = readoutWriter(output);
    expect(write("a")).toBe(true);
    expect(write("a")).toBe(false);
    expect(write("b")).toBe(true);
    expect(output.textContent).toBe("b");
  });

  it("scalp maps: one tab stop for all maps, none on the group, and the legend says each map's range is its own", async () => {
    let checked = 0;
    for (const c of vectors.cases.filter((x) => x.view.kind === "nemar.sensor-field")) {
      const b = await built(c);
      if (b.model.type !== "sensor-field") continue;
      const { tree } = await renderView(b, ctxOf(c));
      const canvases = [...walk(tree)].filter((e) => e.tag === "canvas");
      if (canvases.length === 0) continue;
      expect(canvases.filter((e) => e.attrs.tabindex === "0")).toHaveLength(1);
      expect(canvases.filter((e) => e.attrs.tabindex === "-1")).toHaveLength(canvases.length - 1);
      const group = elements(tree, "qv-drawing")[0];
      expect(group.attrs.role).toBe("group");
      expect(group.attrs.tabindex).toBeUndefined();
      expect(textOf(tree)).toContain(LEGEND_NOTE);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("has a turbo legend whose stops are the turbo table's", async () => {
    const css = fs.readFileSync(repoPath("src/styles/quality-views.css"), "utf8");
    expect(css).toContain(".qv-legend-turbo");
    const tokens = fs.readFileSync(repoPath("src/styles/tokens.css"), "utf8");
    const { lookupTable } = await import("../src/lib/quality-views/colormap");
    const lut = lookupTable("turbo");
    [0, 64, 128, 191, 255].forEach((entry, k) => {
      const hex = `#${[0, 1, 2].map((i) => lut[entry * 3 + i].toString(16).padStart(2, "0")).join("")}`;
      expect(tokens).toContain(`--qv-turbo-${k}: ${hex};`);
    });
  });
});

describe("the review's repros (#594, round 2): mounting and the keys", () => {
  /** Just enough of a document for `toDom` and `mountView`: elements record their children. */
  function fakeDocument() {
    const element = (tag: string) => ({
      tag,
      attrs: {} as Record<string, string>,
      children: [] as unknown[],
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
      appendChild(child: unknown) {
        this.children.push(child);
        return child;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    return {
      createElement: element,
      createElementNS: (_ns: string, tag: string) => element(tag),
      createTextNode: (text: string) => ({ text }),
    };
  }

  it("a fast remount wins: the slower, older mount never replaces it", async () => {
    const doc = fakeDocument();
    const shown: string[] = [];
    const container = {
      ownerDocument: doc,
      replaceChildren(child: { attrs: Record<string, string> }) {
        shown.push(child.attrs.id);
      },
    } as unknown as HTMLElement;
    const c = byName("table_channels");
    const table = await built(c);
    const fallback = { ...table, model: { type: "fallback", tables: [] } } as BuiltModel;
    const deps = {
      client: () => new SensorFieldClient(inThreadWorker),
      layoutKey: "k",
      colors: { foreground: "#000", background: "#fff", contour: "#000" },
    };
    // The first mount loads the table renderer's chunk; the second needs none and finishes first.
    const older = mountView(container, table, viewContext(c.view as never, "older"), deps);
    const newer = mountView(container, fallback, viewContext(c.view as never, "newer"), deps);
    const [a, b] = await Promise.all([older, newer]);
    expect(shown).toEqual(["newer"]);
    expect(a.element).toBeNull();
    expect(b.element).not.toBeNull();
  });

  it("an aborted mount changes nothing", async () => {
    const shown: unknown[] = [];
    const container = {
      ownerDocument: fakeDocument(),
      replaceChildren: (child: unknown) => shown.push(child),
    } as unknown as HTMLElement;
    const b = await built(byName("table_channels"));
    const stop = new AbortController();
    const mounting = mountView(
      container,
      b,
      viewContext(b as never, "x"),
      {} as never,
      stop.signal,
    );
    stop.abort();
    expect((await mounting).element).toBeNull();
    expect(shown).toEqual([]);
  });

  it("lines, heatmaps and histograms say what they are and the keys they answer", async () => {
    const names = {
      "nemar.lines": "line chart",
      "nemar.heatmap": "heatmap",
      "nemar.histogram": "histogram",
    } as const;
    for (const [kind, roleDescription] of Object.entries(names)) {
      const c = vectors.cases.find(
        (x) =>
          x.view.kind === kind &&
          (x as unknown as { model: { drawing: { via: string } } }).model.drawing.via === "kind",
      )!;
      const { tree } = await renderView(await built(c), ctxOf(c));
      const drawing = elements(tree, "qv-drawing")[0];
      expect(drawing.attrs["aria-roledescription"], kind).toBe(roleDescription);
      expect(textOf(elements(tree, "qv-keys")[0]), kind).toMatch(/^Keys: /);
    }
  });
});
