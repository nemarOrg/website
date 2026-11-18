import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { creditLinkSpec } from "./credit";
import {
  GEOMETRY_REASONS,
  type GeometryInput,
  type RecordingGeometry,
  resolveRecordingGeometry,
} from "./geometry";
import {
  ACTIVITY_SENTENCES,
  type ActivityReport,
  GEOMETRY_SENTENCES,
  type GroupInfo,
  LOADING_SENTENCE,
  MAX_ACTIVITY_SAMPLES,
  NO_MATCH_SENTENCE,
  type PanelEffect,
  type PanelEvent,
  type PanelState,
  type RecordingRef,
  SPATIAL_BESIDE_MIN_WIDTH,
  TRANSIENT_REASONS,
  WEBGL_SENTENCE,
  activitySamples,
  contactColors,
  defaultSpaceIndex,
  formatActivityValue,
  initialState,
  positionWarnings,
  readRuns,
  reduce,
  spatialLayout,
  unitsSentence,
  viewModel,
} from "./panel";

/**
 * Every geometry here comes from real public files of the NEMAR data plane, committed byte for byte
 * under test/fixtures/ieeg-geometry (SOURCES.json names dataset, version, path and SHA-256), read by
 * the module's own `resolveRecordingGeometry` through a reader over those files. Channel labels are
 * the real `_channels.tsv` of the bipolar recording of on005522, or the contact names of the
 * electrodes file for a recording whose channels file is not committed.
 *
 * Known-answer inputs, said where they are used: group sizes (rate, duration) that no fixture
 * holds, a failing reader for the transient reasons (an HTTP failure, as the data plane gives), the
 * contact limit of `viewModel`, and hand-made activity reports with values chosen so the means are
 * obvious. Nothing here replaces the code under test.
 */

const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

type Reader = Pick<GeometryInput, "listDir" | "readText">;

function treeReader(
  datasetId: string,
  version: string,
  failRead?: (path: string) => boolean,
): Reader {
  const at = (rel: string) => repoPath(`${FIXTURES}/${datasetId}/${version}/${rel}`);
  return {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) =>
      failRead?.(path) || !fs.existsSync(at(path)) ? null : fs.readFileSync(at(path), "utf8"),
  };
}

