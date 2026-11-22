import { describe, expect, it } from "vitest";
import { type Loaded, load } from "../../../test/ieeg-channel-fixtures";
import { nodeFs, repoPath } from "../../../test/node";
import { parseColor } from "./brain-gl";
import { MATCH_RULES, type MatchRule } from "./channel-match";
import {
  type ExportInput,
  type FigureTheme,
  buildDrawList,
  buildFigure,
  buildSvg,
  channelClause,
  channelProvenance,
  contactTitle,
  exportSvg,
} from "./export";
import { joinChannels } from "./geometry";
import {
  APPROXIMATE_ALPHA,
  type GroupInfo,
  type PanelEvent,
  type PanelState,
  contactColors,
  initialState,
  matchCounts,
  matchNotes,
  placeContacts,
  reduce,
  unlocatedNotes,
  viewModel,
} from "./panel";

/**
 * What the panel, the circle titles and the figure files say about how a channel name reached its
 * contact. Real recordings only: the geometry is read by the module's own resolver over the
 * committed files of test/fixtures/ieeg-channel-names, the labels are the Zarr stores' own, and
 * the recorded line is compared with the electrodes file's own text. Known-answer inputs say so
 * where they appear (an added contact row, a rule table of the test's own).
 */

const fs = await nodeFs();

const THEME: FigureTheme = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#475569",
  border: "#e2e8f0",
  contact: "#f5b82e",
};
const PALETTE = { neutral: parseColor(THEME.contact), noData: parseColor("#64748b") };

function groupOf(labels: readonly string[]): GroupInfo {
  return {
    index: 0,
    modality: "IEEG",
    labels,
    units: labels.map(() => "V"),
    rateHz: 1000,
    nativeRateHz: 1000,
    durationS: 600,
  };
}

