import type { APIRoute } from "astro";
import { getSession } from "../../../../lib/auth";
import { findForOwner, getPublishStatus, setPublishStatus } from "../_store";

// MOCK: replaced when nemar-cli#572 (cookie-aware auth) lands.
// Real backend: POST api.nemar.org/datasets/:id/publish/request runs BIDS
// validation status checks and creates a publication_request row. This mock
// just flips the in-memory publish status to "requested" so the dashboard
// can render the awaiting-review state.
export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ ok: false, error: "bad_content_type" }, 415);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  const id = params.id;
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const dataset = findForOwner(session.user.email, id);
  if (!dataset) return json({ ok: false, error: "not_found" }, 404);
  if (dataset.visibility !== "private" || dataset.concept_doi) {
    return json({ ok: false, error: "already_published" }, 409);
  }
  const current = getPublishStatus(session.user.email, id);
  if (
    current?.status === "requested" ||
    current?.status === "approving" ||
    current?.status === "published"
  ) {
    return json({ ok: false, error: "already_in_flight" }, 409);
  }

  const next = {
    dataset_id: id,
    status: "requested" as const,
    requested_at: new Date().toISOString(),
    requested_by: session.user.email,
  };
  setPublishStatus(session.user.email, next);
  return json(next, 200);
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
