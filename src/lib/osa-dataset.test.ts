import { afterEach, describe, expect, it, vi } from "vitest";
import on008083V1 from "../../test/fixtures/zarr/on008083-index-v1.json";
import v3Sample from "../../test/fixtures/zarr/v3-sample-index.json";
import { OSA_DATASET_WINDOW_PROPERTY, announceOsaDataset, osaDatasetFacts } from "./osa-dataset";
import { type ZarrIndex, parseZarrIndex } from "./zarr-index";

/**
 * A real, hand-built global object -- assigned to `globalThis.window`, not a jsdom/happy-dom
 * instance (neither is a dependency here) and not a mock replacing `announceOsaDataset` itself.
 * `announceOsaDataset` reads/writes the bare `window` identifier the way a browser script would;
 * under Node, an unqualified `window` reference resolves through the global object the same way
 * it would resolve through a browsing context's global, so assigning `globalThis.window` here is
 * enough to exercise the real function against a real (if minimal) `window`.
 */
function installFakeWindow(osaChatWidget?: Record<string, unknown>): Record<string, unknown> {
  const win: Record<string, unknown> = {};
  if (osaChatWidget) win.OSAChatWidget = osaChatWidget;
  (globalThis as unknown as { window: Record<string, unknown> }).window = win;
  return win;
}

describe("announceOsaDataset", () => {
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup of a global only this suite installs.
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("is a no-op when there is no window (not running in a browser)", () => {
    expect(() => announceOsaDataset({ id: "nm000103" })).not.toThrow();
  });

  it("records a valid {id} value on window when OSAChatWidget is absent", () => {
    const win = installFakeWindow();
    announceOsaDataset({ id: "nm000103" });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103" });
  });

  it("records {id, zarr} and calls a real setDataset when the widget has one", () => {
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    announceOsaDataset({ id: "nm000103", zarr: true });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103", zarr: true });
    expect(calls).toEqual([{ id: "nm000103", zarr: true }]);
  });

  it("does not call setDataset when OSAChatWidget exists but has none (today's pinned widget)", () => {
    const win = installFakeWindow({ someOtherMethod: () => {} });
    expect(() => announceOsaDataset({ id: "nm000103" })).not.toThrow();
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103" });
  });

  it("does not call setDataset when OSAChatWidget.setDataset is not a function", () => {
    const win = installFakeWindow({ setDataset: "not-a-function" });
    announceOsaDataset({ id: "nm000103" });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103" });
  });

  it("records null and forwards it to setDataset", () => {
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    announceOsaDataset(null);
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toBeNull();
    expect(calls).toEqual([null]);
  });

  it("re-records on every call, most recent value wins", () => {
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    announceOsaDataset({ id: "nm000103" });
    announceOsaDataset({ id: "nm000103", zarr: false });
    announceOsaDataset({ id: "nm000103", zarr: true });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103", zarr: true });
    expect(calls).toEqual([
      { id: "nm000103" },
      { id: "nm000103", zarr: false },
      { id: "nm000103", zarr: true },
    ]);
  });

  // Mutation check for the id pattern (`^[A-Za-z0-9._-]{1,64}$`): each of these breaks one
  // specific requirement. If the guard were loosened or removed, one of these would flip from
  // "ignored" to "recorded".
  it("ignores an invalid shape and does not touch window", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    const bad = [
      { id: "" }, // too short
      { id: "a".repeat(65) }, // too long
      { id: "nm 000103" }, // space, not in the allowed character class
      { id: "nm000103/../etc" }, // slash
      { id: 42 }, // not a string
      { id: "nm000103", zarr: "true" }, // zarr not a boolean
      { zarr: true }, // missing id
      "nm000103", // not an object at all
      42,
      undefined,
      ["nm000103"],
    ];
    for (const value of bad) {
      announceOsaDataset(value);
    }
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("accepts every character the id pattern allows", () => {
    const win = installFakeWindow();
    announceOsaDataset({ id: "nm000103" });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103" });
    announceOsaDataset({ id: "xx.099900-fixture_1" });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "xx.099900-fixture_1" });
  });

  it("logs a console.warn naming the reason when a value is dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFakeWindow();
    announceOsaDataset({ id: "not a valid id!!" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[osa-dataset]");
  });

  it("does not throw, and still records the value, when the widget's setDataset throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win = installFakeWindow({
      setDataset: () => {
        throw new Error("widget internals exploded");
      },
    });
    expect(() => announceOsaDataset({ id: "nm000103" })).not.toThrow();
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual({ id: "nm000103" });
    expect(warn).toHaveBeenCalled();
  });
});