async function geometryOf(
  datasetId: string,
  version: string,
  recording: string,
  reader: Reader = treeReader(datasetId, version),
): Promise<RecordingGeometry> {
  return resolveRecordingGeometry({ datasetId, version, recording, ...reader });
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
const MONOPOLAR = "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-monopolar_ieeg.edf";
const NM537 = "sub-369/ieeg/sub-369_task-amygdalastim_run-100_ieeg.vhdr";
const NM485 = "sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.vhdr";
const NM373 = "sub-01/ieeg/sub-01_task-categorySL_run-1_ieeg.edf";
const ON4473 = "sub-1/ieeg/sub-1_task-SlowFast_ieeg.edf";
const ON4100 =
  "sub-HUP060/ses-presurgery/ieeg/sub-HUP060_ses-presurgery_task-ictal_acq-seeg_run-01_ieeg.edf";
const ON6253 = "sub-01/ses-01/ieeg/sub-01_ses-01_task-MetaRDK_acq-01_run-01_ieeg.edf";

const BIPOLAR_LABELS = channelLabels(
  "on005522",
  "v1.0.0",
  "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_channels.tsv",
);
const MONOPOLAR_LABELS = channelLabels(
  "on005522",
  "v1.0.0",
  "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-monopolar_channels.tsv",
);

const REC: RecordingRef = { datasetId: "on005522", version: "v1.0.0", path: BIPOLAR };

function groupOf(labels: readonly string[], extra: Partial<GroupInfo> = {}): GroupInfo {
  return {
    index: 0,
    modality: "IEEG",
    labels,
    units: labels.map(() => "V"),
    rateHz: 500,
    nativeRateHz: 500,
    durationS: 2899,
    ...extra,
  };
}

function play(
  from: PanelState,
  events: PanelEvent[],
): { state: PanelState; effects: PanelEffect[] } {
  let state = from;
  const effects: PanelEffect[] = [];
  for (const event of events) {
    const t = reduce(state, event);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

const reads = (effects: PanelEffect[]) =>
  effects.flatMap((e) => (e.type === "read_activity" ? [e.plan] : []));

/** The recording opened on `geometry`, panel open, window 0 to 10 s, Activity off. */
function opened(
  geometry: RecordingGeometry,
  group: GroupInfo,
  recording: RecordingRef = REC,
): { state: PanelState; effects: PanelEffect[] } {
  return play(initialState(), [
    { type: "recording_changed", recording, group },
    { type: "geometry_resolved", token: 1, geometry },
    { type: "toggle_open" },
    { type: "window_changed", startS: 0, lengthS: 10 },
  ]);
}

const bipolarGeometry = await geometryOf("on005522", "v1.0.0", BIPOLAR);
const monoGeometry = await geometryOf("on005522", "v1.0.0", MONOPOLAR);
const nm485 = await geometryOf("nm000485", "v1.0.2", NM485);
const bipolarGroup = groupOf(BIPOLAR_LABELS);

/** The contact names of one space, as channel labels of a monopolar recording. */
function contactLabels(geometry: RecordingGeometry, spaceIndex: number): string[] {
  return geometry.spaces[spaceIndex].contacts.map((c) => c.name);
}

function contactNames(state: PanelState, indices: number[]): string[] {
  return indices.map((i) => state.placement?.contacts[i].name ?? "?");
}

describe("a recording, group or frame change starts clean", () => {
  it("a recording change clears the selected contact", () => {
    const live = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "select_channel", label: "LAF1-LAF2" },
    ]);
    expect(live.state.selection.contacts).toHaveLength(2);

    const after = reduce(live.state, {
      type: "recording_changed",
      recording: { ...REC, path: MONOPOLAR },
      group: groupOf(MONOPOLAR_LABELS),
    });
    expect(after.state.selection).toEqual({ channel: null, contacts: [] });
    expect(after.effects).toContainEqual({ type: "select_trace", label: null });
  });

  it("a recording change cancels an activity read in flight and ignores its late report", () => {
    const live = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "activity_switch", on: true },
    ]);
    expect(live.state.activity.status.kind).toBe("computing");
    const token = live.state.activity.token;

    const after = reduce(live.state, {
      type: "recording_changed",
      recording: { ...REC, path: MONOPOLAR },
      group: groupOf(MONOPOLAR_LABELS),
    });
    expect(after.effects).toContainEqual({ type: "abort_activity" });
    expect(after.effects).toContainEqual({ type: "abort_geometry" });
    expect(after.state.activity.on).toBe(false);
    expect(after.state.activity.status).toEqual({ kind: "off" });

    // The old read finishes after the change: its report must not land in the new recording.
    const late: ActivityReport = {
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
      channels: [],
    };
    const ignored = reduce(after.state, { type: "activity_report", report: late });
    expect(ignored.state).toBe(after.state);
    expect(ignored.effects).toEqual([]);
  });

  it("a result for an earlier resolution of the contacts is ignored", () => {
    const first = reduce(initialState(), {
      type: "recording_changed",
      recording: REC,
      group: bipolarGroup,
    });
    const second = reduce(first.state, {
      type: "recording_changed",
      recording: { ...REC, path: MONOPOLAR },
      group: groupOf(MONOPOLAR_LABELS),
    });
    const stale = reduce(second.state, {
      type: "geometry_resolved",
      token: 1,
      geometry: bipolarGeometry,
    });
    expect(stale.state).toBe(second.state);
    expect(stale.state.geometry.kind).toBe("loading");
  });

  it("a group change clears the selection, aborts the read and waits for the new window", () => {
    const live = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "select_channel", label: "LAF1-LAF2" },
      { type: "activity_switch", on: true },
    ]);
    const after = reduce(live.state, {
      type: "group_changed",
      group: groupOf(BIPOLAR_LABELS, { index: 1 }),
    });
    expect(after.state.selection).toEqual({ channel: null, contacts: [] });
    expect(after.effects).toContainEqual({ type: "abort_activity" });
    expect(reads(after.effects)).toEqual([]);
    expect(after.state.activity.status).toEqual({ kind: "waiting" });

    // The next render reports the new group's window, and only then is a read planned.
    const next = reduce(after.state, { type: "window_changed", startS: 0, lengthS: 10 });
    expect(reads(next.effects)).toHaveLength(1);
    expect(reads(next.effects)[0].groupIndex).toBe(1);
  });

  it("a frame change clears the selection and aborts the read", () => {
    const geometry = nm485;
    const live = play(opened(geometry, groupOf(contactLabels(geometry, 1))).state, [
      { type: "select_channel", label: contactLabels(geometry, 1)[0] },
      { type: "activity_switch", on: true },
    ]);
    expect(live.state.selection.contacts).toHaveLength(1);
    const after = reduce(live.state, { type: "frame_changed", spaceIndex: 0 });
    expect(after.state.spaceIndex).toBe(0);
    expect(after.state.selection).toEqual({ channel: null, contacts: [] });
    expect(after.effects).toContainEqual({ type: "abort_activity" });
    expect(after.effects).toContainEqual({ type: "select_trace", label: null });
  });
});

