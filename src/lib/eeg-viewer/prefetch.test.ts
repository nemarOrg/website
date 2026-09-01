import { describe, expect, it } from "vitest";
import {
  ByteCappedLRUCache,
  PrefetchController,
  type PrefetchTransport,
  outwardOrder,
  segmentIndexForTime,
} from "./prefetch";

// Realistic chunk size: a 10 s window at 250 Hz across a 32-channel montage,
// min/max band (view level) samples -- close to what a real WindowData for a
// mid-recording segment costs (8 bytes/sample/channel for a band channel).
const SEGMENT_BYTES = 10 * 250 * 32 * 8; // 640,000 bytes (~625 KB)

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("ByteCappedLRUCache", () => {
  it("tracks used/remaining bytes across put/delete", () => {
    const cache = new ByteCappedLRUCache<string>(1000);
    cache.put("a", "A", 300);
    cache.put("b", "B", 300);
    expect(cache.usedBytes).toBe(600);
    expect(cache.remainingBytes).toBe(400);
    cache.delete("a");
    expect(cache.usedBytes).toBe(300);
  });

  it("get() returns the value and bumps recency", () => {
    const cache = new ByteCappedLRUCache<string>(1000);
    cache.put("a", "A", 100);
    cache.put("b", "B", 100);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("missing")).toBeUndefined();
  });

  it("peek() does not disturb recency", () => {
    const cache = new ByteCappedLRUCache<string>(250);
    cache.put("a", "A", 100);
    cache.put("b", "B", 100);
    cache.peek("a"); // must NOT save "a" from the next eviction
    cache.put("c", "C", 100); // forces an eviction (250 cap, 300 needed)
    expect(cache.has("a")).toBe(false); // "a" was still LRU
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("put() evicts the least-recently-used entry to make room", () => {
    const cache = new ByteCappedLRUCache<string>(250);
    cache.put("a", "A", 100);
    cache.put("b", "B", 100);
    cache.put("c", "C", 100); // needs 300; evicts "a" (oldest) to fit within 250
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.usedBytes).toBe(200);
  });

  it("put() respects recency: a get() before the evicting put spares that entry", () => {
    const cache = new ByteCappedLRUCache<string>(250);
    cache.put("a", "A", 100);
    cache.put("b", "B", 100);
    cache.get("a"); // "a" is now MRU; "b" is LRU
    cache.put("c", "C", 100);
    expect(cache.has("b")).toBe(false); // "b" evicted instead of "a"
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("put() evicts multiple entries when one large entry needs the room", () => {
    const cache = new ByteCappedLRUCache<string>(1000);
    cache.put("a", "A", 300);
    cache.put("b", "B", 300);
    cache.put("c", "C", 300);
    cache.put("d", "D", 900); // needs 3 evictions to fit under 1000
    expect(cache.count).toBe(1);
    expect(cache.has("d")).toBe(true);
    expect(cache.usedBytes).toBe(900);
  });

  it("put() refuses (and stores nothing) when a single entry exceeds the cap", () => {
    const cache = new ByteCappedLRUCache<string>(500);
    const ok = cache.put("huge", "X", 900);
    expect(ok).toBe(false);
    expect(cache.has("huge")).toBe(false);
    expect(cache.usedBytes).toBe(0);
  });

  it("putIfRoom() never evicts: fails once full, leaving prior entries intact", () => {
    const cache = new ByteCappedLRUCache<string>(250);
    expect(cache.putIfRoom("a", "A", 100)).toBe(true);
    expect(cache.putIfRoom("b", "B", 100)).toBe(true);
    expect(cache.putIfRoom("c", "C", 100)).toBe(false); // only 50 bytes left
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(false);
    expect(cache.usedBytes).toBe(200);
  });

  it("putIfRoom() on an already-cached key is a no-op success, not a duplicate write", () => {
    const cache = new ByteCappedLRUCache<string>(250);
    cache.putIfRoom("a", "A", 100);
    const ok = cache.putIfRoom("a", "A2", 100);
    expect(ok).toBe(true);
    expect(cache.usedBytes).toBe(100); // not double-counted
    expect(cache.peek("a")).toBe("A"); // background re-visit does not overwrite
  });

  it("setCapacity() shrinking evicts LRU entries down to the new cap", () => {
    const cache = new ByteCappedLRUCache<string>(1000);
    cache.put("a", "A", 300);
    cache.put("b", "B", 300);
    cache.put("c", "C", 300);
    cache.setCapacity(400);
    expect(cache.usedBytes).toBeLessThanOrEqual(400);
    expect(cache.has("a")).toBe(false); // oldest goes first
    expect(cache.has("c")).toBe(true); // newest survives
  });

  it("setCapacity() growing does not evict and raises headroom", () => {
    const cache = new ByteCappedLRUCache<string>(200);
    cache.put("a", "A", 200);
    cache.setCapacity(500);
    expect(cache.has("a")).toBe(true);
    expect(cache.remainingBytes).toBe(300);
  });

  it("realistic scale: a 500 MB cap holds ~800 ten-second/32-channel segments", () => {
    const capBytes = 500 * 1024 * 1024;
    const cache = new ByteCappedLRUCache<number>(capBytes);
    let stored = 0;
    for (let i = 0; i < 2000; i++) {
      if (!cache.putIfRoom(`seg-${i}`, i, SEGMENT_BYTES)) break;
      stored++;
    }
    expect(stored).toBeGreaterThan(700);
    expect(cache.usedBytes).toBeLessThanOrEqual(capBytes);
  });
});

describe("outwardOrder", () => {
  it("visits the center segment first", () => {
    expect(outwardOrder(9, 4)[0]).toBe(4);
  });

  it("alternates forward/back around an interior center", () => {
    expect(outwardOrder(7, 3)).toEqual([3, 4, 2, 5, 1, 6, 0]);
  });

  it("clamps a center at the left edge to a purely forward walk", () => {
    expect(outwardOrder(5, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it("clamps a center at the right edge to a purely backward walk", () => {
    expect(outwardOrder(5, 4)).toEqual([4, 3, 2, 1, 0]);
  });

  it("clamps an out-of-range center into bounds instead of throwing", () => {
    expect(outwardOrder(5, 99)).toEqual([4, 3, 2, 1, 0]);
    expect(outwardOrder(5, -3)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns an empty walk for zero or negative segment counts", () => {
    expect(outwardOrder(0, 0)).toEqual([]);
    expect(outwardOrder(-1, 0)).toEqual([]);
  });

  it("floors a fractional center", () => {
    expect(outwardOrder(9, 4.9)[0]).toBe(4);
  });

  it("visits every segment exactly once", () => {
    const order = outwardOrder(11, 6);
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(11).keys()]);
  });
});

describe("segmentIndexForTime", () => {
  it("resolves an exact grid-aligned time", () => {
    expect(segmentIndexForTime(30, 10)).toBe(3);
    expect(segmentIndexForTime(0, 10)).toBe(0);
  });

  it("returns null for a time that does not land on the grid", () => {
    expect(segmentIndexForTime(31, 10)).toBeNull();
    expect(segmentIndexForTime(4.5, 10)).toBeNull();
  });

  it("tolerates floating-point noise within epsilon", () => {
    expect(segmentIndexForTime(30.0000001, 10)).toBe(3);
  });

  it("returns null for a non-positive segment width", () => {
    expect(segmentIndexForTime(10, 0)).toBeNull();
  });
});

/** A deterministic fake transport: returns a fixed byte size per segment and
 * records call order + the abort signal it was given, so tests can assert on
 * scheduling and abort behavior without touching zarr or the network. */
function fakeTransport(bytesPerSegment = 100): {
  transport: PrefetchTransport<number>;
  calls: number[];
  signals: AbortSignal[];
} {
  const calls: number[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    transport: {
      async fetchSegment(segment, signal) {
        calls.push(segment);
        signals.push(signal);
        return { value: segment, bytes: bytesPerSegment };
      },
    },
  };
}

describe("PrefetchController", () => {
  it("walks segments outward from the given center in order", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const { transport, calls } = fakeTransport();
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.start(7, 3);
    await flush(50);
    expect(calls).toEqual([3, 4, 2, 5, 1, 6, 0]);
    expect(controller.coveredSegments.size).toBe(7);
    expect(controller.running).toBe(false); // walk finished naturally
  });

  it("skips segments already resident in the cache without calling the transport", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    cache.put("s3", 3, 100); // pre-seed the center segment
    const { transport, calls } = fakeTransport();
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.start(5, 3);
    await flush(50);
    expect(calls).not.toContain(3);
    expect(controller.coveredSegments.has(3)).toBe(true);
  });

  it("reports progress via onProgress as segments complete", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const { transport } = fakeTransport();
    const progressSnapshots: number[][] = [];
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
      onProgress: (covered) => progressSnapshots.push([...covered].sort((a, b) => a - b)),
    });
    controller.start(3, 0);
    await flush(50);
    expect(progressSnapshots.length).toBe(3);
    expect(progressSnapshots.at(-1)).toEqual([0, 1, 2]);
  });

  it("yields to an interactive read in progress and resumes after it ends", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const { transport, calls } = fakeTransport();
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.notifyInteractiveStart();
    controller.start(4, 0);
    await flush(30);
    expect(calls).toEqual([]); // held for the whole flush while "interactive" is busy

    controller.notifyInteractiveEnd();
    await flush(30);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toEqual([0, 1, 2, 3]);
  });

  it("depth-counts overlapping interactive reads (two starts need two ends)", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const { transport, calls } = fakeTransport();
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.notifyInteractiveStart();
    controller.notifyInteractiveStart();
    controller.start(2, 0);
    controller.notifyInteractiveEnd();
    await flush(20);
    expect(calls).toEqual([]); // still one interactive read outstanding

    controller.notifyInteractiveEnd();
    await flush(20);
    expect(calls).toEqual([0, 1]);
  });

  it("pauses while hidden and resumes when visible again", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const { transport, calls } = fakeTransport();
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.setHidden(true);
    controller.start(3, 0);
    await flush(30);
    expect(calls).toEqual([]);

    controller.setHidden(false);
    await flush(30);
    expect(calls).toEqual([0, 1, 2]);
  });

  it("stop() aborts the in-flight fetch and issues no further ones", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const calls: number[] = [];
    // Holder object (rather than a bare `let`) so the reassignment inside the
    // nested `fetchSegment` closure is visible with its declared type at the
    // read sites below, instead of narrowing to the initial `null`.
    const captured: { signal: AbortSignal | null } = { signal: null };
    const transport: PrefetchTransport<number> = {
      fetchSegment(segment, signal) {
        calls.push(segment);
        if (segment === 3) {
          captured.signal = signal;
          // Never resolves on its own; only stop()'s abort settles it.
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve({ value: segment, bytes: 100 });
      },
    };
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.start(6, 3); // center segment 3 fetches first and hangs
    await flush(10);
    expect(calls).toEqual([3]);
    expect(captured.signal?.aborted).toBe(false);

    controller.stop();
    await flush(20);
    expect(captured.signal?.aborted).toBe(true);
    expect(calls).toEqual([3]); // no further segments fetched after stop()
    expect(controller.running).toBe(false);
  });

  it("stops (without evicting) once the cache is full, rather than displacing entries", async () => {
    // Cap fits exactly 2 segments; a 3rd must halt the walk, not evict #1.
    const cache = new ByteCappedLRUCache<number>(200);
    const { transport, calls } = fakeTransport(100);
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `s${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.start(5, 0);
    await flush(50);
    expect(calls).toEqual([0, 1]); // 2 fit; the 3rd (segment 2) doesn't
    expect(cache.has("s0")).toBe(true);
    expect(cache.has("s1")).toBe(true);
    expect(controller.running).toBe(false);
  });

  it("a fresh start() discards a superseded loop's in-flight result", async () => {
    const cache = new ByteCappedLRUCache<number>(10_000);
    const held: { resolve: ((v: { value: number; bytes: number }) => void) | null } = {
      resolve: null,
    };
    const transport: PrefetchTransport<number> = {
      fetchSegment(segment) {
        if (segment === 0) {
          return new Promise((resolve) => {
            held.resolve = resolve;
          });
        }
        return Promise.resolve({ value: segment, bytes: 50 });
      },
    };
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `a-${seg}`,
      idle: () => Promise.resolve(),
    });
    controller.start(3, 0); // begins fetching segment 0, which hangs
    await flush(5);

    // Retarget to a different key namespace before the first fetch resolves.
    controller.retarget({ keyFor: (seg) => `b-${seg}` });
    controller.start(3, 0);
    await flush(50);

    held.resolve?.({ value: 0, bytes: 50 }); // the stale fetch finally resolves
    await flush(20);

    expect(cache.has("a-0")).toBe(false); // discarded: superseded before it landed
    expect(cache.has("b-0")).toBe(true);
    expect(cache.has("b-1")).toBe(true);
    expect(cache.has("b-2")).toBe(true);
  });

  it("yields periodically through a fully cache-warm restart instead of one synchronous burst", async () => {
    // Simulates restarting the walk over a target that is already entirely
    // resident -- a cache-cap change (forces a restart) or switching back to
    // a previously-visited group/level. Every segment is a `cache.has()` hit
    // with nothing to await, which is exactly the shape that used to run the
    // whole walk in one synchronous burst.
    const total = 300;
    const cache = new ByteCappedLRUCache<number>(1_000_000);
    for (let i = 0; i < total; i++) cache.put(`w-${i}`, i, 10);
    const { transport, calls } = fakeTransport(); // must stay empty: everything is a hit

    let idleCalls = 0;
    const progressBatchSizes: number[] = [];
    const controller = new PrefetchController<number>({
      cache,
      transport,
      keyFor: (seg) => `w-${seg}`,
      idle: () => {
        idleCalls++;
        return Promise.resolve();
      },
      onProgress: (covered) => progressBatchSizes.push(covered.size),
    });

    controller.start(total, 0);
    await flush(400);

    expect(calls).toEqual([]); // pure cache hits -- the transport is never touched
    expect(controller.coveredSegments.size).toBe(total);
    // Must yield repeatedly across 300 hits (batched every ~32), not once.
    expect(idleCalls).toBeGreaterThan(5);
    // Progress arrives in batches -- far fewer calls than segments, not one
    // onProgress (and downstream canvas redraw) per segment.
    expect(progressBatchSizes.length).toBeGreaterThan(0);
    expect(progressBatchSizes.length).toBeLessThan(total / 4);
    expect(progressBatchSizes.at(-1)).toBe(total); // the final flush reports full coverage
  });
});
