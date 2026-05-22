/**
 * Collaborators API client: list per-dataset collaborators and invite a new
 * one by username. Point these calls at `api.nemar.org/datasets/:id/{collabora
 * tors,invite}` once nemar-cli#572 (cookie-aware auth) and #578 (invite by
 * email) land.
 */
import type { AuthSession } from "./auth";
import { DashboardApiError } from "./dashboard-api";
import type { Dataset } from "./types";

export interface Collaborator {
  readonly username: string;
  readonly github_username: string;
  readonly access_type: "invited" | "requested";
  readonly granted_at: string;
  readonly granted_by_username: string;
}

export interface CollaboratorListResponse {
  readonly dataset_id: string;
  readonly collaborators: readonly Collaborator[];
  readonly count: number;
}

export async function listCollaborators(
  datasetId: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch; cookieHeader?: string } = {},
): Promise<CollaboratorListResponse> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(`/api/datasets/${encodeURIComponent(datasetId)}/collaborators`, {
    method: "GET",
    headers,
    credentials: "include",
    signal: init.signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not list collaborators: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as CollaboratorListResponse;
}

export interface InviteResponse {
  readonly message: string;
  readonly dataset_id: string;
  readonly invitee: string;
}

export async function inviteCollaborator(
  datasetId: string,
  username: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<InviteResponse> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`/api/datasets/${encodeURIComponent(datasetId)}/collaborators`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
    signal: init.signal,
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Invite failed: ${detail.message ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as InviteResponse;
}

/**
 * True when the caller is allowed to add/remove collaborators on this
 * dataset. Mirrors the owner-or-admin gate enforced on the real backend;
 * keep in sync when nemar-cli's collaborator write permission changes.
 *
 * Note: the username is derived from the email local part because the
 * mock's `code/verify.ts` builds usernames that way. Once nemar-cli#572
 * adds a real `username` field to the session payload, switch to it.
 */
export function isCollaboratorManager(
  session: AuthSession | null,
  dataset: Pick<Dataset, "owner_username">,
): boolean {
  if (!session) return false;
  if (session.user.role === "admin") return true;
  const username = session.user.email.split("@")[0] ?? "";
  return Boolean(dataset.owner_username) && username === dataset.owner_username;
}

async function readError(res: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return {};
    const code = typeof body.error === "string" ? body.error : undefined;
    const message =
      typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;
    return { message, code };
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}