describe("activity is read only while the switch is on", () => {
  it("with the switch off no read is requested, whatever else happens", () => {
    const events: PanelEvent[] = [
      { type: "recording_changed", recording: REC, group: bipolarGroup },
      { type: "geometry_resolved", token: 1, geometry: bipolarGeometry },
      { type: "toggle_open" },
      { type: "window_changed", startS: 0, lengthS: 10 },
      { type: "window_changed", startS: 10, lengthS: 10 },
      { type: "select_channel", label: "LAF1-LAF2" },
      { type: "activity_options", choice: "rms" },
      { type: "group_changed", group: groupOf(BIPOLAR_LABELS) },
      { type: "window_changed", startS: 20, lengthS: 5 },
      { type: "toggle_open", open: false },
      { type: "toggle_open", open: true },
      { type: "frame_changed", spaceIndex: 0 },
      { type: "window_changed", startS: 30, lengthS: 5 },
    ];
    const { state, effects } = play(initialState(), events);
    expect(reads(effects)).toEqual([]);
    expect(state.activity.on).toBe(false);
    expect(state.activity.status).toEqual({ kind: "off" });
  });

  it("turning the switch on requests one read of the located channels, and off stops reads", () => {
    const start = opened(bipolarGeometry, bipolarGroup).state;
    const on = reduce(start, { type: "activity_switch", on: true });
    const plans = reads(on.effects);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      groupIndex: 0,
      startS: 0,
      endS: 10,
      rateHz: 500,
      metric: "band_power",
      band: "high_gamma",
      relative: false,
    });
    expect(plans[0].rows).toEqual(
      start.placement?.channelContacts.flatMap((c, row) => (c.length > 0 ? [row] : [])),
    );
    expect(on.state.activity.status).toEqual({ kind: "computing" });

    const off = reduce(on.state, { type: "activity_switch", on: false });
    expect(off.effects).toContainEqual({ type: "abort_activity" });
    expect(reads(off.effects)).toEqual([]);
    expect(off.state.activity.status).toEqual({ kind: "off" });
    expect(off.state.activity.shown).toBeNull();
    // A window move now reads nothing.
    expect(
      reads(reduce(off.state, { type: "window_changed", startS: 5, lengthS: 10 }).effects),
    ).toEqual([]);
  });

  it("closing the panel stops reads, and reopening with the switch on starts one", () => {
    const on = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "activity_switch", on: true },
    ]);
    const closed = reduce(on.state, { type: "toggle_open", open: false });
    expect(closed.effects).toContainEqual({ type: "abort_activity" });
    expect(reads(closed.effects)).toEqual([]);
    expect(
      reads(reduce(closed.state, { type: "window_changed", startS: 3, lengthS: 10 }).effects),
    ).toEqual([]);
    const reopened = reduce(closed.state, { type: "toggle_open", open: true });
    expect(reads(reopened.effects)).toHaveLength(1);
  });

  it("moving the window aborts the read in flight, starts the next, and keeps the values meanwhile", () => {
    const start = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "activity_switch", on: true },
    ]).state;
    const token = start.activity.token;
    const done = reduce(start, {
      type: "activity_report",
      report: knownReport(token, BIPOLAR_LABELS),
    });
    expect(done.state.activity.status).toEqual({ kind: "ready" });
    const moved = reduce(done.state, { type: "window_changed", startS: 10, lengthS: 10 });
    expect(moved.effects[0]).toEqual({ type: "abort_activity" });
    expect(reads(moved.effects)).toHaveLength(1);
    expect(reads(moved.effects)[0].token).toBe(token + 1);
    expect(moved.state.activity.status).toEqual({ kind: "computing" });
    expect(moved.state.activity.shown).toBe(done.state.activity.shown);
    // Changing the measure drops the old values instead: they would describe another measure.
    const other = reduce(done.state, { type: "activity_options", choice: "rms" });
    expect(other.state.activity.shown).toBeNull();
  });
});

describe("the read bound", () => {
  it("a window over 4 million samples says zoom in and requests no read", () => {
    // 72 located channels at 1000 Hz: a 55 s window holds 3,960,000 samples, a 56 s one 4,032,000.
    const group = groupOf(BIPOLAR_LABELS, { rateHz: 1000, nativeRateHz: 1000, durationS: 4000 });
    const start = opened(bipolarGeometry, group).state;
    const located = start.placement?.located ?? 0;
    expect(located).toBe(72);
    const under = Math.floor(MAX_ACTIVITY_SAMPLES / located / 1000);
    expect(under).toBe(55);
    const on = reduce(start, { type: "activity_switch", on: true });
    expect(reads(on.effects)).toHaveLength(1);
    const wide = reduce(on.state, { type: "window_changed", startS: 0, lengthS: under + 1 });
    expect(wide.state.activity.status.kind).toBe("too_wide");
    expect(reads(wide.effects)).toEqual([]);
    // The read of the old window is aborted, not left running.
    expect(wide.effects).toEqual([{ type: "abort_activity" }]);
    const model = viewModel(wide.state);
    expect(model.activity?.message).toMatch(/^Zoom in to compute activity/);
    expect(model.activity?.message).toContain(MAX_ACTIVITY_SAMPLES.toLocaleString("en-US"));
    // Colors revert to the neutral one, whatever was shown before.
    const palette = { neutral: [1, 0.5, 0] as const, noData: [0.5, 0.5, 0.5] as const };
    expect([...(contactColors(wide.state, palette) ?? [])].slice(0, 4)).toEqual([1, 0.5, 0, 1]);

    // Just under the bound reads.
    const ok = reduce(wide.state, { type: "window_changed", startS: 0, lengthS: under });
    expect(reads(ok.effects)).toHaveLength(1);
  });

  it("counts samples as readLevel0 does: channels times the columns the window covers", () => {
    expect(activitySamples(2, 0, 10, 500)).toBe(10000);
    expect(activitySamples(1, 0.0015, 10.0015, 1000)).toBe(10001);
    expect(activitySamples(3, 5, 5, 500)).toBe(3);
  });

  it("splits located rows into short consecutive runs", () => {
    expect(readRuns([], 16)).toEqual([]);
    expect(readRuns([0, 1, 2, 5, 6, 9], 16)).toEqual([
      [0, 3],
      [5, 7],
      [9, 10],
    ]);
    expect(readRuns([0, 1, 2, 3, 4], 2)).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
  });

  it("refuses a band the rate cannot carry, and a window too short, before reading", () => {
    const slow = opened(
      bipolarGeometry,
      groupOf(BIPOLAR_LABELS, { rateHz: 250, nativeRateHz: 250 }),
    ).state;
    const t = reduce(slow, { type: "activity_switch", on: true });
    // The default band, high gamma (to 150 Hz), is above 0.45 times 250 Hz.
    expect(t.state.activity.status).toEqual({ kind: "refused", reason: "band_above_nyquist" });
    expect(reads(t.effects)).toEqual([]);
    expect(viewModel(t.state).activity?.message).toBe(ACTIVITY_SENTENCES.band_above_nyquist(250));
    const bands = viewModel(t.state).activity?.bands ?? [];
    expect(bands.find((b) => b.value === "high_gamma")?.disabled).toBe(true);
    expect(bands.find((b) => b.value === "alpha")?.disabled).toBe(false);

    const short = reduce(
      reduce(opened(bipolarGeometry, bipolarGroup).state, { type: "activity_switch", on: true })
        .state,
      { type: "window_changed", startS: 0, lengthS: 1 },
    );
    expect(short.state.activity.status).toEqual({ kind: "refused", reason: "window_too_short" });
    expect(reads(short.effects)).toEqual([]);
  });

  it("a failed read says so, and a report for another token is ignored", () => {
    const on = reduce(opened(bipolarGeometry, bipolarGroup).state, {
      type: "activity_switch",
      on: true,
    });
    const token = on.state.activity.token;
    expect(
      reduce(on.state, { type: "activity_failed", token: token - 1, reason: "read_failed" }).state,
    ).toBe(on.state);
    const failed = reduce(on.state, { type: "activity_failed", token, reason: "read_failed" });
    expect(failed.state.activity.status).toEqual({ kind: "refused", reason: "read_failed" });
    expect(viewModel(failed.state).activity?.message).toBe(ACTIVITY_SENTENCES.read_failed(500));
  });
});

