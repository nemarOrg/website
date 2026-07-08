import type { APIRoute } from "astro";
import { isProductionHost } from "../lib/host";

/**
 * Dynamic robots.txt (epic #923 Phase 6). Static `public/robots.txt` can't
 * vary by host, but this repo serves production (`app.nemar.org`,
 * `ww2.nemar.org`), staging (`test.nemar.org`), and preview (`*.pages.dev`)
 * off the same build — only production should be crawlable. Mirrors the
 * `X-Robots-Tag` header the middleware stamps on non-prod hosts
 * (see `isNoindexHost` in `lib/host.ts`); this is the crawler-facing half
 * of that same policy.
 */
export const GET: APIRoute = ({ request }) => {
  const url = new URL(request.url);
  const body = isProductionHost(url.hostname)
    ? "User-agent: *\nAllow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
};
