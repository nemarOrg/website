import { afterEach, describe, expect, it } from "vitest";
import {
  type BodyStore,
  FRESH_MS,
  RETAIN_S,
  RETRY_AFTER_FAILURE_MS,
  REVALIDATE_MS,
  type StoredBody,
  UpstreamError,
  cachedJson,
  isRateLimited,
  resetApiCacheStateForTests,
} from "./api-cache";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetApiCacheStateForTests();
});

/** A real, in-memory implementation of the store interface (not a stub of logic). */
function memoryStore(seed: Record<string, StoredBody> = {}): BodyStore & {
  entries: Map<string, StoredBody>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.set(key, value);
    },
  };
}

/** Counts calls so a test can say "the API was not asked". */
function respondWith(make: () => Response | Promise<Response>): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return make();
  }) as unknown as typeof fetch;
  return { calls: () => n };
}

const URL_A = "https://api.nemar.org/datasets?limit=10";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const signal = () => AbortSignal.timeout(5000);

describe("cachedJson: fresh copy", () => {
  it("answers from the store without calling the API while the copy is fresh", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: 1_000_000 } });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: () => 1_000_000 + FRESH_MS - 1,
    });
    expect(got).toEqual({ n: 1 });
    expect(api.calls()).toBe(0);
  });

  it("refetches once the copy is older than the freshness window and stores the new body", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: 1_000_000 } });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: () => 1_000_000 + FRESH_MS,
    });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual({ body: '{"n":2}', storedAt: 1_000_000 + FRESH_MS });
  });

  it("stores a miss so the next call is free", async () => {
    const store = memoryStore();
    const api = respondWith(() => json({ n: 3 }));
    const opts = { signal: signal(), label: "list datasets", store, now: () => 5_000 };
    await cachedJson(URL_A, opts);
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(1);
  });
});

describe("cachedJson: stale-if-error", () => {
  const stale = { body: '{"n":1}', storedAt: 1_000 };
  const later = () => 1_000 + 3 * 60 * 60 * 1000; // three hours on

  it("serves the stale copy when the API answers 429", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: later,
    });
    expect(got).toEqual({ n: 1 });
  });

  it("serves the stale copy on a 5xx", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => new Response("boom", { status: 503 }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: later,
    });
    expect(got).toEqual({ n: 1 });
  });

  it("serves the stale copy when the request fails outright", async () => {
    const store = memoryStore({ [URL_A]: stale });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: later,
    });
    expect(got).toEqual({ n: 1 });
  });

  it("does not hide a 404 behind a stale copy: the dataset is really gone", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => new Response("nope", { status: 404 }));
    await expect(
      cachedJson(URL_A, { signal: signal(), label: "get dataset", store, now: later }),
    ).rejects.toMatchObject({ name: "UpstreamError", status: 404 });
  });

  it("throws the API's own error when there is no copy to fall back on", async () => {
    const store = memoryStore();
    respondWith(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    const err: unknown = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: later,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).toBe(
      "api.nemar.org list datasets failed: 429 Too Many Requests",
    );
    expect(isRateLimited(err)).toBe(true);
  });
});

describe("cachedJson: what is never stored", () => {
  it("does not store an error response", async () => {
    const store = memoryStore();
    respondWith(() => new Response("boom", { status: 500 }));
    await cachedJson(URL_A, { signal: signal(), label: "x", store }).catch(() => {});
    expect(store.entries.size).toBe(0);
  });

  it("does not store, or serve stale for, a 2xx that is not JSON", async () => {
    const store = memoryStore({ [URL_A]: { body: '{"n":1}', storedAt: 1_000 } });
    respondWith(() => new Response("<html>edge timeout</html>", { status: 200 }));
    // The copy is stale, so the API is asked; its body is unusable, which is a
    // failure like any other and so falls back to the copy.
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "search",
      store,
      now: () => 1_000 + 3 * 60 * 60 * 1000,
    });
    expect(got).toEqual({ n: 1 });
    expect(store.entries.get(URL_A)?.body).toBe('{"n":1}');
  });

  it("reports a non-JSON 2xx with no copy as an invalid response", async () => {
    respondWith(() => new Response("<html>edge timeout</html>", { status: 200 }));
    await expect(
      cachedJson(URL_A, { signal: signal(), label: "search", store: memoryStore() }),
    ).rejects.toThrow(/invalid response/);
  });
});