describe("announceOsaDataset: subject and task (OSA #477)", () => {
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup of a global only this suite installs.
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("records and forwards subject and task with the id", () => {
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    const value = { id: "nm000132", zarr: true, subject: "001", task: "N170" };
    announceOsaDataset(value);
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual(value);
    expect(calls).toEqual([value]);
  });

  it("drops a subject or task that is not a plain BIDS label alone, and announces the rest", () => {
    const calls: unknown[] = [];
    const win = installFakeWindow({ setDataset: (v: unknown) => calls.push(v) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { id: "nm000132", zarr: true, subject: "sub-001", task: "N170" },
        { id: "nm000132", zarr: true, task: "N170" },
      ],
      [
        { id: "nm000132", zarr: true, task: "task-N170" },
        { id: "nm000132", zarr: true },
      ],
      [
        { id: "nm000132", zarr: true, task: "N170 faces" },
        { id: "nm000132", zarr: true },
      ],
      [
        { id: "nm000132", zarr: true, subject: "" },
        { id: "nm000132", zarr: true },
      ],
      [
        { id: "nm000132", zarr: true, subject: 1 },
        { id: "nm000132", zarr: true },
      ],
    ];
    for (const [announced, expected] of cases) {
      announceOsaDataset(announced);
      expect(win[OSA_DATASET_WINDOW_PROPERTY]).toEqual(expected);
      expect(calls.at(-1)).toEqual(expected);
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
    expect(String(warn.mock.calls[0][0])).toContain("dropping an invalid subject label");
  });

  it("still refuses the whole value for a bad id or zarr, even with good labels", () => {
    const win = installFakeWindow({ setDataset: () => {} });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    announceOsaDataset({ id: "nm 000132", zarr: true, subject: "001" });
    announceOsaDataset({ id: "nm000132", zarr: "yes", subject: "001" });
    expect(win[OSA_DATASET_WINDOW_PROPERTY]).toBeUndefined();
  });
});

describe("osaDatasetFacts", () => {
  const index = (raw: unknown): ZarrIndex => {
    const parsed = parseZarrIndex(raw);
    if (!parsed) throw new Error("fixture did not parse");
    return parsed;
  };
  // The real on008083 index (format 1), with its first recording's path replaced, so the
  // cases below keep the real shape and change only the file name under test.
  const withFirstPath = (path: string): ZarrIndex => {
    const raw = structuredClone(on008083V1) as { stores: { path: string }[] };
    raw.stores[0].path = path;
    return index(raw);
  };

  it("reads the first recording's subject and task from a real index", () => {
    expect(osaDatasetFacts(index(on008083V1))).toEqual({ subject: "003", task: "HierPrior" });
    expect(osaDatasetFacts(index(v3Sample))).toEqual({ subject: "01", task: "rest" });
  });

  it("names nothing without an index or a recording", () => {
    expect(osaDatasetFacts(null)).toEqual({});
    // The real index with every recording failed: it parses, and has no store to name.
    const empty = structuredClone(on008083V1) as { stores: unknown[]; store_count: number };
    empty.stores = [];
    empty.store_count = 0;
    expect(osaDatasetFacts(index(empty))).toEqual({});
  });

  it("leaves out an entity the file name does not carry, or one that is not a plain label", () => {
    expect(osaDatasetFacts(withFirstPath("sub-001/eeg/sub-001_eeg.set"))).toEqual({
      subject: "001",
    });
    expect(osaDatasetFacts(withFirstPath("sub-00-1/eeg/sub-00-1_task-N170_eeg.set"))).toEqual({
      task: "N170",
    });
    // Only the file name counts: a directory named like an entity is not the recording's.
    expect(osaDatasetFacts(withFirstPath("task-x/sub-001_eeg.set"))).toEqual({ subject: "001" });
    // An entity must start the name or follow an underscore: "mysub-2" is not a subject.
    expect(osaDatasetFacts(withFirstPath("sub-001/eeg/mysub-2_task-N170_eeg.set"))).toEqual({
      task: "N170",
    });
  });
});
