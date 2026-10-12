import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BodyStore,
  CACHE_GENERATION,
  FRESH_MS,
  MAX_TRACKED_KEYS,
  RETAIN_S,
  RETRY_AFTER_FAILURE_MS,
  REVALIDATE_MS,
  type StoredBody,
  UpstreamError,
  cachedJson,
  isRateLimited,
  resetApiCacheStateForTests,
  workersStore,
} from "./api-cache";
import {
  type RequestContext,
  dataWasStale,
  markDataStale,
  runWithRequestContext,
} from "./request-context";

const originalFetch = globalThis.fetch;
const originalCaches = (globalThis as { caches?: unknown }).caches;

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as { caches?: unknown }).caches = originalCaches;
  resetApiCacheStateForTests();
  vi.restoreAllMocks();
});

// --- fixtures ----------------------------------------------------------------

/** A real, in-memory implementation of the store interface (not a stub of logic). */
function memoryStore(
  seed: Record<string, StoredBody> = {},
  faults: { set?: boolean; get?: boolean } = {},
): BodyStore & { entries: Map<string, StoredBody> } {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    async get(key) {
      if (faults.get) throw new Error("cache unavailable");
      return entries.get(key);
    },
    async set(key, value) {
      if (faults.set) throw new Error("cache unavailable");
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Answers every fetch with `make()` and records what was asked, so a test can say "the API was not asked". */
function respondWith(make: (call: Call) => Response | Promise<Response>): {
  calls: () => number;
  last: () => Call;
} {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return make(call);
  }) as unknown as typeof fetch;
  return { calls: () => calls.length, last: () => calls[calls.length - 1] };
}

/** A fetch that does not answer until released, so a test can look at what happened meanwhile. */
function pendingFetch(): { release: (res: Response) => void; calls: () => number } {
  let release!: (res: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return gate;
  }) as unknown as typeof fetch;
  return { release, calls: () => n };
}

const URL_A = "https://api.nemar.org/datasets?limit=10";
const URL_B = "https://api.nemar.org/datasets?limit=20";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const tooMany = () => new Response("slow down", { status: 429, statusText: "Too Many Requests" });
const signal = () => AbortSignal.timeout(5000);

/** Collects the background work a call schedules, so a test can await it. */
function backgroundWork(): {
  waitUntil: (work: Promise<unknown>) => void;
  settled: () => Promise<void>;
  count: () => number;
} {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (work) => {
      pending.push(work);
    },
    settled: async () => {
      await Promise.all(pending);
    },
    count: () => pending.length,
  };
}

const storedAt = 1_000_000;
const stale = { body: '{"n":1}', storedAt };
/** A clock `ms` after the stored copy was fetched. */
const msAfter = (ms: number) => () => storedAt + ms;
const base = { signal: signal(), label: "list datasets" } as const;

// --- the windows ---------------------------------------------------------------

describe("the windows are the contract", () => {
  it("pins the numbers ADR 0025 promises, so a derived test cannot drift with them", () => {
    expect(FRESH_MS).toBe(10 * 60 * 1000);
    expect(REVALIDATE_MS).toBe(6 * 60 * 60 * 1000);
    expect(RETAIN_S).toBe(3 * 24 * 60 * 60); // three days, no more
    expect(RETRY_AFTER_FAILURE_MS).toBe(60 * 1000);
  });
});

describe("cachedJson: fresh copy", () => {
  it("answers from the store without calling the API while the copy is fresh", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: msAfter(FRESH_MS - 1) });
    expect(got).toEqual({ n: 1 });
    expect(api.calls()).toBe(0);
  });

  it("asks once the copy is exactly as old as the freshness window, and stores the answer", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: msAfter(FRESH_MS) });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual({ body: '{"n":2}', storedAt: storedAt + FRESH_MS });
  });

  it("stores a miss so the next call is free", async () => {
    const store = memoryStore();
    const api = respondWith(() => json({ n: 3 }));
    const opts = { ...base, store, now: () => 5_000 };
    await cachedJson(URL_A, opts);
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(1);
  });

  it("does not believe a stamp far ahead of its own clock: that is a miss", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: storedAt + FRESH_MS } });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: () => storedAt });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
  });

  it("treats a stamp a little ahead (clock skew between machines) as fresh now", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: storedAt + 30_000 } });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: () => storedAt });
    expect(got).toEqual({ n: 1 });
    expect(api.calls()).toBe(0);
  });

  it("treats a stored body that is not JSON as a miss, and replaces it", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1', storedAt } });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: msAfter(1000) });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)?.body).toBe('{"n":2}');
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stored body is not JSON"));
  });
});

