import { describe, expect, it } from "vitest";
import { buildRecordingList } from "./recording-nav";
import { navControlState, sessionContext, viewSpecForPath } from "./viewer-session";

/**
 * The pure half of the viewer session (website#410): what the nav controls
 * say for a position, and the `?view=` value the URL and the share controls
 * carry. The DOM half (focus hand-off, supersession, the draft guard) is
 * covered by the browser characterization of the dataset page dialog, run
 * before and after the session was extracted from it.
 *
 * Paths are real Zarr index entries: on007753 (41 subjects, one task, with
 * gaps at sub-22, sub-37 and sub-42) and on004696 (sessioned MEF3 runs).
 */
const ON007753 = buildRecordingList([
  "sub-01/eeg/sub-01_task-BCCWJreading_eeg.vhdr",
  "sub-02/eeg/sub-02_task-BCCWJreading_eeg.vhdr",
  "sub-21/eeg/sub-21_task-BCCWJreading_eeg.vhdr",
  "sub-23/eeg/sub-23_task-BCCWJreading_eeg.vhdr",
  "sub-43/eeg/sub-43_task-BCCWJreading_eeg.vhdr",
  "sub-44/eeg/sub-44_task-BCCWJreading_eeg.vhdr",
]);

describe("navControlState", () => {
  it("disables prev on the first recording and names the next one", () => {
    const state = navControlState(ON007753, "sub-01/eeg/sub-01_task-BCCWJreading_eeg.vhdr", "runs");
    expect(state.position).toBe("1 of 6");
    expect(state.before).toBeNull();
    expect(state.prevLabel).toBe("No previous recording");
    expect(state.after?.path).toBe("sub-02/eeg/sub-02_task-BCCWJreading_eeg.vhdr");
    expect(state.nextLabel).toBe("Next recording: sub-02_task-BCCWJreading_eeg.vhdr");
  });

  it("disables next on the last recording", () => {
    const state = navControlState(ON007753, "sub-44/eeg/sub-44_task-BCCWJreading_eeg.vhdr", "runs");
    expect(state.position).toBe("6 of 6");
    expect(state.after).toBeNull();
    expect(state.nextLabel).toBe("No next recording");
    expect(state.prevLabel).toBe("Previous recording: sub-43_task-BCCWJreading_eeg.vhdr");
  });

  it("steps across a gap in subject numbering", () => {
    const state = navControlState(ON007753, "sub-21/eeg/sub-21_task-BCCWJreading_eeg.vhdr", "runs");
    expect(state.nextLabel).toBe("Next recording: sub-23_task-BCCWJreading_eeg.vhdr");
  });

  it("fills the dropdowns, tasks scoped to the subject on screen", () => {
    const state = navControlState(ON007753, "sub-02/eeg/sub-02_task-BCCWJreading_eeg.vhdr", "runs");
    expect(state.subjects).toEqual(["01", "02", "21", "23", "43", "44"]);
    expect(state.tasks).toEqual(["BCCWJreading"]);
    expect(state.current?.sub).toBe("02");
  });

  it("counts recordings without a position for a path not in the list", () => {
    const state = navControlState(ON007753, "sub-99/eeg/sub-99_task-BCCWJreading_eeg.vhdr", "runs");
    expect(state.position).toBe("6 recordings");
    expect(state.current).toBeNull();
    expect(state.before).toBeNull();
    expect(state.after).toBeNull();
  });

  it("follows the nav order for a sessioned, run-numbered dataset", () => {
    const list = buildRecordingList([
      "sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
      "sub-02/ses-ieeg01/ieeg/sub-02_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
    ]);
    const path = "sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd";
    expect(navControlState(list, path, "subjects").nextLabel).toBe(
      "Next recording: sub-02_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
    );
    expect(navControlState(list, path, "file").position).toBe("1 of 2");
  });
});

describe("viewSpecForPath", () => {
  it("writes the recording's entities, the form a partner writes", () => {
    expect(viewSpecForPath(ON007753, "sub-43/eeg/sub-43_task-BCCWJreading_eeg.vhdr")).toBe(
      "sub-43_task-BCCWJreading",
    );
    const list = buildRecordingList([
      "sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
    ]);
    expect(viewSpecForPath(list, list[0].path)).toBe("sub-01_ses-ieeg01_task-ccep_run-01");
  });

  it("falls back to the path for one it does not list", () => {
    // sub-05 is a real on007753 recording that this subset leaves out.
    const path = "sub-05/eeg/sub-05_task-BCCWJreading_eeg.vhdr";
    expect(viewSpecForPath(ON007753, path)).toBe(path);
  });
});

describe("sessionContext", () => {
  // The token and paths are on007753's index (updated_utc 2026-09-29T03:05:16Z).
  const paths = [
    "sub-01/eeg/sub-01_task-BCCWJreading_eeg.vhdr",
    "sub-02/eeg/sub-02_task-BCCWJreading_eeg.vhdr",
    "sub-05/eeg/sub-05_task-BCCWJreading_eeg.vhdr",
  ];

  it("builds the recording list from the index paths and carries its token", () => {
    const zarr = {
      paths: new Set(paths),
      stores: new Map(),
      prefetched: new Set<string>(),
      token: "2026-09-29T03:05:16Z",
    };
    const ctx = sessionContext("on007753", "v1.0.0", zarr);
    expect(ctx.datasetId).toBe("on007753");
    expect(ctx.version).toBe("v1.0.0");
    expect(ctx.recordings.map((e) => e.path)).toEqual(paths);
    expect(ctx.recordings.map((e) => e.sub)).toEqual(["01", "02", "05"]);
    expect(ctx.zarrToken).toBe("2026-09-29T03:05:16Z");
    // The same object, so its prefetched set stays shared with the tree rows.
    expect(ctx.zarr).toBe(zarr);
  });

  it("is empty, with the un-busted token, when there is no index", () => {
    expect(sessionContext("on007753", "v1.0.0", null)).toEqual({
      datasetId: "on007753",
      version: "v1.0.0",
      recordings: [],
      zarrToken: "",
      zarr: null,
    });
  });
});
