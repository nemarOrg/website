import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BodyStore,
  CACHE_GENERATION,
  FRESH_MS,
  MAX_TRACKED_KEYS,
  RETAIN_S,
  RETRY_AFTER_FAILURE_MS,
  REVALIDATE_MS,
  STUCK_FLIGHT_MS,
  type StoredBody,
  UpstreamError,
  cachedJson,
  isApiPaused,
  isMissing,
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
  faults: { set?: boolean; get?: boolean; delete?: boolean } = {},
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
      if (faults.delete) throw new Error("cache unavailable");
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
/** One dataset's own URL: the only kind a 404 or 410 can mean "gone" for. */
const DETAIL = "https://api.nemar.org/datasets/nm000123";
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
/** Let a call that has been started run to its first suspension. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  it.each([404, 410])(
    "drops a dataset's copy when the refresh is told %i: the dataset is gone",
    async (status) => {
      const store = memoryStore({ [DETAIL]: stale });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(() => new Response("no", { status }));
      const bg = backgroundWork();
      const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
      expect(await cachedJson(DETAIL, opts)).toEqual({ n: 1 }); // this visitor still has it
      await bg.settled();
      expect(store.entries.has(DETAIL)).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("dropping the stored copy"));
      // The next visitor hears the answer.
      await expect(cachedJson(DETAIL, opts)).rejects.toMatchObject({ status });
    },
  );

  it.each([
    ["a 400", 400, DETAIL],
    ["a 401", 401, DETAIL],
    ["a 403", 403, DETAIL],
    ["a 404 on a list route, which always exists", 404, URL_A],
    ["a 403 on a list route", 403, URL_A],
  ])(
    "keeps the copy and logs an error when the refresh is told %s: something is broken, not gone",
    async (_name, status, url) => {
      const store = memoryStore({ [url]: stale });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(() => new Response("blocked", { status }));
      const bg = backgroundWork();
      await cachedJson(url, { ...base, store, now: inWindow, waitUntil: bg.waitUntil });
      await bg.settled();
      expect(store.entries.get(url)).toEqual(stale);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("background refresh failed"));
    },
  );

  it.each([
    ["a 429", tooMany],
    ["a 408", () => new Response("slow", { status: 408 })],
  ])("keeps the copy when the refresh is told %s", async (_name, answer) => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(answer);
    const bg = backgroundWork();
    await cachedJson(URL_A, { ...base, store, now: inWindow, waitUntil: bg.waitUntil });
    await bg.settled();
    expect(store.entries.get(URL_A)).toEqual(stale);
  });

  it("pauses every other URL when a refresh is told 429: the budget is shared", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(tooMany);
    const bg = backgroundWork();
    const opts = { ...base, store, now: inWindow, waitUntil: bg.waitUntil };
    await cachedJson(URL_A, opts);
    await bg.settled();
    expect(api.calls()).toBe(1);
    // Another URL, also stale in the window: served, and no refresh is started for it.
    expect(await cachedJson(URL_B, opts)).toEqual({ n: 1 });
    expect(bg.count()).toBe(1);
    expect(api.calls()).toBe(1);
  });

  it("does not let a refresh's own deadline be the caller's, nor end with the request", async () => {
    const store = memoryStore({ [URL_A]: stale });
    // A fetch that honors its signal, so the caller's abort could reach the refresh if it were wired to it.
    let release!: (res: Response) => void;
    const answer = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        answer.then(resolve);
      });
    }) as unknown as typeof fetch;
    const bg = backgroundWork();
    const caller = new AbortController();
    await cachedJson(URL_A, {
      ...base,
      signal: caller.signal,
      store,
      now: inWindow,
      waitUntil: bg.waitUntil,
    });
    caller.abort(); // the page's own timer ends once the response is sent
    release(json({ n: 2 }));
    await bg.settled();
    expect(store.entries.get(URL_A)?.body).toBe('{"n":2}');
    expect(calls).toBe(1);
  });

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
    // The answer is the API's, not the stored copy: nothing was served behind.
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    // The call is handed to waitUntil all the same, so a request that is
    // canceled midway does not take the cache's answer with it.
    expect(bg.count()).toBe(1);
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

  it.each([404, 410])(
    "does not hide a %i for a dataset behind the copy, and drops the copy",
    async (status) => {
      const store = memoryStore({ [DETAIL]: stale });
      respondWith(() => new Response("no", { status }));
      await expect(cachedJson(DETAIL, { ...base, store, now: later })).rejects.toMatchObject({
        name: "UpstreamError",
        status,
      });
      expect(store.entries.has(DETAIL)).toBe(false);
    },
  );

  it.each([
    ["a 400", 400, DETAIL],
    ["a 401", 401, DETAIL],
    ["a 403", 403, DETAIL],
    ["a 404 on a list route", 404, URL_A],
    ["a 403 on a list route", 403, URL_A],
  ])(
    "serves the copy and logs an error on %s: something between here and the API is broken",
    async (_name, status, url) => {
      const store = memoryStore({ [url]: stale });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(() => new Response("blocked", { status }));
      const ctx: RequestContext = {};
      const got = await runWithRequestContext(ctx, () =>
        cachedJson(url, { ...base, store, now: later }),
      );
      expect(got).toEqual({ n: 1 });
      expect(dataWasStale(ctx)).toBe(true);
      expect(store.entries.get(url)).toEqual(stale);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("serving a copy"));
    },
  );

  it("throws a 4xx with no copy to fall back on", async () => {
    respondWith(() => new Response("blocked", { status: 403 }));
    await expect(
      cachedJson(URL_A, { ...base, store: memoryStore(), now: later }),
    ).rejects.toMatchObject({ status: 403 });
  });

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

// --- the default store, through cachedJson --------------------------------------

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

describe("cachedJson: the platform cache is the default store", () => {
  it("uses it when no store is given: a second call within the fresh window is free", async () => {
    (globalThis as { caches?: unknown }).caches = { default: fakePlatformCache() };
    const api = respondWith(() => json({ n: 1 }));
    await cachedJson(URL_A, base);
    await cachedJson(URL_A, base);
    expect(api.calls()).toBe(1);
  });

  it("is bypassed, and not written, by store: null", async () => {
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    const api = respondWith(() => json({ n: 1 }));
    await cachedJson(URL_A, { ...base, store: null });
    await cachedJson(URL_A, { ...base, store: null });
    expect(api.calls()).toBe(2);
    expect(platform.entries.size).toBe(0);
  });
});

describe("cachedJson: refresh reads past the stored copy and leaves the cache better", () => {
  it("ignores a fresh copy, asks the API, and stores the answer", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt } });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, { ...base, store, now: msAfter(1000), refresh: true });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)?.body).toBe('{"n":2}');
    // The next ordinary read finds the new copy.
    await cachedJson(URL_A, { ...base, store, now: msAfter(2000) });
    expect(api.calls()).toBe(1);
  });

  it("drops the stored copy when the API says the dataset is gone, though it never read it", async () => {
    const store = memoryStore({ [DETAIL]: stale });
    respondWith(() => new Response("no", { status: 404 }));
    await expect(
      cachedJson(DETAIL, { ...base, store, now: msAfter(1000), refresh: true }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.entries.has(DETAIL)).toBe(false);
  });

  it("serves no stale copy when the API is failing: it is a read that must not act on old data", async () => {
    const store = memoryStore({ [URL_A]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 503 }));
    await expect(
      cachedJson(URL_A, { ...base, store, now: msAfter(1000), refresh: true }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

// --- the pause, from start to finish -----------------------------------------------

describe("cachedJson: the 429 pause", () => {
  const later = msAfter(REVALIDATE_MS + 60 * 60 * 1000);

  it("marks the request stale for every copy served under the pause", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(tooMany);
    await cachedJson(URL_A, { ...base, store, now: later });
    const ctx: RequestContext = {};
    await runWithRequestContext(ctx, () => cachedJson(URL_B, { ...base, store, now: later }));
    expect(dataWasStale(ctx)).toBe(true);
  });

  it("ends exactly a minute after the 429, for URLs with a copy and for those without", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let recovered = false;
    const api = respondWith(() => (recovered ? json({ n: 9 }) : tooMany()));
    let clock = later();
    const at = () => clock;
    await cachedJson(URL_A, { ...base, store, now: at });
    expect(api.calls()).toBe(1);

    clock += RETRY_AFTER_FAILURE_MS - 1;
    await cachedJson(URL_B, { ...base, store, now: at });
    await cachedJson(DETAIL, { ...base, store, now: at }).catch(() => {});
    expect(api.calls()).toBe(1); // still paused, with a copy and without one

    recovered = true;
    clock += 1;
    // A URL with a copy goes first: a success for any other URL would end the
    // pause by itself, and hide a pause that never ends on its own.
    await cachedJson(URL_B, { ...base, store, now: at });
    expect(api.calls()).toBe(2); // the pause is over, and a URL with a copy is asked
    await cachedJson(DETAIL, { ...base, store, now: at });
    expect(api.calls()).toBe(3); // and so is one with none
  });

  it("is not ended by an answer to a call that started before the refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    let releaseA!: (res: Response) => void;
    const heldA = new Promise<Response>((resolve) => {
      releaseA = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url === URL_A ? heldA : url === URL_B ? tooMany() : json({ n: 3 });
    }) as unknown as typeof fetch;

    const t = storedAt + FRESH_MS; // a moment when the stored copy is past fresh
    const store = memoryStore({ [DETAIL]: stale });
    // A starts first and is held; B is refused later; C has a copy and is read just afterwards.
    const a = cachedJson(URL_A, { ...base, store: memoryStore(), now: () => t + 1000 });
    await tick();
    await cachedJson(URL_B, { ...base, store: memoryStore(), now: () => t + 1500 }).catch(() => {});
    releaseA(json({ n: 1 }));
    await a;
    // A succeeded, but it started before the 429 and says nothing about now.
    const got = await cachedJson(DETAIL, { ...base, store, now: () => t + 1600 });
    expect(got).toEqual({ n: 1 });
    expect(calls).not.toContain(DETAIL);
  });

  it("is ended by an answer to a call made after the refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith((call) => (call.url === URL_B ? tooMany() : json({ n: 5 })));
    const t = storedAt + FRESH_MS;
    await cachedJson(URL_B, { ...base, store: memoryStore(), now: () => t + 1000 }).catch(() => {});
    // A read that bypasses the cache is made inside the pause and succeeds.
    await cachedJson(URL_A, { ...base, store: null, now: () => t + 2000 });
    const store = memoryStore({ [DETAIL]: stale });
    await cachedJson(DETAIL, { ...base, store, now: () => t + 3000 });
    expect(api.calls()).toBe(3); // the stored copy was asked about, so the pause had ended
  });

  it("is noted once a minute, not once a request, and the note counts what was served", async () => {
    const store = memoryStore({ [URL_A]: stale, [URL_B]: stale });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(tooMany);
    let clock = storedAt + FRESH_MS + 1; // copies young enough that a note is a warning
    const at = () => clock;
    await cachedJson(URL_A, { ...base, store, now: at });
    warn.mockClear();
    for (let i = 0; i < 5; i++) await cachedJson(URL_B, { ...base, store, now: at });
    const notes = warn.mock.calls.filter((c) => String(c[0]).includes("the API is refusing"));
    expect(notes).toHaveLength(1);
    expect(String(notes[0][0])).toContain("1 stored copy");

    clock += RETRY_AFTER_FAILURE_MS - 1; // the pause is almost over; still one note a minute
    await cachedJson(URL_B, { ...base, store, now: at });
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("the API is refusing")),
    ).toHaveLength(1);
  });

  it("escalates to an error once the API has been failing for hours", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 503 }));
    let clock = storedAt + FRESH_MS + 1;
    const at = () => clock;
    // The first failure starts the outage; the copy is young, so it is a warning.
    await cachedJson(URL_A, { ...base, store, now: at });
    expect(error.mock.calls.some((c) => String(c[0]).includes("failing for hours"))).toBe(false);
    // Hours later the copy is still young enough to serve behind a refresh, but the outage is not.
    clock += REVALIDATE_MS + 1;
    store.entries.set(URL_A, { body: '{"n":1}', storedAt: clock - FRESH_MS - 1 });
    await cachedJson(URL_A, { ...base, store, now: at });
    expect(error.mock.calls.some((c) => String(c[0]).includes("failing for hours"))).toBe(true);
  });
});

// --- a caller's own deadline --------------------------------------------------------

describe("cachedJson: a caller's own deadline", () => {
  it("does not ask the API when the caller's deadline is already gone, and serves the copy", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const ctx: RequestContext = {};
    const got = await runWithRequestContext(ctx, () =>
      cachedJson(URL_A, {
        ...base,
        signal: AbortSignal.abort(),
        store,
        now: msAfter(REVALIDATE_MS + 1),
      }),
    );
    expect(got).toEqual({ n: 1 });
    expect(api.calls()).toBe(0);
    expect(dataWasStale(ctx)).toBe(true);
    // And nothing was held against the API: the next caller with time is not turned away.
    await cachedJson(URL_A, { ...base, store, now: msAfter(REVALIDATE_MS + 1) });
    expect(api.calls()).toBe(1);
  });

  it("throws the abort when there is no copy to serve", async () => {
    respondWith(() => json({ n: 2 }));
    await expect(
      cachedJson(URL_A, { ...base, signal: AbortSignal.abort(), store: memoryStore() }),
    ).rejects.toBeDefined();
  });

  it("does not make a caller wait past its own deadline for a call another started", async () => {
    const api = pendingFetch();
    const store = memoryStore();
    const creator = cachedJson(URL_A, { ...base, store, now: () => 5_000 });
    const started = Date.now();
    const joiner = cachedJson(URL_A, {
      ...base,
      signal: AbortSignal.timeout(20),
      store,
      now: () => 5_000,
    });
    await expect(joiner).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(1000);
    // The call itself carries on for the one that started it.
    api.release(json({ n: 4 }));
    expect(await creator).toEqual({ n: 4 });
    expect(api.calls()).toBe(1);
  });

  it("asks for itself when the call it joined ended on the creator's shorter deadline", async () => {
    let n = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      n++;
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return json({ n: 5 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = memoryStore();
    const creator = cachedJson(URL_A, {
      ...base,
      signal: AbortSignal.timeout(10),
      store,
      now: () => 5_000,
    }).catch((e: unknown) => e);
    const joiner = cachedJson<{ n: number }>(URL_A, {
      ...base,
      signal: AbortSignal.timeout(2000),
      store,
      now: () => 5_000,
    });
    expect(((await creator) as Error).name).toBe("TimeoutError");
    expect(await joiner).toEqual({ n: 5 });
    expect(n).toBe(2);
  });
});

// --- a store that will not delete ----------------------------------------------------

describe("cachedJson: a store that cannot drop an entry, on the inline path", () => {
  it("remembers the failure, so the next visitor does not spend another call", async () => {
    const store = memoryStore({ [DETAIL]: stale }, { delete: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => new Response("no", { status: 404 }));
    const opts = { ...base, store, now: msAfter(REVALIDATE_MS + 1) };
    // Past the window: the API is asked first, says the dataset is gone, and the copy cannot be dropped.
    await expect(cachedJson(DETAIL, opts)).rejects.toMatchObject({ status: 404 });
    expect(api.calls()).toBe(1);
    // The next visitor within the minute is not sent to the API again.
    await cachedJson(DETAIL, opts);
    expect(api.calls()).toBe(1);
  });
});

describe("cachedJson: a store that cannot drop an entry", () => {
  it("still tells the caller the dataset is gone, and does not hammer the API about it", async () => {
    const store = memoryStore({ [DETAIL]: stale }, { delete: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = respondWith(() => new Response("no", { status: 404 }));
    const bg = backgroundWork();
    const opts = {
      ...base,
      store,
      now: msAfter(FRESH_MS + 1),
      waitUntil: bg.waitUntil,
    };
    // The visitor still has the copy; the refresh learns it is gone but cannot drop it.
    expect(await cachedJson(DETAIL, opts)).toEqual({ n: 1 });
    await bg.settled();
    expect(api.calls()).toBe(1);
    // The failure is remembered, so the next visitors do not each spend a call.
    await cachedJson(DETAIL, opts);
    await cachedJson(DETAIL, opts);
    expect(api.calls()).toBe(1);
  });
});

// --- what the log may say ------------------------------------------------------------

describe("cachedJson: logs carry the path, never the query", () => {
  const SEARCH = "https://api.nemar.org/datasets/search?q=secret-name&limit=10";

  function everythingLogged(spies: Array<ReturnType<typeof vi.spyOn>>): string {
    return spies
      .map((spy) => spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n"))
      .join("\n");
  }

  it("keeps a visitor's search words out of every line, on every path", async () => {
    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    // Serving a stale copy after a failure, past the window.
    respondWith(() => new Response("boom", { status: 503 }));
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store: memoryStore({ [SEARCH]: stale }),
      now: msAfter(REVALIDATE_MS + 1),
    });
    // A refresh behind the response that fails, then a note under the pause.
    resetApiCacheStateForTests();
    const bg = backgroundWork();
    const store = memoryStore({ [SEARCH]: stale });
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store,
      now: msAfter(FRESH_MS + 1),
      waitUntil: bg.waitUntil,
    });
    await bg.settled();
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store,
      now: msAfter(FRESH_MS + 2),
      waitUntil: bg.waitUntil,
    });
    // A body that is not JSON, one that is not accepted, and a cache that cannot be written.
    resetApiCacheStateForTests();
    respondWith(() => new Response("<html>", { status: 200 }));
    await cachedJson(SEARCH, { ...base, label: "search", store: memoryStore() }).catch(() => {});
    respondWith(() => json({ nope: true }));
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store: memoryStore(),
      accept: () => false,
    }).catch(() => {});
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store: memoryStore({}, { set: true }),
    }).catch(() => {});
    // A stored body that is unusable.
    await cachedJson(SEARCH, {
      ...base,
      label: "search",
      store: memoryStore({ [SEARCH]: { body: "{", storedAt } }),
      now: msAfter(1000),
    }).catch(() => {});

    const text = everythingLogged(spies);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("secret-name");
    expect(text).not.toContain("q=");
    expect(text).toContain("/datasets/search");
  });
});

// --- a stored body that fails on the way out -----------------------------------------

describe("cachedJson: a stored body is checked on the way out too", () => {
  it("drops a stored body of the wrong shape and asks the API", async () => {
    const store = memoryStore({ [URL_A]: { body: "null", storedAt } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = respondWith(() => json({ datasets: [] }));
    const got = await cachedJson(URL_A, {
      ...base,
      store,
      now: msAfter(1000),
      accept: (p) => typeof p === "object" && p !== null,
    });
    expect(got).toEqual({ datasets: [] });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)?.body).toBe('{"datasets":[]}');
  });

  it("drops a stored body that is not JSON, so it is not read and logged on every request", async () => {
    const store = memoryStore({ [URL_A]: { body: "{", storedAt } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 503 }));
    await cachedJson(URL_A, { ...base, store, now: msAfter(1000) }).catch(() => {});
    expect(store.entries.has(URL_A)).toBe(false);
  });
});

// --- flights ---------------------------------------------------------------------------

describe("cachedJson: shared flights", () => {
  it("gives every one of thirty callers an object of its own", async () => {
    const api = pendingFetch();
    const opts = { ...base, store: memoryStore(), now: () => 5_000 };
    const callers = Array.from({ length: 30 }, () => cachedJson<{ n: number }>(URL_A, opts));
    api.release(json({ n: 7 }));
    const results = await Promise.all(callers);
    expect(new Set(results).size).toBe(30);
  });

  it("waits for a flight up to the stuck threshold, and replaces it just past it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    expect(STUCK_FLIGHT_MS).toBe(30_000);
    let clock = 0;
    const opts = { ...base, store: memoryStore(), now: () => clock };
    void cachedJson(URL_A, opts).catch(() => {});
    await tick();
    clock = STUCK_FLIGHT_MS;
    void cachedJson(URL_A, opts).catch(() => {});
    await tick();
    expect(n).toBe(1); // exactly at the threshold, still joined
    clock = STUCK_FLIGHT_MS + 1;
    void cachedJson(URL_A, opts).catch(() => {});
    await tick();
    expect(n).toBe(2); // one millisecond past it, replaced
  });

  it("does not let a replaced flight, settling late, remove the one that replaced it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const releases: Array<(res: Response) => void> = [];
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return new Promise<Response>((resolve) => {
        releases.push(resolve);
      });
    }) as unknown as typeof fetch;
    let clock = 0;
    // No store: an answer must not become a stored copy that serves the third
    // caller before it ever looks at the flights.
    const opts = { ...base, store: null, now: () => clock };
    const first = cachedJson(URL_A, opts);
    await tick();
    clock = STUCK_FLIGHT_MS + 1;
    const second = cachedJson(URL_A, opts); // replaces the first
    await tick();
    expect(n).toBe(2);
    releases[0](json({ n: 1 })); // the lost one finally answers
    await first;
    // The replacement is still in flight and still shared: a new caller joins it.
    void cachedJson(URL_A, opts);
    await tick();
    expect(n).toBe(2);
    releases[1](json({ n: 2 }));
    await second;
  });
});

// --- clock boundaries -----------------------------------------------------------------

describe("cachedJson: a stamp ahead of the clock", () => {
  it("is believed up to a minute ahead, and not a millisecond more", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: storedAt + 60_000 } });
    const api = respondWith(() => json({ n: 2 }));
    expect(await cachedJson(URL_A, { ...base, store, now: () => storedAt })).toEqual({ n: 1 });
    expect(api.calls()).toBe(0);
    const farther = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: storedAt + 60_001 } });
    expect(await cachedJson(URL_A, { ...base, store: farther, now: () => storedAt })).toEqual({
      n: 2,
    });
    expect(api.calls()).toBe(1);
  });

  it("says so once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWith(() => json({ n: 2 }));
    const ahead = () => memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: storedAt + 120_000 } });
    await cachedJson(URL_A, { ...base, store: ahead(), now: () => storedAt });
    await cachedJson(URL_A, { ...base, store: ahead(), now: () => storedAt });
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("ahead of this clock")),
    ).toHaveLength(1);
  });
});

// --- how many failing URLs are remembered ---------------------------------------------

describe("cachedJson: the failure memory", () => {
  const later = msAfter(REVALIDATE_MS + 60 * 60 * 1000);
  const urlN = (i: number) => `https://api.nemar.org/datasets/nm${String(i).padStart(6, "0")}`;

  it("keeps exactly MAX_TRACKED_KEYS and moves a URL that fails again to the newest slot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const urls = Array.from({ length: MAX_TRACKED_KEYS + 1 }, (_, i) => urlN(i));
    const store = memoryStore(Object.fromEntries(urls.map((u) => [u, stale])));
    const api = respondWith(() => new Response("boom", { status: 503 }));
    let clock = later();
    const at = () => clock;
    const opts = { ...base, store, now: at };

    for (const u of urls.slice(0, MAX_TRACKED_KEYS)) await cachedJson(u, opts); // exactly MAX
    expect(api.calls()).toBe(MAX_TRACKED_KEYS);
    await cachedJson(urls[0], opts); // all remembered, the first included
    expect(api.calls()).toBe(MAX_TRACKED_KEYS);

    clock += RETRY_AFTER_FAILURE_MS; // the first fails again: now the newest
    await cachedJson(urls[0], opts);
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 1);
    await cachedJson(urls[MAX_TRACKED_KEYS], opts); // one more URL: the oldest goes
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 2);

    await cachedJson(urls[0], opts); // still remembered: it moved to the back
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 2);
    await cachedJson(urls[1], opts); // the oldest was forgotten, so it is asked again
    expect(api.calls()).toBe(MAX_TRACKED_KEYS + 3);
  });

  it("does not remember a failure for a URL with no copy to protect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = respondWith(() => new Response("boom", { status: 503 }));
    const opts = { ...base, store: memoryStore(), now: later };
    await cachedJson(URL_A, opts).catch(() => {});
    await cachedJson(URL_A, opts).catch(() => {});
    expect(api.calls()).toBe(2);
  });
});

// --- a cache write that never answers ------------------------------------------------

describe("cachedJson: a cache write has a deadline", () => {
  it("counts a write that never answers as failed, so the page is not held up", async () => {
    vi.useFakeTimers();
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(() => json({ n: 8 }));
      const store: BodyStore = {
        async get() {
          return undefined;
        },
        set: () => new Promise<void>(() => {}),
        async delete() {},
      };
      const pending = cachedJson<{ n: number }>(URL_A, { ...base, store, now: () => 5_000 });
      await vi.advanceTimersByTimeAsync(2100);
      expect(await pending).toEqual({ n: 8 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("write failed"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workersStore: an entry with no usable stamp", () => {
  it("is a miss, and the isolate says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = fakePlatformCache();
    (globalThis as { caches?: unknown }).caches = { default: platform };
    const key = `https://api-cache.internal/${CACHE_GENERATION}/${encodeURIComponent(URL_A)}`;
    platform.entries.set(key, new Response("{}"));
    const store = workersStore();
    expect(await store?.get(URL_A)).toBeUndefined();
    expect(await store?.get(URL_A)).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("no usable stamp"))).toHaveLength(1);
  });
});

describe("isMissing", () => {
  it("is true for the answers that mean the thing is not there, and not for a 400", () => {
    expect(isMissing(new UpstreamError("x", 404))).toBe(true);
    expect(isMissing(new UpstreamError("x", 410))).toBe(true);
    // A page asks only for ids it has validated, so a 400 is something broken, not "missing".
    expect(isMissing(new UpstreamError("x", 400))).toBe(false);
    expect(isMissing(new UpstreamError("x", 429))).toBe(false);
    expect(isMissing(new UpstreamError("x", 503))).toBe(false);
    expect(isMissing(new Error("404"))).toBe(false);
  });
});

describe("isApiPaused", () => {
  it("is true for a minute after a 429, and not before one or after the minute", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isApiPaused(() => 1_000)).toBe(false);
    respondWith(tooMany);
    await cachedJson(URL_A, { ...base, store: memoryStore(), now: () => 1_000 }).catch(() => {});
    expect(isApiPaused(() => 1_000 + RETRY_AFTER_FAILURE_MS - 1)).toBe(true);
    expect(isApiPaused(() => 1_000 + RETRY_AFTER_FAILURE_MS)).toBe(false);
  });

  it("is not set by a failure that is not a 429", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(() => new Response("boom", { status: 503 }));
    await cachedJson(URL_A, { ...base, store: memoryStore(), now: () => 1_000 }).catch(() => {});
    expect(isApiPaused(() => 1_000)).toBe(false);
  });
});
