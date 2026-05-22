import type { APIRoute } from "astro";
import { getSession } from "../../../../../lib/auth";
import { applyAdminDeny, getPublicationRequestRecord } from "../../../datasets/_store";

// MOCK: replaced when nemar-cli#572 (cookie-aware auth on /admin) lands.
// Real backend: POST api.nemar.org/admin/publish/:id/deny writes the denial
// reason to the publication_requests row and sends a denial email to the
// requester. The mock applies the state transition and the email is the
// real backend's job.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const reason =
    typeof (body as { reason?: unknown })?.reason === "string"
      ? (body as { reason: string }).reason.trim()
      : "";
  if (reason.length === 0) {
    return json({ ok: false, error: "missing_field", message: "Provide a reason." }, 400);
  }
  if (reason.length > 2000) {
    return json({ ok: false, error: "missing_field", message: "Reason is too long." }, 400);
  }

  const result = applyAdminDeny(id, reason);
  if (!result.ok) {
    return json({ ok: false, error: "not_invitable", message: result.reason }, 409);
  }

  const record = getPublicationRequestRecord(id);
  return json({ status: record?.status }, 200);
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
