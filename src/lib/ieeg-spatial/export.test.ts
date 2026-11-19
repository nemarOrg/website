import { resolveObjectURL } from "node:buffer";
import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { colorFor } from "./activity";
import { parseColor } from "./brain-gl";
import { CREDIT_CLASS, CREDIT_FONT_PX, RAVE_CREDIT, doiUrl } from "./credit";
import {
  EXPORT_SCALE,
  type ExportInput,
  FIGURE_WIDTH,
  type FigureTheme,
  REVOKE_DELAY_MS,
  type TemplatePlacement,
  buildDrawList,
  buildFigure,
  buildSvg,
  downloadFile,
  estimateWidth,
  exportSvg,
  figureFileName,
  figureLabels,
  frameFileLabel,
  rasterize,
  recordedLocation,
  recordingStem,
  templateLocation,
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
import {
  ACTIVITY_CHOICES,
  forgetTemplateOutlines,
  templateNotice,
  templateOutlines,
  templateRuleOf,
} from "./panel";
import {
  TALAIRACH_TO_MNI,
  TEMPLATE_LICENSE_HREF,
  TEMPLATE_LOADING_SENTENCE,
  TEMPLATE_REFERENCE,
  applyAffine,
  noPlacementSentence,
  templateLabel,
} from "./transforms";
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

/** x, y, z of one contact as the electrodes file wrote them (its text). The fixtures hold values the line reproduces character for character; the line itself is numerically equal, not verbatim. */
function recordedRow(datasetId: string, version: string, file: string, name: string): string[] {
  const text = fs.readFileSync(repoPath(`${FIXTURES}/${datasetId}/${version}/${file}`), "utf8");
  const row = text.split(/\r?\n/).find((l) => l.split("\t")[0] === name);
  if (!row) throw new Error(`no ${name} in ${file}`);
  return row.split("\t").slice(1, 4);
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
  approximate: true,
  references: [
    "https://doi.org/10.1016/j.neuroimage.2010.07.033",
    "/vendor/brain-templates/x/LICENSE.txt",
  ],
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
    cursorScale: null,
    channels: labels.map((label, i) => ({ label, value: i + 1, reason: null })),
  };
}

const plain = opened(bipolar, groupOf(BIPOLAR_LABELS), REC);
const withActivity = (() => {
  const on = play(plain, [
    { type: "activity_options", choice: "band_power" },
    { type: "activity_switch", on: true },
  ]);
  return reduce(on, {
    type: "activity_report",
    report: knownReport(on.activity.token, BIPOLAR_LABELS),
  }).state;
})();
const selectedActivity = play(withActivity, [{ type: "select_channel", label: "LAF1-LAF2" }]);

