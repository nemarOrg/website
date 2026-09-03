import { describe, expect, it, vi } from "vitest";
import {
  aggregateOverview,
  chooseWindowLevel,
  dedupingFetch,
  openRecording,
  parseChannels,
  predictedViewLevelCount,
  readLevel0,
  readOverview,
  readWindow,
  retryingFetch,
  windowDataBytes,
} from "./store";

describe("parseChannels", () => {
  it("falls back scale to 1 when scale is null", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: null }]);
    expect(ch.scale).toBe(1);
  });

  it("falls back scale to 1 when scale is a string (e.g. '0.5e-6')", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: "0.5e-6" }]);
    expect(ch.scale).toBe(1);
  });

  it("uses scale when it is a finite number", () => {
    const [ch] = parseChannels([{ label: "Fz", unit: "uV", scale: 0.5e-6 }]);
    expect(ch.scale).toBeCloseTo(0.5e-6, 15);
  });

  it("defaults unit to 'uV' and siFactor to 1e-6 when unit is missing", () => {
    const [ch] = parseChannels([{ label: "Cz" }]);
    expect(ch.unit).toBe("uV");
    expect(ch.siFactor).toBeCloseTo(1e-6, 12);
  });

  it("preserves row_index: 0 as 0 (not a falsy fallback)", () => {
    const [ch] = parseChannels([{ label: "Fp1", row_index: 0 }]);
    expect(ch.rowIndex).toBe(0);
  });

  it("usable_for_inference: false -> false", () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: false }]);
    expect(ch.usableForInference).toBe(false);
  });

  it("usable_for_inference: missing -> true", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.usableForInference).toBe(true);
  });

  it("usable_for_inference: 0 -> true (only explicit false disables)", () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: 0 }]);
    expect(ch.usableForInference).toBe(true);
  });

  it('usable_for_inference: "false" (string) -> true', () => {
    const [ch] = parseChannels([{ label: "x", usable_for_inference: "false" }]);
    expect(ch.usableForInference).toBe(true);
  });

  it("defaults channel_type to 'OTHER'", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.channelType).toBe("OTHER");
  });

  it("defaults modality to 'MISC'", () => {
    const [ch] = parseChannels([{ label: "x" }]);
    expect(ch.modality).toBe("MISC");
  });

  it("defaults label to ch<index>", () => {
    const [ch] = parseChannels([{}]);
    expect(ch.label).toBe("ch0");
  });

  it("returns empty array for non-array input", () => {
    expect(parseChannels(null)).toHaveLength(0);
    expect(parseChannels("bad")).toHaveLength(0);
    expect(parseChannels({})).toHaveLength(0);
  });
});

