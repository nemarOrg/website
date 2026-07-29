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
import { DEFAULT_REQUEST_TIMEOUT_MS, resolveSignal } from "./request-deadline";
import type { Dataset } from "./types";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. See {@link COLLABORATOR_TIMEOUTS_MS}. */
  readonly timeoutMs?: number;
};

/**
 * Per-operation request deadlines, exported so the difference between them is
 * a pinned contract rather than loose magic numbers.
 *
 * - `list` — a D1-backed read that SSRs `/dataset/:id/collaborators`, and the
 *   page's primary content; base deadline.
 * - `invite` — grants repo access on the dataset's GitHub repo as well as
 *   writing the row, so it carries a third-party round-trip the read does not.
 *   It is a user-initiated click with a spinner, so a longer wait degrades one
 *   form rather than the whole render.
 */
export const COLLABORATOR_TIMEOUTS_MS = {
  list: DEFAULT_REQUEST_TIMEOUT_MS,
  invite: 15_000,
} as const;

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
  init: Init = {},
): Promise<CollaboratorListResponse> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/datasets/${encodeURIComponent(datasetId)}/collaborators`,
    {
      method: "GET",
      headers,
      credentials: "include",
      signal: resolveSignal(init, COLLABORATOR_TIMEOUTS_MS.list),
    },
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
  init: Init = {},
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
      signal: resolveSignal(init, COLLABORATOR_TIMEOUTS_MS.invite),
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
