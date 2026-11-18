import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { colorFor } from "./activity";
import { parseColor } from "./brain-gl";
import { CREDIT_CLASS, CREDIT_FONT_PX, RAVE_CREDIT } from "./credit";
import {
  EXPORT_SCALE,
  type ExportInput,
  FIGURE_WIDTH,
  type FigureTheme,
  type TemplatePlacement,
  buildDrawList,
  buildFigure,
  buildSvg,
  estimateWidth,
  exportSvg,
  figureFileName,
  figureLabels,
  frameFileLabel,
  rasterize,
  recordingStem,
  viewContacts,
  wrapText,
} from "./export";
import {
  type GeometryInput,
  type RecordingGeometry,
  joinChannels,
  resolveRecordingGeometry,
} from "./geometry";
import {
  type ActivityReport,
  type GroupInfo,
  type PanelEvent,
  type PanelState,
  type RecordingRef,
  WEBGL_SENTENCE,
  contactColors,
  frameName,
  initialState,
  reduce,
  templatePlacementFor,
  viewModel,
} from "./panel";
import { VIEWS_SENTENCE, VIEW_NAMES, parseViewOutlines } from "./views2d";

/**
 * Real files only. Geometry is read by the module's own resolver through a reader over the
 * committed fixtures of IS-C1 (test/fixtures/ieeg-geometry, SOURCES.json names dataset, version,
 * path and SHA-256); the template outlines are the vendored `views.json`; channel labels are the
 * real `_channels.tsv` of on005522's bipolar recording.
 *
 * Known-answer inputs, said where used: hand-made activity values chosen so means are obvious, the
 * template sentences IS-V2 will say (the seam's tests give them as data), and a recording stand-in
 * for the browser's canvas context in the one test that checks the order of painted operations
 * (the drawing API is the browser's; nothing of NEMAR's logic is replaced).
 */
const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

function treeReader(
  datasetId: string,
  version: string,
): Pick<GeometryInput, "listDir" | "readText"> {
  const at = (rel: string) => repoPath(`${FIXTURES}/${datasetId}/${version}/${rel}`);
  return {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) => (fs.existsSync(at(path)) ? fs.readFileSync(at(path), "utf8") : null),
  };
}

function geometryOf(
  datasetId: string,
  version: string,
  recording: string,
): Promise<RecordingGeometry> {
  return resolveRecordingGeometry({
    datasetId,
    version,
    recording,
    ...treeReader(datasetId, version),
  });
}

function channelLabels(datasetId: string, version: string, path: string): string[] {
  const text = fs.readFileSync(repoPath(`${FIXTURES}/${datasetId}/${version}/${path}`), "utf8");
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((l) => l.split("\t")[0]);
}

const BIPOLAR = "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_ieeg.edf";
const ON4473 = "sub-1/ieeg/sub-1_task-SlowFast_ieeg.edf";
const NM485 = "sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.vhdr";
const BIPOLAR_LABELS = channelLabels(
  "on005522",
  "v1.0.0",
  "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_channels.tsv",
);
const REC: RecordingRef = { datasetId: "on005522", version: "v1.0.0", path: BIPOLAR };

function groupOf(labels: readonly string[]): GroupInfo {
  return {
    index: 0,
    modality: "IEEG",
    labels,
    units: labels.map(() => "V"),
    rateHz: 500,
    nativeRateHz: 500,
    durationS: 2899,
  };
}

function play(from: PanelState, events: PanelEvent[]): PanelState {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

function opened(
  geometry: RecordingGeometry,
  group: GroupInfo,
  recording: RecordingRef,
  more: PanelEvent[] = [],
): PanelState {
  return play(initialState(), [
    { type: "recording_changed", recording, group },
    { type: "geometry_resolved", token: 1, geometry },
    { type: "toggle_open" },
    { type: "window_changed", startS: 0, lengthS: 10 },
    ...more,
  ]);
}

const bipolar = await geometryOf("on005522", "v1.0.0", BIPOLAR);
const acpc = await geometryOf("on004473", "v1.0.0", ON4473);
const nm485 = await geometryOf("nm000485", "v1.0.2", NM485);

const THEME: FigureTheme = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#475569",
  border: "#e2e8f0",
  contact: "#f5b82e",
};
const PALETTE = { neutral: parseColor(THEME.contact), noData: parseColor("#64748b") };

