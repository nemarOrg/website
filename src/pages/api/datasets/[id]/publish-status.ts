import type { APIRoute } from "astro";
import { getSession } from "../../../../lib/auth";
import { findForOwner, getPublishStatus } from "../_store";

// MOCK: replaced when nemar-cli#572 (cookie-aware auth) lands.
// Real backend: GET api.nemar.org/datasets/:id/publish/status returns the
// publication_requests row plus BIDS CI status.
export const GET: APIRoute = async ({ params, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  const id = params.id;
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const dataset = findForOwner(session.user.email, id);
  if (!dataset) return json({ ok: false, error: "not_found" }, 404);

  const status = getPublishStatus(session.user.email, id) ?? {
    dataset_id: id,
    status: "none" as const,
  };
  return json(status, 200);
};

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
