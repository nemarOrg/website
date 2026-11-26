import type { APIRoute } from "astro";
import { apiBase } from "../../../../../../lib/api-base";
import { apiFetch } from "../../../../../../lib/api-fetch";
import { getSession, readSessionCookie } from "../../../../../../lib/auth";
import { proxyAdminQuality } from "../../../../../../lib/quality-views/admin-proxy";

/**
 * The same-origin proxy of the admin quality mount (website phase W9, #588): a run's recording
 * record and its declared files, for the run drill-down. Everything it decides is
 * `proxyAdminQuality`'s (`src/lib/quality-views/admin-proxy.ts`), which names nemar-cli's
 * obligations one by one. `ALL`, so every method reaches the one handler and is refused there
 * unless it is GET. The route's own params are never read: `rest` is taken from the raw pathname.
 */
export const ALL: APIRoute = ({ request, locals, cookies }) => {
  const found = readSessionCookie(cookies, request.headers.get("cookie"));
  return proxyAdminQuality(request, {
    session: getSession(locals),
    sessionCookie: found?.value ? `${found.name}=${found.value}` : null,
    apiBase: apiBase(),
    fetch: apiFetch,
  });
};
