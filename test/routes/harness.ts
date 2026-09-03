import type { APIContext, APIRoute } from "astro";

/**
 * Shared harness for the route-level tests in this directory (website#294
 * fix 10).
 *
 * WHY THESE TESTS LIVE UNDER `test/` RATHER THAN BESIDE THE ROUTES, unlike
 * every other test in this repo. Every file under `src/pages/` is a route,
 * `.test.ts` included: a `sitemap.xml.test.ts` placed there builds without
 * complaint and lands in the route manifest as `/sitemap.xml.test` (verified
 * by grepping `dist/_worker.js/index.js` after a build), so it would ship
 * test code into the Worker bundle and serve a route with no handler. Hence
 * the tests sit outside the pages tree; vitest's default include glob matches
 * a `.test.ts` file anywhere in the repo, so nothing else has to be
 * configured for them to run.
 *
 * WHAT IS STUBBED, AND WHAT IS NOT. Only the network boundary
 * (`globalThis.fetch`) and Astro's own `redirect` helper, which is a
 * one-line `Location` response the framework would otherwise supply. Every
 * line of route logic -- the visibility gate, the status split, the header
 * set, the body -- is the real code path. This matches the convention the
 * client tests already follow (`src/lib/api.test.ts`,
 * `src/lib/qa-aggregate.test.ts`): assign `globalThis.fetch`, restore it
 * afterwards.
 */

/**
 * A stub network. Returns a `Response` for a URL it recognises and
 * `undefined` for anything else, which {@link withFetch} turns into a thrown
 * error rather than a silent empty body -- an unexpected upstream call is a
 * finding, not a default.
 */
export type FetchStub = (url: string) => Response | undefined;

/** JSON response helper for a {@link FetchStub}. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Run `body` with `globalThis.fetch` replaced by `stub`, restoring the real
 * one afterwards even if the assertion throws. Records every URL requested so
 * a test can assert that a route did NOT call upstream at all.
 */
export async function withFetch<T>(
  stub: FetchStub,
  body: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const response = stub(url);
    if (!response) {
      return Promise.reject(new Error(`unstubbed fetch: ${url}`));
    }
    return Promise.resolve(response);
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Drive a route handler with a plain `Request`, the way the Worker does.
 *
 * `redirect` reproduces Astro's helper exactly (an empty body plus a
 * `Location` header at the requested status) so a route's redirect is
 * observable as a real `Response`. The cast is the seam: an `APIContext`
 * carries a dozen fields these routes never read, and constructing them would
 * assert nothing.
 */
export async function callRoute(
  route: APIRoute,
  url: string,
  params: Record<string, string | undefined> = {},
): Promise<Response> {
  const request = new Request(url);
  const context = {
    request,
    url: new URL(url),
    params,
    props: {},
    redirect: (path: string, status = 302) =>
      new Response(null, { status, headers: { Location: path } }),
  } as unknown as APIContext;
  return await route(context);
}