function play(from: PanelState, events: PanelEvent[]): PanelState {
  let state = from;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

function opened(l: Loaded, more: PanelEvent[] = []): PanelState {
  return play(initialState(), [
    {
      type: "recording_changed",
      recording: { datasetId: l.case.id, version: l.case.version, path: l.case.recording },
      group: groupOf(l.labels),
    },
    { type: "geometry_resolved", token: 1, geometry: l.geometry },
    { type: "toggle_open" },
    { type: "subjects_timeout" },
    { type: "window_changed", startS: 0, lengthS: 10 },
    ...more,
  ]);
}

function inputOf(state: PanelState): ExportInput {
  return {
    state,
    model: viewModel(state),
    colors: contactColors(state, PALETTE),
    theme: THEME,
    template: null,
    frameLabel: "ACPC",
  };
}

/** x, y, z of one contact as the electrodes file wrote them: its text, read independently. */
function fileCells(l: Loaded, name: string): string[] {
  const path = repoPath(
    `test/fixtures/ieeg-channel-names/${l.case.id}/${l.case.version}/${l.space.electrodesPath}`,
  );
  const lines = fs.readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const row = lines.find((line) => line.split("\t")[0] === name);
  if (!row) throw new Error(`no ${name} in ${l.space.electrodesPath}`);
  return row.split("\t").slice(1, 4);
}

const rowOf = (state: PanelState, name: string) => {
  const row = viewModel(state).contacts.find((c) => c.name === name);
  expect(row, `row ${name}`).toBeDefined();
  return row as ReturnType<typeof viewModel>["contacts"][number];
};

describe("a row names the contact as recorded, the channel beside it, and the kind of match", () => {
  it("a name that joined by a rule: LTP1 (channel LTP1-20000) with the tag and the rule's own words", async () => {
    const l = await load("on005415-72");
    const state = opened(l);
    const row = rowOf(state, "LTP1");
    expect(row.name).toBe("LTP1");
    expect(row.detail).toBe("(channel LTP1-20000)");
    expect(row.tag).toBe("suffix match");
    expect(row.tagTitle).toBe("channel names end in a numeric tail after the contact name.");
    expect(row.links).toEqual([{ name: "LTP1-20000", kind: "suffix" }]);
  });

  it("an exact join of identical names carries no detail and no tag (nm000376)", async () => {
    const l = await load("nm000376");
    const row = rowOf(opened(l), "A1-A2");
    expect(row.detail).toBe("");
    expect(row.tag).toBe("");
    expect(row.tagTitle).toBe("");
  });

  it("a bipolar channel's contacts name the channels, and the channel reads by its contacts (on005522)", async () => {
    const l = await load("on005522");
    const state = opened(l, [{ type: "select_channel", label: "LAF1-LAF2" }]);
    expect(rowOf(state, "LAF2").detail).toBe("(channels LAF1-LAF2, LAF2-LAF3)");
    expect(rowOf(state, "LAF2").tag).toBe("");
    expect(viewModel(state).selectedChannel).toBe("LAF1-LAF2 (contacts LAF1, LAF2; midpoint)");
  });

  it("a bipolar channel that joined after a rewrite says so as well (on006233)", async () => {
    const l = await load("on006233");
    const state = opened(l, [{ type: "select_channel", label: "POL A1-A2" }]);
    const row = rowOf(state, "A1");
    expect(row.detail).toBe("(channel POL A1-A2)");
    expect(row.tag).toBe("normalized match");
    expect(viewModel(state).selectedChannel).toBe(
      "POL A1-A2 (contacts A1, A2; midpoint; normalized match)",
    );
  });

  it("a channel whose name is its contact's own has no channel line", async () => {
    const l = await load("nm000376");
    const state = opened(l, [{ type: "select_channel", label: "A1-A2" }]);
    expect(viewModel(state).selectedChannel).toBeNull();
  });
});

describe("the recorded line is the file's own text, with its unit word and frame", () => {
  it("on004473 in meters: the exponent and 16 digits are the file's, and the row is a normalized join", async () => {
    const l = await load("on004473");
    const [x, y, z] = fileCells(l, "LAMY1");
    expect(y).toBe("-7.589096499647889e-05");
    const row = rowOf(opened(l), "LAMY1");
    expect(row.recorded).toBe(`recorded (${x}, ${y}, ${z}) m, frame: ACPC`);
    expect(row.detail).toBe("(channel LAMY 1)");
    expect(row.tag).toBe("normalized match");
  });

  it("nm000376 in millimeters: -5.0 and 17 significant digits stay as written", async () => {
    const l = await load("nm000376");
    const state = opened(l);
    const [x, y, z] = fileCells(l, "A6-A7");
    expect(y).toBe("-5.0");
    expect(rowOf(state, "A6-A7").recorded).toBe(
      `recorded (${x}, ${y}, ${z}) mm, frame: IXI549Space`,
    );
    const q = fileCells(l, "Q8-Q9");
    expect(q[0]).toBe("63.150000000000006");
    expect(rowOf(state, "Q8-Q9").recorded).toContain("(63.150000000000006,");
  });

  it("on005415: a title says the contact first, then the channel with its kind, then the recorded line", async () => {
    const l = await load("on005415-72");
    const state = opened(l);
    const [x, y, z] = fileCells(l, "LTP1");
    const svg = exportSvg(inputOf(state)).data as string;
    expect(svg).toContain(
      `<title>LTP1 (channel LTP1-20000 [suffix match]); recorded (${x}, ${y}, ${z}) m, frame: ACPC</title>`,
    );
    expect(
      contactTitle({ name: "A", channels: [], recorded: "r", template: null, value: null }),
    ).toBe("A; r");
    expect(
      channelClause([
        { name: "X", kind: "exact" },
        { name: "Y-1", kind: "suffix" },
      ]),
    ).toBe("channels X, Y-1 [suffix match]");
    expect(channelClause([{ name: "Y-1", kind: "suffix" }], false)).toBe("channel Y-1");
  });

  it("a template frame adds the template position below, labeled approximate, after the recorded one (on005522)", async () => {
    const l = await load("on005522");
    const state = opened(l, [{ type: "template_loaded" }]);
    const row = rowOf(state, "LAF1");
    expect(row.recorded).toMatch(
      /^recorded \(-41\.18, 60\.1441, 3\.01713875326076\) mm, frame: MNI152NLin6ASym, size -999$/,
    );
    expect(row.template).toMatch(/^template \(.*\) mm, approximate$/);
    const title = contactTitle({
      name: row.name,
      channels: row.links,
      recorded: row.recorded,
      template: row.template,
      value: row.value,
    });
    expect(title.indexOf("recorded (")).toBeLessThan(title.indexOf("template ("));
  });

  it("a native frame has the recorded line only", async () => {
    const l = await load("on005415-72");
    expect(rowOf(opened(l), "LTP1").template).toBeNull();
  });
});

describe("the panel and the files say how many joined by which kind, and which names", () => {
  it("on005415: the status line counts the suffix matches, and one note says what was read", async () => {
    const l = await load("on005415-72");
    const state = opened(l);
    const model = viewModel(state);
    const joins = joinChannels(l.space, l.labels);
    const suffix = joins.filter((j) => j.matchKind === "suffix").length;
    expect(suffix).toBeGreaterThan(100);
    expect(model.status).toBe(
      `${suffix} of ${l.labels.length} channels located; frame: ACPC; positions as declared by the dataset; joined by name rules: ${suffix} suffix match`,
    );
    const note = model.notes.find((n) => n.includes("joined to contacts by suffix match"));
    expect(note).toBe(
      `${suffix} channels joined to contacts by suffix match: channel names end in a numeric tail after the contact name. For example LTP1-20000 for LTP1, LTP2-20000 for LTP2, LTP3-20000 for LTP3, and ${suffix - 3} more.`,
    );
    expect(matchCounts(joins)).toEqual([{ kind: "suffix", count: suffix }]);
  });

  it("a recording with only exact joins has the unchanged status line and no match note (on005522, nm000376)", async () => {
    for (const key of ["on005522", "nm000376"]) {
      const l = await load(key);
      const model = viewModel(opened(l));
      expect(model.status, key).toMatch(
        /^\d+ of \d+ channels located; frame: [A-Za-z0-9]+; positions as declared by the dataset$/,
      );
      expect(
        model.notes.some((n) => n.includes("joined to contacts by")),
        key,
      ).toBe(false);
      expect(matchCounts(joinChannels(l.space, l.labels)), key).toEqual([]);
    }
  });

  it("a rewrite chain is named by every rule it took (on004551: POL, then the reference)", async () => {
    const l = await load("on004551");
    const notes = matchNotes(joinChannels(l.space, l.labels));
    expect(
      notes.some((n) => n.includes("by normalized match") && n.includes("POL A3 for A3")),
    ).toBe(true);
    const chained = notes.find((n) => n.includes("EEG A1-Ref for A1"));
    expect(chained).toContain("by suffix match");
    expect(chained).toContain("start with a signal-type word");
    expect(chained).toContain("end in REF or Ref with an optional number, read as a reference");
  });

  it("the unlocated channels are listed by their original names with the cause (nm000463)", async () => {
    const l = await load("nm000463");
    const derived = l.labels.filter((x) => x.endsWith("_rms"));
    expect(derived.length).toBeGreaterThan(6);
    const notes = unlocatedNotes(joinChannels(l.space, l.labels));
    expect(notes).toEqual([
      `${derived.length} unlocated channels, no contact of that name in the electrodes file: ${derived.slice(0, 6).join(", ")} and ${derived.length - 6} more.`,
    ]);
  });

  it("a name that fits two contacts is listed with both, never joined (known-answer contact LSF001)", async () => {
    const l = await load("on004194");
    const row = l.space.contacts.find((c) => c.name === "LSF01");
    expect(row).toBeDefined();
    const space = {
      ...l.space,
      contacts: [
        ...l.space.contacts,
        { ...(row as NonNullable<typeof row>), name: "LSF001", row: l.space.contacts.length },
      ],
    };
    const joins = joinChannels(space, ["LSF1"]);
    expect(unlocatedNotes(joins)).toEqual([
      "1 unlocated channel, the name fits more than one contact equally well: LSF1 (fits LSF01 and LSF001).",
    ]);
  });

  it("a channel that lost its contact to the exact channel says whose contact it is (nm000463 with a rule of the test's own)", async () => {
    const l = await load("nm000463");
    const rms: MatchRule = {
      id: "rms_copy",
      kind: "suffix",
      form: "strip",
      pattern: "a test rule that removes _rms",
      example: { channel: "AD1_rms", contact: "AD1" },
      datasets: [],
      sentence: "channel names end in _rms",
      strip: (n) => (n.endsWith("_rms") ? n.slice(0, -4) : null),
    };
    const joins = joinChannels(l.space, l.labels, [...MATCH_RULES, rms]);
    const notes = unlocatedNotes(joins);
    expect(notes[0]).toContain("another channel already holds it: AD1_rms (contact AD1)");
  });

  it("the SVG and the PNG's draw list carry the same sentences as the screen (on005415)", async () => {
    const l = await load("on005415-72");
    const state = opened(l, [{ type: "select_channel", label: "LTP1-20000" }]);
    const input = inputOf(state);
    const model = input.model;
    const sentences = [
      model.status ?? "",
      ...model.notes.filter((n) => n.includes("joined to contacts by")),
      `Selected channel: ${model.selectedChannel}`,
    ];
    expect(model.selectedChannel).toBe("LTP1-20000 (contact LTP1; suffix match)");
    const figure = buildFigure(input, null);
    const svg = buildSvg(figure);
    const ops = buildDrawList(figure);
    for (const sentence of sentences) {
      const label = figure.labels.find((x) => x.text === sentence);
      expect(label, sentence).toBeDefined();
      if (!label) continue;
      const lines = figure.lines.filter((x) => x.labelId === label.id).map((x) => x.text);
      expect(lines.join(""), sentence).toBe(sentence);
      const drawn = ops.flatMap((o) => (o.op === "text" && o.label === label.id ? [o.text] : []));
      expect(drawn.join(""), sentence).toBe(sentence);
      expect(svg, sentence).toContain(`<dc:description>${sentence}</dc:description>`);
    }
  });
});

describe("the 3D PNG's figure says the same as the SVG's", () => {
  it("on005415: with a 3D frame the labels still hold the status, the match note and the channel line", async () => {
    const l = await load("on005415-72");
    const state = opened(l, [{ type: "select_channel", label: "LTP1-20000" }]);
    const input = inputOf(state);
    const withViews = buildFigure(input, null).labels.map((x) => x.text);
    const with3d = buildFigure(input, { width: 640, height: 480 });
    const texts = with3d.labels.map((x) => x.text);
    const note = input.model.notes.find((n) => n.includes("joined to contacts by"));
    for (const sentence of [
      input.model.status,
      note,
      "Selected channel: LTP1-20000 (contact LTP1; suffix match)",
    ]) {
      expect(texts, String(sentence)).toContain(sentence);
      expect(withViews, String(sentence)).toContain(sentence);
    }
    const ops = buildDrawList(with3d);
    const drawn = ops.flatMap((o) => (o.op === "text" ? [o.text] : [])).join("");
    expect(drawn).toContain("joined to contacts by suffix match");
  });
});

describe("an approximate name match is drawn apart", () => {
  // No shipped rule joins by the close tier (the survey's one candidate is right in one dataset and
  // wrong in another), so the marker is shown with a rule table of the test's own on a real space.
  const dropFirst: MatchRule = {
    id: "drop_first",
    kind: "close",
    form: "variants",
    pattern: "a test rule that removes the first letter",
    example: { channel: "mmAL1", contact: "mAL1" },
    datasets: [],
    sentence: "channel names repeat a letter of the contact name",
    variants: (n) => [n.slice(1)],
  };

  it("on003374: a contact reached by the close tier is half transparent, and the status line says so", async () => {
    const l = await load("on003374");
    const placement = placeContacts(l.space, 0, l.labels, [...MATCH_RULES, dropFirst]);
    expect(placement.joins.every((j) => j.matchKind === "close")).toBe(true);
    const state: PanelState = { ...opened(l), placement };
    const colors = contactColors(state, PALETTE);
    expect(colors).not.toBeNull();
    for (let i = 0; i < placement.contacts.length; i++) {
      // A literal, so changing the constant fails here.
      expect((colors as Float32Array)[i * 4 + 3]).toBeCloseTo(0.55, 5);
    }
    expect(viewModel(state).status).toBe(
      "4 of 4 channels located; frame: Other (the file name says MNI152); positions as declared by the dataset; joined by name rules: 4 approximate name match",
    );
    const row = viewModel(state).contacts[0];
    expect(row.tag).toBe("approximate name match");
    // A selected contact is drawn in full, the others are dimmed as for any selection.
    const picked = play(state, [{ type: "select_contact", contact: 0 }]);
    const c2 = contactColors(picked, PALETTE) as Float32Array;
    expect(c2[3]).toBe(1);
    expect(c2[7]).toBeLessThan(0.55);
    expect(APPROXIMATE_ALPHA).toBe(0.55);
  });

  it("an exact or normalized join is drawn in full", async () => {
    const l = await load("on004473");
    const colors = contactColors(opened(l), PALETTE) as Float32Array;
    for (let i = 3; i < colors.length; i += 4) expect(colors[i]).toBe(1);
  });

  it("the channel provenance names the close kind too", async () => {
    const l = await load("on003374");
    const [j] = joinChannels(l.space, ["mmAL1"], [...MATCH_RULES, dropFirst]);
    expect(channelProvenance(j)).toBe("mmAL1 (contact mAL1; approximate name match)");
    expect(channelProvenance({ ...j, status: "unlocated", matchKind: null })).toBeNull();
  });
});
