import type { APIRoute } from "astro";
import { apiBase } from "../../lib/api-base";
import { fetchActiveNotices } from "../../lib/notices-api";

/**
 * Same-origin JSON feed for the site-wide notice banner.
 *
 * Exists as its own route rather than going through `/api/v1/[...path]`
 * because this one is deliberately *public*: the banner renders for
 * anonymous visitors on the marketing host too, and the generic proxy is
 * shaped for authenticated dashboard/admin traffic.
 *
 * **Why the banner fetches instead of being server-rendered.** The public
 * pages set real edge-cache headers with long stale-while-revalidate
 * windows — `index.astro` allows 12 h stale, `dataset/[id].astro` 24 h. A
 * banner rendered into that HTML would be cached with it: a new outage
 * notice would not appear until `s-maxage` elapsed, and a resolved one
 * would linger for the whole SWR window. Keeping the banner out of the
 * cached document and fetching it from this `no-store` endpoint means page
 * HTML stays cacheable and the banner is always current.
 *
 * Role filtering is the backend's job (`optionalAuthMiddleware` on
 * `GET /notices`): forwarding the cookie is what lets a signed-in admin see
 * `scope: "admins"` notices. On the marketing host no cookie exists (it is
 * `Domain=app.nemar.org`), so the request is anonymous and only
 * `scope: "all"` comes back — exactly the intended behaviour.
 */
export const GET: APIRoute = async ({ request }) => {
  const cookieHeader = request.headers.get("cookie") ?? undefined;
  // `baseUrl` is passed explicitly rather than left to the cookie-presence
  // heuristic. An anonymous visitor sends no cookie, which would resolve to
  // the relative `/api/v1` — unfetchable server-side. Since the banner fails
  // soft, that surfaces not as an error but as a banner that never appears
  // for signed-out visitors, i.e. most of the marketing surface.
  //
  // Never throws — see fetchActiveNotices. A notices outage degrades to an
  // empty array (no banner), never to an error the visitor has to see.
  const notices = await fetchActiveNotices({ cookieHeader, baseUrl: apiBase() });
  return new Response(JSON.stringify({ notices }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // The entire point of this route. It must never be edge-cached, and
      // it must never be cached per-user either: the response varies by
      // role via the forwarded cookie.
      "Cache-Control": "no-store",
    },
  });
};