describe("aggregateOverview", () => {
  const identity = { scale: 1, offset: 0, siFactor: 1 };

  it("returns max |max-min| across channels for each column", () => {
    // 2 channels, 2 time columns: layout [2, nCh=2, nTime=2]
    // data[row=0,ch=0,t=0]=10, [row=0,ch=0,t=1]=20 (min row)
    // data[row=1,ch=0,t=0]=30, [row=1,ch=0,t=1]=40 (max row)
    // data[row=0,ch=1,t=0]=0,  [row=0,ch=1,t=1]=5
    // data[row=1,ch=1,t=0]=5,  [row=1,ch=1,t=1]=5
    // ch0 range t=0: |30-10|=20, t=1: |40-20|=20
    // ch1 range t=0: |5-0|=5,   t=1: |5-5|=0
    // max per col: [20, 20]
    const nCh = 2;
    const nTime = 2;
    // flat index: (row * nCh + ch) * nTime + t
    const data = new Int16Array([
      10,
      20, // row=0, ch=0
      0,
      5, // row=0, ch=1
      30,
      40, // row=1, ch=0
      5,
      5, // row=1, ch=1
    ]);
    const out = aggregateOverview(data, nCh, nTime, [identity, identity]);
    expect(out[0]).toBeCloseTo(20, 6);
    expect(out[1]).toBeCloseTo(20, 6);
  });

  it("applies scale and siFactor correctly", () => {
    // 1 channel, 1 time col: min=0, max=100, scale=0.5e-6, offset=0, siFactor=1
    const data = new Int16Array([0, 100]); // [min-row, max-row]
    const ch = { scale: 0.5e-6, offset: 0, siFactor: 1 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(50e-6, 9);
  });

  it("applies a non-unity siFactor (uV stored -> SI volts out)", () => {
    // 100 uV stored raw (scale=1) must come out as 100e-6 V via siFactor=1e-6.
    const data = new Int16Array([0, 100]);
    const ch = { scale: 1, offset: 0, siFactor: 1e-6 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(100e-6, 9);
  });

  it("cancels a non-zero offset in the min/max range", () => {
    // offset must apply to both rows so it cancels: (100+1000)-(0+1000) = 100.
    const data = new Int16Array([0, 100]);
    const ch = { scale: 1, offset: 1000, siFactor: 1 };
    const out = aggregateOverview(data, 1, 1, [ch]);
    expect(out[0]).toBeCloseTo(100, 6);
  });

  it("returns zeros when min equals max (flat signal)", () => {
    const data = new Int16Array([5, 5]); // min=max
    const out = aggregateOverview(data, 1, 1, [identity]);
    expect(out[0]).toBe(0);
  });

  it("returns empty array when nTime=0", () => {
    const out = aggregateOverview(new Int16Array([]), 0, 0, []);
    expect(out).toHaveLength(0);
  });
});

/** Swaps the global fetch for the duration of one test, restoring it after --
 *  the HTTP layer is the transport boundary being exercised here (retry
 *  logic against real-shape Response objects), not business logic, matching
 *  the repo's fixture policy for testing retry/error paths. */
function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

describe("retryingFetch", () => {
  it("does not retry a transient 5xx once the request's own signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("https://zarr.nemar.org/x", { signal: controller.signal });
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return new Response("gateway timeout", { status: 503 });
      },
      async () => {
        const handler = retryingFetch(6, 250);
        await expect(handler(request)).rejects.toThrow();
        expect(calls).toBe(1); // no retry attempts after the abort
      },
    );
  });

  it("propagates an AbortError immediately instead of retrying it as transient", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("https://zarr.nemar.org/x", { signal: controller.signal });
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        throw new DOMException("The operation was aborted.", "AbortError");
      },
      async () => {
        const handler = retryingFetch(6, 250);
        await expect(handler(request)).rejects.toThrow();
        expect(calls).toBe(1); // no retry: an aborted fetch is not a transient failure
      },
    );
  });

  it("still retries a transient 5xx to a successful response when not aborted", async () => {
    const request = new Request("https://zarr.nemar.org/x");
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return calls < 2
          ? new Response("gateway timeout", { status: 503 })
          : new Response("ok", { status: 200 });
      },
      async () => {
        const handler = retryingFetch(6, 1); // tiny baseMs: the one retry stays fast
        const res = await handler(request);
        expect(res.status).toBe(200);
        expect(calls).toBe(2); // confirms the abort check didn't disable retrying altogether
      },
    );
  });
});

describe("predictedViewLevelCount", () => {
  it("matches the real 172s/250Hz store on zarr.nemar.org (4 levels, coarsest 168)", () => {
    expect(predictedViewLevelCount(43096)).toBe(4);
  });

  it("matches the real 2430s/250Hz store on zarr.nemar.org (6 levels, coarsest 148)", () => {
    expect(predictedViewLevelCount(607585)).toBe(6);
  });

  it("predicts a single level for a recording under the producer's floor", () => {
    expect(predictedViewLevelCount(100)).toBe(1);
    expect(predictedViewLevelCount(999)).toBe(1); // 999/4 < 250: nothing past view/1
    expect(predictedViewLevelCount(1000)).toBe(2); // 1000/4 = 250: view/2 exists
  });

  it("falls back to the probe maximum for missing/garbage n_samples", () => {
    expect(predictedViewLevelCount(Number.NaN)).toBe(12);
    expect(predictedViewLevelCount(0)).toBe(12);
    expect(predictedViewLevelCount(-5)).toBe(12);
  });

  it("clamps an absurdly long recording to the probe maximum", () => {
    expect(predictedViewLevelCount(Number.MAX_SAFE_INTEGER)).toBe(12);
  });
});