describe("contacts and traces link both ways", () => {
  it("a bipolar channel selects its two contacts", () => {
    const { state } = opened(bipolarGeometry, bipolarGroup);
    const t = reduce(state, { type: "select_channel", label: "LAF1-LAF2" });
    expect(contactNames(t.state, t.state.selection.contacts)).toEqual(["LAF1", "LAF2"]);
    expect(t.state.selection.channel).toBe(BIPOLAR_LABELS.indexOf("LAF1-LAF2"));
    expect(t.effects).toEqual([{ type: "select_trace", label: "LAF1-LAF2" }]);
    const rows = viewModel(t.state).contacts;
    expect(rows.filter((r) => r.selected).map((r) => r.name)).toEqual(["LAF1", "LAF2"]);
    // The row says which channel it belongs to when the names differ.
    expect(rows.find((r) => r.name === "LAF1")?.detail).toBe("LAF1-LAF2");
    expect(rows.find((r) => r.name === "LAF2")?.detail).toBe("LAF1-LAF2, LAF2-LAF3");
  });

  it("clicking a contact selects its channel's trace and both of its contacts", () => {
    const { state } = opened(bipolarGeometry, bipolarGroup);
    const laf2 = state.placement?.contacts.findIndex((c) => c.name === "LAF2") ?? -1;
    const t = reduce(state, { type: "select_contact", contact: laf2 });
    // LAF2 sits in LAF1-LAF2 and LAF2-LAF3; the first channel in row order wins.
    expect(t.effects).toEqual([{ type: "select_trace", label: "LAF1-LAF2" }]);
    expect(contactNames(t.state, t.state.selection.contacts)).toEqual(["LAF1", "LAF2"]);
    // The same contact again deselects; an arrow-key move never does.
    expect(
      reduce(t.state, { type: "select_contact", contact: laf2 }).state.selection.contacts,
    ).toEqual([]);
    expect(
      reduce(t.state, { type: "select_contact", contact: laf2, toggle: false }).state.selection
        .contacts,
    ).toHaveLength(2);
  });

  it("a single-contact channel selects one contact, and an unlocated or unknown label selects none", () => {
    const labels = [...MONOPOLAR_LABELS, "NOSUCH1-NOSUCH2"];
    const mono = opened(monoGeometry, groupOf(labels), { ...REC, path: MONOPOLAR }).state;
    const one = reduce(mono, { type: "select_channel", label: "LAF1" });
    expect(contactNames(one.state, one.state.selection.contacts)).toEqual(["LAF1"]);
    const ghost = reduce(mono, { type: "select_channel", label: "NOSUCH1-NOSUCH2" });
    expect(ghost.state.selection.channel).toBe(labels.length - 1);
    expect(ghost.state.selection.contacts).toEqual([]);
    const unknown = reduce(one.state, { type: "select_channel", label: "not a channel" });
    expect(unknown.state.selection).toEqual({ channel: null, contacts: [] });
    // Selecting the selected channel again clears it.
    expect(
      reduce(one.state, { type: "select_channel", label: "LAF1" }).state.selection.channel,
    ).toBeNull();
  });

  it("closing the panel clears the selection and the trace highlight", () => {
    const sel = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "select_channel", label: "LAF1-LAF2" },
    ]);
    const closed = reduce(sel.state, { type: "toggle_open", open: false });
    expect(closed.state.selection).toEqual({ channel: null, contacts: [] });
    expect(closed.effects).toContainEqual({ type: "select_trace", label: null });
  });
});

