import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";
import type { PublicationStatus } from "../../../lib/dashboard-api";
import { listAllPublicationRequests } from "../datasets/_store";

type PubStatusValue = PublicationStatus["status"];
const VALID_STATUSES: ReadonlyArray<PubStatusValue> = [
  "none",
  "requested",
  "approving",
  "published",
  "denied",
  "blocked",
];

// MOCK: replaced when nemar-cli#572 (cookie-aware auth on /admin) lands.
// Real backend: GET api.nemar.org/admin/publish/requests?status=... lists
// every publication_request row visible to admins, sorted by requested_at.
export const GET: APIRoute = async ({ request, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);
  if (session.user.role !== "admin") {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const statusFilter: PubStatusValue | undefined =
    rawStatus && VALID_STATUSES.includes(rawStatus as PubStatusValue)
      ? (rawStatus as PubStatusValue)
      : undefined;
  const requests = listAllPublicationRequests(
    statusFilter ? { status: statusFilter } : undefined,
  ).map((r) => ({
    dataset_id: r.datasetId,
    dataset_name: r.datasetName,
    owner_email: r.ownerEmail,
    status: r.status,
  }));

  return json({ requests, count: requests.length }, 200);
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
