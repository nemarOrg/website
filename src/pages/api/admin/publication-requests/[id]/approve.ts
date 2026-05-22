import type { APIRoute } from "astro";
import { getSession } from "../../../../../lib/auth";
import { applyAdminApprove, getPublicationRequestRecord } from "../../../datasets/_store";

// MOCK: replaced when nemar-cli#572 (cookie-aware auth on /admin) lands.
// Real backend: POST api.nemar.org/admin/publish/:id/approve runs a 17-step
// orchestrator (BIDS CI gate, GitHub repo public, DOI mint, Zenodo deposit,
// S3 object lock, etc.). The mock collapses every step into a single
// transition to "published" so the dashboard surface can show the result.
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
  if (session.user.role !== "admin") {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const id = params.id;
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const result = applyAdminApprove(id);
  if (!result.ok) {
    return json(
      { ok: false, error: "not_invitable", message: "This request is no longer pending." },
      409,
    );
  }

  const record = getPublicationRequestRecord(id);
  if (!record) {
    // applyAdminApprove just wrote this record; a missing lookup here is a
    // programming error, not a user-visible state we should masquerade as success.
    console.error("[admin/approve] record missing after successful applyAdminApprove for", id);
    return json({ ok: false, error: "internal_error" }, 500);
  }
  return json({ status: record.status }, 200);
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