describe("the credit is in every state", () => {
  it("is in the model whether the panel is loading, shown, closed, refused, without WebGL2 or disposed", async () => {
    const credit = creditLinkSpec();
    const permanent = await geometryOf("nm000537", "v1.0.2", NM537);
    const transient = await geometryOf(
      "on005522",
      "v1.0.0",
      BIPOLAR,
      treeReader("on005522", "v1.0.0", (p) => p.endsWith("_electrodes.tsv")),
    );
    const otherFailing = await geometryOf(
      "nm000485",
      "v1.0.2",
      NM485,
      treeReader("nm000485", "v1.0.2", (p) => p.includes("space-Other_electrodes")),
    );

    const loading = play(initialState(), [
      { type: "recording_changed", recording: REC, group: bipolarGroup },
    ]).state;
    const shown = opened(bipolarGeometry, bipolarGroup).state;
    const states: [string, PanelState, { maxContacts: number }?][] = [
      ["before anything", initialState()],
      ["loading", loading],
      ["closed", play(shown, [{ type: "toggle_open", open: false }]).state],
      ["shown", shown],
      [
        "shown with a selection",
        play(shown, [{ type: "select_channel", label: "LAF1-LAF2" }]).state,
      ],
      ["activity on", play(shown, [{ type: "activity_switch", on: true }]).state],
      ["no WebGL2", play(shown, [{ type: "webgl_unavailable" }]).state],
      ["too many contacts", shown, { maxContacts: 10 }],
      [
        "refused for good",
        opened(permanent, groupOf(contactLabels(permanent, 0)), {
          ...REC,
          datasetId: "nm000537",
          path: NM537,
        }).state,
      ],
      ["refused, maybe for a moment", opened(transient, bipolarGroup).state],
      [
        "a refused frame chosen",
        play(opened(otherFailing, groupOf(contactLabels(otherFailing, 1))).state, [
          { type: "frame_changed", spaceIndex: 0 },
        ]).state,
      ],
      ["disposed", play(shown, [{ type: "disposed" }]).state],
    ];
    for (const [name, state, limits] of states) {
      expect(viewModel(state, limits).credit, name).toEqual(credit);
    }
    // The refusal states really are refusals, so the loop above did cross them.
    expect(viewModel(states[8][1]).stage.kind).toBe("refusal");
    expect(viewModel(states[9][1]).stage.kind).toBe("refusal");
    expect(viewModel(states[10][1]).stage.kind).toBe("refusal");
    expect(viewModel(states[7][1], { maxContacts: 10 }).stage.kind).toBe("refusal");
  });
});

describe("the toggle", () => {
  it("is enabled once a located contact is resolved, and says it is checking until then", () => {
    const loading = play(initialState(), [
      { type: "recording_changed", recording: REC, group: bipolarGroup },
    ]).state;
    expect(viewModel(loading).toggle).toMatchObject({ visible: true, enabled: false });
    expect(viewModel(loading).toggle.title).toContain("checking");
    expect(viewModel(loading).stage).toEqual({ kind: "loading", sentence: LOADING_SENTENCE });
    const ready = opened(bipolarGeometry, bipolarGroup).state;
    expect(viewModel(ready).toggle).toMatchObject({ visible: true, enabled: true, pressed: true });
  });

  it("is not shown for a group that is not iEEG", () => {
    const eeg = opened(bipolarGeometry, groupOf(BIPOLAR_LABELS, { modality: "EEG" })).state;
    expect(viewModel(eeg).toggle.visible).toBe(false);
  });

  it("nm000537 is disabled, and its title is the no_coordinates sentence", async () => {
    const geometry = await geometryOf("nm000537", "v1.0.2", NM537);
    expect(geometry.reason).toBe("no_coordinates");
    const state = opened(geometry, groupOf(contactLabels(geometry, 0)), {
      datasetId: "nm000537",
      version: "v1.0.2",
      path: NM537,
    }).state;
    const toggle = viewModel(state).toggle;
    expect(toggle.enabled).toBe(false);
    expect(toggle.title).toBe(`Brain view unavailable: ${GEOMETRY_SENTENCES.no_coordinates}`);
    // No contact is drawn, and nothing about a frame is claimed.
    expect(viewModel(state).status).toBeNull();
    expect(viewModel(state).contacts).toEqual([]);
  });

  it("stays enabled for a failure that may pass, shows it, and a retry resolves again", async () => {
    const failing = await geometryOf(
      "on005522",
      "v1.0.0",
      BIPOLAR,
      treeReader("on005522", "v1.0.0", (p) => p.endsWith("_electrodes.tsv")),
    );
    expect(failing.reason).toBe("unreadable");
    expect(TRANSIENT_REASONS).toContain(failing.reason);
    const state = opened(failing, bipolarGroup).state;
    const model = viewModel(state);
    expect(model.toggle).toMatchObject({ enabled: true, pressed: true });
    expect(model.toggle.title).toContain("retry");
    expect(model.stage).toEqual({
      kind: "refusal",
      sentence: GEOMETRY_SENTENCES.unreadable,
      retry: true,
    });

    const again = reduce(state, { type: "retry" });
    expect(again.state.geometry.kind).toBe("loading");
    expect(again.state.geometryToken).toBe(state.geometryToken + 1);
    expect(again.effects).toContainEqual({
      type: "resolve_geometry",
      token: again.state.geometryToken,
      recording: REC,
    });
    // The first attempt's late answer cannot overwrite the retry.
    const late = reduce(again.state, {
      type: "geometry_resolved",
      token: state.geometryToken,
      geometry: failing,
    });
    expect(late.state).toBe(again.state);
    const fixed = reduce(again.state, {
      type: "geometry_resolved",
      token: again.state.geometryToken,
      geometry: bipolarGeometry,
    });
    expect(viewModel(fixed.state).stage.kind).toBe("canvas");
  });

  it("a failed listing is a refusal that may pass, with no spaces to choose from", async () => {
    const geometry = await geometryOf("on005522", "v1.0.0", BIPOLAR, {
      listDir: async () => null,
      readText: async () => null,
    });
    expect(geometry.reason).toBe("listing_failed");
    expect(geometry.spaces).toEqual([]);
    const model = viewModel(opened(geometry, bipolarGroup).state);
    expect(model.toggle.enabled).toBe(true);
    expect(model.stage).toEqual({
      kind: "refusal",
      sentence: GEOMETRY_SENTENCES.listing_failed,
      retry: true,
    });
    expect(model.frames).toBeNull();
  });

  it("is disabled, with its own sentence, when no channel matches a contact", () => {
    const state = opened(bipolarGeometry, groupOf(["X1-X2", "X2-X3", "X3-X4"])).state;
    expect(viewModel(state).toggle.enabled).toBe(false);
    expect(viewModel(state).toggle.title).toBe(`Brain view unavailable: ${NO_MATCH_SENTENCE}`);
  });

  it("has a plain sentence for every reason IS-C1 can give, all different", () => {
    expect(Object.keys(GEOMETRY_SENTENCES).sort()).toEqual([...GEOMETRY_REASONS].sort());
    expect(new Set(Object.values(GEOMETRY_SENTENCES)).size).toBe(GEOMETRY_REASONS.length);
    for (const s of Object.values(GEOMETRY_SENTENCES)) expect(s).toMatch(/^[A-Z].*\.$/);
  });
});

