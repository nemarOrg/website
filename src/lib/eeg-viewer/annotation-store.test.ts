import { describe, expect, it } from "vitest";
import {
  createMemoryAnnotationStore,
  openAnnotationStore,
  recordingKeyString,
  reviveAnnotationSet,
} from "./annotation-store";
import { createChannelAnnotation, createTimeAnnotation } from "./annotations";

const AT = 1_750_000_000_000;
const KEY = {
  datasetId: "ds005863",
  version: "1.0.0",
  filePath: "sub-01/eeg/sub-01_task-rest_eeg.edf",
};

describe("recordingKeyString", () => {
  it("includes dataset, version and path", () => {
    expect(recordingKeyString(KEY)).toBe(
      JSON.stringify(["ds005863", "1.0.0", "sub-01/eeg/sub-01_task-rest_eeg.edf"]),
    );
  });

  it("cannot be collided by a path that contains a delimiter-looking character", () => {
    const a = recordingKeyString({ datasetId: "ds1", version: "1.0.0", filePath: "a/b" });
    const b = recordingKeyString({ datasetId: "ds1", version: "1.0.0/a", filePath: "b" });
    expect(a).not.toBe(b);
  });

  it("separates two versions of the same recording", () => {
    expect(recordingKeyString({ ...KEY, version: "2.0.0" })).not.toBe(recordingKeyString(KEY));
  });

  it("separates two recordings in one dataset version", () => {
    expect(
      recordingKeyString({ ...KEY, filePath: "sub-02/eeg/sub-02_task-rest_eeg.edf" }),
    ).not.toBe(recordingKeyString(KEY));
  });

  it("handles a null version without collapsing onto another dataset", () => {
    expect(recordingKeyString({ ...KEY, version: null })).toBe(
      JSON.stringify(["ds005863", "", "sub-01/eeg/sub-01_task-rest_eeg.edf"]),
    );
    expect(recordingKeyString({ ...KEY, version: null })).not.toBe(recordingKeyString(KEY));
  });
});

describe("reviveAnnotationSet", () => {
  it("returns an empty set for a missing record", () => {
    expect(reviveAnnotationSet(undefined)).toEqual({ time: [], channels: [] });
    expect(reviveAnnotationSet(null)).toEqual({ time: [], channels: [] });
    expect(reviveAnnotationSet("nonsense")).toEqual({ time: [], channels: [] });
  });

  it("tolerates a record whose arrays are missing", () => {
    expect(reviveAnnotationSet({ savedAt: AT })).toEqual({ time: [], channels: [] });
  });

  it("round-trips a real set through a plain-object clone", () => {
    const set = {
      time: [
        createTimeAnnotation(
          { onsetS: 40, durationS: 12.25, hedTags: ["sc:Episode/Epileptic-seizure"] },
          AT,
        ),
      ],
      channels: [createChannelAnnotation({ channel: "T7", description: "noisy" }, AT)],
    };
    const revived = reviveAnnotationSet(JSON.parse(JSON.stringify(set)));
    expect(revived).toEqual(set);
  });

  it("clamps a hand-edited negative onset", () => {
    const revived = reviveAnnotationSet({
      time: [{ id: "a", onsetS: -12, durationS: 5, hedTags: [], description: "" }],
      channels: [],
    });
    expect(revived.time[0].onsetS).toBe(0);
  });

  it("drops non-string tags written by a broken writer", () => {
    const revived = reviveAnnotationSet({
      time: [{ id: "a", onsetS: 1, durationS: 0, hedTags: ["Spike", 7, null], description: "" }],
      channels: [],
    });
    expect(revived.time[0].hedTags).toEqual(["Spike"]);
  });

  it("drops a channel row with no name, which could not be exported", () => {
    const revived = reviveAnnotationSet({
      time: [],
      channels: [
        { id: "a", channel: "", status: "bad" },
        { id: "b", channel: "T7", status: "bad" },
      ],
    });
    expect(revived.channels.map((c) => c.channel)).toEqual(["T7"]);
  });

  it("coerces an unknown status to bad", () => {
    const revived = reviveAnnotationSet({
      time: [],
      channels: [{ id: "a", channel: "T7", status: "questionable" }],
    });
    expect(revived.channels[0].status).toBe("bad");
  });

  it("skips array members that are not objects", () => {
    const revived = reviveAnnotationSet({ time: [1, "x", null], channels: ["y"] });
    expect(revived).toEqual({ time: [], channels: [] });
  });

  it("returns the two kinds already sorted", () => {
    const revived = reviveAnnotationSet({
      time: [
        { id: "b", onsetS: 90, durationS: 0 },
        { id: "a", onsetS: 3, durationS: 0 },
      ],
      channels: [
        { id: "y", channel: "T8" },
        { id: "x", channel: "Cz" },
      ],
    });
    expect(revived.time.map((a) => a.onsetS)).toEqual([3, 90]);
    expect(revived.channels.map((c) => c.channel)).toEqual(["Cz", "T8"]);
  });
});

describe("createMemoryAnnotationStore", () => {
  it("reports itself as non-persistent", () => {
    expect(createMemoryAnnotationStore().persistent).toBe(false);
  });

  it("returns an empty set for a recording it has never seen", async () => {
    const store = createMemoryAnnotationStore();
    await expect(store.load(KEY)).resolves.toEqual({ time: [], channels: [] });
  });

  it("reads back what it saved", async () => {
    const store = createMemoryAnnotationStore();
    const set = {
      time: [createTimeAnnotation({ onsetS: 12.5, durationS: 0 }, AT)],
      channels: [],
    };
    await store.save(KEY, set);
    expect(await store.load(KEY)).toEqual(set);
  });

  it("keeps two recordings apart", async () => {
    const store = createMemoryAnnotationStore();
    const other = { ...KEY, filePath: "sub-02/eeg/sub-02_task-rest_eeg.edf" };
    await store.save(KEY, {
      time: [createTimeAnnotation({ onsetS: 1, durationS: 0 }, AT)],
      channels: [],
    });
    expect((await store.load(other)).time).toHaveLength(0);
  });

  it("forgets everything on close", async () => {
    const store = createMemoryAnnotationStore();
    await store.save(KEY, {
      time: [createTimeAnnotation({ onsetS: 1, durationS: 0 }, AT)],
      channels: [],
    });
    store.close();
    expect((await store.load(KEY)).time).toHaveLength(0);
  });
});

describe("openAnnotationStore", () => {
  /**
   * Node has no IndexedDB, so this is the real fallback path rather than a
   * simulated one: `globalThis.indexedDB` is genuinely undefined here, which
   * is exactly the private-window / embedded-webview case the guard exists
   * for. The store still has to work.
   */
  it("degrades to memory when there is no IndexedDB", async () => {
    const store = await openAnnotationStore();
    expect(store.persistent).toBe(false);
    await store.save(KEY, {
      time: [createTimeAnnotation({ onsetS: 4, durationS: 2 }, AT)],
      channels: [],
    });
    expect((await store.load(KEY)).time).toHaveLength(1);
    store.close();
  });

  it("degrades to memory when explicitly given no factory", async () => {
    const store = await openAnnotationStore(null);
    expect(store.persistent).toBe(false);
  });

  it("never rejects, so a mount cannot be taken down by storage", async () => {
    await expect(openAnnotationStore(undefined)).resolves.toBeDefined();
  });
});