const OUTLINES = parseViewOutlines(
  JSON.parse(
    fs.readFileSync(
      repoPath("public/vendor/brain-templates/mni152nlin2009casym@1/views.json"),
      "utf8",
    ),
  ),
);
/** What IS-V2 will say for a standard template frame that is not the template's own; known-answer data. */
const TEMPLATE: TemplatePlacement = {
  outlines: OUTLINES,
  labels: [
    "Template brain, not this subject's anatomy.",
    "Approximate: MNI template variants differ by a few millimeters.",
  ],
};

function inputOf(state: PanelState, template: TemplatePlacement | null = null): ExportInput {
  const model = viewModel(state);
  return {
    state,
    model,
    colors: contactColors(state, PALETTE),
    theme: THEME,
    template,
    frameLabel: frameName(state.placement?.space.frame ?? null),
  };
}

/** A report with obvious values: channel row i has value i + 1, in µV². */
function knownReport(token: number, labels: readonly string[]): ActivityReport {
  return {
    token,
    metric: "band_power",
    band: "high_gamma",
    relative: false,
    unit: "µV²",
    windowS: 10,
    analyzedS: 9.5,
    segments: 18,
    segmentSamples: 512,
    referenceHz: null,
    channels: labels.map((label, i) => ({ label, value: i + 1, reason: null })),
  };
}

const plain = opened(bipolar, groupOf(BIPOLAR_LABELS), REC);
const withActivity = (() => {
  const on = play(plain, [{ type: "activity_switch", on: true }]);
  return reduce(on, {
    type: "activity_report",
    report: knownReport(on.activity.token, BIPOLAR_LABELS),
  }).state;
})();
const selectedActivity = play(withActivity, [{ type: "select_channel", label: "LAF1-LAF2" }]);

function svgOf(input: ExportInput): string {
  return exportSvg(input).data as string;
}

const unescapeXml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

/** The text of one `<text id="label-N">`: its tspans joined, as a reader sees it. */
function svgLabelText(svg: string, id: string): string | null {
  const m = new RegExp(`<text id="${id}"[^>]*>(.*?)</text>`, "s").exec(svg);
  if (!m) return null;
  return [...m[1].matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gs)].map((t) => unescapeXml(t[1])).join("");
}

/** A minimal well-formedness check: tags nest and close, attributes are quoted. */
function expectWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) expect(stack.pop(), `closing ${m[2]}`).toBe(m[2]);
    else stack.push(m[2]);
  }
  expect(stack).toEqual([]);
  // No stray angle bracket outside the tags matched above.
  const stripped = body.replace(/<\/?[A-Za-z][\w:.-]*(?:\s+[\w:.-]+="[^"<]*")*\s*\/?>/g, "");
  expect(stripped).not.toMatch(/[<>]/);
}

