import type { APIRoute } from "astro";
import { getSession } from "../../../../lib/auth";
import {
  addCollaboratorForDataset,
  findDatasetAnyOwner,
  findForOwner,
  listCollaboratorsForDataset,
} from "../_store";

// MOCK: replaced when nemar-cli#572 (cookie-aware auth) + #578 (invite by
// email) land. Real backend:
//   GET  /datasets/:id/collaborators
//   POST /datasets/:id/invite  (today takes { username })
// The two endpoints are folded into one route here for the same dataset id;
// the cutover splits them back out.

export const GET: APIRoute = async ({ params, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  const datasetId = params.id;
  if (!datasetId) return json({ ok: false, error: "missing_id" }, 400);

  const found = findDatasetAnyOwner(datasetId);
  if (!found) return json({ ok: false, error: "not_found" }, 404);

  if (!canSeeCollaborators(session.user, found.ownerEmail)) {
    // Mirror the surface as 404 rather than 403 — non-owners shouldn't even
    // know this dataset has a collaborators surface.
    return json({ ok: false, error: "not_found" }, 404);
  }

  const collaborators = listCollaboratorsForDataset(found.ownerEmail, datasetId);
  return json({ dataset_id: datasetId, collaborators, count: collaborators.length }, 200);
};

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

  const datasetId = params.id;
  if (!datasetId) return json({ ok: false, error: "missing_id" }, 400);

  const found = findDatasetAnyOwner(datasetId);
  if (!found) return json({ ok: false, error: "not_found" }, 404);

  if (!canManageCollaborators(session.user, found.ownerEmail)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const username =
    typeof (body as { username?: unknown })?.username === "string"
      ? (body as { username: string }).username.trim()
      : "";
  if (username.length < 1 || username.length > 64) {
    return json({ ok: false, error: "missing_field", message: "Provide a username." }, 400);
  }

  const inviterUsername = session.user.email.split("@")[0] ?? "admin";
  const result = addCollaboratorForDataset(found.ownerEmail, datasetId, {
    username,
    github_username: username,
    access_type: "invited",
    granted_at: new Date().toISOString(),
    granted_by_username: inviterUsername,
  });
  if (!result.ok) {
    if (result.reason === "duplicate") {
      return json({ ok: false, error: "not_invitable", message: "Already a collaborator." }, 409);
    }
    return json(
      { ok: false, error: "not_invitable", message: "Cannot invite the dataset owner." },
      409,
    );
  }

  return json(
    {
      message: `User '${username}' invited to ${datasetId}`,
      dataset_id: datasetId,
      invitee: username,
    },
    200,
  );
};

function canSeeCollaborators(user: { email: string; role: string }, ownerEmail: string): boolean {
  if (user.role === "admin") return true;
  if (user.email.trim().toLowerCase() === ownerEmail.trim().toLowerCase()) return true;
  // A collaborator on the dataset can also see the list (read-only). We
  // don't have a quick reverse-index, so check the owner's collab list.
  const collabs = findForOwner(ownerEmail, "");
  void collabs;
  const callerUsername = user.email.split("@")[0] ?? "";
  const list = listCollaboratorsForDataset(ownerEmail, "");
  if (list.some((c) => c.username === callerUsername)) return true;
  return false;
}

function canManageCollaborators(
  user: { email: string; role: string },
  ownerEmail: string,
): boolean {
  if (user.role === "admin") return true;
  return user.email.trim().toLowerCase() === ownerEmail.trim().toLowerCase();
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
