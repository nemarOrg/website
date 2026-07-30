import type { APIRoute } from "astro";
import { buildInfo } from "../lib/build-info";

/**
 * Machine-readable build identity (website#214).
 *
 * One build serves four production domains plus `test.nemar.org`, and the two
 * environments deploy through different mechanisms (Cloudflare's GitHub
 * integration for prod, `deploy-test.yml` for staging). "Is staging actually
 * ahead of production right now?" therefore has no answer from the outside
 * without something like this.
 *
 * The `x-nemar-version` response header carries the same identity on every
 * SSR response, which is the quicker check; this endpoint exists for anything
 * that wants to parse rather than grep, and so the version is reachable
 * without inspecting headers.
 *
 * `no-store` is deliberate and load-bearing. The middleware's edge cache is
 * opt-in (`isPublicCacheable` requires an explicit `public` + `max-age`), so
 * omitting a cache header would already be enough — but a *stale* answer here
 * is worse than no answer, because the entire point is to report what is
 * running right now. Stating it defends against a future default flipping.
 */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildInfo(), null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