// --- stale while revalidating -------------------------------------------------

describe("cachedJson: served at once, refreshed behind", () => {
  const inWindow = msAfter(FRESH_MS + 1);

  it("answers while the refresh is still running, and the refresh then replaces the copy", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = pendingFetch();
    const bg = backgroundWork();
    const got = await cachedJson(URL_A, { ...base, store, now: inWindow, waitUntil: bg.waitUntil });
    // The caller has its answer while the API call is still open.
    expect(got).toEqual({ n: 1 });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual(stale);
    api.release(json({ n: 2 }));
    await bg.settled();
    expect(store.entries.get(URL_A)).toEqual({ body: '{"n":2}', storedAt: inWindow() });
  });

  it("finds the platform's waitUntil through the request context, as production does", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    // No `waitUntil` option: it must come from the request context.
    const got = await runWithRequestContext({ waitUntil: bg.waitUntil }, () =>
      cachedJson(URL_A, { ...base, store, now: inWindow }),
    );
    expect(got).toEqual({ n: 1 });
    expect(bg.count()).toBe(1);
    await bg.settled();
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)?.body).toBe('{"n":2}');
  });

  it("marks the request as built from stale data, and a fresh copy does not", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();

    const staleCtx: RequestContext = { waitUntil: bg.waitUntil };
    await runWithRequestContext(staleCtx, () =>
      cachedJson(URL_A, { ...base, store, now: inWindow }),
    );
    expect(dataWasStale(staleCtx)).toBe(true);
    await bg.settled();

    const freshCtx: RequestContext = {};
    await runWithRequestContext(freshCtx, () =>
      cachedJson(URL_A, { ...base, store, now: () => inWindow() + 1 }),
    );
    expect(dataWasStale(freshCtx)).toBe(false);
  });

  it("starts one refresh for a burst of visitors", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
    await Promise.all([cachedJson(URL_A, opts), cachedJson(URL_A, opts), cachedJson(URL_A, opts)]);
    await bg.settled();
    expect(api.calls()).toBe(1);
    expect(bg.count()).toBe(1);
  });

  it("keeps the old copy when the refresh fails, and does not ask again until the backoff ends", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => new Response("boom", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = inWindow();
    const bg = backgroundWork();
    const opts = { ...base, store, now: () => clock, waitUntil: bg.waitUntil };
    expect(await cachedJson(URL_A, opts)).toEqual({ n: 1 });
    await bg.settled();
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual(stale);

    clock += RETRY_AFTER_FAILURE_MS - 1; // still inside the minute
    expect(await cachedJson(URL_A, opts)).toEqual({ n: 1 });
    expect(api.calls()).toBe(1);

    clock += 1; // exactly a minute: asked again
    await cachedJson(URL_A, opts);
    await bg.settled();
    expect(api.calls()).toBe(2);
  });

  it("keeps the old copy when the refresh returns something that is not JSON", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => new Response("<html>edge timeout</html>", { status: 200 }));
    const bg = backgroundWork();
    const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
    await cachedJson(URL_A, opts);
    await bg.settled();
    expect(store.entries.get(URL_A)).toEqual(stale); // never overwritten with HTML
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(1); // and the failure is remembered
  });

  it("keeps the old copy when the refresh returns JSON of the wrong shape", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => json(null));
    const bg = backgroundWork();
    await cachedJson(URL_A, {
      ...base,
      store,
      now: inWindow,
      waitUntil: bg.waitUntil,
      accept: (p) => typeof p === "object" && p !== null,
    });
    await bg.settled();
    expect(store.entries.get(URL_A)).toEqual(stale);
  });

  it.each([400, 403, 404, 410])(
    "drops the copy when the refresh is told %i: the request is wrong, not the service",
    async (status) => {
      const store = memoryStore({ [URL_A]: stale });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(() => new Response("no", { status }));
      const bg = backgroundWork();
      const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
      expect(await cachedJson(URL_A, opts)).toEqual({ n: 1 }); // this visitor still has it
      await bg.settled();
      expect(store.entries.has(URL_A)).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("dropping the stored copy"));
      // The next visitor hears the answer.
      await expect(cachedJson(URL_A, opts)).rejects.toMatchObject({ status });
    },
  );

  it("does not drop the copy for a 5xx: the service is struggling", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 502 }));
    const bg = backgroundWork();
    await cachedJson(URL_A, { ...base, store, now: inWindow, waitUntil: bg.waitUntil });
    await bg.settled();
    expect(store.entries.get(URL_A)).toEqual(stale);
  });

  it("does not hammer the API when the store cannot be written", async () => {
    const store = memoryStore({ [URL_A]: stale }, { set: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
    for (let i = 0; i < 5; i++) {
      await cachedJson(URL_A, opts);
      await bg.settled();
    }
    expect(api.calls()).toBe(1); // the first refresh could not be kept; the rest stayed away
    expect(error).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  });

  it("still serves the copy when waitUntil itself throws", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, {
      ...base,
      store,
      now: inWindow,
      waitUntil: () => {
        throw new TypeError("Illegal invocation");
      },
    });
    expect(got).toEqual({ n: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("waitUntil threw"));
  });

  it("replaces a refresh that has been in flight too long, instead of waiting for it", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Promise<Response>(() => {}); // never answers
    }) as unknown as typeof fetch;
    const bg = backgroundWork();
    let clock = inWindow();
    const opts = { ...base, store, now: () => clock, waitUntil: bg.waitUntil };
    await cachedJson(URL_A, opts);
    clock += 10_000;
    await cachedJson(URL_A, opts);
    expect(n).toBe(1); // joined the one in flight
    clock += 25_000; // 35 s: past the 30 s a flight is allowed
    await cachedJson(URL_A, opts);
    expect(n).toBe(2);
  });

  it("refreshes inline when there is nowhere to run background work, and says so once", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => json({ n: 2 }));
    const opts = { ...base, store, now: inWindow };
    expect(await cachedJson(URL_A, opts)).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    // A second stale read, later: still inline, and the note is not repeated.
    store.entries.set(URL_A, stale);
    await cachedJson(URL_A, opts);
    const notes = warn.mock.calls.filter((c) => String(c[0]).includes("no waitUntil"));
    expect(notes).toHaveLength(1);
  });

  it("asks the API first, not behind the response, once past the revalidate window", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const got = await cachedJson(URL_A, {
      ...base,
      store,
      now: msAfter(REVALIDATE_MS),
      waitUntil: bg.waitUntil,
    });
    expect(got).toEqual({ n: 2 });
    expect(bg.count()).toBe(0);
    expect(api.calls()).toBe(1);
  });

  it("still serves behind the response one millisecond inside the revalidate window", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const got = await cachedJson(URL_A, {
      ...base,
      store,
      now: msAfter(REVALIDATE_MS - 1),
      waitUntil: bg.waitUntil,
    });
    expect(got).toEqual({ n: 1 });
    expect(bg.count()).toBe(1);
  });
});

