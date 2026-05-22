import type { APIRoute } from "astro";
import { getSession } from "../../../../lib/auth";

// MOCK: removed in Phase 5 cutover (nemar-cli#572 + #573).
// Real backend deploys the BIDS validation workflow, applies branch
// protection, and enables auto-merge. This mock just returns success and
// logs the finalize call for dev visibility.
export const POST: APIRoute = async ({ params, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  const id = params.id;
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  console.info(`[datasets/mock] finalized ${id} for ${session.user.email}`);

  return json(
    {
      ok: true,
      message: "Dataset finalized (mock).",
      dataset: {
        dataset_id: id,
        status: "active",
        visibility: "private",
        github_url: `https://github.com/nemarDatasets/${id}`,
      },
      workflows: {
        deployed: ["bids-validation"],
        already_present: [],
      },
    },
    200,
  );
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
