import type { APIRoute } from "astro";
import { robotsBody } from "../lib/robots";

/**
 * Dynamic robots.txt (epic #923 Phase 6; AI crawler policy + sitemap link
 * added in website#284 phase 1, issue #285). Static `public/robots.txt`
 * can't vary by host, but this repo serves production (`app.nemar.org`,
 * `nemar.org`, `ww2.nemar.org`), staging (`test.nemar.org`), and preview
 * (`*.pages.dev`) off the same build -- only production should be
 * crawlable. Mirrors the `X-Robots-Tag` header the middleware stamps on
 * non-prod hosts (see `isNoindexHost` in `lib/host.ts`); this is the
 * crawler-facing half of that same policy.
 *
 * On production hosts the body also allow-lists named AI crawlers ahead of
 * the general `User-agent: *` rule and points at `/sitemap.xml`. See
 * `lib/robots.ts` for the actual content -- this route is intentionally
 * just a hostname-in, body-out wrapper around it.
 */
export const GET: APIRoute = ({ request }) => {
  const url = new URL(request.url);
  return new Response(robotsBody(url.hostname), { headers: { "Content-Type": "text/plain" } });
};