describe("the status line, frames and notes", () => {
  it("states located channels, the frame and where the positions come from", () => {
    const state = opened(bipolarGeometry, bipolarGroup).state;
    expect(viewModel(state).status).toBe(
      "72 of 72 channels located; frame: MNI152NLin6ASym; positions as declared by the dataset",
    );
    const notes = viewModel(state).notes;
    expect(notes).toContain("Units: millimeters.");
  });

  it("counts only the channels that matched", () => {
    const labels = [...BIPOLAR_LABELS.slice(0, 10), "X1-X2", "X2-X3"];
    const state = opened(bipolarGeometry, groupOf(labels)).state;
    expect(viewModel(state).status).toBe(
      "10 of 12 channels located; frame: MNI152NLin6ASym; positions as declared by the dataset",
    );
  });

  it("offers every frame, defaults to the first template frame, and names the choice", () => {
    expect(defaultSpaceIndex(nm485)).toBe(1);
    const state = opened(nm485, groupOf(contactLabels(nm485, 1)), {
      datasetId: "nm000485",
      version: "v1.0.2",
      path: NM485,
    }).state;
    const model = viewModel(state);
    expect(model.frames).toEqual({
      selected: 1,
      options: [
        { index: 0, label: "Other", refused: false },
        { index: 1, label: "Talairach", refused: false },
      ],
    });
    expect(model.status).toContain("frame: Talairach;");
    // The other frame's description is carried verbatim.
    const other = reduce(state, { type: "frame_changed", spaceIndex: 0 }).state;
    const description = nm485.spaces[0].description;
    expect(description).toBeTruthy();
    expect(viewModel(other).status).toContain("frame: Other;");
    expect(viewModel(other).notes).toContain(`The dataset describes this frame as: ${description}`);
  });

  it("with no template frame, the first shown space is the default and is still named", async () => {
    const g = await geometryOf("on004473", "v1.0.0", ON4473);
    expect(g.spaces.map((s) => s.space)).toEqual(["ACPC", "ScanRAS"]);
    expect(defaultSpaceIndex(g)).toBe(0);
    const state = opened(g, groupOf(contactLabels(g, 0)), {
      datasetId: "on004473",
      version: "v1.0.0",
      path: ON4473,
    }).state;
    expect(viewModel(state).status).toContain("frame: ACPC;");
    expect(viewModel(state).frames?.options.map((o) => o.label)).toEqual(["ACPC", "ScanRAS"]);
  });

  it("claims millimeters only when the units were scaled to millimeters", async () => {
    const g = await geometryOf("on004473", "v1.0.0", ON4473);
    expect(g.spaces[0].units.declared).toBe("m");
    expect(unitsSentence(g.spaces[0].units)).toBe(
      "Units: millimeters (the file says m, scaled to millimeters).",
    );
    const undeclared = await geometryOf("nm000373", "v1.0.2", NM373);
    expect(undeclared.spaces[0].units.unit).toBeNull();
    expect(unitsSentence(undeclared.spaces[0].units)).toBe(
      "Units: not declared; values are shown as written, with no scale claim.",
    );
    expect(
      unitsSentence({ declared: "pixels", unit: "pixels", scaleToMm: null, unitsDeclared: true }),
    ).toBe("Units: pixels, as written.");
    expect(
      unitsSentence({ declared: "furlongs", unit: null, scaleToMm: null, unitsDeclared: false }),
    ).toContain('"furlongs" is not a length unit');
  });

  it("notes the identifier the file wrote when it differs in case only", async () => {
    const g = await geometryOf("nm000373", "v1.0.2", NM373);
    const state = opened(g, groupOf(contactLabels(g, 0)), {
      datasetId: "nm000373",
      version: "v1.0.2",
      path: NM373,
    }).state;
    expect(viewModel(state).status).toContain("frame: MNI152NLin6ASym;");
    expect(viewModel(state).notes).toContain(
      'The file writes the identifier as "MNI152NLin6Asym".',
    );
  });

  it("shows the file name and the label when they disagree, and says a pairing is missing", async () => {
    const g = await geometryOf("on006253", "v1.0.0", ON6253);
    const index = g.spaces.findIndex((s) => s.space === "mni");
    const state = play(
      opened(g, groupOf(contactLabels(g, index)), {
        datasetId: "on006253",
        version: "v1.0.0",
        path: ON6253,
      }).state,
      [{ type: "frame_changed", spaceIndex: index }],
    ).state;
    expect(viewModel(state).status).toContain("frame: not declared;");
    expect(viewModel(state).notes).toContain(
      "No coordinate system file pairs with these positions.",
    );
  });

  it("warns about positions wider than a head, and draws them as written", async () => {
    // on004100 declares meters, but its values are millimeter-sized; the declared unit decides.
    const g = await geometryOf("on004100", "v1.0.0", ON4100);
    const space = g.spaces[0];
    expect(space.units.declared).toBe("m");
    const state = opened(g, groupOf(contactLabels(g, 0)), {
      datasetId: "on004100",
      version: "v1.0.0",
      path: ON4100,
    }).state;
    const notes = viewModel(state).notes.join("\n");
    expect(notes).toMatch(/span \d+ mm, wider than a head/);
    // The first contact is where the file puts it, scaled by the declared unit and nothing else.
    const first = state.placement?.contacts[0];
    const raw = space.contacts.find((c) => c.name === first?.name);
    expect(first?.position).toEqual(raw?.position);
    // A well-formed recording has no warning.
    expect(viewModel(opened(bipolarGeometry, bipolarGroup).state).notes.join("\n")).not.toMatch(
      /wider|exactly/,
    );
  });

  it("warns about a contact at 0, 0, 0 only, and not about a span in an undeclared unit", () => {
    const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as const });
    const mm = { declared: "mm", unit: "mm" as const, scaleToMm: 1, unitsDeclared: true };
    const none = { declared: null, unit: null, scaleToMm: null, unitsDeclared: false };
    expect(positionWarnings([at(0, 0, 0), at(10, 20, 30), at(-40, 5, 9)], mm)).toEqual([
      { kind: "origin", count: 1 },
    ]);
    expect(positionWarnings([at(0, 0, 0), at(900, 0, 0)], mm)).toEqual([
      { kind: "origin", count: 1 },
      { kind: "span", mm: 900 },
    ]);
    expect(positionWarnings([at(1, 1, 1), at(900, 0, 0)], none)).toEqual([]);
  });
});

