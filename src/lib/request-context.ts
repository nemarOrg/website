/**
 * What the code deep inside a render needs from the request that started it,
 * without threading it through every signature.
 *
 * Three things: `waitUntil`, so a cache can refresh a stale entry after the
 * response has been sent; a flag the cache raises when it answered this
 * request from data that was not fresh, so the middleware can keep such a page
 * out of the edge cache for long (`api-cache.ts`, `middleware.ts`); and the
 * service binding to the API Worker with the visitor this request acts for, so
 * a call to the API can be counted as that visitor's (`api-fetch.ts`). The
 * Workers runtime hands `waitUntil` to the middleware as `locals.runtime.ctx`;
 * the lib code that fetches data has no Astro context, so the middleware opens
 * this scope around the render and the lib reads it back.
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

/** What a Workers service binding offers that this site uses: `fetch`, with the caller's own URL. */
export interface ApiBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface RequestContext {
  /** Keeps the isolate alive for `work` after the response is sent. */
  readonly waitUntil?: (work: Promise<unknown>) => void;
  /** The service binding to the API Worker, where the project has one configured. */
  readonly apiBinding?: ApiBinding;
  /** The visitor this request acts for: the `CF-Connecting-IP` it arrived with. */
  readonly visitorIp?: string;
  /** Raised by {@link markDataStale}: this render used data that was not fresh. */
  dataStale?: boolean;
  /** Set once the middleware has read `dataStale`; a later {@link markDataStale} is too late to act on. */
  sealed?: boolean;
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

/** The service binding and visitor of the current request, or `undefined` outside one. */
export function currentApiRoute(): Pick<RequestContext, "apiBinding" | "visitorIp"> | undefined {
  const store = scope.getStore();
  return store ? { apiBinding: store.apiBinding, visitorIp: store.visitorIp } : undefined;
}

let warnedOutsideRequest = false;
let warnedTooLate = false;

/**
 * Say that this request was answered from data that was not fresh (or missing),
 * so the page built from it must not stay at the edge for long.
 *
 * It cannot say so quietly when it has nowhere to say it: outside any request
 * (the scope was lost, which would silently stop every stale page being marked)
 * or after the middleware has already read the flag (a catalog read made while
 * the response streamed). Each is logged once per isolate.
 */
export function markDataStale(): void {
  const store = scope.getStore();
  if (!store) {
    if (!warnedOutsideRequest) {
      warnedOutsideRequest = true;
      console.warn(
        "[request-context] stale data was used outside a request context; the page cannot be marked (logged once per isolate)",
      );
    }
    return;
  }
  if (store.sealed && !warnedTooLate) {
    warnedTooLate = true;
    console.error(
      "[request-context] stale data was marked after the response was built; its cache lifetime was not shortened (logged once per isolate)",
    );
  }
  store.dataStale = true;
}

/** Whether {@link markDataStale} was called for this request. */
export function dataWasStale(ctx: RequestContext): boolean {
  return ctx.dataStale === true;
}

/** Declare that the flag has been read: any later {@link markDataStale} is too late to act on. */
export function sealRequestContext(ctx: RequestContext): void {
  ctx.sealed = true;
}

/** Forget the once-per-isolate warnings. For the unit tests only. */
export function resetRequestContextWarningsForTests(): void {
  warnedOutsideRequest = false;
  warnedTooLate = false;
}