// --- stale if error -----------------------------------------------------------

describe("cachedJson: stale-if-error, between six hours and three days", () => {
  const later = msAfter(REVALIDATE_MS + 60 * 60 * 1000); // seven hours on: past the window

  const transient: [string, () => Response | Promise<Response>][] = [
    ["a 429", tooMany],
    ["a 500", () => new Response("boom", { status: 500 })],
    ["a 503", () => new Response("boom", { status: 503 })],
    ["a 504", () => new Response("boom", { status: 504 })],
    ["a 408", () => new Response("slow", { status: 408 })],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];

  it.each(transient)("serves the copy on %s, and marks the request stale", async (_n, answer) => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(answer);
    const ctx: RequestContext = {};
    const got = await runWithRequestContext(ctx, () =>
      cachedJson(URL_A, { ...base, store, now: later }),
    );
    expect(got).toEqual({ n: 1 });
    expect(dataWasStale(ctx)).toBe(true);
  });

  it("serves the copy when the call times out, and hands the API the caller's signal", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = respondWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
        }),
    );
    const got = await cachedJson(URL_A, {
      ...base,
      signal: AbortSignal.timeout(5),
      store,
      now: later,
    });
    expect(got).toEqual({ n: 1 });
    expect(api.last().init.signal).toBeDefined();
    expect(new Headers(api.last().init.headers).get("Accept")).toBe("application/json");
  });

  it.each([400, 403, 404, 410])(
    "does not hide a %i behind the copy, and drops the copy",
    async (status) => {
      const store = memoryStore({ [URL_A]: stale });
      respondWith(() => new Response("no", { status }));
      await expect(cachedJson(URL_A, { ...base, store, now: later })).rejects.toMatchObject({
        name: "UpstreamError",
        status,
      });
      expect(store.entries.has(URL_A)).toBe(false);
    },
  );

  it("serves a copy just inside three days, and not one a millisecond older", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(tooMany);
    const store = memoryStore({ [URL_A]: stale });
    expect(await cachedJson(URL_A, { ...base, store, now: msAfter(RETAIN_S * 1000) })).toEqual({
      n: 1,
    });
    resetApiCacheStateForTests();
    await expect(
      cachedJson(URL_A, { ...base, store, now: msAfter(RETAIN_S * 1000 + 1) }),
    ).rejects.toMatchObject({ name: "UpstreamError", status: 429 });
  });

  it("logs a copy older than the revalidate window as an error, and a younger one as a warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 503 }));
    await cachedJson(URL_A, { ...base, store: memoryStore({ [URL_A]: stale }), now: later });
    expect(error.mock.calls.some((c) => String(c[0]).includes("serving a copy"))).toBe(true);

    error.mockClear();
    warn.mockClear();
    resetApiCacheStateForTests();
    // No waitUntil here, so a copy in the revalidate window takes the inline path too.
    await cachedJson(URL_A, {
      ...base,
      store: memoryStore({ [URL_A]: stale }),
      now: msAfter(FRESH_MS + 1),
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("serving a copy"))).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes("serving a copy"))).toBe(false);
  });

  it("serves the copy without asking again for a minute, then asks once more", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => new Response("boom", { status: 503 }));
    let clock = later();
    const opts = { ...base, store, now: () => clock };
    await cachedJson(URL_A, opts);
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(1);
    clock += RETRY_AFTER_FAILURE_MS - 1;
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(1);
    clock += 1;
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(2);
  });

  it("keeps one URL's failure from silencing another's, unless it was a 429", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith((call) =>
      call.url === URL_A ? new Response("boom", { status: 503 }) : json({ n: 2 }),
    );
    await cachedJson(URL_A, { ...base, store, now: later });
    expect(await cachedJson(URL_B, { ...base, store, now: later })).toEqual({ n: 2 });
    expect(api.calls()).toBe(2);
  });

  it("treats a 429 as the shared budget: other URLs wait too, with or without a copy", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(tooMany);
    await cachedJson(URL_A, { ...base, store, now: later });
    expect(api.calls()).toBe(1);

    // Another URL with a copy: served, the API left alone.
    expect(await cachedJson(URL_B, { ...base, store, now: later })).toEqual({ n: 1 });
    // A URL with no copy: told what the API would have said, without asking.
    const none = await cachedJson("https://api.nemar.org/datasets/nm000001", {
      ...base,
      store,
      now: later,
    }).catch((e: unknown) => e);
    expect(isRateLimited(none)).toBe(true);
    expect(api.calls()).toBe(1);

    // A read that bypasses the cache on purpose is not held back.
    await cachedJson(URL_B, { ...base, store: null, now: later }).catch(() => {});
    expect(api.calls()).toBe(2);
  });

  it("remembers at most MAX_TRACKED_KEYS failing URLs, forgetting the oldest first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const urls = Array.from(
      { length: MAX_TRACKED_KEYS + 1 },
      (_, i) => `https://api.nemar.org/datasets/nm${String(i).padStart(6, "0")}`,
    );
    const store = memoryStore(Object.fromEntries(urls.map((u) => [u, stale])));
    const api = respondWith(() => new Response("boom", { status: 503 }));
    const opts = { ...base, store, now: later };
    for (const u of urls) await cachedJson(u, opts);
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 1);

    await cachedJson(urls[MAX_TRACKED_KEYS], opts); // the newest is still remembered
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 1);
    await cachedJson(urls[0], opts); // the oldest was forgotten, so it is asked again
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 2);
  });
});

