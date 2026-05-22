import type { APIRoute } from "astro";
import { getSession } from "../../../../lib/auth";
import { findForOwner, getPublishStatus, removeForOwner } from "../_store";

// MOCK: replaced when nemar-cli#575 (owner-callable delete-draft) lands.
// Real backend: DELETE api.nemar.org/datasets/:id with owner-of-draft scope
// (currently admin-only; #575 makes owners able to delete their own drafts).
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
    return json(
      { ok: false, error: "not_deletable", message: "Only drafts can be self-deleted." },
      403,
    );
  }
  const status = getPublishStatus(session.user.email, id);
  if (status?.status === "requested" || status?.status === "approved") {
    return json(
      {
        ok: false,
        error: "not_deletable",
        message: "Cancel the publication request before deleting.",
      },
      403,
    );
  }

  removeForOwner(session.user.email, id);
  return json({ ok: true }, 200);
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
