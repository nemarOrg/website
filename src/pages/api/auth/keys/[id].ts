import type { APIRoute } from "astro";
import { forwardAuthMutation, jsonResponse } from "../../../../lib/auth-proxy";
import { revokeApiKeyDev } from "../../../../lib/device-authorize-dev";

/**
 * Revoke a named API key by row id (epic #1272 phase 2, nemarOrg/website#316;
 * nemar-cli ADR 0047) — the Settings CLI-keys card's Revoke button, behind
 * `ConfirmDialog`.
 *
 * `:id` is always the numeric row id from the server-rendered list here —
 * `current` (revoke the presenting bearer's own key) is meaningful only on
 * the CLI's bearer path, which this website never has a credential for.
 * Production forwards to `${apiBase}/auth/keys/:id`, whose refusal is
 * `key_not_found` (404) for an id that is not numeric, not owned by this
 * account, or already revoked — the backend does not distinguish those three,
 * so neither does this proxy. `astro dev` revokes against the same in-memory
 * store `api/auth/keys.ts` creates into.
 */
export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const id = params.id ?? "";

  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const result = revokeApiKeyDev(id);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return forwardAuthMutation(request, `/auth/keys/${encodeURIComponent(id)}`);
};