// --- one request for concurrent callers -----------------------------------------

describe("cachedJson: concurrent callers", () => {
  it("makes one API call for many callers, and gives each its own object", async () => {
    const store = memoryStore();
    const api = pendingFetch();
    const opts = { ...base, store, now: () => 5_000 };
    const callers = Array.from({ length: 30 }, () => cachedJson<{ n: number }>(URL_A, opts));
    api.release(json({ n: 7 }));
    const results = await Promise.all(callers);
    expect(api.calls()).toBe(1);
    expect(results.every((r) => r.n === 7)).toBe(true);
    expect(new Set(results).size).toBeGreaterThan(1); // not one shared mutable value
    results[0].n = 99;
    expect(results[1].n).toBe(7);
  });

  it("lets every caller see a failure, and calls the API once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = pendingFetch();
    const opts = { ...base, store: memoryStore(), now: () => 5_000 };
    const callers = Array.from({ length: 5 }, () =>
      cachedJson(URL_A, opts).catch((e: unknown) => e),
    );
    api.release(new Response("boom", { status: 500 }));
    const results = await Promise.all(callers);
    expect(api.calls()).toBe(1);
    expect(results.every((r) => r instanceof UpstreamError)).toBe(true);
  });
});

// --- what is never stored ---------------------------------------------------------