describe("dedupingFetch", () => {
  const bodyOf = (res: Response) => res.text();

  it("shares one inner fetch across concurrent GETs of the same URL+Range", async () => {
    let calls = 0;
    const handler = dedupingFetch(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response("chunk-bytes", { status: 206 });
    });
    const req = () =>
      new Request("https://zarr.nemar.org/x/0/c/0/0", { headers: { Range: "bytes=0-99" } });
    const [a, b] = await Promise.all([handler(req()), handler(req())]);
    expect(calls).toBe(1);
    // Each caller must get an independently consumable body (clones).
    expect(await bodyOf(a)).toBe("chunk-bytes");
    expect(await bodyOf(b)).toBe("chunk-bytes");
  });

  it("does not merge requests for different byte ranges of the same URL", async () => {
    let calls = 0;
    const handler = dedupingFetch(async () => {
      calls++;
      return new Response("ok");
    });
    await Promise.all([
      handler(new Request("https://zarr.nemar.org/x", { headers: { Range: "bytes=0-9" } })),
      handler(new Request("https://zarr.nemar.org/x", { headers: { Range: "bytes=10-19" } })),
    ]);
    expect(calls).toBe(2);
  });

  it("issues a fresh inner fetch once the shared request has settled", async () => {
    let calls = 0;
    const handler = dedupingFetch(async () => {
      calls++;
      return new Response("ok");
    });
    await handler(new Request("https://zarr.nemar.org/x"));
    await handler(new Request("https://zarr.nemar.org/x"));
    expect(calls).toBe(2); // in-flight dedup only; never a byte cache
  });

  it("keeps the shared fetch alive when only one of two subscribers aborts", async () => {
    let innerAborted = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = dedupingFetch(async (request) => {
      request.signal.addEventListener("abort", () => {
        innerAborted = true;
      });
      await gate;
      return new Response("survived");
    });
    const aborter = new AbortController();
    const p1 = handler(new Request("https://zarr.nemar.org/x", { signal: aborter.signal }));
    const p2 = handler(new Request("https://zarr.nemar.org/x"));
    aborter.abort();
    await expect(p1).rejects.toThrow();
    release();
    expect(await bodyOf(await p2)).toBe("survived");
    expect(innerAborted).toBe(false);
  });

  it("aborts the shared fetch once every subscriber has aborted", async () => {
    let innerAborted = false;
    const handler = dedupingFetch(async (request) => {
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          innerAborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const a1 = new AbortController();
    const a2 = new AbortController();
    const p1 = handler(new Request("https://zarr.nemar.org/x", { signal: a1.signal }));
    const p2 = handler(new Request("https://zarr.nemar.org/x", { signal: a2.signal }));
    a1.abort();
    await expect(p1).rejects.toThrow();
    expect(innerAborted).toBe(false); // one subscriber still waiting
    a2.abort();
    await expect(p2).rejects.toThrow();
    expect(innerAborted).toBe(true); // nobody left: the network request stops
  });

  it("a caller arriving after all prior subscribers aborted gets a fresh fetch", async () => {
    let calls = 0;
    const handler = dedupingFetch(async (request) => {
      calls++;
      if (calls === 1) {
        // First shared request: hang until aborted.
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      }
      return new Response("fresh");
    });
    const a1 = new AbortController();
    const p1 = handler(new Request("https://zarr.nemar.org/x", { signal: a1.signal }));
    a1.abort();
    await expect(p1).rejects.toThrow();
    // The dying entry may still be settling; a new caller must not join it.
    const res = await handler(new Request("https://zarr.nemar.org/x"));
    expect(await bodyOf(res)).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("propagates a rejection of the shared fetch to every subscriber", async () => {
    const handler = dedupingFetch(async () => {
      throw new Error("upstream exploded");
    });
    const p1 = handler(new Request("https://zarr.nemar.org/x"));
    const p2 = handler(new Request("https://zarr.nemar.org/x"));
    await expect(p1).rejects.toThrow("upstream exploded");
    await expect(p2).rejects.toThrow("upstream exploded");
  });

  it("rejects an already-aborted caller without touching the network", async () => {
    let calls = 0;
    const handler = dedupingFetch(async () => {
      calls++;
      return new Response("ok");
    });
    const aborter = new AbortController();
    aborter.abort();
    await expect(
      handler(new Request("https://zarr.nemar.org/x", { signal: aborter.signal })),
    ).rejects.toThrow();
    expect(calls).toBe(0); // rejected before any inner fetch started
    const res = await handler(new Request("https://zarr.nemar.org/x"));
    expect(await bodyOf(res)).toBe("ok");
    expect(calls).toBe(1);
  });

  it("issues a fresh inner fetch for a key whose previous request rejected", async () => {
    let calls = 0;
    const handler = dedupingFetch(async () => {
      calls++;
      if (calls === 1) throw new Error("first attempt fails");
      return new Response("recovered");
    });
    await expect(handler(new Request("https://zarr.nemar.org/x"))).rejects.toThrow(
      "first attempt fails",
    );
    // The failed entry must have left the in-flight map; the next caller for
    // the SAME key gets a fresh request, not the settled rejection.
    const res = await handler(new Request("https://zarr.nemar.org/x"));
    expect(await bodyOf(res)).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("shares one whole retry cycle between concurrent callers (dedup wraps retry)", async () => {
    // makeStore composes dedupingFetch(retryingFetch()): two concurrent callers
    // must share ONE retrying operation -- a 503 then its retry (2 inner
    // fetches total), not each caller running its own retry cycle (4).
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return calls === 1
          ? new Response("gateway timeout", { status: 503 })
          : new Response("ok", { status: 200 });
      },
      async () => {
        const handler = dedupingFetch(retryingFetch(6, 1));
        const req = () => new Request("https://zarr.nemar.org/x");
        const [a, b] = await Promise.all([handler(req()), handler(req())]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(calls).toBe(2);
      },
    );
  });
});

describe("windowDataBytes", () => {
  it("sums Float32Array byteLength across line channels", () => {
    const win = {
      level: 0,
      nCols: 4,
      channels: [
        { kind: "line" as const, line: new Float32Array(4) },
        { kind: "line" as const, line: new Float32Array(4) },
      ],
    };
    expect(windowDataBytes(win)).toBe(4 * 4 + 4 * 4); // 4 bytes/sample * 4 samples * 2 channels
  });

  it("sums min+max byteLength across band (view-level) channels", () => {
    const win = {
      level: 1,
      nCols: 3,
      channels: [{ kind: "band" as const, min: new Float32Array(3), max: new Float32Array(3) }],
    };
    expect(windowDataBytes(win)).toBe(3 * 4 * 2); // min + max, 4 bytes/sample
  });

  it("handles a mix of line and band channels", () => {
    const win = {
      level: 0,
      nCols: 5,
      channels: [
        { kind: "line" as const, line: new Float32Array(5) },
        { kind: "band" as const, min: new Float32Array(5), max: new Float32Array(5) },
      ],
    };
    expect(windowDataBytes(win)).toBe(5 * 4 + 5 * 4 * 2);
  });

  it("returns 0 for a window with no channels", () => {
    const win = { level: 0, nCols: 0, channels: [] };
    expect(windowDataBytes(win)).toBe(0);
  });
});

/** Minimal GroupHandle-shaped fixture: only the fields chooseWindowLevel
 *  reads (durationS, nSamples, rate, viewLevels). Cast rather than satisfying
 *  the full interface (channels, level0 zarr.Array, etc.) since those are
 *  never touched by this pure function. */
function fakeGroup(over: {
  durationS?: number;
  nSamples?: number;
  rate?: number;
  viewLevels?: Array<{ level: number; nTime: number }>;
}): Parameters<typeof chooseWindowLevel>[0] {
  return {
    durationS: 100,
    nSamples: 25000,
    rate: 250,
    viewLevels: [],
    ...over,
  } as unknown as Parameters<typeof chooseWindowLevel>[0];
}

describe("chooseWindowLevel", () => {
  it("picks level 0 for a narrow window well within the level-0 sample cap", () => {
    const g = fakeGroup({});
    expect(chooseWindowLevel(g, 0, 2, 800)).toBe(0); // 2s * 250Hz = 500 samples
  });

  it("falls back to the finest view level once natural selection prefers it", () => {
    const g = fakeGroup({
      durationS: 3600,
      nSamples: 3600 * 250,
      viewLevels: [{ level: 1, nTime: 36000 }],
    });
    // The whole (1-hour) recording is visible: the pyramid alone already
    // covers the requested pixel width, and the window is also far past the
    // level-0 sample cap either way.
    expect(chooseWindowLevel(g, 0, 3600, 800)).toBe(1);
  });

  it("forceLevel0 overrides a natural pyramid pick when the sample cap allows it", () => {
    const g = fakeGroup({
      durationS: 10,
      nSamples: 2500,
      viewLevels: [{ level: 1, nTime: 5000 }],
    });
    expect(chooseWindowLevel(g, 0, 10, 800, false)).toBe(1); // natural pick: the pyramid
    expect(chooseWindowLevel(g, 0, 10, 800, true)).toBe(0); // forced: still within the cap
  });

  it("matches readWindow's own LEVEL0_MAX_SAMPLES boundary (20000 samples)", () => {
    const g = fakeGroup({
      durationS: 200,
      nSamples: 200 * 250,
      viewLevels: [{ level: 1, nTime: 2000 }],
    });
    expect(chooseWindowLevel(g, 0, 80, 4000)).toBe(0); // 80s * 250Hz = 20000, at the cap
    expect(chooseWindowLevel(g, 0, 81, 4000)).toBe(1); // 81s * 250Hz = 20250, over the cap
  });

  it("returns level 0 when the group has no view pyramid at all", () => {
    const g = fakeGroup({ durationS: 5000, nSamples: 5000 * 250, viewLevels: [] });
    expect(chooseWindowLevel(g, 0, 5000, 800)).toBe(0);
  });
});

/**
 * A minimal but real-shape Zarr v3 store served from memory: valid zarr.json
 * documents that zarrita itself parses, plus 404s (and optionally one 403) for
 * everything else. This is the transport boundary, not mocked business logic --
 * the whole reader stack (makeStore's dedup+retry pipeline, openNode's
 * v3-pinned opens, probe batching) runs for real against it.
 */
function fakeZarrV3Store(opts: {
  /** attrs.n_samples on the channel group (drives probe-batch prediction). */
  nSamples: number;
  /** nTime per view level; index 0 = view/1. */
  viewLevels: number[];
  /** This view level responds 403 instead of metadata (expired-token shape). */
  failLevel?: number;
  /** When set, the group attrs declare this exact pyramid shape
   *  (biosigio 1.2.6+, website#276) instead of leaving discovery to probe
   *  for it. An empty array declares a zero-level pyramid. */
  declaredLevels?: number[];
  /** When set (and `declaredLevels` is not), declares the pyramid via the
   *  numeric `n_view_levels` count instead of the `view_levels` array --
   *  the sibling declaration shape `declaredViewLevels` also reads. 0
   *  declares a zero-level pyramid, same as an empty `declaredLevels`. */
  declaredCount?: number;
}) {
  const requests: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const group = (attributes: Record<string, unknown>) =>
    json({ zarr_format: 3, node_type: "group", attributes });
  const array = (shape: number[], chunk: number[]) =>
    json({
      zarr_format: 3,
      node_type: "array",
      shape,
      data_type: "int16",
      chunk_grid: { name: "regular", configuration: { chunk_shape: chunk } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      attributes: {},
    });
  const handler = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname.replace(/^\/store\//, "");
    requests.push(path);
    if (path === "zarr.json") return group({ format: "test", channel_groups: ["eeg"] });
    if (path === "eeg/zarr.json") {
      return group({
        rate: 250,
        n_samples: opts.nSamples,
        channels: [{ label: "Cz", unit: "uV", row_index: 0 }],
        ...(opts.declaredLevels !== undefined ? { view_levels: opts.declaredLevels } : {}),
        ...(opts.declaredLevels === undefined && opts.declaredCount !== undefined
          ? { n_view_levels: opts.declaredCount }
          : {}),
      });
    }
    if (path === "eeg/0/zarr.json") return array([1, opts.nSamples], [1, 1000]);
    const m = path.match(/^eeg\/view\/(\d+)\/zarr\.json$/);
    if (m) {
      const level = Number(m[1]);
      if (level === opts.failLevel) return new Response("forbidden", { status: 403 });
      const nTime = opts.viewLevels[level - 1];
      if (nTime !== undefined) return array([2, 1, nTime], [2, 1, 250]);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { handler, requests };
}

describe("view-level discovery against a fake v3 store", () => {
  const viewProbes = (requests: string[]) => requests.filter((p) => p.includes("/view/")).sort();

  it("exact prediction probes the predicted levels plus one follow-up confirm batch", async () => {
    // n_samples=8000 predicts 3 levels; the store has exactly 3.
    const { handler, requests } = fakeZarrV3Store({ nSamples: 8000, viewLevels: [2000, 500, 125] });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const g = store.groups[0];
      const levels = await g.viewLevelsReady;
      await store.eventsReady; // let the parallel events read finish before asserting requests
      expect(levels.map((l) => l.level)).toEqual([1, 2, 3]);
      expect(g.viewLevelsDegraded).toBe(false);
      // Levels 1-3 in the predicted batch, 4-5 as the follow-up confirming the
      // end -- and nothing past that.
      expect(viewProbes(requests)).toEqual([
        "eeg/view/1/zarr.json",
        "eeg/view/2/zarr.json",
        "eeg/view/3/zarr.json",
        "eeg/view/4/zarr.json",
        "eeg/view/5/zarr.json",
      ]);
      // v3-pinned opens: the v2 fallback must never fire on a working v3 store,
      // not even for genuinely missing nodes (view/4-5, the absent events group).
      expect(requests.some((p) => /\.zattrs|\.zarray|\.zgroup/.test(p))).toBe(false);
    });
  });

  it("creeps past an undershot prediction in follow-up batches until the real end", async () => {
    // n_samples=8000 still predicts 3, but the store has 5 levels.
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125, 31, 7],
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const levels = await store.groups[0].viewLevelsReady;
      expect(levels.map((l) => l.level)).toEqual([1, 2, 3, 4, 5]);
      expect(store.groups[0].viewLevelsDegraded).toBe(false);
      // 1-3 predicted, 4-5 follow-up (all present), 6-7 follow-up finds the end.
      expect(viewProbes(requests)).toEqual([
        "eeg/view/1/zarr.json",
        "eeg/view/2/zarr.json",
        "eeg/view/3/zarr.json",
        "eeg/view/4/zarr.json",
        "eeg/view/5/zarr.json",
        "eeg/view/6/zarr.json",
        "eeg/view/7/zarr.json",
      ]);
    });
  });

  it("keeps fulfilled sibling levels and flags degradation on a non-404 probe failure", async () => {
    // view/2 responds 403 (an expired token, not a missing level): the levels
    // that DID open must survive, and the handle must say discovery broke.
    const { handler } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      failLevel: 2,
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const g = store.groups[0];
      const levels = await g.viewLevelsReady;
      expect(levels.map((l) => l.level)).toEqual([1, 3]); // siblings kept, not discarded
      expect(g.viewLevels.map((l) => l.level)).toEqual([1, 3]);
      expect(g.viewLevelsDegraded).toBe(true); // "discovery broke", not "1-level recording"
    });
  });
});

