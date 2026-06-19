/**
 * Collaborators API client: list per-dataset collaborators and invite a new
 * one. SSR callers pass `cookieHeader` and hit `api.nemar.org` directly;
 * browser callers go through the same-origin `/api/v1` proxy (see
 * `dashboardApiBase` in `./api-base.ts`) so the session cookie attaches
 * automatically without broadening it to other `*.nemar.org` hosts.
 */
import { dashboardApiBase, readError } from "./api-base";
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
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(datasetId)}/collaborators`,
    { method: "GET", headers, credentials: "include", signal: init.signal },
  );
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

/** Invite a collaborator by NEMAR username via POST /datasets/:id/invite. */
export async function inviteCollaborator(
  datasetId: string,
  username: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch; cookieHeader?: string } = {},
): Promise<InviteResponse> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(datasetId)}/invite`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ username }),
      signal: init.signal,
    },
  );
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
 * dataset. Mirrors the owner-or-admin gate enforced on the backend.
 *
 * Username is derived from the email local part because the backend session
 * payload does not yet expose a dedicated `username` field (nemar-cli#572).
 * When #572 ships, replace `session.user.email.split("@")[0]` with
 * `session.user.username`.
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