describe("cachedJson: what is never stored", () => {
  it("does not store an error response, and releases its body", async () => {
    const store = memoryStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let cancelled = false;
    respondWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("boom"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        ),
    );
    await cachedJson(URL_A, { ...base, store }).catch(() => {});
    expect(store.entries.size).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("does not store a 2xx that is not JSON, and falls back to the copy it would have replaced", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => new Response("<html>edge timeout</html>", { status: 200 }));
    const got = await cachedJson(URL_A, { ...base, store, now: msAfter(REVALIDATE_MS + 1) });
    expect(got).toEqual({ n: 1 });
    expect(store.entries.get(URL_A)?.body).toBe('{"n":1}');
  });

  it("reports a non-JSON 2xx with no copy as an invalid response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => new Response("<html>edge timeout</html>", { status: 200 }));
    await expect(cachedJson(URL_A, { ...base, store: memoryStore() })).rejects.toThrow(
      /invalid response/,
    );
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["an error envelope", { error: "Rate limit exceeded" }],
  ])("does not store %s when the caller expects a list", async (_name, body) => {
    const store = memoryStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => json(body));
    const accept = (p: unknown) =>
      typeof p === "object" && p !== null && Array.isArray((p as { datasets?: unknown }).datasets);
    await expect(cachedJson(URL_A, { ...base, store, accept })).rejects.toThrow(/invalid response/);
    expect(store.entries.size).toBe(0);
  });

  it("does not let a body of the wrong shape replace a good copy", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"datasets":[1]}', storedAt } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => json(null));
    const got = await cachedJson(URL_A, {
      ...base,
      store,
      now: msAfter(REVALIDATE_MS + 1),
      accept: (p) => typeof p === "object" && p !== null,
    });
    expect(got).toEqual({ datasets: [1] });
    expect(store.entries.get(URL_A)?.body).toBe('{"datasets":[1]}');
  });

  it("stores a body the caller accepts", async () => {
    const store = memoryStore();
    respondWith(() => json({ datasets: [] }));
    await cachedJson(URL_A, {
      ...base,
      store,
      accept: (p) => Array.isArray((p as { datasets?: unknown }).datasets),
    });
    expect(store.entries.size).toBe(1);
  });
});