describe("exportSvg carries the credit inside the file", () => {
  const svg = svgOf(inputOf(plain, TEMPLATE));

  it("holds the credit's link around its text, with the address credit.ts declares", () => {
    const link = new RegExp(
      `<a [^>]*href="${RAVE_CREDIT.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>\\s*<text[^>]*>${RAVE_CREDIT.text}</text>\\s*</a>`,
    );
    expect(svg).toMatch(link);
    expect(svg).toContain(`https://doi.org/${RAVE_CREDIT.doi}`);
  });

  it("says approximate, as the screen's template sentence does", () => {
    expect(svg).toContain("Approximate: MNI template variants differ by a few millimeters.");
    expect(svgLabelText(svg, "label-2")).toContain("Approximate");
  });

  it("puts the credit last, after every label and view, so nothing covers it", () => {
    const credit = svg.lastIndexOf(`<g class="${CREDIT_CLASS}">`);
    expect(credit).toBeGreaterThan(svg.lastIndexOf('<g id="labels">'));
    expect(credit).toBeGreaterThan(svg.lastIndexOf('<g id="views">'));
    expect(svg.trimEnd().endsWith("</g>\n</svg>")).toBe(true);
    expect(svg.slice(credit).match(/<circle|<tspan/g)).toBeNull();
  });

  it("names the dataset, version, recording, frame, the labels and the credit in its metadata", () => {
    const meta = /<metadata id="figure-metadata".*?<\/metadata>/s.exec(svg)?.[0] ?? "";
    expect(meta).toContain("<nemar:dataset>on005522</nemar:dataset>");
    expect(meta).toContain("<nemar:version>v1.0.0</nemar:version>");
    expect(meta).toContain(`<nemar:recording>${BIPOLAR}</nemar:recording>`);
    expect(meta).toContain(
      `<nemar:frame>${frameName(plain.placement?.space.frame ?? null)}</nemar:frame>`,
    );
    expect(meta).toContain(`<dc:description>${RAVE_CREDIT.text}</dc:description>`);
    expect(meta).toContain(`<dc:relation>${RAVE_CREDIT.href}</dc:relation>`);
    expect(meta).toContain(`<dc:relation>https://doi.org/${RAVE_CREDIT.doi}</dc:relation>`);
    for (const label of figureLabels(inputOf(plain, TEMPLATE), true)) {
      expect(meta).toContain(`<dc:description>${label.text}</dc:description>`);
    }
  });

  it("is well-formed XML with one view group each for left, top and front", () => {
    expectWellFormed(svg);
    for (const name of VIEW_NAMES) expect(svg).toContain(`<g id="view-${name}"`);
    expect(svg.match(/<g id="view-/g)).toHaveLength(3);
    expect(svg).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 960 \d+"/,
    );
  });
});

describe("exportPng's draw list paints the credit last", () => {
  for (const [name, input, image] of [
    ["the three views", inputOf(selectedActivity, TEMPLATE), null],
    ["the 3D frame", inputOf(selectedActivity), { width: 1200, height: 900 }],
  ] as const) {
    it(`for ${name}`, () => {
      const ops = buildDrawList(buildFigure(input, image));
      expect(ops.filter((o) => o.op === "credit")).toHaveLength(1);
      expect(ops[ops.length - 1].op).toBe("credit");
      // Every label, view and the image come before it.
      const credit = ops.findIndex((o) => o.op === "credit");
      expect(ops.slice(0, credit).some((o) => o.op === "text")).toBe(true);
      expect(ops.slice(credit + 1)).toEqual([]);
    });
  }

  it("rasterizes the credit with the export canvas's own ratio, after every label", () => {
    const figure = buildFigure(inputOf(selectedActivity), null);
    for (const scale of [1, 2, 3]) {
      const width = Math.ceil(figure.width * scale);
      const height = Math.ceil(figure.height * scale);
      const { ctx, texts } = recordingContext();
      rasterize(ctx, buildDrawList(figure), { width, height, scale, theme: THEME });
      const last = texts[texts.length - 1];
      expect(last.text).toBe(RAVE_CREDIT.text);
      expect(Number.parseFloat(last.font)).toBeCloseTo(CREDIT_FONT_PX * scale);
      // Painted in canvas pixels: the backing sits in the bottom-right corner of this canvas.
      expect(last.x).toBeGreaterThan(width / 2);
      expect(last.y).toBeGreaterThan(height - 40 * scale);
      // Every other text came first and at the figure's own scale.
      expect(texts.slice(0, -1).every((t) => t.text !== RAVE_CREDIT.text)).toBe(true);
      expect(texts.length).toBeGreaterThan(3);
    }
    expect(EXPORT_SCALE).toBe(2);
  });
});

describe("template outlines only for a registered template placement", () => {
  const acpcState = opened(acpc, groupOf(acpc.spaces[0].contacts.map((c) => c.name)), {
    datasetId: "on004473",
    version: "v1.0.0",
    path: ON4473,
  });

  it("a native frame (ACPC) has no outline and no template sentence in the SVG", () => {
    expect(acpcState.placement?.space.frame?.kind).toBe("native");
    expect(templatePlacementFor(acpcState)).toBeNull();
    const svg = svgOf(inputOf(acpcState, templatePlacementFor(acpcState)));
    expect(svg).not.toContain("data-template-outline");
    expect(svg).not.toContain("Template brain");
  });

  it("a described frame (Other) has none either", () => {
    const other = play(
      opened(nm485, groupOf(nm485.spaces[0].contacts.map((c) => c.name)), {
        datasetId: "nm000485",
        version: "v1.0.2",
        path: NM485,
      }),
      [{ type: "frame_changed", spaceIndex: 0 }],
    );
    expect(other.placement?.space.frame?.kind).toBe("described");
    expect(svgOf(inputOf(other, templatePlacementFor(other)))).not.toContain(
      "data-template-outline",
    );
  });

  it("a registered template placement draws the outline in each of the three views", () => {
    const svg = svgOf(inputOf(plain, TEMPLATE));
    expect(svg.match(/data-template-outline/g)).toHaveLength(3);
    expect(svg).toContain("Template brain, not this subject's anatomy.");
  });

  it("draws the positions the seam hands over, and none for a contact it gives no position", () => {
    const n = plain.placement?.contacts.length ?? 0;
    const shifted =
      plain.placement?.contacts.map(
        (c) => [c.position[0] + 100, c.position[1], c.position[2]] as const,
      ) ?? [];
    const own = viewContacts(inputOf(plain, { ...TEMPLATE, positions: shifted }));
    expect(own.map((c) => c.position)).toEqual(shifted);
    const holes = shifted.map((p, i) => (i === 0 ? null : p));
    const svg = svgOf(inputOf(plain, { ...TEMPLATE, positions: holes }));
    expect(svg.match(/<circle /g)).toHaveLength(3 * (n - 1));
  });
});

describe("every located contact has one circle with a title", () => {
  it("one per view, titled with name, channel and, when Activity shows, its value", () => {
    const state = selectedActivity;
    const svg = svgOf(inputOf(state));
    const contacts = state.placement?.contacts ?? [];
    expect(svg.match(/<circle /g)).toHaveLength(3 * contacts.length);
    const circles = svg.match(/<circle [^>]*>.*?<\/circle>/g) ?? [];
    expect(circles).toHaveLength(3 * contacts.length);
    for (const c of circles) expect(c).toMatch(/<title>[^<]+<\/title><\/circle>$/);
    contacts.forEach((contact, i) => {
      const mine = circles.filter((c) => c.includes(`data-contact="${i}"`));
      expect(mine, contact.name).toHaveLength(3);
      for (const c of mine) expect(c).toContain(`<title>${contact.name}; channel`);
    });
    // LAF2 belongs to two channels; its title says both and carries its mean value, 1.5 µV².
    const laf2 = contacts.findIndex((c) => c.name === "LAF2");
    const title = /data-contact="\d+"[^>]*><title>(LAF2[^<]*)<\/title>/.exec(
      circles.find((c) => c.includes(`data-contact="${laf2}"`)) ?? "",
    )?.[1];
    expect(title).toBe("LAF2; channels LAF1-LAF2, LAF2-LAF3; 1.50 µV²");
  });

  it("says nothing of a value while Activity is off", () => {
    const svg = svgOf(inputOf(plain));
    expect(svg).not.toContain("µV²");
    expect(svg).toMatch(/<title>LAF1; channel LAF1-LAF2<\/title>/);
  });

  it("draws no circle for a channel that has no position", () => {
    // nm000485's Talairach file has contacts with n/a positions: their channels are unlocated.
    const group = groupOf(nm485.spaces[1].contacts.map((c) => c.name));
    const state = opened(nm485, group, { datasetId: "nm000485", version: "v1.0.2", path: NM485 }, [
      { type: "frame_changed", spaceIndex: 1 },
    ]);
    const unlocated = joinChannels(nm485.spaces[1], group.labels).filter(
      (j) => j.status === "unlocated",
    );
    expect(unlocated.length).toBeGreaterThan(0);
    const svg = svgOf(inputOf(state));
    expect(svg.match(/<circle /g)).toHaveLength(3 * (state.placement?.contacts.length ?? 0));
    for (const j of unlocated) expect(svg).not.toContain(`<title>${j.channel};`);
    // The unlocated channels are said in words, as on screen.
    expect(svg).toContain("unlocated channel");
  });
});

describe("the files say what the screen says", () => {
  const input = inputOf(selectedActivity, TEMPLATE);
  const { model } = input;
  const expected: string[] = [
    model.status ?? "",
    ...TEMPLATE.labels,
    ...model.notes,
    model.activity?.summary ?? "",
    model.activity?.noData ?? "",
    VIEWS_SENTENCE,
  ].filter((s) => s !== "");

  it("the screen has a status line, notes, a summary and a selection", () => {
    expect(model.status).toMatch(/channels located; frame: MNI152NLin6ASym;/);
    expect(model.notes.length).toBeGreaterThan(0);
    expect(model.activity?.summary).toContain("Welch's method");
    expect(model.contacts.some((c) => c.selected)).toBe(true);
  });

  it("every one of those sentences is in the SVG and in the PNG's draw list, in the same words", () => {
    const figure = buildFigure(input, null);
    const svg = buildSvg(figure);
    const ops = buildDrawList(figure);
    const drawn = (id: string) =>
      ops.flatMap((o) => (o.op === "text" && o.label === id ? [o.text] : [])).join("");
    for (const sentence of expected) {
      const label = figure.labels.find((l) => l.text === sentence);
      expect(label, sentence).toBeDefined();
      if (!label) continue;
      expect(svgLabelText(svg, label.id), sentence).toBe(sentence);
      expect(drawn(label.id), sentence).toBe(sentence);
    }
  });

  it("the colorbar ends and the selection are drawn as the screen words them", () => {
    const figure = buildFigure(input, null);
    const bar = model.activity?.colorbar;
    expect(bar).not.toBeNull();
    const texts = buildDrawList(figure).flatMap((o) => (o.op === "text" ? [o.text] : []));
    expect(texts).toContain(bar?.lo);
    expect(texts).toContain(bar?.hi);
    const selected = figure.labels.find((l) => l.role === "selected");
    expect(selected?.text).toBe(
      "Selected: LAF1 (LAF1-LAF2): 1.00 µV²; LAF2 (LAF1-LAF2, LAF2-LAF3): 1.50 µV²",
    );
  });

  it("a state without Activity has no colorbar, summary or value", () => {
    const figure = buildFigure(inputOf(plain), null);
    expect(figure.colorbar).toBeNull();
    expect(figure.labels.some((l) => l.role === "activity")).toBe(false);
    expect(figure.labels.some((l) => l.role === "selected")).toBe(false);
  });

  it("the frame selector's choice is a label when the recording has several frames", () => {
    // nm000485 declares Other and Talairach; the screen's selector shows the chosen one.
    const state = play(
      opened(nm485, groupOf(nm485.spaces[1].contacts.map((c) => c.name)), {
        datasetId: "nm000485",
        version: "v1.0.2",
        path: NM485,
      }),
      [{ type: "frame_changed", spaceIndex: 1 }],
    );
    const frames = viewModel(state).frames;
    expect(frames?.options.map((o) => o.label)).toEqual(["Other", "Talairach"]);
    const texts = figureLabels(inputOf(state), true).map((l) => l.text);
    expect(texts).toContain("Frame Talairach");
    expect(texts).not.toContain("Frame Other");
  });

  it("the 3D PNG says the same, without the axes sentence for views it does not draw", () => {
    const withViews = figureLabels(input, true).map((l) => l.text);
    const without = figureLabels(input, false).map((l) => l.text);
    expect(withViews).toContain(VIEWS_SENTENCE);
    expect(without).not.toContain(VIEWS_SENTENCE);
    expect(without).toEqual(withViews.filter((t) => t !== VIEWS_SENTENCE));
  });

  it("without WebGL2 the screen's sentence is a label too", () => {
    const state = reduce(plain, { type: "webgl_unavailable" }).state;
    expect(figureLabels(inputOf(state), true).some((l) => l.text === WEBGL_SENTENCE)).toBe(true);
  });

  it("draws the colorbar from the scale the screen uses", () => {
    const figure = buildFigure(input, null);
    const scale = selectedActivity.activity.shown?.scale;
    if (!scale || !figure.colorbar) throw new Error("no scale");
    expect(figure.colorbar.steps).toHaveLength(48);
    const first = colorFor(scale, scale.lo + (0.5 / 48) * (scale.hi - scale.lo));
    expect(figure.colorbar.steps[0].fill).toBe(`rgb(${first?.[0]}, ${first?.[1]}, ${first?.[2]})`);
  });
});

describe("the figure's layout", () => {
  it("is as wide as declared, with the credit's footer clear of every label and view", () => {
    const figure = buildFigure(inputOf(selectedActivity, TEMPLATE), null);
    expect(figure.width).toBe(FIGURE_WIDTH);
    const lowest = Math.max(...figure.lines.map((l) => l.y));
    expect(lowest).toBeLessThan(figure.footer.y);
    for (const cell of figure.views?.cells ?? []) {
      expect(cell.box.y + cell.box.height).toBeLessThanOrEqual(figure.footer.y);
    }
    expect(figure.footer.y + figure.footer.height).toBe(figure.height);
  });

  it("places the 3D frame inside the margins with its own aspect", () => {
    const figure = buildFigure(inputOf(plain), { width: 2000, height: 1000 });
    expect(figure.views).toBeNull();
    const box = figure.image;
    if (!box) throw new Error("no image box");
    expect(box.width / box.height).toBeCloseTo(2);
    expect(box.x).toBeGreaterThanOrEqual(24);
    expect(box.x + box.width).toBeLessThanOrEqual(FIGURE_WIDTH - 24);
    const tall = buildFigure(inputOf(plain), { width: 500, height: 1000 }).image;
    expect(tall?.height).toBeLessThanOrEqual(520);
    expect((tall?.width ?? 0) / (tall?.height ?? 1)).toBeCloseTo(0.5);
  });

  it("never draws the 3D frame larger than its own pixel size", () => {
    const small = buildFigure(inputOf(plain), { width: 340, height: 272 }).image;
    expect(small?.width).toBe(340);
    expect(small?.height).toBe(272);
    const wide = buildFigure(inputOf(plain), { width: 3000, height: 1500 }).image;
    expect(wide?.width).toBeLessThanOrEqual(FIGURE_WIDTH - 48);
  });

  it("refuses to build a figure when no contacts are on screen", () => {
    const loading = reduce(initialState(), {
      type: "recording_changed",
      recording: REC,
      group: groupOf(BIPOLAR_LABELS),
    }).state;
    expect(() => buildFigure(inputOf(loading), null)).toThrow(/no contacts on screen/);
    const closedRefusal = opened(bipolar, groupOf(["no-such-channel"]), REC);
    expect(viewModel(closedRefusal).stage.kind).toBe("refusal");
    expect(() => exportSvg(inputOf(closedRefusal))).toThrow(/no contacts on screen/);
  });
});

describe("wrapping", () => {
  const sentence =
    "Welch's method: 18 segments of 512 samples over 9.5 s of a 10 s window; decibels against the channel's own power.";

  it("keeps every word, in order, and no line over the width", () => {
    for (const width of [120, 300, 912]) {
      const lines = wrapText(sentence, width, 12, estimateWidth);
      expect(lines.join("")).toBe(sentence);
      for (const line of lines)
        expect(estimateWidth(line.trimEnd(), 12)).toBeLessThanOrEqual(width);
    }
  });

  it("splits a word wider than the line and never returns nothing", () => {
    const long = "x".repeat(60);
    const lines = wrapText(long, 100, 12, estimateWidth);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(long);
    expect(wrapText("", 100, 12, estimateWidth)).toEqual([""]);
  });
});

describe("file names", () => {
  it("is the recording stem, contacts, and the frame, lowercase", () => {
    expect(figureFileName(inputOf(plain), "png")).toBe(
      "sub-R1001P_ses-0_task-YC1_acq-bipolar_ieeg_contacts_mni152nlin6asym.png",
    );
    expect(figureFileName(inputOf(plain), "svg")).toMatch(/_contacts_mni152nlin6asym\.svg$/);
  });

  it("builds from the path and a closed vocabulary, never from free text", () => {
    expect(recordingStem("sub-01/ieeg/sub-01_task-a b/../c_ieeg.nii.gz")).toBe("c_ieeg");
    expect(recordingStem("a/<script>x.edf")).toBe("_script_x");
    expect(recordingStem("")).toBe("recording");
    expect(frameFileLabel({ kind: "native", declared: "ACPC" })).toBe("acpc");
    expect(frameFileLabel({ kind: "pixels", declared: "Pixels" })).toBe("pixels");
    expect(frameFileLabel({ kind: "described", declared: "Other", description: "../../etc" })).toBe(
      "other",
    );
    expect(
      frameFileLabel({
        kind: "unknown",
        why: "unrecognized_label",
        declared: "MNI/../x y",
        spaceEntity: null,
      }),
    ).toBe("unknown");
    expect(frameFileLabel(null)).toBe("unknown");
  });
});

describe("the panel's switch to the 2D views", () => {
  it("starts on the 3D canvas and changes only by the reader's choice", () => {
    expect(plain.view2d).toBe(false);
    expect(viewModel(plain).stage.kind).toBe("canvas");
    expect(viewModel(plain).view).toEqual({
      shown: true,
      on: false,
      enabled: true,
      title: expect.stringContaining("three flat views"),
    });
    const flat = reduce(plain, { type: "view_changed", view2d: true }).state;
    expect(viewModel(flat).stage.kind).toBe("views2d");
    expect(viewModel(flat).view.on).toBe(true);
    expect(reduce(flat, { type: "view_changed", view2d: true }).state).toBe(flat);
    expect(viewModel(reduce(flat, { type: "view_changed", view2d: false }).state).stage.kind).toBe(
      "canvas",
    );
  });

  it("keeps the status, notes, Activity and the contact list in the 2D views", () => {
    const flat = reduce(withActivity, { type: "view_changed", view2d: true }).state;
    const model = viewModel(flat);
    expect(model.status).not.toBeNull();
    expect(model.activity?.colorbar).not.toBeNull();
    expect(model.contacts.length).toBeGreaterThan(0);
    expect(model.credit.attributes.href).toBe(RAVE_CREDIT.href);
  });

  it("is the only view without WebGL2, and says why", () => {
    const state = reduce(plain, { type: "webgl_unavailable" }).state;
    const model = viewModel(state);
    expect(model.stage.kind).toBe("no_webgl");
    expect(model.view).toEqual({ shown: true, on: true, enabled: false, title: WEBGL_SENTENCE });
    expect(model.credit.attributes.href).toBe(RAVE_CREDIT.href);
  });

  it("shows no switch or save button where nothing is drawn, and keeps the credit", () => {
    const loading = reduce(initialState(), {
      type: "recording_changed",
      recording: REC,
      group: groupOf(BIPOLAR_LABELS),
    }).state;
    const model = viewModel(loading);
    expect(model.view.shown).toBe(false);
    expect(model.credit.attributes.href).toBe(RAVE_CREDIT.href);
  });

  it("survives a recording change as the reader's preference", () => {
    const flat = reduce(plain, { type: "view_changed", view2d: true }).state;
    const next = reduce(flat, {
      type: "recording_changed",
      recording: REC,
      group: groupOf(BIPOLAR_LABELS),
    }).state;
    expect(next.view2d).toBe(true);
  });
});

// A recording stand-in for the browser's canvas 2D context: the order of what is painted, and the
// text, font and position of each fillText. The drawing API is the browser's; this keeps its log.
function recordingContext() {
  const state = { font: "", fillStyle: "", globalAlpha: 1, textAlign: "start" };
  const saved: (typeof state)[] = [];
  const texts: { text: string; font: string; x: number; y: number }[] = [];
  const noop = () => {};
  const ctx = {
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set lineJoin(_v: string) {},
    set textAlign(v: string) {
      state.textAlign = v;
    },
    set textBaseline(_v: string) {},
    set imageSmoothingEnabled(_v: boolean) {},
    set imageSmoothingQuality(_v: string) {},
    save: () => saved.push({ ...state }),
    restore: () => Object.assign(state, saved.pop()),
    setTransform: noop,
    measureText: (t: string) => ({ width: t.length * Number.parseFloat(state.font) * 0.5 }),
    fillRect: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    drawImage: noop,
    fillText: (text: string, x: number, y: number) => texts.push({ text, font: state.font, x, y }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}
