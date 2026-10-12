/**
 * What the code deep inside a render needs from the request that started it,
 * without threading it through every signature.
 *
 * Today that is one thing: `waitUntil`, so a cache can refresh a stale entry
 * after the response has been sent (`api-cache.ts`). The Workers runtime hands
 * it to the middleware as `locals.runtime.ctx`; the lib code that fetches data
 * has no Astro context, so the middleware opens this scope around the render
 * and the lib reads it back.
 *
 * `AsyncLocalStorage` (available under `nodejs_compat`, which both wrangler
 * configs set) follows the request across `await`s. Outside a request, or in a
 * runtime with no `waitUntil` (`astro dev`, unit tests), there is no store, and
 * callers fall back to doing the work inline.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Keeps the isolate alive for `work` after the response is sent. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

const scope = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` visible to everything it awaits. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return scope.run(ctx, fn);
}

/** The current request's `waitUntil`, or `undefined` when there is none. */
export function currentWaitUntil(): RequestContext["waitUntil"] {
  return scope.getStore()?.waitUntil;
}
