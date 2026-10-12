/**
 * What the code deep inside a render needs from the request that started it,
 * without threading it through every signature.
 *
 * Two things: `waitUntil`, so a cache can refresh a stale entry after the
 * response has been sent, and a flag the cache raises when it answered this
 * request from data that was not fresh, so the middleware can keep such a page
 * out of the edge cache for long (`api-cache.ts`, `middleware.ts`). The Workers
 * runtime hands `waitUntil` to the middleware as `locals.runtime.ctx`; the lib
 * code that fetches data has no Astro context, so the middleware opens this
 * scope around the render and the lib reads it back.
 *
 * `AsyncLocalStorage` (available under `nodejs_compat`, which both wrangler
 * configs set) follows the request across `await`s. Outside a request, or in a
 * runtime with no `waitUntil` (`astro dev`, unit tests), there is no store, and
 * callers fall back to doing the work inline.
 */

// This site's CI installs no Node type definitions on purpose (a `@types/node`
// would change the global types of a Workers project), but some machines have
// them anyway, found in a parent directory's `node_modules`. The import is
// untyped where they are missing and typed where they are present, so it is
// typed by hand below instead, and the same code passes on both.
// @ts-ignore TS2591 where Node types are absent; a `@ts-expect-error` would fail where they exist
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Keeps the isolate alive for `work` after the response is sent. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
  /** Raised by {@link markDataStale}: this render used data that was not fresh. */
  dataStale?: boolean;
}

interface Scope {
  run<R>(store: RequestContext, fn: () => R): R;
  getStore(): RequestContext | undefined;
}

const scope: Scope = new (AsyncLocalStorage as unknown as new () => Scope)();

/** Run `fn` with `ctx` visible to everything it awaits. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return scope.run(ctx, fn);
}

/** The current request's `waitUntil`, or `undefined` when there is none. */
export function currentWaitUntil(): RequestContext["waitUntil"] {
  return scope.getStore()?.waitUntil;
}

/** Say that this request was answered from data that was not fresh. A no-op outside a request. */
export function markDataStale(): void {
  const store = scope.getStore();
  if (store) store.dataStale = true;
}

/** Whether {@link markDataStale} was called for this request. */
export function dataWasStale(ctx: RequestContext): boolean {
  return ctx.dataStale === true;
}
