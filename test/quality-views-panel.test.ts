/**
 * The per-recording quality panel's decisions (`src/lib/quality-views/panel-model.ts`) and its idle
 * preload (`preload.ts`), on the record captured from the real nemar-cli route
 * (`test/fixtures/quality-views/route/`): which tab draws which view, the deep link's round trip,
 * the recordings the picker lists, the preload's scope and cap, and the preload's triggers
 * (connection, cancellation, the viewer, nothing shown on failure).
 *
 * The panel's drawing in a real browser is `e2e/quality-panel.spec.ts`. The record and its files
 * reach the code as `Response` objects built from the captured answers (HTTP fixtures).
 */

import { afterEach, describe, expect, it } from "vitest";
import { heldRecord } from "../src/lib/quality-views/panel-bridge";
import {
  TABS,
  formatQualityHash,
  parseQualityHash,
  qualityPermalink,
  qualityRecordings,
  readTurbo,
  tabOf,
  viewsByTab,
  writeTurbo,
} from "../src/lib/quality-views/panel-model";
import { preloadInput, preloadPlan, startIdlePreload } from "../src/lib/quality-views/preload";
import { forgetPreloads, preloadedSource } from "../src/lib/quality-views/prepare-ahead";
import { fileUrl } from "../src/lib/quality-views/quality-api";
import { type QualityRecord, readRecordAnswer } from "../src/lib/quality-views/record";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const ROUTE = "test/fixtures/quality-views/route";
const json = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const captured = json(`${ROUTE}/record.json`);
const files = json(`${ROUTE}/files.json`) as Record<string, { location: string }>;
const provenance = json(`${ROUTE}/provenance.json`);
const BASE = "https://data.example.invalid";
const TARGET = { base: BASE, datasetId: provenance.dataset_id, recipe: provenance.recipe };
const RECORDING = provenance.recording as string;
const record = (await readRecordAnswer(new TextEncoder().encode(captured.body), null, {
  ...TARGET,
  recording: RECORDING,
})) as QualityRecord;
const bytesOf = (sha: string) => new Uint8Array(fs.readFileSync(repoPath(`${ROUTE}/files/${sha}`)));

/** A fetch answering the route's captured answers by path, and recording what was asked. */
function route(asked: string[]) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    if (url === `${BASE}${captured.path}`)
      return new Response(captured.body, { headers: captured.headers });
    const sha = Object.keys(files).find((s) => url.includes(`/${s}/`));
    if (sha) return new Response(bytesOf(sha));
    return new Response(JSON.stringify({ error: "quality_not_found" }), { status: 404 });
  };
}

afterEach(() => forgetPreloads());

describe("tabs", () => {
  it("draws each kind under its tab, and every other kind under Other", () => {
    expect(TABS.map((t) => t.id)).toEqual(["spectrum", "components", "signal", "other"]);
    const byTab = viewsByTab(record.views as never);
    expect(byTab.get("spectrum")).toEqual(["spectrum"]);
    expect(byTab.get("components")).toEqual(["icmaps", "icclasses"]);
    expect(byTab.get("signal")).toEqual(["midsegment"]);
    // Activations are phase W7's; until then the view is shown under Other, never left out.
    expect(byTab.get("other")).toEqual(["icactivity"]);
    expect(tabOf("example.unknown-kind")).toBe("other");
  });
});

describe("deep links", () => {
  it("round-trips a recording and a view, each segment encoded", () => {
    for (const link of [
      { recording: RECORDING, key: "icmaps" },
      { recording: RECORDING, key: null },
      { recording: "sub-01/ses-a b/eeg/sub-01_ses-a b_task-rest_eeg.edf", key: "spectrum" },
      { recording: null, key: null },
    ]) {
      const hash = formatQualityHash(link);
      expect(parseQualityHash(hash), hash).toEqual(link);
    }
    expect(formatQualityHash({ recording: "sub-01/eeg/sub-01 x_eeg.edf", key: "icmaps" })).toBe(
      "#quality/sub-01/eeg/sub-01%20x_eeg.edf/icmaps",
    );
  });

  it("is not the panel's for another hash, a path that names no recording, or bad escapes", () => {
    for (const hash of [
      "",
      "#",
      "#qualityx",
      "#quality/../x_eeg.edf/icmaps",
      "#quality/%E0%A4%A",
      "#quality/sub-01/meg/x_meg.fif",
    ]) {
      expect(parseQualityHash(hash), hash).toBeNull();
    }
  });

  it("builds the export permalink of the live-views plan's C14", () => {
    expect(
      qualityPermalink("https://nemar.org", "nm000001", "v1.0.0", {
        recording: RECORDING,
        key: "icmaps",
      }),
    ).toBe(
      `https://nemar.org/dataset/nm000001?v=v1.0.0${formatQualityHash({ recording: RECORDING, key: "icmaps" })}`,
    );
  });
});

