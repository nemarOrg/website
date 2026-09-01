import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  createMemoryAnnotationStore,
  openAnnotationStore,
  recordingKeyString,
  reviveAnnotationSet,
} from "./annotation-store";
import { shouldWarnBeforeUnload } from "./annotation-ui";
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

/**
 * The persistent path, against a real IndexedDB implementation.
 *
 * `fake-indexeddb` is a platform shim, not a mock of anything this repo owns:
 * it is the actual W3C IndexedDB algorithms (upgrade transactions, structured
 * clone, request queueing) running under Node, the same way `jsdom` is a real
 * DOM. Nothing in `annotation-store.ts` is stubbed — these drive the genuine
 * open-and-upgrade, the genuine `put`/`get`, and a genuine write failure.
 *
 * A fresh `IDBFactory` per test keeps them independent: the shim keeps its
 * databases inside the factory instance rather than in a global.
 */
describe("openAnnotationStore against a real IndexedDB", () => {
  const setOf = (onsetS: number) => ({
    time: [
      createTimeAnnotation({ onsetS, durationS: 1.5, hedTags: ["Property/Data-property"] }, AT),
    ],
    channels: [createChannelAnnotation({ channel: "Cz", status: "bad" as const }, AT)],
  });

  it("opens, creating its object store on first use", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    expect(store.persistent).toBe(true);
    // An empty database reads back as an empty set rather than throwing.
    expect(await store.load(KEY)).toEqual({ time: [], channels: [] });
    store.close();
  });

  it("round-trips a set through storage, not just through memory", async () => {
    const factory = new IDBFactory();
    const first = await openAnnotationStore(factory);
    await first.save(KEY, setOf(3));
    first.close();

    // A second connection shares nothing with the first but the database on
    // disk, so what comes back has genuinely been through IndexedDB.
    const second = await openAnnotationStore(factory);
    const loaded = await second.load(KEY);
    expect(loaded.time).toHaveLength(1);
    expect(loaded.time[0].onsetS).toBe(3);
    expect(loaded.time[0].hedTags).toEqual(["Property/Data-property"]);
    expect(loaded.channels.map((c) => c.channel)).toEqual(["Cz"]);
    second.close();
  });

  it("keeps two versions of one recording apart in the same database", async () => {
    const factory = new IDBFactory();
    const store = await openAnnotationStore(factory);
    await store.save(KEY, setOf(3));
    await store.save({ ...KEY, version: "2.0.0" }, setOf(9));
    expect((await store.load(KEY)).time[0].onsetS).toBe(3);
    expect((await store.load({ ...KEY, version: "2.0.0" })).time[0].onsetS).toBe(9);
    store.close();
  });

  it("stops claiming persistence once a write fails, and still serves reads", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    await store.save(KEY, setOf(3));
    expect(store.persistent).toBe(true);

    // A dead connection is the real failure this degrades for: the browser can
    // drop one under storage pressure, and every later transaction then throws.
    store.close();
    await store.save(KEY, setOf(7));
    expect(store.persistent).toBe(false);

    // The point of degrading rather than throwing: what the annotator has on
    // screen is still readable afterwards.
    expect((await store.load(KEY)).time[0].onsetS).toBe(7);
  });

  it("pushes the degrade to a subscriber, so the UI does not have to poll", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    const seen: boolean[] = [];
    store.onPersistenceChange((persistent) => seen.push(persistent));
    await store.save(KEY, setOf(3));
    expect(seen).toEqual([]); // a successful write announces nothing

    store.close();
    await store.save(KEY, setOf(7));
    expect(seen).toEqual([false]);

    // Only ever once: the store degrades, it does not oscillate.
    await store.save(KEY, setOf(9));
    expect(seen).toEqual([false]);
  });

  it("flips shouldWarnBeforeUnload's answer for a signed-in annotator", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    const warns = () =>
      shouldWarnBeforeUnload({
        hasWork: true,
        signedIn: true,
        storePersistent: store.persistent,
      });
    // Signed in and persisting: the work is safe, so no confirm.
    expect(warns()).toBe(false);

    let notified = false;
    store.onPersistenceChange(() => {
      notified = true;
    });
    store.close();
    await store.save(KEY, setOf(7));

    expect(notified).toBe(true);
    expect(warns()).toBe(true);
  });

  it("announces a degrade on load(), before anything has been saved", async () => {
    // The realistic first contact: the annotation layer mounts, subscribes and
    // LOADS. If the connection is already unusable, the failure surfaces there
    // with no prior save() to have caught it -- and that is exactly the visit
    // where the annotator would otherwise be told their marks are safe.
    const store = await openAnnotationStore(new IDBFactory());
    const seen: boolean[] = [];
    store.onPersistenceChange((persistent) => seen.push(persistent));

    store.close();
    const loaded = await store.load(KEY);

    expect(seen).toEqual([false]);
    expect(store.persistent).toBe(false);
    // Degraded, not broken: the read still answers, out of memory.
    expect(loaded).toEqual({ time: [], channels: [] });
  });

  it("tells a late subscriber it has already degraded", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    store.close();
    await store.save(KEY, setOf(7));
    expect(store.persistent).toBe(false);

    const seen: boolean[] = [];
    store.onPersistenceChange((persistent) => seen.push(persistent));
    expect(seen).toEqual([false]);
  });

  it("keeps degrading even when a listener throws", async () => {
    const store = await openAnnotationStore(new IDBFactory());
    const seen: boolean[] = [];
    store.onPersistenceChange(() => {
      throw new Error("listener blew up");
    });
    store.onPersistenceChange((persistent) => seen.push(persistent));
    store.close();
    await store.save(KEY, setOf(7));
    expect(store.persistent).toBe(false);
    expect(seen).toEqual([false]);
  });
});