describe("cachedJson: a broken cache never breaks the page", () => {
  it("falls through to the API when the store throws on read and write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => json({ n: 9 }));
    const got = await cachedJson(URL_A, {
      ...base,
      store: memoryStore({}, { get: true, set: true }),
    });
    expect(got).toEqual({ n: 9 });
  });

  it("calls the API every time when there is no store (null)", async () => {
    const api = respondWith(() => json({ n: 1 }));
    const opts = { ...base, store: null } as const;
    await cachedJson(URL_A, opts);
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(2);
  });
});

// --- the Workers adapter -------------------------------------------------------

describe("workersStore", () => {
  /** A stand-in for the platform's Cache, keyed by URL like the real one: real Request and Response objects. */
  function fakePlatformCache() {
    const entries = new Map<string, Response>();
    return {
      entries,
      async match(request: Request) {
        return entries.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        entries.set(request.url, response);
      },
      async delete(request: Request) {
        return entries.delete(request.url);
      },
    };
  }

  it("is undefined where there is no Workers cache, so callers go straight to the API", () => {
    (globalThis as { caches?: unknown }).caches = undefined;
    expect(workersStore()).toBeUndefined();
  });

  it("round-trips a body and its stamp under a private, versioned key", async () => {
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    const store = workersStore();
    await store?.set(URL_A, { body: '{"n":1}', storedAt: 123 });
    const [key] = [...platform.entries.keys()];
    expect(key).toBe(`https://api-cache.internal/${CACHE_GENERATION}/${encodeURIComponent(URL_A)}`);
    expect(await store?.get(URL_A)).toEqual({ body: '{"n":1}', storedAt: 123 });
    expect(await store?.get(URL_B)).toBeUndefined();
  });

  it("stores for the retention period, never longer", async () => {
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    await workersStore()?.set(URL_A, { body: "{}", storedAt: 1 });
    const stored = [...platform.entries.values()][0];
    expect(stored.headers.get("Cache-Control")).toBe(`max-age=${RETAIN_S}`);
  });

  it("treats an entry with a missing or unusable stamp as a miss", async () => {
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    const store = workersStore();
    const key = `https://api-cache.internal/${CACHE_GENERATION}/${encodeURIComponent(URL_A)}`;
    platform.entries.set(key, new Response("{}"));
    expect(await store?.get(URL_A)).toBeUndefined();
    platform.entries.set(key, new Response("{}", { headers: { "x-nemar-stored-at": "soon" } }));
    expect(await store?.get(URL_A)).toBeUndefined();
  });

  it("deletes an entry", async () => {
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    const store = workersStore();
    await store?.set(URL_A, { body: "{}", storedAt: 5 });
    await store?.delete(URL_A);
    expect(await store?.get(URL_A)).toBeUndefined();
  });
});

describe("isRateLimited", () => {
  it("is true only for the API's 429", () => {
    expect(isRateLimited(new UpstreamError("x", 429))).toBe(true);
    expect(isRateLimited(new UpstreamError("x", 503))).toBe(false);
    expect(isRateLimited(new Error("429"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe("markDataStale outside a request", () => {
  it("does nothing, rather than throw", () => {
    expect(() => markDataStale()).not.toThrow();
  });
});