describe("cachedJson: a broken cache never breaks the page", () => {
  it("falls through to the API when the store throws on read and write", async () => {
    const broken: BodyStore = {
      async get() {
        throw new Error("cache unavailable");
      },
      async set() {
        throw new Error("cache unavailable");
      },
    };
    respondWith(() => json({ n: 9 }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store: broken,
    });
    expect(got).toEqual({ n: 9 });
  });

  it("calls the API every time when there is no store (null)", async () => {
    const api = respondWith(() => json({ n: 1 }));
    const opts = { signal: signal(), label: "list datasets", store: null } as const;
    await cachedJson(URL_A, opts);
    await cachedJson(URL_A, opts);
    expect(api.calls()).toBe(2);
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

describe("cachedJson: stale-while-revalidate", () => {
  const storedAt = 1_000_000;
  const stale = { body: '{"n":1}', storedAt };
  const inWindow = () => storedAt + FRESH_MS + 1;

  it("serves a copy past fresh at once and refreshes it behind the response", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: inWindow,
      waitUntil: bg.waitUntil,
    });
    expect(got).toEqual({ n: 1 }); // the old copy, immediately
    expect(bg.count()).toBe(1);
    await bg.settled();
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual({ body: '{"n":2}', storedAt: inWindow() });
  });

  it("starts one refresh for a burst of visitors", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const opts = {
      signal: signal(),
      label: "list datasets",
      store,
      now: inWindow,
      waitUntil: bg.waitUntil,
    };
    await Promise.all([cachedJson(URL_A, opts), cachedJson(URL_A, opts), cachedJson(URL_A, opts)]);
    await bg.settled();
    expect(api.calls()).toBe(1);
  });

  it("keeps the old copy when the refresh fails, and does not ask again for a minute", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(
      () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
    );
    let clock = inWindow();
    const bg = backgroundWork();
    const opts = {
      signal: signal(),
      label: "list datasets",
      store,
      now: () => clock,
      waitUntil: bg.waitUntil,
    };
    expect(await cachedJson(URL_A, opts)).toEqual({ n: 1 });
    await bg.settled();
    expect(api.calls()).toBe(1);
    expect(store.entries.get(URL_A)).toEqual(stale); // untouched

    // Within the backoff: served, and the API is left alone.
    clock += RETRY_AFTER_FAILURE_MS - 1;
    expect(await cachedJson(URL_A, opts)).toEqual({ n: 1 });
    expect(api.calls()).toBe(1);
    expect(bg.count()).toBe(1);

    // Past it: one more try.
    clock += 2;
    await cachedJson(URL_A, opts);
    await bg.settled();
    expect(api.calls()).toBe(2);
  });

  it("refreshes inline when there is nowhere to run background work", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: inWindow,
    });
    expect(got).toEqual({ n: 2 });
    expect(api.calls()).toBe(1);
  });

  it("asks the API first, not behind the response, once past the revalidate window", async () => {
    const store = memoryStore({ [URL_A]: stale });
    const api = respondWith(() => json({ n: 2 }));
    const bg = backgroundWork();
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: () => storedAt + REVALIDATE_MS + 1,
      waitUntil: bg.waitUntil,
    });
    expect(got).toEqual({ n: 2 });
    expect(bg.count()).toBe(0);
    expect(api.calls()).toBe(1);
  });
});

describe("cachedJson: the three-day ceiling", () => {
  const storedAt = 1_000_000;
  const stale = { body: '{"n":1}', storedAt };

  it("still serves a copy just inside three days when the API is down", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    const got = await cachedJson(URL_A, {
      signal: signal(),
      label: "list datasets",
      store,
      now: () => storedAt + RETAIN_S * 1000,
    });
    expect(got).toEqual({ n: 1 });
  });

  it("does not serve a copy older than three days, even with the API down", async () => {
    const store = memoryStore({ [URL_A]: stale });
    respondWith(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    await expect(
      cachedJson(URL_A, {
        signal: signal(),
        label: "list datasets",
        store,
        now: () => storedAt + RETAIN_S * 1000 + 1,
      }),
    ).rejects.toMatchObject({ name: "UpstreamError", status: 429 });
  });

  it("is three days, no more", () => {
    expect(RETAIN_S).toBe(3 * 24 * 60 * 60);
  });
});

describe("cachedJson: a failing API with nothing stored", () => {
  it("is asked every time: there is no copy to protect it with", async () => {
    const api = respondWith(
      () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
    );
    const opts = { signal: signal(), label: "list datasets", store: memoryStore() };
    await cachedJson(URL_A, opts).catch(() => {});
    await cachedJson(URL_A, opts).catch(() => {});
    expect(api.calls()).toBe(2);
  });
});
