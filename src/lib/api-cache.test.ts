import { afterEach, describe, expect, it } from "vitest";
import {
  type BodyStore,
  FRESH_MS,
  type StoredBody,
  UpstreamError,
  cachedJson,
  isRateLimited,
} from "./api-cache";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
