import { describe, expect, it } from "vitest";
import { load } from "../../../test/ieeg-channel-fixtures";
import { nodeFs, repoPath } from "../../../test/node";
import type { WindowData } from "../eeg-viewer/store";
import { computeActivity } from "./activity";
import { creditLinkSpec } from "./credit";
import {
  GEOMETRY_REASONS,
  type GeometryInput,
  type RecordingGeometry,
  classifyFrame,
  joinChannels,
  resolveRecordingGeometry,
} from "./geometry";
import {
  SPATIAL_BESIDE_MIN_WIDTH,
  STACKED_SCOPE_MIN_HEIGHT,
  isIeegModality,
  spatialLayout,
  stackedScopeHeight,
} from "./layout";
import {
  ACTIVITY_SENTENCES,
  type ActivityPlan,
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
  TRANSIENT_REASONS,
  WEBGL_SENTENCE,
  abortableSleep,
  activitySamples,
  computeActivityPlan,
  contactColors,
  defaultSpaceIndex,
  drawnPositions,
  drawnTemplate,
  formatActivityValue,
  frameName,
  initialState,
  needsAnotherTry,
  positionWarnings,
  readRuns,
  reduce,
  resolveWithRetries,
  templateRuleOf,
  unitsSentence,
  unlocatedNotes,
  viewModel,
} from "./panel";
import {
  MNI305_TO_MNI152,
  TALAIRACH_TO_MNI,
  TEMPLATE_FAILED_SENTENCE,
  TEMPLATE_LICENSE_HREF,
  TEMPLATE_LOADING_SENTENCE,
  TEMPLATE_REFERENCE,
  applyAffine,
} from "./transforms";

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
const NM405 = "sub-000/ses-right/ieeg/sub-000_ses-right_task-force_run-0_desc-1kHz_ieeg.vhdr";
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

  it("a group change to a group that is not iEEG closes the panel, whose toggle is then hidden", () => {
    const live = opened(bipolarGeometry, bipolarGroup).state;
    expect(live.open).toBe(true);
    const eeg = reduce(live, {
      type: "group_changed",
      group: groupOf(BIPOLAR_LABELS, { index: 1, modality: "EEG" }),
    });
    expect(eeg.state.open).toBe(false);
    expect(viewModel(eeg.state).toggle.visible).toBe(false);
    // Back to an iEEG group: the panel stays as it was left, closed.
    const back = reduce(eeg.state, { type: "group_changed", group: groupOf(BIPOLAR_LABELS) });
    expect(back.state.open).toBe(false);
    expect(viewModel(back.state).toggle).toMatchObject({ visible: true, enabled: true });
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
    expect(rows.find((r) => r.name === "LAF1")?.detail).toBe("(channel LAF1-LAF2)");
    expect(rows.find((r) => r.name === "LAF2")?.detail).toBe("(channels LAF1-LAF2, LAF2-LAF3)");
    // An exact pair carries no tag: both names are the file's own.
    expect(rows.every((r) => r.tag === "" && r.tagTitle === "")).toBe(true);
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

  it("a recording closed by its channel names (nm000377, on004624) stays openable, and opens a refusal that lists both sets of names", async () => {
    for (const key of ["nm000377", "on004624"]) {
      const l = await load(key);
      const rec = { datasetId: l.case.id, version: l.case.version, path: l.case.recording };
      const { state, effects } = opened(l.geometry, groupOf(l.labels), rec);
      const model = viewModel(state);
      // Not the generic disabled button: it opens, and says why in its title.
      expect(model.toggle).toMatchObject({ visible: true, enabled: true, pressed: true });
      expect(model.toggle.title).toBe(
        "Brain: no channel name joins a contact; open to compare the two lists of names",
      );
      expect(model.stage).toEqual({ kind: "refusal", sentence: NO_MATCH_SENTENCE, retry: false });
      const names = model.nameRefusal;
      expect(names?.channels).toMatchObject({ total: l.labels.length });
      expect(names?.channels.names).toEqual(l.labels.slice(0, 12));
      expect(names?.contacts).toMatchObject({ total: l.space.contacts.length });
      expect(names?.contacts.names).toEqual(l.space.contacts.slice(0, 12).map((c) => c.name));
      expect(names?.causes).toEqual([
        `${l.labels.length} unlocated channels, no contact of that name in the electrodes file.`,
      ]);
      expect(names?.verdict).toBe("No rule joined these names; nothing was guessed.");
      // The credit stays, and nothing is drawn, claimed or read.
      expect(model.credit).toEqual(creditLinkSpec());
      expect(model.status).toBeNull();
      expect(model.contacts).toEqual([]);
      expect(model.activity).toBeNull();
      expect(model.view.shown).toBe(false);
      expect(model.template).toBeNull();
      expect(effects.map((e) => e.type)).not.toContain("load_template");
      expect(effects.map((e) => e.type)).not.toContain("load_outlines");
      expect(effects.map((e) => e.type)).not.toContain("read_activity");
    }
  });

  it("names are listed only for a refusal that names are the cause of", () => {
    // A recording that joins is a canvas with no name lists, whatever else it says.
    expect(viewModel(opened(bipolarGeometry, bipolarGroup).state).nameRefusal).toBeNull();
    // Loading, a geometry failure and a closed panel have none either.
    expect(viewModel(initialState()).nameRefusal).toBeNull();
  });

  it("a refusal for want of coordinates stays disabled with its sentence, and lists no names", async () => {
    // nm000537: no usable positions. on004642: no electrodes file. Both are properties of the data.
    const missing = [
      {
        g: await geometryOf("nm000537", "v1.0.2", NM537),
        rec: { datasetId: "nm000537", version: "v1.0.2", path: NM537 },
        reason: "no_coordinates",
      },
      {
        g: await geometryOf(
          "on004642",
          "v1.0.0",
          "sub-01/ses-01/ieeg/sub-01_ses-01_task-lozHFO_run-01_ieeg.edf",
        ),
        rec: {
          datasetId: "on004642",
          version: "v1.0.0",
          path: "sub-01/ses-01/ieeg/sub-01_ses-01_task-lozHFO_run-01_ieeg.edf",
        },
        reason: "no_electrodes_file",
      },
    ] as const;
    for (const { g, rec, reason } of missing) {
      const labels = ["A1", "A2", "B1"];
      const state = play(initialState(), [
        { type: "recording_changed", recording: rec, group: groupOf(labels) },
        { type: "geometry_resolved", token: 1, geometry: g },
      ]).state;
      const toggle = viewModel(state).toggle;
      expect(toggle.enabled).toBe(false);
      expect(toggle.title).toBe(`Brain view unavailable: ${GEOMETRY_SENTENCES[reason]}`);
      expect(viewModel(state).nameRefusal).toBeNull();
    }
  });

  it("channels that name a contact with no position are a missing-coordinates refusal, not a naming one", async () => {
    // The real labels of on005415 whose contact the electrodes file leaves without a position.
    const l = await load("on005415-86");
    const noPosition = joinChannels(l.space, l.labels)
      .filter((j) => j.cause === "no_position")
      .map((j) => j.channel);
    expect(noPosition.length).toBeGreaterThan(0);
    const rec = { datasetId: l.case.id, version: l.case.version, path: l.case.recording };
    const state = opened(l.geometry, groupOf(noPosition), rec).state;
    expect(viewModel(state).toggle.enabled).toBe(false);
    expect(viewModel(state).toggle.title).toMatch(/^Brain view unavailable: /);
    expect(viewModel(state).nameRefusal).toBeNull();
  });

  it("has a plain sentence for every reason IS-C1 can give, all different", () => {
    expect(Object.keys(GEOMETRY_SENTENCES).sort()).toEqual([...GEOMETRY_REASONS].sort());
    expect(new Set(Object.values(GEOMETRY_SENTENCES)).size).toBe(GEOMETRY_REASONS.length);
    for (const s of Object.values(GEOMETRY_SENTENCES)) expect(s).toMatch(/^[A-Z].*\.$/);
  });
});

