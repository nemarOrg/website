import { describe, expect, it } from "vitest";
import { buildRecordingList } from "./recording-nav";
import {
  RETRY_CLASS,
  navControlState,
  openFailureHtml,
  reloadUrl,
  sessionContext,
  viewSpecForPath,
} from "./viewer-session";

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

describe("openFailureHtml", () => {
  const fallback = '<a href="/dataset/on007753">Open this recording on NEMAR</a>';

  it("names the recording, keeps the page's fallback sentence and offers Try again in the alert", () => {
    const html = openFailureHtml("sub-01_task-rest_eeg.vhdr", fallback);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn't open sub-01_task-rest_eeg.vhdr.");
    expect(html).toContain(`${fallback} instead.`);
    expect(html).toContain(`class="${RETRY_CLASS}"`);
    expect(html).toContain(">Try again</button>");
    // One alert, with the button inside it and described by the sentence.
    expect(html.match(/<p /g)).toHaveLength(1);
    expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("instead."));
    expect(html.indexOf("</button>")).toBeLessThan(html.indexOf("</p>"));
    const id = /<span id="([^"]+)">/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-describedby="${id}"`);
  });

  it("says Still after a failed retry, so a click that changed nothing else still shows", () => {
    expect(openFailureHtml("a.vhdr", fallback, { again: true })).toContain(
      "Still couldn't open a.vhdr.",
    );
    expect(openFailureHtml("a.vhdr", fallback)).not.toContain("Still");
  });

  it("offers Reload page instead when the viewer's code did not load", () => {
    const html = openFailureHtml("a.vhdr", fallback, { reload: true });
    expect(html).toContain(">Reload page</button>");
    expect(html).not.toContain("Try again");
    expect(html).toContain(`class="${RETRY_CLASS}"`);
  });

  it("escapes a file name that carries markup", () => {
    const html = openFailureHtml('"><img src=x onerror=alert(1)>.vhdr', "fallback");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("reloadUrl", () => {
  it("names the failed recording where the session stripped it", () => {
    expect(
      reloadUrl("https://nemar.org/dataset/on007753/embed?theme=dark", "sub-03_task-rest"),
    ).toBe("https://nemar.org/dataset/on007753/embed?theme=dark&view=sub-03_task-rest");
  });

  it("replaces a ?view= that is still there and keeps the version and the hash", () => {
    expect(
      reloadUrl("https://nemar.org/dataset/on007753?v=1.0.1&view=old#readme", "sub-02_task-rest"),
    ).toBe("https://nemar.org/dataset/on007753?v=1.0.1&view=sub-02_task-rest#readme");
  });

  it("is the address unchanged when there is no recording to name", () => {
    expect(reloadUrl("https://nemar.org/dataset/on007753?v=1.0.1", null)).toBe(
      "https://nemar.org/dataset/on007753?v=1.0.1",
    );
  });
});