describe("the stage", () => {
  it("refuses more contacts than the renderer draws, with both numbers", () => {
    const state = opened(bipolarGeometry, bipolarGroup).state;
    const stage = viewModel(state, { maxContacts: 10 }).stage;
    expect(stage.kind).toBe("refusal");
    expect(stage.kind === "refusal" && stage.sentence).toContain(
      `${state.placement?.contacts.length} located contacts`,
    );
    expect(stage.kind === "refusal" && stage.sentence).toContain("at most 10");
    // Nothing is listed or claimed for what is not drawn.
    expect(viewModel(state, { maxContacts: 10 }).contacts).toEqual([]);
  });

  it("without WebGL2 says so, keeps the contact list, and still links the selection", () => {
    const state = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "webgl_unavailable" },
      { type: "select_channel", label: "LAF1-LAF2" },
    ]).state;
    const model = viewModel(state);
    expect(model.stage).toEqual({ kind: "no_webgl", sentence: WEBGL_SENTENCE });
    expect(WEBGL_SENTENCE).toBe("3D view needs WebGL2");
    expect(model.contacts.length).toBeGreaterThan(0);
    expect(model.contacts.filter((c) => c.selected)).toHaveLength(2);
    expect(model.status).toContain("72 of 72 channels located");
  });

  it("a chosen frame that cannot be shown gets its own sentence, and a retry if it may pass", async () => {
    const g = await geometryOf(
      "nm000485",
      "v1.0.2",
      NM485,
      treeReader("nm000485", "v1.0.2", (p) => p.includes("space-Other_electrodes")),
    );
    expect(g.reason).toBeNull();
    expect(g.spaces[0].reason).toBe("unreadable");
    const state = play(opened(g, groupOf(contactLabels(g, 1))).state, [
      { type: "frame_changed", spaceIndex: 0 },
    ]).state;
    const model = viewModel(state);
    expect(model.stage).toEqual({
      kind: "refusal",
      sentence: GEOMETRY_SENTENCES.unreadable,
      retry: true,
    });
    expect(model.frames?.options.map((o) => o.label)).toEqual(["Other (unavailable)", "Talairach"]);
    expect(model.frames?.options[0].refused).toBe(true);
    expect(model.contacts).toEqual([]);
    expect(model.toggle.enabled).toBe(true);
  });
});

/** A report with obvious values: channel row i has value i + 1, in µV², every row located. */
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