describe("declared view levels skip probing entirely (website#276)", () => {
  const viewProbes = (requests: string[]) => requests.filter((p) => p.includes("/view/")).sort();

  it("an empty declared view_levels array means zero levels, not 'undeclared' -- no probe requests at all", async () => {
    // The server actually has 3 levels available, but they are not declared:
    // a reader that treated [] as "absent" would probe and find them anyway,
    // which is exactly the bug website#276 asks to fix.
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      declaredLevels: [],
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const levels = await store.groups[0].viewLevelsReady;
      expect(levels).toEqual([]);
      expect(store.groups[0].viewLevelsDegraded).toBe(false);
      expect(viewProbes(requests)).toEqual([]);
    });
  });

  it("a non-empty declared view_levels array opens exactly those levels, with no follow-up probe", async () => {
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500],
      declaredLevels: [1, 2],
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const levels = await store.groups[0].viewLevelsReady;
      expect(levels.map((l) => l.level)).toEqual([1, 2]);
      expect(store.groups[0].viewLevelsDegraded).toBe(false);
      // Exactly the declared levels are fetched -- no confirm-the-end 404,
      // unlike the probing path's VIEW_PROBE_FOLLOWUP batch.
      expect(viewProbes(requests)).toEqual(["eeg/view/1/zarr.json", "eeg/view/2/zarr.json"]);
    });
  });

  it("keeps fulfilled declared siblings and flags degradation on a non-404 declared-level failure", async () => {
    // Declared 3 levels; level 2 comes back 403 (expired token, not missing).
    // Levels 1 and 3 must survive -- a single bad declared level must not
    // discard siblings that opened fine (PR #278 review).
    const { handler } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      declaredLevels: [1, 2, 3],
      failLevel: 2,
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const g = store.groups[0];
      const levels = await g.viewLevelsReady;
      expect(levels.map((l) => l.level)).toEqual([1, 3]);
      expect(g.viewLevels.map((l) => l.level)).toEqual([1, 3]);
      expect(g.viewLevelsDegraded).toBe(true);
    });
  });

  it("a positive numeric n_view_levels count declares 1..count, no probing", async () => {
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      declaredCount: 3,
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const levels = await store.groups[0].viewLevelsReady;
      expect(levels.map((l) => l.level)).toEqual([1, 2, 3]);
      expect(store.groups[0].viewLevelsDegraded).toBe(false);
      expect(viewProbes(requests)).toEqual([
        "eeg/view/1/zarr.json",
        "eeg/view/2/zarr.json",
        "eeg/view/3/zarr.json",
      ]);
    });
  });

  it("a zero numeric n_view_levels count means zero levels, not undeclared -- no probe requests", async () => {
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125], // present on the server but not declared
      declaredCount: 0,
    });
    await withFetch(handler, async () => {
      const store = await openRecording("https://example.test/store/");
      const levels = await store.groups[0].viewLevelsReady;
      expect(levels).toEqual([]);
      expect(store.groups[0].viewLevelsDegraded).toBe(false);
      expect(viewProbes(requests)).toEqual([]);
    });
  });

  it("a non-empty view_levels array of nothing but garbage falls back to probing, with a warning (not declared-empty)", async () => {
    // Every entry is invalid (strings), unlike a genuine [] -- malformed
    // producer data must not be read as "zero levels declared".
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      declaredLevels: ["bogus", "also-bogus"] as unknown as number[],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withFetch(handler, async () => {
        const store = await openRecording("https://example.test/store/");
        const levels = await store.groups[0].viewLevelsReady;
        // Falls through to probing and finds the real 3 levels on the server.
        expect(levels.map((l) => l.level)).toEqual([1, 2, 3]);
        expect(viewProbes(requests).length).toBeGreaterThan(0);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("view_levels declared"));
    } finally {
      warn.mockRestore();
    }
  });

  it("a genuinely empty view_levels array stays declared-empty (no warning, no probe)", async () => {
    const { handler, requests } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
      declaredLevels: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withFetch(handler, async () => {
        const store = await openRecording("https://example.test/store/");
        const levels = await store.groups[0].viewLevelsReady;
        expect(levels).toEqual([]);
        expect(viewProbes(requests)).toEqual([]);
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * website#208: the interactive path (openRecording, and the window reads
 * viewer.ts's render loop calls) must actually cancel its underlying HTTP
 * requests when a mount is superseded or destroyed, not just discard the
 * result once it eventually arrives. These exercise the same transport
 * boundary as the rest of this file (a real in-memory fetch stub, real
 * AbortController/AbortSignal plumbing through zarrita) rather than mocking
 * openRecording/readWindow themselves.
 */
describe("abort propagation into the interactive path (website#208)", () => {
  it("openRecording rejects once the caller's signal aborts mid-open, and never issues a group/level-0 request", async () => {
    const requests: string[] = [];
    // The root zarr.json request hangs forever on its own -- it only settles
    // (via zarrita/dedupingFetch's own abort wiring) once `controller` aborts.
    const handler = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(new URL(url).pathname.replace(/^\/store\//, ""));
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const controller = new AbortController();
    await withFetch(handler, async () => {
      const pending = openRecording("https://example.test/store/", controller.signal);
      // Let the synchronous open of the root request actually dispatch before
      // aborting it -- confirms the rejection comes from the abort, not from
      // aborting before anything was even in flight.
      await Promise.resolve();
      expect(requests).toEqual(["zarr.json"]);
      controller.abort();
      await expect(pending).rejects.toThrow();
    });
    // No group ("eeg/zarr.json") or level-0 ("eeg/0/zarr.json") request was
    // ever issued -- the abort cut the open off at the root, not after.
    expect(requests).toEqual(["zarr.json"]);
  });

  it("readLevel0 rejects an in-flight chunk read once the signal aborts, and writes no data", async () => {
    const { handler: openHandler } = fakeZarrV3Store({ nSamples: 2000, viewLevels: [] });
    let opened: Awaited<ReturnType<typeof openRecording>> | undefined;
    await withFetch(openHandler, async () => {
      opened = await openRecording("https://example.test/store/");
      // Let the fire-and-forget view-level/events reads settle on THIS
      // handler before it is swapped out below, so they don't leak a
      // dangling request into the hanging handler.
      await opened.groups[0].viewLevelsReady;
      await opened.eventsReady;
    });
    const g = opened?.groups[0];
    if (!g) throw new Error("test setup: group did not open");

    // Every request for the actual chunk bytes hangs until aborted -- opening
    // is already done, so nothing else should be requesting metadata here.
    const hangingFetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const controller = new AbortController();
    await withFetch(hangingFetch, async () => {
      const pending = readLevel0(g, 0, 1, 0, g.nChannels, controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(pending).rejects.toThrow();
    });
  });

  it("readWindow (the function viewer.ts's interactive render path calls) also rejects on abort instead of resolving with stale data", async () => {
    const { handler: openHandler } = fakeZarrV3Store({ nSamples: 2000, viewLevels: [] });
    let opened: Awaited<ReturnType<typeof openRecording>> | undefined;
    await withFetch(openHandler, async () => {
      opened = await openRecording("https://example.test/store/");
      await opened.groups[0].viewLevelsReady;
      await opened.eventsReady;
    });
    const g = opened?.groups[0];
    if (!g) throw new Error("test setup: group did not open");

    const hangingFetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const controller = new AbortController();
    let settled: "resolved" | "rejected" | "pending" = "pending";
    await withFetch(hangingFetch, async () => {
      const pending = readWindow(g, 0, 1, 800, 0, g.nChannels, false, controller.signal).then(
        () => {
          settled = "resolved";
        },
        () => {
          settled = "rejected";
        },
      );
      await Promise.resolve();
      expect(settled).toBe("pending"); // genuinely in flight, not already settled
      controller.abort();
      await pending;
    });
    expect(settled).toBe("rejected"); // aborted, not resolved with a dropped-in-flight result
  });

  it("readOverview resolves to null (never rejects, never hangs) once the signal aborts the minimap read", async () => {
    const { handler: openHandler } = fakeZarrV3Store({
      nSamples: 8000,
      viewLevels: [2000, 500, 125],
    });
    let opened: Awaited<ReturnType<typeof openRecording>> | undefined;
    await withFetch(openHandler, async () => {
      opened = await openRecording("https://example.test/store/");
      await opened.groups[0].viewLevelsReady;
      await opened.eventsReady;
    });
    const g = opened?.groups[0];
    if (!g) throw new Error("test setup: group did not open");
    // Otherwise readOverview short-circuits to null without ever reading --
    // the abort has to interrupt a genuine in-flight zarr.get.
    expect(g.viewLevels.length).toBeGreaterThan(0);

    const hangingFetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const controller = new AbortController();
    let settled: "resolved" | "rejected" | "pending" = "pending";
    let result: Float32Array | null | undefined;
    await withFetch(hangingFetch, async () => {
      const pending = readOverview(g, controller.signal).then((data) => {
        settled = "resolved";
        result = data;
      });
      await Promise.resolve();
      expect(settled).toBe("pending"); // genuinely in flight, not already settled
      controller.abort();
      await pending;
    });
    // readOverview swallows every failure (including an abort) and resolves
    // to null rather than throwing -- same contract it always had, now also
    // true for a caller-driven cancellation.
    expect(settled).toBe("resolved");
    expect(result).toBeNull();
  });
});