describe("trying again quietly", () => {
  const noWait = { delaysMs: [0, 0, 0], sleep: async () => {} };
  const countingAttempt = (
    dataset: string,
    version: string,
    recording: string,
    failRead?: (path: string, call: number) => boolean,
  ) => {
    let calls = 0;
    return {
      calls: () => calls,
      attempt: () => {
        const call = calls++;
        return geometryOf(
          dataset,
          version,
          recording,
          treeReader(dataset, version, (p) => failRead?.(p, call) ?? false),
        );
      },
    };
  };

  it("a read that failed in a way that may pass is tried again until it works", async () => {
    // The data plane answered 500 to the first two reads of the electrodes file, then 200.
    const c = countingAttempt(
      "on005522",
      "v1.0.0",
      BIPOLAR,
      (p, call) => p.endsWith("_electrodes.tsv") && call < 2,
    );
    const geometry = await resolveWithRetries(c.attempt, noWait);
    expect(c.calls()).toBe(3);
    expect(geometry.reason).toBeNull();
    expect(geometry.spaces[0].contacts.length).toBeGreaterThan(0);
  });

  it("gives up after the last pause and says so, so the reader can retry by hand", async () => {
    const c = countingAttempt("on005522", "v1.0.0", BIPOLAR, (p) => p.endsWith("_electrodes.tsv"));
    const geometry = await resolveWithRetries(c.attempt, noWait);
    expect(c.calls()).toBe(4);
    expect(geometry.reason).toBe("unreadable");
    expect(needsAnotherTry(geometry)).toBe(true);
  });

  it("does not retry a refusal that is a property of the data", async () => {
    const c = countingAttempt("nm000537", "v1.0.2", NM537);
    const geometry = await resolveWithRetries(c.attempt, noWait);
    expect(c.calls()).toBe(1);
    expect(geometry.reason).toBe("no_coordinates");
    expect(needsAnotherTry(geometry)).toBe(false);
  });

  it("stops at once when the resolution was superseded, without even waiting", async () => {
    const ctl = new AbortController();
    const waited: number[] = [];
    const c = countingAttempt("on005522", "v1.0.0", BIPOLAR, (p) => p.endsWith("_electrodes.tsv"));
    ctl.abort();
    await resolveWithRetries(c.attempt, {
      delaysMs: [0, 0, 0],
      sleep: async (ms) => {
        waited.push(ms);
      },
      signal: ctl.signal,
    });
    expect(c.calls()).toBe(1);
    expect(waited).toEqual([]);
  });

  it("stops when the resolution is superseded during a pause", async () => {
    const ctl = new AbortController();
    const c = countingAttempt("on005522", "v1.0.0", BIPOLAR, (p) => p.endsWith("_electrodes.tsv"));
    await resolveWithRetries(c.attempt, {
      delaysMs: [0, 0, 0],
      sleep: async () => ctl.abort(),
      signal: ctl.signal,
    });
    expect(c.calls()).toBe(1);
  });

  it("counts one frame's failure as worth another try, though the recording shows another frame", async () => {
    const g = await geometryOf(
      "nm000485",
      "v1.0.2",
      NM485,
      treeReader("nm000485", "v1.0.2", (p) => p.includes("space-Other_electrodes")),
    );
    expect(g.reason).toBeNull();
    expect(needsAnotherTry(g)).toBe(true);
  });

  it("an abort cancels a long pause at once instead of waiting it out", async () => {
    const ctl = new AbortController();
    const c = countingAttempt("on005522", "v1.0.0", BIPOLAR, (p) => p.endsWith("_electrodes.tsv"));
    const started = Date.now();
    const pending = resolveWithRetries(c.attempt, { delaysMs: [60_000], signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    const geometry = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(c.calls()).toBe(1);
    expect(geometry.reason).toBe("unreadable");
  });

  it("abortableSleep waits its time, and ends early on an abort or an already aborted signal", async () => {
    const t0 = Date.now();
    await abortableSleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const ctl = new AbortController();
    const t1 = Date.now();
    const slept = abortableSleep(60_000, ctl.signal);
    ctl.abort();
    await slept;
    expect(Date.now() - t1).toBeLessThan(1000);
    const t2 = Date.now();
    await abortableSleep(60_000, ctl.signal);
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  it("waits the stated pause before each further try", async () => {
    const waited: number[] = [];
    const c = countingAttempt("on005522", "v1.0.0", BIPOLAR, (p) => p.endsWith("_electrodes.tsv"));
    await resolveWithRetries(c.attempt, {
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toEqual([300, 800, 1600]);
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

  it("lists the channels that have no position, with the cause IS-C1 gave, and never counts them", () => {
    const labels = [...BIPOLAR_LABELS.slice(0, 3), "X1-X2", "X2-X3", "LAF1"];
    const state = opened(bipolarGeometry, groupOf(labels)).state;
    const notes = viewModel(state).notes;
    expect(notes).toContain(
      "2 unlocated channels, no contact of that name in the electrodes file: X1-X2, X2-X3.",
    );
    // LAF1 alone is a contact in the file, so it is located (the file lists it as a contact).
    expect(viewModel(state).status).toContain("4 of 6 channels located");
    expect(unlocatedNotes([])).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `Z${i}-Z${i + 1}`);
    expect(unlocatedNotes(joinChannels(bipolarGeometry.spaces[0], many))).toEqual([
      "9 unlocated channels, no contact of that name in the electrodes file: Z0-Z1, Z1-Z2, Z2-Z3, Z3-Z4, Z4-Z5, Z5-Z6 and 3 more.",
    ]);
  });

  it("shows both the declared label and the file name when they disagree", async () => {
    const g = await geometryOf("nm000405", "v1.0.3", NM405);
    const space = g.spaces.find((s) => s.space === "mni");
    expect(space?.frame).toMatchObject({ kind: "unknown", why: "space_mismatch" });
    expect(frameName(space?.frame ?? null)).toBe("Other (the file name says mni)");
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
      "mixed_units",
      "read_failed",
    ] as const) {
      expect(ACTIVITY_SENTENCES[reason](1000).length).toBeGreaterThan(20);
    }
  });
});

describe("activity reports and failures carry a token", () => {
  it("a report for another token, arriving while the read computes, changes nothing", () => {
    const on = reduce(opened(bipolarGeometry, bipolarGroup).state, {
      type: "activity_switch",
      on: true,
    });
    expect(on.state.activity.status.kind).toBe("computing");
    const late = reduce(on.state, {
      type: "activity_report",
      report: knownReport(on.state.activity.token - 1, BIPOLAR_LABELS),
    });
    expect(late.state).toBe(on.state);
    expect(late.effects).toEqual([]);
    // The right token lands.
    const right = reduce(on.state, {
      type: "activity_report",
      report: knownReport(on.state.activity.token, BIPOLAR_LABELS),
    });
    expect(right.state.activity.status).toEqual({ kind: "ready" });
  });
});

// A real window: 14 channels, 2 s of level-0 samples of on006136 sub-P5 at 1000 Hz, in volts as
// readLevel0 returns them (test/fixtures/ieeg-activity, SOURCES.json names its provenance).
const activitySources = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/ieeg-activity/SOURCES.json"), "utf8"),
) as {
  slice: { file: string; n_channels: number; n_samples: number; channel_labels: string[] };
};
const sliceBytes = fs.readFileSync(
  repoPath(`test/fixtures/ieeg-activity/${activitySources.slice.file}`),
);
const sliceSamples = new Float32Array(sliceBytes.slice().buffer);
const SLICE_ROWS = activitySources.slice.n_channels;
const SLICE_COLS = activitySources.slice.n_samples;

function fixtureRows(r0: number, r1: number, level = 0): WindowData {
  return {
    level,
    nCols: SLICE_COLS,
    channels: Array.from({ length: r1 - r0 }, (_, i) => ({
      kind: "line" as const,
      line: sliceSamples.slice((r0 + i) * SLICE_COLS, (r0 + i + 1) * SLICE_COLS),
    })),
  };
}

const slicePlan: ActivityPlan = {
  token: 7,
  groupIndex: 0,
  startS: 300,
  endS: 302,
  rateHz: 1000,
  metric: "rms",
  band: null,
  relative: false,
  rows: Array.from({ length: SLICE_ROWS }, (_, i) => i),
};
const sliceGroup = {
  labels: activitySources.slice.channel_labels,
  units: activitySources.slice.channel_labels.map(() => "uV"),
  nativeRateHz: 1000,
};
const noYield = { yieldTask: async () => {} };

describe("computing a plan in slices", () => {
  it("slicing does not change the values, and reads only the rows it is asked for", async () => {
    const asked: [number, number][] = [];
    const sliced = await computeActivityPlan(
      slicePlan,
      sliceGroup,
      async (r0, r1) => {
        asked.push([r0, r1]);
        return fixtureRows(r0, r1);
      },
      { ...noYield, sliceChannels: 5 },
    );
    expect(asked).toEqual([
      [0, 5],
      [5, 10],
      [10, 14],
    ]);
    const whole = await computeActivityPlan(
      slicePlan,
      sliceGroup,
      async (r0, r1) => fixtureRows(r0, r1),
      {
        ...noYield,
        sliceChannels: 100,
      },
    );
    expect(sliced?.ok && whole?.ok).toBe(true);
    if (!sliced?.ok || !whole?.ok) return;
    expect(sliced.report.channels).toEqual(whole.report.channels);
    expect(sliced.report.unit).toBe("µV");
    // And they are what IS-M1 gives for the same window in one call.
    const direct = computeActivity({
      channels: activitySources.slice.channel_labels.map((label, i) => ({
        label,
        samples: sliceSamples.slice(i * SLICE_COLS, (i + 1) * SLICE_COLS),
        nativeRateHz: 1000,
      })),
      rateHz: 1000,
      unit: "V",
      metric: "rms",
      displayUnit: "µV",
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(sliced.report.channels.map((c) => c?.value)).toEqual(
      direct.channels.map((c) => c.value),
    );
  });

  it("refuses when a later slice's channels have another unit than the first's", async () => {
    // Seven channels in microvolts, then seven in femtotesla: one color scale cannot span them.
    const units = sliceGroup.labels.map((_, i) => (i < 7 ? "uV" : "fT"));
    let reads = 0;
    const outcome = await computeActivityPlan(
      slicePlan,
      { ...sliceGroup, units },
      async (r0, r1) => {
        reads += 1;
        return fixtureRows(r0, r1);
      },
      { ...noYield, sliceChannels: 7 },
    );
    expect(reads).toBe(2);
    expect(outcome).toEqual({ ok: false, reason: "mixed_units" });
    expect(ACTIVITY_SENTENCES.mixed_units(1000)).toBe(
      "Activity cannot be computed: this recording's channels mix voltage and field units.",
    );
    // The panel says so in words, and shows nothing.
    const on = reduce(opened(bipolarGeometry, bipolarGroup).state, {
      type: "activity_switch",
      on: true,
    });
    const failed = reduce(on.state, {
      type: "activity_failed",
      token: on.state.activity.token,
      reason: "mixed_units",
    });
    expect(viewModel(failed.state).activity?.message).toBe(ACTIVITY_SENTENCES.mixed_units(500));
    expect(failed.state.activity.shown).toBeNull();
  });

  it("carries IS-M1's refusal of a window that is not level 0", async () => {
    const outcome = await computeActivityPlan(
      slicePlan,
      sliceGroup,
      async (r0, r1) => fixtureRows(r0, r1, 1),
      noYield,
    );
    expect(outcome).toEqual({ ok: false, reason: "not_level0" });
  });

  it("stops at once when aborted, returning nothing", async () => {
    const ctl = new AbortController();
    let reads = 0;
    const outcome = await computeActivityPlan(
      slicePlan,
      sliceGroup,
      async (r0, r1) => {
        reads += 1;
        ctl.abort();
        return fixtureRows(r0, r1);
      },
      { ...noYield, sliceChannels: 5, signal: ctl.signal },
    );
    expect(outcome).toBeNull();
    expect(reads).toBe(1);
  });

  it("reads nothing at all when it was aborted before it began", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let reads = 0;
    const outcome = await computeActivityPlan(
      slicePlan,
      sliceGroup,
      async (r0, r1) => {
        reads += 1;
        return fixtureRows(r0, r1);
      },
      { ...noYield, signal: ctl.signal },
    );
    expect(outcome).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("layout", () => {
  it("keeps the scope at least 280 px tall while the panel is below it, in the code and the stylesheet", () => {
    expect(STACKED_SCOPE_MIN_HEIGHT).toBe(280);
    // The embed fits the scope to its host: with the panel below, that left 179 px for 72 channels.
    expect(stackedScopeHeight(179, true)).toBe(280);
    expect(stackedScopeHeight(645, true)).toBe(645);
    expect(stackedScopeHeight(179, false)).toBe(179);
    const css = fs.readFileSync(repoPath("src/styles/eeg-viewer.css"), "utf8");
    const rule = /\.eegv__plot--stack \.eegv__scope\s*\{[^}]*min-block-size:\s*(\d+)px/.exec(css);
    expect(rule?.[1]).toBe(String(STACKED_SCOPE_MIN_HEIGHT));
  });

  it("knows an iEEG group by its modality, ignoring case, and nothing else", () => {
    expect(isIeegModality("IEEG")).toBe(true);
    expect(isIeegModality("ieeg")).toBe(true);
    expect(isIeegModality("EEG")).toBe(false);
    expect(isIeegModality("MEG")).toBe(false);
    expect(isIeegModality(undefined)).toBe(false);
    expect(isIeegModality("")).toBe(false);
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

/**
 * How many arguments the call whose name starts at `at` has: the non-empty pieces between its
 * parentheses at the top level. Commas inside brackets, braces, parentheses and strings do not
 * split, and a trailing comma (as a formatter leaves after the last argument of a multi-line
 * call) adds no argument.
 */
function countArguments(text: string, at: number): number {
  const open = text.indexOf("(", at);
  const pieces: string[] = [""];
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      pieces[pieces.length - 1] += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) {
      pieces.push("");
      continue;
    }
    pieces[pieces.length - 1] += ch;
  }
  return pieces.filter((p) => p.trim() !== "").length;
}

describe("exports", () => {
  it("counts a call's arguments, with and without a trailing comma, so the guard can fail", () => {
    const call = (args: string[], trailing: boolean) =>
      `paintCredit(\n  ${args.join(",\n  ")}${trailing ? "," : ""}\n)`;
    const four = ["ctx", "width", "height", "theme"];
    const five = [...four, "dpr"];
    for (const trailing of [false, true]) {
      expect(countArguments(call(four, trailing), 0), `four, trailing ${trailing}`).toBe(4);
      expect(countArguments(call(five, trailing), 0), `five, trailing ${trailing}`).toBe(5);
    }
    // Commas inside nested calls, objects, arrays and strings stay inside their argument.
    expect(
      countArguments(
        'paintCredit(ctx, w, h, { background: "#fff", foreground: "a,b" }, Math.min(2, window.devicePixelRatio), )',
        0,
      ),
    ).toBe(5);
    expect(countArguments("paintCredit()", 0)).toBe(0);
    // Only the call at `at` is counted, not what follows it.
    const two = "paintCredit(a, b); other(c, d, e, f, g);";
    expect(countArguments(two, 0)).toBe(2);
  });

  it("every call to paintCredit passes its own device pixel ratio", () => {
    // An export canvas rendered at a fixed scale, whatever the screen, has to say its own ratio,
    // or a 2x export drawn from a 1x screen would shrink the credit. The default (the screen's
    // ratio) is for live canvases only. export.ts has the one call (export.test.ts checks that it
    // passes the export's own ratio).
    const calls: { file: string; args: number }[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (fs.statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|astro)$/.test(name) && !name.endsWith(".test.ts") && name !== "credit.ts") {
          const text = fs.readFileSync(path, "utf8");
          for (
            let at = text.indexOf("paintCredit(");
            at >= 0;
            at = text.indexOf("paintCredit(", at + 1)
          ) {
            calls.push({ file: path, args: countArguments(text, at) });
          }
        }
      }
    };
    walk(repoPath("src"));
    for (const call of calls) expect(call.args, call.file).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Template anatomy (card IS-V2)
// ---------------------------------------------------------------------------

const NM454 =
  "sub-PID02/ses-clinical01/ieeg/sub-PID02_ses-clinical01_task-ictal10046_run-04_ieeg.edf";
const ON5522_TAL = "sub-R1009W/ses-0/ieeg/sub-R1009W_ses-0_task-YC1_acq-monopolar_ieeg.edf";
const ON6136 = "sub-P1/ieeg/sub-P1_task-OWM_ieeg.edf";
const NM376 = "sub-P1/ieeg/sub-P1_task-memact_ieeg.vhdr";
const ON5415 = "sub-72/ieeg/sub-72_task-numbers_run-1_ieeg.edf";

const OWN = "Template brain (MNI152NLin2009cAsym), not this subject's anatomy";
const VARIANT = `${OWN}; approximate: MNI template variants differ by a few millimeters`;

/** One real recording per placed frame (the identifiers MNI305 and the other variants have no fixture). */
const PLACED = [
  {
    name: "MNI152NLin2009cAsym (the surface's own frame)",
    dataset: ["nm000454", "v1.0.2"],
    recording: NM454,
    identifier: "MNI152NLin2009cAsym",
    label: OWN,
    approximate: false,
  },
  {
    name: "MNI152NLin6ASym (another MNI variant)",
    dataset: ["on005522", "v1.0.0"],
    recording: MONOPOLAR,
    identifier: "MNI152NLin6ASym",
    label: VARIANT,
    approximate: true,
  },
  {
    name: "MNI152Lin",
    dataset: ["on006136", "v1.0.0"],
    recording: ON6136,
    identifier: "MNI152Lin",
    label: VARIANT,
    approximate: true,
  },
  {
    name: "IXI549Space",
    dataset: ["nm000376", "v1.0.2"],
    recording: NM376,
    identifier: "IXI549Space",
    label: VARIANT,
    approximate: true,
  },
  {
    name: "Talairach (a cited affine)",
    dataset: ["on005522", "v1.0.0"],
    recording: ON5522_TAL,
    identifier: "Talairach",
    label: `${OWN}; approximate: Talairach to MNI affine`,
    approximate: true,
  },
  {
    name: "fsaverage (FreeSurfer's MNI305 affine)",
    dataset: ["on006253", "v1.0.0"],
    recording: ON6253,
    identifier: "fsaverage",
    label: `${OWN}; approximate: MNI305 to MNI152 affine`,
    approximate: true,
  },
] as const;

async function placedState(c: (typeof PLACED)[number]) {
  const [dataset, version] = c.dataset;
  const geometry = await geometryOf(dataset, version, c.recording);
  const index = geometry.spaces.findIndex(
    (s) => s.frame?.kind === "template" && s.frame.identifier === c.identifier,
  );
  expect(index, c.name).toBeGreaterThanOrEqual(0);
  const ref: RecordingRef = { datasetId: dataset, version, path: c.recording };
  const live = play(opened(geometry, groupOf(contactLabels(geometry, index)), ref).state, [
    { type: "frame_changed", spaceIndex: index },
  ]);
  return { geometry, index, ref, state: live.state, effects: live.effects };
}

/** The panel opened on one chosen frame: the reader picks it while the panel is still closed. */
function openedOnSpace(
  geometry: RecordingGeometry,
  index: number,
  ref: RecordingRef,
): { state: PanelState; effects: PanelEffect[] } {
  return play(initialState(), [
    {
      type: "recording_changed",
      recording: ref,
      group: groupOf(contactLabels(geometry, index)),
    },
    { type: "geometry_resolved", token: 1, geometry },
    { type: "frame_changed", spaceIndex: index },
    { type: "toggle_open" },
    { type: "window_changed", startS: 0, lengthS: 10 },
  ]);
}

const loads = (effects: PanelEffect[]) => effects.filter((e) => e.type === "load_template");
const loaded = (state: PanelState) => reduce(state, { type: "template_loaded" }).state;

/** A recording shown on a frame with no template placement, with the panel open. */
async function unplacedCases() {
  const acpc = await geometryOf("on005415", "v1.0.0", ON5415);
  const scan = await geometryOf("on004473", "v1.0.0", ON4473);
  const other = await geometryOf("nm000485", "v1.0.2", NM485);
  const mni = await geometryOf("nm000405", "v1.0.3", NM405);
  const noUnits = await geometryOf("nm000373", "v1.0.2", NM373);
  const mniEntity = mni.spaces.findIndex((s) => s.space === "mni");
  const otherIndex = other.spaces.findIndex((s) => s.frame?.kind === "described");
  const scanIndex = scan.spaces.findIndex((s) => s.space === "ScanRAS");
  return [
    {
      name: "ACPC",
      geometry: acpc,
      index: 0,
      word: "ACPC",
      path: ON5415,
      ds: ["on005415", "v1.0.0"],
    },
    {
      name: "ScanRAS",
      geometry: scan,
      index: scanIndex,
      word: "ScanRAS",
      path: ON4473,
      ds: ["on004473", "v1.0.0"],
    },
    {
      name: "Other",
      geometry: other,
      index: otherIndex,
      word: "Other",
      path: NM485,
      ds: ["nm000485", "v1.0.2"],
    },
    {
      name: "a label the file name contradicts",
      geometry: mni,
      index: mniEntity,
      word: "Other",
      path: NM405,
      ds: ["nm000405", "v1.0.3"],
    },
    {
      name: "a template frame whose units are not declared",
      geometry: noUnits,
      index: 0,
      word: "MNI152NLin6ASym",
      path: NM373,
      ds: ["nm000373", "v1.0.2"],
    },
  ] as const;
}

describe("template anatomy", () => {
  it("a registered frame asks for the surface once, when the panel is open on it and not before", async () => {
    const c = PLACED[1];
    const [dataset, version] = c.dataset;
    const geometry = await geometryOf(dataset, version, c.recording);
    const ref: RecordingRef = { datasetId: dataset, version, path: c.recording };
    const closed = play(initialState(), [
      { type: "recording_changed", recording: ref, group: groupOf(contactLabels(geometry, 0)) },
      { type: "geometry_resolved", token: 1, geometry },
      { type: "window_changed", startS: 0, lengthS: 10 },
    ]);
    expect(loads(closed.effects)).toEqual([]);
    expect(closed.state.template).toBe("idle");

    const open = reduce(closed.state, { type: "toggle_open" });
    expect(loads(open.effects)).toEqual([{ type: "load_template" }]);
    expect(open.state.template).toBe("loading");

    // Nothing asks again while it loads, whatever else happens.
    const more = play(open.state, [
      { type: "window_changed", startS: 10, lengthS: 10 },
      { type: "activity_switch", on: true },
      { type: "select_channel", label: contactLabels(geometry, 0)[0] },
    ]);
    expect(loads(more.effects)).toEqual([]);
    expect(loaded(more.state).template).toBe("ready");
    // and a loaded surface is not asked for again when the panel is closed and opened
    const again = play(loaded(more.state), [
      { type: "toggle_open", open: false },
      { type: "toggle_open", open: true },
    ]);
    expect(loads(again.effects)).toEqual([]);
  });

  it("a frame with no template placement never asks for the surface and says so", async () => {
    for (const c of await unplacedCases()) {
      const [dataset, version] = c.ds;
      const ref: RecordingRef = { datasetId: dataset, version, path: c.path };
      const start = openedOnSpace(c.geometry, c.index, ref);
      const live = play(start.state, [
        { type: "toggle_open", open: false },
        { type: "toggle_open", open: true },
        { type: "frame_changed", spaceIndex: c.index },
      ]);
      expect(live.state.template, c.name).toBe("idle");
      expect(loads([...start.effects, ...live.effects]), c.name).toEqual([]);
      const model = viewModel(live.state);
      expect(model.stage.kind, c.name).toBe("canvas");
      expect(model.template, c.name).toBeNull();
      expect(model.notes, c.name).toContain(
        `No template placement for ${c.word}: positions are shown in the dataset's own frame`,
      );
      // drawn exactly where the dataset says, and no surface
      expect(drawnTemplate(live.state), c.name).toBeNull();
      expect(drawnPositions(live.state), c.name).toEqual(
        live.state.placement?.contacts.map((p) => p.position),
      );
    }
  });

  it("a frame that is placed does not say 'no template placement'", async () => {
    for (const c of PLACED) {
      const { state } = await placedState(c);
      expect(viewModel(state).notes.join("\n"), c.name).not.toMatch(/No template placement/);
    }
  });

  it("without WebGL2 the surface is never asked for, even if the panel was opened first", async () => {
    const c = PLACED[1];
    const [dataset, version] = c.dataset;
    const geometry = await geometryOf(dataset, version, c.recording);
    const ref: RecordingRef = { datasetId: dataset, version, path: c.recording };
    const before = play(initialState(), [
      { type: "webgl_unavailable" },
      { type: "recording_changed", recording: ref, group: groupOf(contactLabels(geometry, 0)) },
      { type: "geometry_resolved", token: 1, geometry },
      { type: "toggle_open" },
    ]);
    expect(loads(before.effects)).toEqual([]);
    expect(viewModel(before.state).stage.kind).toBe("no_webgl");
    // The surface is never asked for; the 2D views wait on the template's outlines instead (IS-V3),
    // and say so in the same words.
    expect(viewModel(before.state).template).toEqual({
      status: "loading",
      sentence: "Loading the template brain...",
    });
    expect(before.state.template).toBe("idle");
    expect(before.state.outlines).toBe("loading");

    // The DOM half learns of the missing WebGL2 after the panel opened and the request was made:
    // the request is withdrawn, so a later change does not leave a fetch "loading" for ever.
    const asked = play(initialState(), [
      { type: "recording_changed", recording: ref, group: groupOf(contactLabels(geometry, 0)) },
      { type: "geometry_resolved", token: 1, geometry },
      { type: "toggle_open" },
    ]);
    expect(loads(asked.effects)).toHaveLength(1);
    expect(reduce(asked.state, { type: "webgl_unavailable" }).state.template).toBe("idle");
  });

  it("a recording with more than one frame asks only while the shown frame is placed", async () => {
    const g = await geometryOf("nm000485", "v1.0.2", NM485);
    const talairach = g.spaces.findIndex((s) => s.frame?.kind === "template");
    const other = g.spaces.findIndex((s) => s.frame?.kind === "described");
    const start = opened(g, groupOf(contactLabels(g, talairach)), {
      datasetId: "nm000485",
      version: "v1.0.2",
      path: NM485,
    });
    expect(g.spaces[talairach].frame).toMatchObject({ identifier: "Talairach" });
    expect(loads(start.effects)).toHaveLength(1);

    // Moving to the described frame hides the surface: contacts as declared, no label, the sentence.
    const ready = loaded(start.state);
    const moved = reduce(ready, { type: "frame_changed", spaceIndex: other }).state;
    expect(loads(reduce(ready, { type: "frame_changed", spaceIndex: other }).effects)).toEqual([]);
    expect(viewModel(moved).template).toBeNull();
    expect(drawnTemplate(moved)).toBeNull();
    expect(viewModel(moved).notes).toContain(
      "No template placement for Other: positions are shown in the dataset's own frame",
    );
    // Back to Talairach: the surface it already holds is drawn, with no second request.
    const back = reduce(moved, { type: "frame_changed", spaceIndex: talairach });
    expect(loads(back.effects)).toEqual([]);
    expect(viewModel(back.state).template).toMatchObject({ status: "ready" });

    // Opening on the described frame first and then moving to Talairach asks then, once.
    const first = openedOnSpace(g, other, {
      datasetId: "nm000485",
      version: "v1.0.2",
      path: NM485,
    });
    expect(first.state.template).toBe("idle");
    expect(loads(first.effects)).toEqual([]);
    const later = reduce(first.state, { type: "frame_changed", spaceIndex: talairach });
    expect(loads(later.effects)).toHaveLength(1);
  });

  it("every state that draws the surface carries the template label, and every transformed one 'approximate'", async () => {
    for (const c of PLACED) {
      const { state } = await placedState(c);
      const model = viewModel(loaded(state));
      expect(model.template, c.name).toMatchObject({ status: "ready", label: c.label });
      if (model.template?.status !== "ready") throw new Error("not ready");
      expect(model.template.label.startsWith(OWN), c.name).toBe(true);
      expect(model.template.approximate, c.name).toBe(c.approximate);
      expect(/approximate: /.test(model.template.label), c.name).toBe(c.approximate);
      // who made the surface and where its notice is, beside the label
      expect(model.template.reference).toEqual({
        text: TEMPLATE_REFERENCE.text,
        href: "https://doi.org/10.1016/j.neuroimage.2010.07.033",
      });
      expect(model.template.license.href).toBe(
        "/vendor/brain-templates/mni152nlin2009casym@1/LICENSE.txt",
      );
      expect(model.template.license.href).toBe(TEMPLATE_LICENSE_HREF);
      expect(drawnTemplate(loaded(state))?.identifier, c.name).toBe(c.identifier);
      expect(templateRuleOf(state)?.identifier, c.name).toBe(c.identifier);
    }
  });

  it("while the surface loads or has failed, no label claims a drawing, and the credit stays", async () => {
    const { state } = await placedState(PLACED[4]);
    expect(state.template).toBe("loading");
    const loading = viewModel(state);
    expect(loading.template).toEqual({ status: "loading", sentence: TEMPLATE_LOADING_SENTENCE });
    expect(JSON.stringify(loading.template)).not.toMatch(/Template brain|approximate/);
    const failed = viewModel(reduce(state, { type: "template_failed" }).state);
    expect(failed.template).toEqual({ status: "failed", sentence: TEMPLATE_FAILED_SENTENCE });
    expect(JSON.stringify(failed.template)).not.toMatch(/approximate/);
    for (const model of [loading, failed, viewModel(loaded(state))]) {
      expect(model.credit).toEqual(creditLinkSpec());
    }
  });

  it("contacts go through the row's affine only while the surface is drawn, and nothing is moved onto it", async () => {
    const tal = await placedState(PLACED[4]);
    const declared = tal.state.placement?.contacts.map((c) => c.position) ?? [];
    expect(declared.length).toBeGreaterThan(10);
    // loading: as declared
    expect(drawnPositions(tal.state)).toEqual(declared);
    // ready: each through the inverse of Lancaster's Eq. (3), index for index
    const drawn = drawnPositions(loaded(tal.state)) ?? [];
    expect(drawn).toHaveLength(declared.length);
    declared.forEach((p, i) => expect(drawn[i]).toEqual(applyAffine(TALAIRACH_TO_MNI, p)));
    expect(drawn[0]).not.toEqual(declared[0]);
    // failed: as declared again
    expect(drawnPositions(reduce(tal.state, { type: "template_failed" }).state)).toEqual(declared);

    const fsa = await placedState(PLACED[5]);
    const fsaDeclared = fsa.state.placement?.contacts.map((c) => c.position) ?? [];
    const fsaDrawn = drawnPositions(loaded(fsa.state)) ?? [];
    fsaDeclared.forEach((p, i) => expect(fsaDrawn[i]).toEqual(applyAffine(MNI305_TO_MNI152, p)));

    // the surface's own frame and the variants: untouched, whatever the surface is
    for (const c of [PLACED[0], PLACED[1], PLACED[2], PLACED[3]]) {
      const { state } = await placedState(c);
      expect(drawnPositions(loaded(state)), c.name).toEqual(
        state.placement?.contacts.map((p) => p.position),
      );
    }
  });

  it("a failed fetch is tried again when the panel is reopened, the frame changes or the recording does", async () => {
    const { state, ref } = await placedState(PLACED[1]);
    const failed = reduce(state, { type: "template_failed" }).state;
    expect(failed.template).toBe("failed");
    // staying open and moving the window does not retry
    expect(
      loads(reduce(failed, { type: "window_changed", startS: 5, lengthS: 10 }).effects),
    ).toEqual([]);
    const reopened = play(failed, [
      { type: "toggle_open", open: false },
      { type: "toggle_open", open: true },
    ]);
    expect(loads(reopened.effects)).toHaveLength(1);
    expect(reopened.state.template).toBe("loading");
    const framed = reduce(failed, { type: "frame_changed", spaceIndex: 0 });
    expect(loads(framed.effects)).toHaveLength(1);
    const recorded = reduce(failed, {
      type: "recording_changed",
      recording: ref,
      group: groupOf(contactLabels(await geometryOf("on005522", "v1.0.0", MONOPOLAR), 0)),
    });
    expect(recorded.state.template).toBe("idle");
    // a surface that is ready or loading survives a recording change, with no second request
    const ready = loaded(state);
    expect(
      reduce(ready, { type: "recording_changed", recording: ref, group: groupOf(MONOPOLAR_LABELS) })
        .state.template,
    ).toBe("ready");
  });

  it("a report of the fetch that is not expected changes nothing", async () => {
    const { state } = await placedState(PLACED[1]);
    const ready = loaded(state);
    expect(reduce(ready, { type: "template_loaded" }).state).toBe(ready);
    expect(reduce(ready, { type: "template_failed" }).state).toBe(ready);
    const idle = reduce(state, { type: "toggle_open", open: false }).state;
    const never = { ...idle, template: "idle" as const };
    expect(reduce(never, { type: "template_loaded" }).state).toBe(never);
  });

  // No public dataset declares a pending family (the census has none), so this is the real contacts
  // of nm000454 under a frame label changed to the one under test: a known-answer input, as the
  // header of this file says. The code under test (`reduce`, `viewModel`) is untouched.
  async function underFrame(label: string) {
    const g = await geometryOf("nm000454", "v1.0.2", NM454);
    const geometry: RecordingGeometry = {
      ...g,
      spaces: g.spaces.map((s) => ({ ...s, frame: classifyFrame(label, null, null) })),
    };
    const ref: RecordingRef = { datasetId: "nm000454", version: "v1.0.2", path: NM454 };
    return openedOnSpace(geometry, 0, ref);
  }
  const TAIL = ": positions are shown in the dataset's own frame";

  it("a pending family and an unsupported native frame get different sentences, and neither places a contact", async () => {
    const pendingLabels = [
      "MNIColin27",
      "ICBM452AirSpace",
      "ICBM452Warp5Space",
      "fsLR",
      "NIHPD",
      "OASIS30AntsOASISAnts",
      "OASIS30Atropos",
      "UNCInfant",
    ];
    const declared = (await underFrame("ACPC")).state.placement?.contacts.map((c) => c.position);
    expect(declared?.length).toBeGreaterThan(10);
    const native = await underFrame("ACPC");
    const nativeNotes = viewModel(native.state).notes;
    expect(nativeNotes).toContain(`No template placement for ACPC${TAIL}`);
    expect(nativeNotes.join("\n")).not.toContain("placement yet");

    for (const label of pendingLabels) {
      const { state, effects } = await underFrame(label);
      const model = viewModel(state);
      expect(model.stage.kind, label).toBe("canvas");
      expect(model.notes, label).toContain(`No template placement yet for ${label}${TAIL}`);
      expect(model.notes, label).not.toContain(`No template placement for ${label}${TAIL}`);
      // no surface asked for, none drawn, no label, contacts exactly as declared
      expect(loads(effects), label).toEqual([]);
      expect(state.template, label).toBe("idle");
      expect(model.template, label).toBeNull();
      expect(drawnTemplate(state), label).toBeNull();
      expect(templateRuleOf(state), label).toBeNull();
      expect(drawnPositions(state), label).toEqual(declared);
      // the credit stays
      expect(model.credit, label).toEqual(creditLinkSpec());
    }
    // the same real contacts under a placed identifier do get the surface: the label is what differs
    const placed = await underFrame("MNI152NLin2009cAsym");
    expect(loads(placed.effects)).toHaveLength(1);
    expect(viewModel(loaded(placed.state)).template).toMatchObject({ status: "ready" });
  });

  it("fsaverageSym is placed like fsaverage: the surface is asked for, the label says approximate, contacts go through FreeSurfer's affine", async () => {
    const sym = await underFrame("fsaverageSym");
    expect(loads(sym.effects)).toHaveLength(1);
    expect(sym.state.template).toBe("loading");
    expect(viewModel(sym.state).notes.join("\n")).not.toMatch(/No template placement/);
    const ready = loaded(sym.state);
    expect(viewModel(ready).template).toMatchObject({
      status: "ready",
      label: `${OWN}; approximate: MNI305 to MNI152 affine`,
    });
    const declared = sym.state.placement?.contacts.map((c) => c.position) ?? [];
    expect(declared.length).toBeGreaterThan(10);
    const drawn = drawnPositions(ready) ?? [];
    declared.forEach((p, i) => expect(drawn[i]).toEqual(applyAffine(MNI305_TO_MNI152, p)));
    expect(drawn[0]).not.toEqual(declared[0]);
  });

  it("the sentence for an undeclared frame does not name a frame the file never wrote", async () => {
    const g = await geometryOf("on006253", "v1.0.0", ON6253);
    const index = g.spaces.findIndex((s) => s.space === "mni");
    const { state, effects } = openedOnSpace(g, index, {
      datasetId: "on006253",
      version: "v1.0.0",
      path: ON6253,
    });
    expect(loads(effects)).toEqual([]);
    expect(viewModel(state).notes).toContain(
      "No template placement for an undeclared frame: positions are shown in the dataset's own frame",
    );
    expect(state.template).toBe("idle");
  });
});