describe("activity values on the contacts", () => {
  const palette = { neutral: [0.9, 0.7, 0.1] as const, noData: [0.4, 0.4, 0.4] as const };

  function withReport(report: (token: number) => ActivityReport): PanelState {
    const on = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "activity_switch", on: true },
    ]).state;
    return reduce(on, { type: "activity_report", report: report(on.activity.token) }).state;
  }

  it("a contact in two channels takes the mean of their values", () => {
    const state = withReport((t) => knownReport(t, BIPOLAR_LABELS));
    const names = state.placement?.contacts.map((c) => c.name) ?? [];
    const values = state.activity.shown?.contactValues ?? [];
    // Channel rows are LAF1-LAF2 = 1, LAF2-LAF3 = 2, ...; LAF1 is in the first only, LAF2 in the first two.
    expect(values[names.indexOf("LAF1")]).toBe(1);
    expect(values[names.indexOf("LAF2")]).toBe(1.5);
    const rows = viewModel(state).contacts;
    expect(rows.find((r) => r.name === "LAF2")?.value).toBe("1.50 µV²");
  });

  it("colors by the scale, paints a contact with no value in the no-data color, and keeps neutral while off", () => {
    const report = (t: number): ActivityReport => {
      const r = knownReport(t, BIPOLAR_LABELS);
      r.channels[0] = { label: BIPOLAR_LABELS[0], value: null, reason: "non_finite" };
      return r;
    };
    const state = withReport(report);
    const names = state.placement?.contacts.map((c) => c.name) ?? [];
    const colors = contactColors(state, palette) ?? new Float32Array();
    const at = (name: string) => [
      ...colors.slice(names.indexOf(name) * 4, names.indexOf(name) * 4 + 4),
    ];
    // LAF1 only belongs to the first channel, which has no value.
    expect(at("LAF1")).toEqual([...palette.noData.map((v) => Math.fround(v)), 1]);
    expect(at("LAF5")).not.toEqual(at("LAF8"));
    for (const name of names) expect(colors[names.indexOf(name) * 4 + 3]).toBe(1);
    expect(viewModel(state).contacts.find((c) => c.name === "LAF1")?.value).toBe(
      "no value: a sample was not a number",
    );
    expect(viewModel(state).activity?.noData).toMatch(/Gray contacts have no value/);

    const off = reduce(state, { type: "activity_switch", on: false }).state;
    const neutral = contactColors(off, palette) ?? new Float32Array();
    expect([...neutral.slice(0, 4)]).toEqual([...palette.neutral.map((v) => Math.fround(v)), 1]);
  });

  it("dims every contact outside the selection, so both halves of a pair stand out", () => {
    const state = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "select_channel", label: "LAF1-LAF2" },
    ]).state;
    const colors = contactColors(state, palette) ?? new Float32Array();
    const alpha = [...colors].filter((_, i) => i % 4 === 3);
    expect(alpha.filter((a) => a === 1)).toHaveLength(2);
    expect(alpha.filter((a) => a < 1 && a > 0)).toHaveLength(alpha.length - 2);
  });

  it("says how the values were computed, with the colorbar's ends in the unit", () => {
    const state = withReport((t) => knownReport(t, BIPOLAR_LABELS));
    const a = viewModel(state).activity;
    expect(a?.summary).toBe(
      "Welch's method: 18 segments of 512 samples over 9.5 s of a 10 s window.",
    );
    expect(a?.colorbar?.lo).toMatch(/µV²$/);
    expect(a?.colorbar?.hi).toMatch(/µV²$/);
    expect(a?.busy).toBe(false);
    // A short analysis is flagged, and the dB reference band is stated.
    const db = reduce(reduce(state, { type: "activity_options", choice: "band_power_db" }).state, {
      type: "activity_report",
      report: {
        ...knownReport(state.activity.token + 1, BIPOLAR_LABELS),
        relative: true,
        unit: "dB",
        segments: 3,
        analyzedS: 2,
        windowS: 2,
        referenceHz: [1, 150],
      },
    }).state;
    expect(viewModel(db).activity?.summary).toBe(
      "Welch's method: 3 segments of 512 samples over 2 s of a 2 s window; few segments, so values are noisy; decibels against the channel's own power from 1 to 150 Hz.",
    );
  });

  it("labels the plain metric the way the plan words it", () => {
    const labels = viewModel(opened(bipolarGeometry, bipolarGroup).state).activity?.choices.map(
      (c) => c.label,
    );
    expect(labels).toContain("RMS (mean removed)");
  });

  it("formats values to three digits, in exponent form at the extremes", () => {
    expect(formatActivityValue(12.3456, "µV")).toBe("12.3 µV");
    expect(formatActivityValue(0, "µV")).toBe("0 µV");
    expect(formatActivityValue(123456, "µV²")).toBe("1.23e+5 µV²");
    expect(formatActivityValue(0.0004, "dB")).toBe("4.00e-4 dB");
    expect(formatActivityValue(-5.5, "dB")).toBe("-5.50 dB");
  });

  it("has a sentence for every refusal the activity module can give", () => {
    for (const reason of [
      "band_above_nyquist",
      "window_too_short",
      "not_level0",
      "bad_input",
      "read_failed",
    ] as const) {
      expect(ACTIVITY_SENTENCES[reason](1000).length).toBeGreaterThan(20);
    }
  });
});

describe("layout and disposal", () => {
  it("sits beside the scope only at 720 CSS pixels or wider", () => {
    expect(SPATIAL_BESIDE_MIN_WIDTH).toBe(720);
    expect(spatialLayout(719)).toBe("below");
    expect(spatialLayout(720)).toBe("beside");
    expect(spatialLayout(360)).toBe("below");
  });

  it("after disposal every event is ignored and nothing is requested", () => {
    const live = play(opened(bipolarGeometry, bipolarGroup).state, [
      { type: "activity_switch", on: true },
    ]);
    const gone = reduce(live.state, { type: "disposed" });
    expect(gone.effects).toEqual([
      { type: "abort_activity" },
      { type: "abort_geometry" },
      { type: "select_trace", label: null },
    ]);
    for (const event of [
      { type: "recording_changed", recording: REC, group: bipolarGroup },
      { type: "window_changed", startS: 5, lengthS: 10 },
      { type: "activity_switch", on: false },
      { type: "geometry_resolved", token: 1, geometry: bipolarGeometry },
    ] as PanelEvent[]) {
      const t = reduce(gone.state, event);
      expect(t.state).toBe(gone.state);
      expect(t.effects).toEqual([]);
    }
  });
});
