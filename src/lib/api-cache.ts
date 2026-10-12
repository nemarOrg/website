/**
 * Edge cache with stale-if-error for the public catalog reads in `api.ts`.
 *
 * Why this exists: every page this site renders on the server calls
 * api.nemar.org from inside a Cloudflare Worker, so all visitors reach the API
 * from one small pool of Cloudflare egress IPs. The API rate-limits anonymous
 * traffic per IP (`backend/src/middleware/rateLimit.ts` in nemar-cli), which
 * makes that pool one shared budget. When it runs dry the API answers
 * `429 Too Many Requests` and `/discover` showed "Could not load datasets" for
 * everyone, for as long as the budget stayed empty.
 *
 * Two things follow from that, and this module does both:
 *
 *  - A response fetched in the last {@link FRESH_MS} is served from the cache
 *    without calling the API at all. A search page hydrates ten datasets by id
 *    and a client-filtered browse page downloads the whole catalog, so repeat
 *    visits to the same data were spending the shared budget on answers it had
 *    already paid for.
 *  - When the API does fail (429, 5xx, timeout, network error), the last good
 *    copy is served instead of an error, up to {@link RETAIN_S} old. A
 *    catalog that is a few minutes behind is a far better page than none.
 *
 * Only successful, unauthenticated GET bodies are stored. Anything else
 * (404, 400, a body that is not JSON) is never cached and surfaces unchanged.
 *
 * Kept free of the Workers runtime types so the logic is unit-testable: the
 * runtime is reached through the small {@link BodyStore} interface.
 */

/** How long a stored body answers requests with no API call. */
export const FRESH_MS = 60_000;

/** How long a body is kept for stale-if-error. */
export const RETAIN_S = 24 * 60 * 60;

export interface StoredBody {
  readonly body: string;
  /** Epoch milliseconds when the body was fetched from the API. */
  readonly storedAt: number;
}

export interface BodyStore {
  get(key: string): Promise<StoredBody | undefined>;
  set(key: string, value: StoredBody): Promise<void>;
}

/** The API answered, but not with a body we can use. `status` is its HTTP status. */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/** True for the API's `429 Too Many Requests`, which the page words differently. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof UpstreamError && err.status === 429;
}

const STORED_AT_HEADER = "x-nemar-stored-at";

/**
 * The store backed by the Workers per-data-center cache, or `undefined` where
 * there is none (unit tests, a runtime without `caches.default`). Callers treat
 * `undefined` as "no cache": every call goes to the API, as before.
 */
export function workersStore(): BodyStore | undefined {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return undefined;
  return {
    async get(key) {
      const hit = await cache.match(new Request(key));
      if (!hit) return undefined;
      const storedAt = Number(hit.headers.get(STORED_AT_HEADER));
      if (!Number.isFinite(storedAt) || storedAt <= 0) return undefined;
      return { body: await hit.text(), storedAt };
    },
    async set(key, value) {
      await cache.put(
        new Request(key),
        new Response(value.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${RETAIN_S}`,
            [STORED_AT_HEADER]: String(value.storedAt),
          },
        }),
      );
    },
  };
}

export interface CachedJsonOptions {
  signal: AbortSignal;
  /** Names the call in logs and error messages, e.g. "list datasets". */
  label: string;
  /** Message for a 2xx whose body is not JSON. Defaults to a generic one. */
  invalidBodyMessage?: string;
  /** Defaults to {@link workersStore}. Pass `null` to bypass the cache. */
  store?: BodyStore | null;
  /** Clock, for tests. */
  now?: () => number;
}

async function readStore(store: BodyStore, key: string): Promise<StoredBody | undefined> {
  try {
    return await store.get(key);
  } catch (err) {
    // A broken cache must never break the page: behave as a miss.
    console.warn(`[api-cache] read failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * GET `url` as JSON, through the cache. Throws what the uncached call would
 * have thrown, except when a stored copy exists, in which case it is returned.
 */
export async function cachedJson<T>(url: string, opts: CachedJsonOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const store = opts.store === undefined ? workersStore() : opts.store;
  const stored = store ? await readStore(store, url) : undefined;

  if (stored && now() - stored.storedAt < FRESH_MS) {
    return JSON.parse(stored.body) as T;
  }

  let failure: unknown;
  try {
    const res = await fetch(url, {
      signal: opts.signal,
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const body = await res.text();
      let parsed: T | undefined;
      try {
        parsed = JSON.parse(body) as T;
      } catch {
        // A 2xx with a non-JSON body (e.g. an edge timeout HTML page): never
        // stored, and no stale copy is better than telling the caller so.
        console.error(`[api] ${opts.label}: response body was not valid JSON`);
        failure = new Error(
          opts.invalidBodyMessage ?? `api.nemar.org ${opts.label} returned an invalid response`,
        );
      }
      if (parsed !== undefined) {
        if (store) {
          try {
            await store.set(url, { body, storedAt: now() });
          } catch (err) {
            console.warn(
              `[api-cache] write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        return parsed;
      }
    } else {
      // A 404 or 400 is an ordinary answer for the caller to handle (an unknown
      // dataset id); only a struggling service is worth a log line.
      if (res.status === 429 || res.status >= 500) {
        console.error(`[api] ${opts.label}: ${res.status} ${res.statusText}`);
      }
      failure = new UpstreamError(
        `api.nemar.org ${opts.label} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
  } catch (err) {
    failure = err;
  }

  // 4xx other than 429 means this request is wrong, not that the service is
  // struggling: a stale 200 would hide a real answer (a dataset that was
  // removed, an id that is malformed).
  const transient =
    !(failure instanceof UpstreamError) || failure.status === 429 || failure.status >= 500;
  if (stored && transient) {
    const ageS = Math.round((now() - stored.storedAt) / 1000);
    console.warn(
      `[api-cache] ${opts.label}: serving a copy ${ageS}s old after: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
    );
    return JSON.parse(stored.body) as T;
  }
  throw failure;
}
