import type { APIRoute } from "astro";
import { forwardAuthMutation, jsonResponse } from "../../../lib/auth-proxy";
import { createApiKeyDev } from "../../../lib/device-authorize-dev";

/**
 * Mint a named API key (epic #1272 phase 2, nemarOrg/website#316; nemar-cli
 * ADR 0047) — the Settings CLI-keys card's create form, and the paste-key
 * fallback for a machine that cannot open a browser.
 *
 * `GET /auth/keys` is deliberately NOT proxied here: the list is
 * server-rendered in `settings.astro` with a pinned `Origin: Astro.url.origin`
 * (the cookie path 403s `"Origin not allowed"` without one), so there is
 * nothing for a same-origin browser-side GET to reach. Only the two
 * mutations — create (here) and revoke (`./keys/[id].ts`) — need a route,
 * matching `api/auth/profile.ts`'s PATCH-only shape.
 *
 * Production forwards to `${apiBase}/auth/keys`; `astro dev` has no backend,
 * so it mints against the in-memory dev store (`device-authorize-dev.ts`)
 * instead — the same store `/cli/authorize` uses in dev, so a key created
 * here shows up in that page's dev-mode confirm flow too.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    let body: { name?: unknown };
    try {
      body = (await request.json()) as { name?: unknown };
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : "";
    const result = createApiKeyDev(name);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return forwardAuthMutation(request, "/auth/keys");
};
