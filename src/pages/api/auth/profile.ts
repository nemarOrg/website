import type { APIRoute } from "astro";
import { isValidGithubUsername } from "../../../lib/auth";
import { reissueDevSession } from "../../../lib/auth-dev";
import { forwardAuthMutation, jsonResponse } from "../../../lib/auth-proxy";

/**
 * Self-service profile edit (#135): GitHub handle (validated; required to
 * publish), city + country (required for export-control screening), and
 * affiliation (optional). Name is NOT editable here — it's ORCID-canonical.
 * Production forwards a PATCH to `${apiBase}/auth/profile`; `astro dev` merges
 * the patch into the local dev session so the page reflects it on reload.
 */
export const PATCH: APIRoute = async ({ request, locals }) => {
  if (import.meta.env.DEV) {
    if (!locals.session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    const patch: Record<string, string> = {};
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    if ("github_username" in body) {
      const gh = str(body.github_username).replace(/^@/, "");
      if (gh.length > 0 && !isValidGithubUsername(gh)) {
        return jsonResponse({ ok: false, error: "invalid_github_username" }, 400);
      }
      patch.github_username = gh;
    }
    if ("city" in body) patch.city = str(body.city);
    if ("country" in body) patch.country = str(body.country);
    if ("affiliation" in body) patch.affiliation = str(body.affiliation);

    const user = { ...locals.session.user, ...patch };
    const cookie = await reissueDevSession(locals.session.user, patch);
    return new Response(JSON.stringify({ ok: true, user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie,
      },
    });
  }

  return forwardAuthMutation(request, "/auth/profile");
};
