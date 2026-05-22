import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";
import { listForOwner } from "./_store";

// MOCK: removed in Phase 5 cutover (nemar-cli#572).
// Real backend: GET api.nemar.org/datasets?mine=true reads the session cookie
// and returns the owner's datasets (plus collaborator-shared ones in a future
// phase). This mock reads the in-memory seed store keyed by session email.
export const GET: APIRoute = async ({ request, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  const url = new URL(request.url);
  const limit = toInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = toInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const { datasets, total } = listForOwner(session.user.email, { limit, offset });

  return json(
    {
      datasets,
      count: datasets.length,
      total_count: total,
      limit,
      offset,
    },
    200,
  );
};

function toInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