describe("the picker", () => {
  it("lists the viewer's recordings a quality record can name, in the viewer's order", () => {
    const list = [
      { path: "sub-02/eeg/sub-02_task-rest_eeg.edf", name: "b" },
      { path: "sub-01/meg/sub-01_task-rest_meg.fif", name: "meg" },
      { path: "sub-01/eeg/sub-01_task-rest_eeg.edf", name: "a" },
    ];
    expect(qualityRecordings(list).map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("the idle preload's scope", () => {
  const url = (f: { sha256: string }) => fileUrl(BASE, record, f as never);
  it("is the layout and the files of the Spectrum and Components tabs' views, each once, capped at their bytes", () => {
    const plan = preloadPlan(record, url);
    const declared = (key: string) =>
      record.views.find((v) => v.key === key)!.data as {
        location: string;
        sha256: string;
        size: number;
      }[];
    expect(plan.layout?.file.location).toMatch(/_chanlocs\.tsv$/);
    const expected = [
      ...declared("spectrum"),
      ...declared("icmaps"),
      ...declared("icclasses"),
    ].filter(
      (f, i, all) =>
        f.sha256 !== plan.layout!.file.sha256 && all.findIndex((g) => g.sha256 === f.sha256) === i,
    );
    expect(plan.files.map((f) => f.location)).toEqual(expected.map((f) => f.location));
    // Nothing of the Signal or Other tabs: the activations' unmixing, the floor's tables.
    expect(plan.files.some((f) => /_(unmixing|channels|badsegments)\.tsv$/.test(f.location))).toBe(
      false,
    );
    expect(plan.maxBytes).toBe(plan.files.reduce((sum, f) => sum + f.size, plan.layout!.file.size));
    for (const f of plan.files) expect(f.url).toBe(url(f));
    // prepareAhead is asked for exactly this: the cap follows the scope.
    const signal = new AbortController().signal;
    expect(preloadInput(plan, signal)).toEqual({
      warm: true,
      layout: plan.layout,
      files: plan.files,
      maxBytes: plan.maxBytes,
      signal,
    });
  });

  it("leaves out the Signal and Other tabs' data files", () => {
    const table = {
      key: "extra",
      kind: "nemar.table",
      kind_version: 1,
      caption: "A table under Other.",
      source: { recipe: { name: "nemar-ica", version: "1" } },
      data: [
        {
          role: "table",
          location: "x/y_desc-nemarica_extra.tsv",
          format: "tsv",
          size: 9,
          sha256: "f".repeat(64),
        },
      ],
    };
    const plan = preloadPlan({ ...record, views: [...record.views, table] }, url);
    expect(plan.files.some((f) => f.sha256 === "f".repeat(64))).toBe(false);
  });
});

describe("the idle preload", () => {
  const recordings = async () => [{ path: RECORDING, name: "x" }];
  const ready = {
    loaded: Promise.resolve(),
    idle: (run: () => void) => run(),
    viewerOpen: () => false,
  };

  it("warms the worker, prepares the layout's geometry and fetches the first windows' files only", async () => {
    const asked: string[] = [];
    const client = new SensorFieldClient(inThreadWorker);
    const run = startIdlePreload(TARGET, {
      ...ready,
      recordings,
      fetch: route(asked),
      client,
      onLeave: () => {},
    });
    const result = await run.done;
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran" || !result.outcome) throw new Error("no preload");
    expect(result.outcome.warm).toBe("started");
    expect(result.outcome.layout).toMatchObject({ kind: "prepared" });
    const plan = preloadPlan(record, (f) => fileUrl(BASE, record, f));
    expect([...result.outcome.files.values()]).toEqual(plan.files.map(() => "preloaded"));
    // The record once, the layout and the planned files once each: nothing else.
    expect(asked).toEqual([
      `${BASE}${captured.path}`,
      plan.layout!.file.url,
      ...plan.files.map((f) => f.url),
    ]);
    // The panel takes the preloaded record and files without asking again.
    expect(await heldRecord(RECORDING)).toMatchObject({ kind: "ok" });
    const none = async () => {
      throw new Error("asked again");
    };
    const source = preloadedSource(none);
    for (const f of plan.files) expect(await source(f)).toEqual(bytesOf(f.sha256));
    client.terminate();
  });

  it("does nothing on a data-saving or 2G-class connection", async () => {
    const asked: string[] = [];
    for (const connection of [
      { saveData: true },
      { effectiveType: "2g" },
      { effectiveType: "slow-2g" },
    ]) {
      const run = startIdlePreload(TARGET, {
        ...ready,
        recordings,
        fetch: route(asked),
        navigator: { connection },
        onLeave: () => {},
      });
      expect(await run.done).toEqual({ kind: "skipped", reason: "connection" });
    }
    expect(asked).toEqual([]);
  });

  it("waits for the page's load and the viewer's list, and skips a page whose viewer is open", async () => {
    const asked: string[] = [];
    const run = startIdlePreload(TARGET, {
      ...ready,
      viewerOpen: () => true,
      recordings,
      fetch: route(asked),
      onLeave: () => {},
    });
    expect(await run.done).toEqual({ kind: "skipped", reason: "viewer open" });
    let loaded: () => void = () => {};
    const waiting = startIdlePreload(TARGET, {
      ...ready,
      loaded: new Promise<void>((resolve) => {
        loaded = resolve;
      }),
      recordings,
      fetch: route(asked),
      onLeave: () => {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual([]);
    waiting.cancel();
    loaded();
    expect(await waiting.done).toEqual({ kind: "skipped", reason: "cancelled" });
    expect(asked).toEqual([]);
  });

  it("stops when the visitor leaves, forgets what it fetched, and shows nothing", async () => {
    const asked: string[] = [];
    let leave: () => void = () => {};
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = route(asked);
    const run = startIdlePreload(TARGET, {
      ...ready,
      recordings,
      onLeave: (go) => {
        leave = go;
      },
      fetch: async (input, init) => {
        if (String(input).includes("/file/")) await gate;
        if ((init as RequestInit | undefined)?.signal?.aborted)
          throw new DOMException("aborted", "AbortError");
        return slow(input);
      },
      client: new SensorFieldClient(inThreadWorker),
    });
    await new Promise((r) => setTimeout(r, 20));
    leave();
    release();
    const result = await run.done;
    // The layout's fetch was under way: it is cancelled, and no file is kept.
    if (result.kind !== "ran" || !result.outcome) throw new Error(JSON.stringify(result));
    expect(result.outcome.layout).toMatchObject({ kind: "skipped" });
    expect([...result.outcome.files.values()].every((f) => f !== "preloaded")).toBe(true);
    expect(heldRecord(RECORDING)).toBeNull();
    const none = async () => null;
    for (const sha of Object.keys(files)) {
      expect(await preloadedSource(none)({ location: "x", size: 1, sha256: sha })).toBeNull();
    }
  });

  it("forgets what it fetched when the visitor leaves after it finished", async () => {
    let leave: () => void = () => {};
    const run = startIdlePreload(TARGET, {
      ...ready,
      recordings,
      fetch: route([]),
      client: new SensorFieldClient(inThreadWorker),
      onLeave: (go) => {
        leave = go;
      },
    });
    const result = await run.done;
    if (result.kind !== "ran" || !result.outcome) throw new Error("no preload");
    const plan = preloadPlan(record, (f) => fileUrl(BASE, record, f));
    const none = async () => null;
    expect(await preloadedSource(none)(plan.files[0])).not.toBeNull();
    leave();
    expect(heldRecord(RECORDING)).toBeNull();
    for (const f of plan.files) expect(await preloadedSource(none)(f)).toBeNull();
  });

  it("leaves nothing behind when the route has no quality or fails", async () => {
    for (const answer of [
      new Response(JSON.stringify({ error: "quality_not_found" }), { status: 404 }),
      new Response("oops", { status: 500 }),
    ]) {
      const run = startIdlePreload(TARGET, {
        ...ready,
        recordings,
        fetch: async () => answer.clone(),
        onLeave: () => {},
      });
      expect(await run.done).toEqual({ kind: "ran", recording: RECORDING, outcome: null });
    }
    const offline = startIdlePreload(TARGET, {
      ...ready,
      recordings: async () => {
        throw new Error("no list");
      },
      onLeave: () => {},
    });
    expect(await offline.done).toEqual({ kind: "skipped", reason: "failed" });
  });

  it("has no recording to preload when the viewer's list has none a record can name", async () => {
    const run = startIdlePreload(TARGET, {
      ...ready,
      recordings: async () => [{ path: "sub-01/meg/sub-01_meg.fif", name: "x" }],
      onLeave: () => {},
    });
    expect(await run.done).toEqual({ kind: "skipped", reason: "no recording" });
  });
});

describe("the Turbo toggle", () => {
  it("is remembered per viewer, and blocked storage only forgets it", () => {
    const store = new Map<string, string>();
    const storage = () =>
      ({
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }) as unknown as Storage;
    expect(readTurbo(storage)).toBe(false);
    writeTurbo(storage, true);
    expect(readTurbo(storage)).toBe(true);
    const blocked = () => {
      throw new Error("blocked");
    };
    expect(readTurbo(blocked)).toBe(false);
    expect(() => writeTurbo(blocked, true)).not.toThrow();
  });
});