const acpcStateForTitles = opened(acpc, groupOf(acpc.spaces[0].contacts.map((c) => c.name)), {
  datasetId: "on004473",
  version: "v1.0.0",
  path: ON4473,
});

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
    expect(doiUrl()).toBe(`https://doi.org/${RAVE_CREDIT.doi}`);
    expect(meta).toContain(`<dc:relation>${doiUrl()}</dc:relation>`);
    for (const label of figureLabels(inputOf(plain, TEMPLATE), true)) {
      expect(meta).toContain(`<dc:description>${label.text}</dc:description>`);
    }
  });

  it("builds the paper's address nowhere but credit.ts", () => {
    const source = fs.readFileSync(repoPath("src/lib/ieeg-spatial/export.ts"), "utf8");
    expect(source).not.toContain("doi.org");
    expect(source).toContain("doiUrl()");
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
      expect(ops.filter((o) => o.op === "frame")).toHaveLength(image ? 0 : 3);
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
    expect(templatePlacementFor(acpcState, OUTLINES)).toBeNull();
    const svg = svgOf(inputOf(acpcState, templatePlacementFor(acpcState, OUTLINES)));
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
    expect(svgOf(inputOf(other, templatePlacementFor(other, OUTLINES)))).not.toContain(
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
      for (const c of mine) expect(c).toContain(`<title>${contact.name} (channel`);
    });
    // LAF2 belongs to two channels. Its title says its name as recorded first, the channels beside
    // it, where the dataset recorded it, equal to the electrodes file's value (with the file's
    // unit word and the declared frame), and the mean value, 1.5 µV².
    const laf2 = contacts.findIndex((c) => c.name === "LAF2");
    const title = /data-contact="\d+"[^>]*><title>(LAF2[^<]*)<\/title>/.exec(
      circles.find((c) => c.includes(`data-contact="${laf2}"`)) ?? "",
    )?.[1];
    const [x, y, z] = recordedRow(
      "on005522",
      "v1.0.0",
      "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_space-MNI152NLin6ASym_electrodes.tsv",
      "LAF2",
    );
    expect(title).toBe(
      `LAF2 (channels LAF1-LAF2, LAF2-LAF3); recorded (${x}, ${y}, ${z}) mm, frame: MNI152NLin6ASym, size -999; 1.50 µV²`,
    );
  });

  it("says nothing of a value while Activity is off, and still names the recorded position", () => {
    const svg = svgOf(inputOf(plain));
    expect(svg).not.toContain("µV²");
    expect(svg).toMatch(
      /<title>LAF1 \(channel LAF1-LAF2\); recorded \(-41\.18, 60\.1441, 3\.01713875326076\) mm, frame: MNI152NLin6ASym, size -999<\/title>/,
    );
  });

  it("a contact with a template position says both, the recorded one first, and says approximate", () => {
    const n = plain.placement?.contacts.length ?? 0;
    const positions = Array.from({ length: n }, (_, i) => [i + 0.5, -2, 3.25] as const);
    const svg = svgOf(inputOf(plain, { ...TEMPLATE, positions }));
    const laf1 = /<title>(LAF1 \(channel[^<]*)<\/title>/.exec(svg)?.[1] ?? "";
    expect(laf1).toBe(
      "LAF1 (channel LAF1-LAF2); recorded (-41.18, 60.1441, 3.01713875326076) mm, frame: MNI152NLin6ASym, size -999; template (0.5, -2, 3.25) mm, approximate",
    );
    // Without the approximate flag the title does not claim it.
    const own = svgOf(inputOf(plain, { ...TEMPLATE, approximate: false, positions }));
    expect(own).toContain("; template (0.5, -2, 3.25) mm</title>");
    expect(own).not.toContain("mm, approximate</title>");
  });

  it("a native-frame contact has only the recorded line, in the file's own unit", () => {
    expect(acpcStateForTitles.placement?.space.frame?.kind).toBe("native");
    const svg = svgOf(
      inputOf(acpcStateForTitles, templatePlacementFor(acpcStateForTitles, OUTLINES)),
    );
    const [x, y, z] = recordedRow(
      "on004473",
      "v1.0.0",
      "sub-1/ieeg/sub-1_space-ACPC_electrodes.tsv",
      "LENT1",
    );
    // The file says meters; the line says what it recorded, in meters, and the frame; no template.
    expect(svg).toContain(
      `<title>LENT1 (channel LENT1); recorded (${x}, ${y}, ${z}) m, frame: ACPC</title>`,
    );
    expect(svg).not.toMatch(/; template \(/);
  });

  it("builds the recorded line from the file's own cells, never from the parsed numbers", () => {
    const mm = { declared: "mm", unit: "mm", scaleToMm: 1, unitsDeclared: true } as const;
    const cells = { x: "1.50", y: "-5.0", z: "-7.589096499647889e-05", size: "n/a" };
    // Trailing zero, exponent notation and 16 significant digits stay what the file wrote.
    expect(recordedLocation(cells, mm, "ACPC")).toBe(
      "recorded (1.50, -5.0, -7.589096499647889e-05) mm, frame: ACPC",
    );
    // The unit word is the file's own: meters stay meters, centimeters stay centimeters.
    const m = { declared: "m", unit: "mm", scaleToMm: 1000, unitsDeclared: true } as const;
    expect(recordedLocation(cells, m, "ACPC")).toContain(") m, frame: ACPC");
    const cm = { declared: "cm", unit: "mm", scaleToMm: 10, unitsDeclared: true } as const;
    expect(recordedLocation(cells, cm, "ACPC")).toContain(") cm, frame: ACPC");
    const none = { declared: null, unit: null, scaleToMm: null, unitsDeclared: false } as const;
    expect(recordedLocation(cells, none, "X")).toBe(
      "recorded (1.50, -5.0, -7.589096499647889e-05), units not declared, frame: X",
    );
    expect(recordedLocation(cells, { ...none, declared: "n/a" }, "X")).toContain(
      ", units not declared, frame: X",
    );
    expect(recordedLocation(cells, { ...none, declared: "furlong" }, "X")).toContain(
      ', units "furlong" (not converted), frame: X',
    );
    const px = {
      declared: "pixels",
      unit: "pixels",
      scaleToMm: null,
      unitsDeclared: true,
    } as const;
    expect(recordedLocation(cells, px, "Pixels")).toContain(") pixels, frame: Pixels");
    // A size is added as written (the -999 sentinel too); n/a and an empty cell add nothing.
    expect(recordedLocation({ ...cells, size: "12.50" }, mm, "ACPC")).toMatch(/, size 12\.50$/);
    expect(recordedLocation({ ...cells, size: "-999" }, mm, "ACPC")).toMatch(/, size -999$/);
    expect(recordedLocation({ ...cells, size: "" }, mm, "ACPC")).not.toContain("size");
    expect(recordedLocation({ ...cells, size: null }, mm, "ACPC")).not.toContain("size");
    expect(templateLocation([1.00049, 2, 3], true)).toBe("template (1, 2, 3) mm, approximate");
  });

  it("the displayed line is the committed fixtures' own bytes (on004473 in meters, nm000376 in millimeters)", async () => {
    const g = await geometryOf("on004473", "v1.0.0", ON4473);
    const s = g.spaces.find((x) => x.space === "ACPC");
    const lamy1 = s?.contacts.find((c) => c.name === "LAMY1");
    const [x, y, z] = recordedRow(
      "on004473",
      "v1.0.0",
      "sub-1/ieeg/sub-1_space-ACPC_electrodes.tsv",
      "LAMY1",
    );
    expect(y).toBe("-7.589096499647889e-05");
    expect(recordedLocation(lamy1?.raw as never, s?.units as never, "ACPC")).toBe(
      `recorded (${x}, ${y}, ${z}) m, frame: ACPC`,
    );
    const n = await geometryOf("nm000376", "v1.0.2", "sub-P1/ieeg/sub-P1_task-memact_ieeg.vhdr");
    const ns = n.spaces[0];
    const a67 = ns.contacts.find((c) => c.name === "A6-A7");
    const [nx, ny, nz] = recordedRow(
      "nm000376",
      "v1.0.2",
      "sub-P1/ieeg/sub-P1_space-IXI549Space_electrodes.tsv",
      "A6-A7",
    );
    expect(ny).toBe("-5.0");
    expect(recordedLocation(a67?.raw as never, ns.units, "IXI549Space")).toBe(
      `recorded (${nx}, ${ny}, ${nz}) mm, frame: IXI549Space`,
    );
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
    const selectedLabels = figure.labels.filter((l) => l.role === "selected").map((l) => l.text);
    // The channel first, by what it was joined to; then each contact with both names and where it was recorded.
    expect(selectedLabels[0]).toBe("Selected channel: LAF1-LAF2 (contacts LAF1, LAF2; midpoint)");
    expect(selectedLabels[1]).toBe(
      "Selected: LAF1 (channel LAF1-LAF2); recorded (-41.18, 60.1441, 3.01713875326076) mm, frame: MNI152NLin6ASym, size -999; 1.00 µV² | LAF2 (channels LAF1-LAF2, LAF2-LAF3); recorded (-48.8321, 53.1194, 1.08525940626615) mm, frame: MNI152NLin6ASym, size -999; 1.50 µV²",
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
    // Template sentences differ by design (the 3D frame says the panel's own state, the views the
    // seam's); everything else is the same words.
    const rest = (withViews: boolean) =>
      figureLabels(input, withViews)
        .filter((l) => l.role !== "template")
        .map((l) => l.text);
    expect(rest(true)).toContain(VIEWS_SENTENCE);
    expect(rest(false)).not.toContain(VIEWS_SENTENCE);
    expect(rest(false)).toEqual(rest(true).filter((t) => t !== VIEWS_SENTENCE));
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

  it("never makes the 3D frame wider than its own pixel count in figure pixels (drawn at 2x)", () => {
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
      canClear: false,
      shown: true,
      on: false,
      enabled: true,
      title: expect.stringContaining("three flat views"),
      reason: null,
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
    expect(model.view).toEqual({
      canClear: false,
      shown: true,
      on: true,
      enabled: false,
      title: WEBGL_SENTENCE,
      reason: null,
    });
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
    strokeRect: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    drawImage: noop,
    fillText: (text: string, x: number, y: number) => texts.push({ text, font: state.font, x, y }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

describe("which measure and band the values are", () => {
  function activityState(events: PanelEvent[]): PanelState {
    const on = play(plain, [
      { type: "activity_options", choice: "band_power" },
      { type: "activity_switch", on: true },
      ...events,
    ]);
    return reduce(on, {
      type: "activity_report",
      report: knownReport(on.activity.token, BIPOLAR_LABELS),
    }).state;
  }
  const words = (choice: string) => ACTIVITY_CHOICES.find((c) => c.value === choice)?.label;

  it("band power names the choice and the band, in the selectors' words, in the model and every file", () => {
    const input = inputOf(withActivity);
    expect(input.model.activity?.measure).toBe(`${words("band_power")}: High gamma, 70 to 150 Hz`);
    const figure = buildFigure(input, null);
    const label = figure.labels.find((l) => l.role === "measure");
    expect(label?.text).toBe("Band power: High gamma, 70 to 150 Hz");
    expect(svgLabelText(buildSvg(figure), label?.id ?? "")).toBe(label?.text);
    const drawn = buildDrawList(figure).flatMap((o) =>
      o.op === "text" && o.label === label?.id ? [o.text] : [],
    );
    expect(drawn.join("")).toBe(label?.text);
    // The 3D PNG says it too.
    expect(figureLabels(input, false).some((l) => l.text === label?.text)).toBe(true);
  });

  it("relative band power and a lower band", () => {
    const state = activityState([
      { type: "activity_options", choice: "band_power_db", band: "theta" },
    ]);
    expect(viewModel(state).activity?.measure).toBe(`${words("band_power_db")}: Theta, 4 to 8 Hz`);
    expect(figureLabels(inputOf(state), true).map((l) => l.text)).toContain(
      "Band power, relative (dB): Theta, 4 to 8 Hz",
    );
  });

  it("RMS and line length name no band", () => {
    const rms = activityState([{ type: "activity_options", choice: "rms" }]);
    expect(viewModel(rms).activity?.measure).toBe("RMS (mean removed)");
    const ll = activityState([{ type: "activity_options", choice: "line_length" }]);
    expect(viewModel(ll).activity?.measure).toBe("Line length");
  });

  it("says nothing while Activity is off", () => {
    expect(viewModel(plain).activity?.measure).toBeNull();
    expect(figureLabels(inputOf(plain), true).some((l) => l.role === "measure")).toBe(false);
  });
});

describe("a contact name that XML cannot hold", () => {
  it("is cleaned in every circle title, so the document still parses as XML", () => {
    const contacts = (plain.placement?.contacts ?? []).map((c, i) =>
      i === 0 ? { ...c, name: "A\u0001B\u000BC" } : c,
    );
    const state: PanelState = plain.placement
      ? { ...plain, placement: { ...plain.placement, contacts } }
      : plain;
    const svg = svgOf(inputOf(state));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
    expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(svg).toContain("<title>ABC (channel");
    expectWellFormed(svg);
  });
});

describe("orientation letters", () => {
  it("every view carries four, in the SVG and the PNG's draw list", () => {
    const figure = buildFigure(inputOf(plain), null);
    const svg = buildSvg(figure);
    expect(svg.match(/data-orientation=/g)).toHaveLength(12);
    const ops = buildDrawList(figure).filter((o) => o.op === "text" && o.label === "orientation");
    expect(ops).toHaveLength(12);
    const live = viewsMarkupLetters(figure);
    expect(live).toEqual(["A", "P", "S", "I", "L", "R", "A", "P", "R", "L", "S", "I"].sort());
  });
});

function viewsMarkupLetters(figure: ReturnType<typeof buildFigure>): string[] {
  return (figure.views?.cells ?? []).flatMap((c) => c.letters.map((l) => l.text)).sort();
}

describe("downloadFile", () => {
  function fakeDocument() {
    const link = {
      href: "",
      download: "",
      clicked: 0,
      click() {
        this.clicked += 1;
      },
      remove() {},
    };
    const doc = { createElement: () => link, body: { append() {} } } as unknown as Document;
    return { doc, link };
  }

  it("hands the browser the file under its name, and revokes its address after the delay", () => {
    const { doc, link } = fakeDocument();
    const timers: { run: () => void; ms: number }[] = [];
    downloadFile({ filename: "a.svg", mime: "image/svg+xml", data: "<svg/>" }, doc, (run, ms) =>
      timers.push({ run, ms }),
    );
    expect(link.download).toBe("a.svg");
    expect(link.clicked).toBe(1);
    expect(timers.map((t) => t.ms)).toEqual([REVOKE_DELAY_MS]);
    // The real URL registry holds the blob until the timer runs, and not after.
    expect(resolveObjectURL(link.href)).toBeDefined();
    timers[0].run();
    expect(resolveObjectURL(link.href)).toBeUndefined();
  });

  it("revokes the address even when the browser refuses the click", () => {
    const { doc, link } = fakeDocument();
    link.click = () => {
      throw new Error("blocked");
    };
    const timers: (() => void)[] = [];
    expect(() =>
      downloadFile({ filename: "a.png", mime: "image/png", data: new Blob(["x"]) }, doc, (run) =>
        timers.push(run),
      ),
    ).toThrow("blocked");
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(resolveObjectURL(link.href)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Template placement (IS-V2's registry, wired to the 2D views and the files)
// ---------------------------------------------------------------------------

const NM454 =
  "sub-PID02/ses-clinical01/ieeg/sub-PID02_ses-clinical01_task-ictal10046_run-04_ieeg.edf";
const NM376 = "sub-P1/ieeg/sub-P1_task-memact_ieeg.vhdr";
const ON5522_TAL = "sub-R1009W/ses-0/ieeg/sub-R1009W_ses-0_task-YC1_acq-monopolar_ieeg.edf";
const NM373 = "sub-01/ieeg/sub-01_task-categorySL_run-1_ieeg.edf";

/** The panel opened on the first space of `identifier` (or `index`), as a reader would, outlines arrived. */
async function placedOn(
  dataset: string,
  version: string,
  recording: string,
  pick: string | number,
  ready = true,
): Promise<PanelState> {
  const geometry = await geometryOf(dataset, version, recording);
  const index =
    typeof pick === "number"
      ? pick
      : geometry.spaces.findIndex(
          (sp) => sp.frame?.kind === "template" && sp.frame.identifier === pick,
        );
  expect(index, `${dataset} ${pick}`).toBeGreaterThanOrEqual(0);
  const state = play(initialState(), [
    {
      type: "recording_changed",
      recording: { datasetId: dataset, version, path: recording },
      group: groupOf(geometry.spaces[index].contacts.map((c) => c.name)),
    },
    { type: "geometry_resolved", token: 1, geometry },
    { type: "frame_changed", spaceIndex: index },
    { type: "toggle_open" },
    { type: "window_changed", startS: 0, lengthS: 10 },
  ]);
  return ready ? reduce(state, { type: "outlines_loaded" }).state : state;
}

const loadsOutlines = (events: PanelEvent[], from: PanelState = initialState()) => {
  let state = from;
  let n = 0;
  for (const e of events) {
    const t = reduce(state, e);
    n += t.effects.filter((x) => x.type === "load_outlines").length;
    state = t.state;
  }
  return { state, n };
};

describe("outlines are fetched only for a registered frame with the panel open", () => {
  it("a registered frame asks once, when the panel opens, and not again on a reopen", async () => {
    const geometry = await geometryOf("nm000376", "v1.0.2", NM376);
    const labels = geometry.spaces[0].contacts.map((c) => c.name);
    const start: PanelEvent[] = [
      {
        type: "recording_changed",
        recording: { datasetId: "nm000376", version: "v1.0.2", path: NM376 },
        group: groupOf(labels),
      },
      { type: "geometry_resolved", token: 1, geometry },
    ];
    const closed = loadsOutlines(start);
    expect(closed.n).toBe(0);
    expect(closed.state.outlines).toBe("idle");
    const open = loadsOutlines([{ type: "toggle_open" }], closed.state);
    expect(open.n).toBe(1);
    expect(open.state.outlines).toBe("loading");
    const done = reduce(open.state, { type: "outlines_loaded" }).state;
    const again = loadsOutlines(
      [
        { type: "toggle_open", open: false },
        { type: "toggle_open", open: true },
        { type: "view_changed", view2d: true },
      ],
      done,
    );
    expect(again.n).toBe(0);
    expect(again.state.outlines).toBe("ready");
  });

  it("a failure is tried again on a reopen, once", async () => {
    const live = await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space", false);
    const failed = reduce(live, { type: "outlines_failed" }).state;
    expect(failed.outlines).toBe("failed");
    const retry = loadsOutlines(
      [
        { type: "toggle_open", open: false },
        { type: "toggle_open", open: true },
      ],
      failed,
    );
    expect(retry.n).toBe(1);
  });

  it("never for ACPC or Other, nor for a template frame whose units are not declared", async () => {
    const acpc = await geometryOf("on004473", "v1.0.0", ON4473);
    for (const [geometry, path, ds, v] of [
      [acpc, ON4473, "on004473", "v1.0.0"],
      [nm485, NM485, "nm000485", "v1.0.2"],
      [await geometryOf("nm000373", "v1.0.2", NM373), NM373, "nm000373", "v1.0.2"],
    ] as const) {
      const index = geometry.spaces.findIndex(
        (sp) => sp.frame?.kind !== "template" || sp.units.unit !== "mm",
      );
      const { n, state } = loadsOutlines([
        {
          type: "recording_changed",
          recording: { datasetId: ds, version: v, path },
          group: groupOf(geometry.spaces[Math.max(0, index)].contacts.map((c) => c.name)),
        },
        { type: "geometry_resolved", token: 1, geometry },
        { type: "frame_changed", spaceIndex: Math.max(0, index) },
        { type: "toggle_open" },
      ]);
      expect(n, ds).toBe(0);
      expect(state.outlines, ds).toBe("idle");
    }
  });

  it("without WebGL2 or in the 2D views a registered frame still wants them, a refusal does not", async () => {
    const live = await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space", false);
    expect(live.outlines).toBe("loading");
    const flat = reduce(live, { type: "view_changed", view2d: true });
    expect(flat.effects.some((e) => e.type === "load_outlines")).toBe(false);
    const refused = opened(bipolar, groupOf(["no-such-channel"]), REC);
    expect(refused.outlines).toBe("idle");
  });
});

describe("the 2D views and the files draw a registered template, the same way as the 3D view", () => {
  const CASES = [
    {
      name: "own frame",
      args: ["nm000454", "v1.0.2", NM454, "MNI152NLin2009cAsym"],
      approximate: false,
    },
    { name: "IXI549Space", args: ["nm000376", "v1.0.2", NM376, "IXI549Space"], approximate: true },
    { name: "Talairach", args: ["on005522", "v1.0.0", ON5522_TAL, "Talairach"], approximate: true },
  ] as const;

  for (const c of CASES) {
    it(`${c.name}: outlines, moved contacts, the 3D view's words, a template line per contact`, async () => {
      const state = await placedOn(c.args[0], c.args[1], c.args[2], c.args[3]);
      const rule = templateRuleOf(state);
      if (!rule) throw new Error("no rule");
      const seam = templatePlacementFor(state, OUTLINES);
      if (!seam) throw new Error("no placement");
      // The positions are V2's own placement of each declared position.
      const contacts = state.placement?.contacts ?? [];
      expect(seam.positions).toHaveLength(contacts.length);
      expect(seam.approximate).toBe(c.approximate);
      expect(seam.labels).toEqual([templateLabel(rule), templateNotice()]);
      expect(seam.references).toEqual([TEMPLATE_REFERENCE.href, TEMPLATE_LICENSE_HREF]);
      if (c.name === "Talairach") {
        contacts.forEach((ct, i) => {
          const want = applyAffine(TALAIRACH_TO_MNI, ct.position);
          seam.positions?.[i]?.forEach((v, k) => expect(v).toBeCloseTo(want[k], 9));
        });
      } else {
        expect(seam.positions).toEqual(contacts.map((ct) => ct.position));
      }

      const input = inputOf(state, seam);
      const svg = svgOf(input);
      expect(svg.match(/data-template-outline/g)).toHaveLength(3);
      // Both sentences are labels of the file, word for word the 3D view's.
      const labels = figureLabels(input, true).map((l) => l.text);
      expect(labels).toContain(templateLabel(rule));
      expect(labels).toContain(templateNotice());
      expect(svg).toContain(`<dc:relation>${TEMPLATE_REFERENCE.href}</dc:relation>`);
      expect(svg).toContain(`<dc:relation>${TEMPLATE_LICENSE_HREF}</dc:relation>`);
      expect(templateLabel(rule).includes("approximate")).toBe(c.approximate);
      // A contact's title says what was recorded, then the template position, then "approximate".
      const first = contacts[0];
      const placed = seam.positions?.[0] ?? [0, 0, 0];
      const title =
        new RegExp(`<title>(${first.name} \\(channel[^<]*)</title>`).exec(svg)?.[1] ?? "";
      expect(title).toContain("; recorded (");
      expect(title).toContain(`; ${templateLocation(placed, c.approximate)}`);
      expect(title.indexOf("recorded")).toBeLessThan(title.indexOf("template ("));
      expect(title.endsWith(", approximate") || title.includes(", approximate;")).toBe(
        c.approximate,
      );
      // The live view says the same words: the model's row for the 2D stage, and its template box.
      const flat = reduce(state, { type: "view_changed", view2d: true }).state;
      const live = viewModel(flat);
      expect(live.template).toMatchObject({
        status: "ready",
        label: templateLabel(rule),
        notice: templateNotice(),
      });
      expect(live.contacts[0].template).toBe(templateLocation(placed, c.approximate));
      expect(live.contacts[0].recorded).toMatch(/^recorded \(/);
    });
  }

  it("the Selected line carries both positions", async () => {
    const state = play(await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space"), [
      { type: "select_contact", contact: 0 },
    ]);
    const seam = templatePlacementFor(state, OUTLINES);
    const label = figureLabels(inputOf(state, seam), true).find((l) => l.role === "selected");
    expect(label?.text).toMatch(
      /^Selected: .*; recorded \(.*\) mm, frame: IXI549Space; template \(.*\) mm, approximate$/,
    );
  });

  it("the 3D frame says the model's words: the label once the surface is drawn, the loading sentence before", async () => {
    const state = await placedOn("nm000454", "v1.0.2", NM454, "MNI152NLin2009cAsym");
    expect(state.template).toBe("loading");
    const loading = figureLabels(inputOf(state, null), false).map((l) => l.text);
    expect(loading).toContain(TEMPLATE_LOADING_SENTENCE);
    expect(loading.some((t) => t.startsWith("Template brain"))).toBe(false);
    const ready = reduce(state, { type: "template_loaded" }).state;
    const labels = figureLabels(inputOf(ready, null), false).map((l) => l.text);
    expect(labels).toContain(templateLabel(templateRuleOf(ready) ?? (null as never)));
    expect(labels).toContain(templateNotice());
    // A list row gets its template line only once the surface is drawn.
    expect(viewModel(state).contacts[0].template).toBeNull();
    expect(viewModel(ready).contacts[0].template).toMatch(/^template \(.*\) mm$/);
  });

  it("a frame with no placement gets no outline, no template line and no label, and says why", async () => {
    const cases: [string, PanelState][] = [
      [
        "ACPC",
        opened(acpc, groupOf(acpc.spaces[0].contacts.map((c) => c.name)), {
          datasetId: "on004473",
          version: "v1.0.0",
          path: ON4473,
        }),
      ],
      [
        "Other",
        play(
          opened(nm485, groupOf(nm485.spaces[0].contacts.map((c) => c.name)), {
            datasetId: "nm000485",
            version: "v1.0.2",
            path: NM485,
          }),
          [{ type: "frame_changed", spaceIndex: 0 }],
        ),
      ],
    ];
    // Pending: a standard identifier the registry has no row for (derived from a real placed state).
    const placed = await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space");
    if (placed.placement) {
      const frame = {
        kind: "template",
        declared: "NIHPD",
        identifier: "NIHPD",
        caseNormalized: false,
      } as const;
      cases.push([
        "pending",
        {
          ...placed,
          placement: { ...placed.placement, space: { ...placed.placement.space, frame } },
        },
      ]);
    }
    for (const [name, base] of cases) {
      const state = { ...base, outlines: "ready" as const };
      expect(templatePlacementFor(state, OUTLINES), name).toBeNull();
      const input = inputOf(state, templatePlacementFor(state, OUTLINES));
      const svg = svgOf(input);
      expect(svg, name).not.toContain("data-template-outline");
      expect(svg, name).not.toContain("template (");
      expect(svg, name).not.toContain("Template brain");
      expect(svg, name).not.toContain("Template surface");
      const word = state.placement?.space.frame;
      expect(
        figureLabels(input, true).some((l) => l.text.startsWith("No brain surface")),
        name,
      ).toBe(true);
      expect(
        figureLabels(input, true).map((l) => l.text),
        name,
      ).toContain(noPlacementSentence(word ?? null));
      expect(
        viewModel(state).contacts.every((r) => r.template === null),
        name,
      ).toBe(true);
    }
  });

  it("outlines still loading or failed draw the contacts as declared, with no template sentence", async () => {
    const loading = await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space", false);
    expect(templatePlacementFor(loading, OUTLINES)).toBeNull();
    const failed = reduce(loading, { type: "outlines_failed" }).state;
    expect(templatePlacementFor(failed, OUTLINES)).toBeNull();
    expect(
      templatePlacementFor(await placedOn("nm000376", "v1.0.2", NM376, "IXI549Space"), null),
    ).toBeNull();
    // The 2D live view says so in the 3D view's words.
    const flat = (st: PanelState) =>
      viewModel(reduce(st, { type: "view_changed", view2d: true }).state);
    expect(flat(loading).template).toEqual({
      status: "loading",
      sentence: TEMPLATE_LOADING_SENTENCE,
    });
    expect(flat(failed).template?.status).toBe("failed");
  });
});

describe("the template outlines are read once per page", () => {
  const file = fs.readFileSync(
    repoPath("public/vendor/brain-templates/mni152nlin2009casym@1/views.json"),
    "utf8",
  );

  it("two panels opened in sequence share one read, and a failure is not kept", async () => {
    forgetTemplateOutlines();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return JSON.parse(file);
    };
    const failing = async () => {
      reads += 1;
      throw new Error("views.json answered 503");
    };
    await expect(templateOutlines(failing)).rejects.toThrow("503");
    expect(reads).toBe(1);
    // The failure was forgotten: the next panel reads again, and the one after it does not.
    const first = await templateOutlines(read);
    const second = await templateOutlines(read);
    expect(reads).toBe(2);
    expect(second).toBe(first);
    expect(first.left.polylines.length).toBeGreaterThan(0);
    forgetTemplateOutlines();
  });

  it("refuses a file that is not the outlines format, and keeps nothing", async () => {
    forgetTemplateOutlines();
    await expect(templateOutlines(async () => ({ format: "other" }))).rejects.toThrow(
      /brain-template-views/,
    );
    let reads = 0;
    await templateOutlines(async () => {
      reads += 1;
      return JSON.parse(file);
    });
    expect(reads).toBe(1);
    forgetTemplateOutlines();
  });
});
