import { describe, expect, it } from "vitest";
import {
  aggregateOverview,
  chooseWindowLevel,
  parseChannels,
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
