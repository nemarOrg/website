/**
 * Admin users API client: list/inspect/approve/revoke/role-change/delete
 * accounts, plus a fail-soft awaiting-approval count for the Users tab
 * badge. Follows the `admin-api.ts` client pattern: SSR callers pass
 * `cookieHeader` and hit `api.nemar.org` directly; browser callers omit it
 * and go through the same-origin `/api/v1` proxy (`dashboardApiBase` in
 * `./api-base.ts`) so the `Domain=app.nemar.org` session cookie attaches
 * automatically.
 *
 * Backend contract: `nemar-cli` backend/src/routes/admin/users.ts
 * (registerUsersRoutes), mounted at `/admin/*` behind `authMiddleware` +
 * `adminMiddleware`; role-change and delete additionally require
 * `ownerMiddleware`. Unlike the publish routes (short codes like
 * "not_found"), these handlers put a human-readable sentence straight in
 * the `error` field (e.g. "Cannot revoke your own access") and rarely set
 * `message`. `readError()` maps `error` -> `code`, so every throw below
 * prefers `detail.message ?? detail.code ?? res.statusText` — the code IS
 * the useful text here.
 *
 * Every fetch carries a deadline (`resolveSignal` from `request-deadline.ts`):
 * a plain `try/catch` only covers outright network rejection, not a connection
 * that opens and never writes a response. That matters more here than in most
 * clients — `fetchAwaitingApprovalCount` is awaited from the shared
 * `AdminLayout` on every admin page, so a hung upstream without a deadline
 * would hang the entire admin section, not just this one client.
 */
import { dashboardApiBase, readError } from "./api-base";
import { DashboardApiError } from "./dashboard-api";
import { resolveSignal } from "./request-deadline";

/**
 * `"revoked_iam_pending"` is a real value the backend can persist (partial
 * IAM cleanup on revoke) but is not one of the four lifecycle stages an
 * admin filters by; callers of {@link listAdminUsers} only ever pass the
 * four canonical stages.
 */
export type AdminUserStatus =
  | "pending"
  | "verified"
  | "approved"
  | "revoked"
  | "revoked_iam_pending";
export type AdminUserRole = "owner" | "admin" | "member";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  /** Abort the request after this many ms. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
};

/**
 * Decorative chrome gets a tighter deadline than primary content: the
 * awaiting-approval badge renders from the shared `AdminLayout`, so it is on
 * the critical path of *every* admin page. Waiting the full base deadline for
 * a number the page reads fine without would make a degraded backend feel like
 * a broken one.
 */
const BADGE_TIMEOUT_MS = 2000;

/**
 * Row shape from `GET /admin/users`. A narrow, explicit column projection
 * (id, username, email, github_username, status, email_verified, role,
 * created_at, approved_at, revoked_at) — it does not carry profile fields
 * or `service_access`; use {@link getAdminUser} for those.
 */
export interface AdminUserListRow {
  readonly id: number;
  /**
   * NULL for ORCID/web signups that never set a username
   * (nemarOrg/nemar-cli#1012, open). Every write endpoint below except
   * {@link deleteUserById} is keyed by username, so a null-username row
   * cannot be approved/revoked/role-changed through the admin API today —
   * see {@link isActionable}.
   */
  readonly username: string | null;
  readonly email: string;
  readonly github_username: string | null;
  readonly status: AdminUserStatus;
  /** D1 stores this as an INTEGER (0/1), not a JSON boolean. */
  readonly email_verified: number;
  readonly role: AdminUserRole | null;
  readonly created_at: string;
  readonly approved_at: string | null;
  readonly revoked_at: string | null;
}

export interface AdminUserListResponse {
  readonly users: readonly AdminUserListRow[];
  readonly count: number;
}

/**
 * Detail shape from `GET /admin/users/:username`, which selects `u.*` plus
 * two computed aggregates. Genuinely wider than {@link AdminUserListRow}
 * (profile + tiered-access columns the list query never selects), so it's
 * modeled as its own type rather than an extension of the list row.
 */
export interface AdminUserDetail {
  readonly id: number;
  readonly username: string | null;
  readonly email: string;
  readonly github_username: string | null;
  readonly status: AdminUserStatus;
  readonly email_verified: number;
  readonly role: AdminUserRole | null;
  readonly created_at: string;
  readonly approved_at: string | null;
  readonly revoked_at: string | null;
  readonly given_name?: string | null;
  readonly family_name?: string | null;
  readonly orcid?: string | null;
  readonly orcid_verified?: number | null;
  readonly city?: string | null;
  readonly country?: string | null;
  readonly affiliation?: string | null;
  /** Tiered-access grant (ADR 0010 / nemar-cli#1013 Phase 1). The grant
   *  queue UI is out of scope for this phase (nemar-cli#1023) — shown
   *  read-only where present. */
  readonly service_access?: number;
  readonly service_access_granted_at?: string | null;
  readonly dataset_count: number;
  readonly active_tokens: number;
}

interface AdminUserDetailResponse {
  readonly user: AdminUserDetail;
}

/**
 * True when an admin can act on this user through the write endpoints
 * (approve/revoke/role change). False for rows with a NULL `username`
 * (nemarOrg/nemar-cli#1012) — those endpoints are keyed by username, so
 * there is no addressable URL for them yet. {@link deleteUserById} is
 * exempt: it's keyed by numeric id specifically so it can still reach
 * these rows.
 */
export function isActionable(user: Pick<AdminUserListRow, "username">): boolean {
  return typeof user.username === "string" && user.username.length > 0;
}

/**
 * True when `userId` is the signed-in admin's own account. The backend
 * rejects self-revoke, self-role-change, and self-delete (see users.ts:
 * "Cannot revoke your own access" / "Cannot change your own role" / "Cannot
 * delete your own account") to prevent lockout, but only after a typed
 * ConfirmDialog confirmation — so the UI needs to know this up front to
 * avoid walking someone through a destructive-looking flow that was never
 * possible. Self-approve is NOT blocked by the backend, so callers must not
 * fold this into an approve gate.
 *
 * Compared as strings deliberately: `AdminUserListRow.id`/`AdminUserDetail.id`
 * are numeric (D1 row ids), but `AuthUser.id` is a string and, in the local
 * dev mock, non-numeric (e.g. `"dev-qa_nemar_admin"`). `Number(sessionUserId)`
 * would silently evaluate to `NaN` for that case and never match, so the dev
 * render would look "fixed" while staying broken for every real account.
 */
export function isSelf(userId: number, sessionUserId: string): boolean {
  return String(userId) === String(sessionUserId);
}

export async function listAdminUsers(
  query: { status?: AdminUserStatus; role?: AdminUserRole; includeDeleted?: boolean } = {},
  init: Init = {},
): Promise<AdminUserListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.role) params.set("role", query.role);
  if (query.includeDeleted) params.set("include_deleted", "true");
  const qs = params.toString();
  const url = `${dashboardApiBase(init.cookieHeader)}/admin/users${qs ? `?${qs}` : ""}`;
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not list users: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as AdminUserListResponse;
}

export async function getAdminUser(username: string, init: Init = {}): Promise<AdminUserDetail> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/users/${encodeURIComponent(username)}`,
    { method: "GET", headers, credentials: "include", signal: resolveSignal(init) },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not load user: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  const body = (await res.json()) as AdminUserDetailResponse;
  return body.user;
}

export interface ApproveUserResult {
  readonly message: string;
  readonly user: { readonly username: string; readonly email: string; readonly status: "approved" };
  readonly email_sent: boolean;
}

export async function approveUser(username: string, init: Init = {}): Promise<ApproveUserResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/approve/${encodeURIComponent(username)}`,
    { method: "POST", headers, credentials: "include", body: "{}", signal: resolveSignal(init) },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Approve failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as ApproveUserResult;
}

export interface RevokeUserResult {
  readonly message: string;
  readonly user: { readonly username: string; readonly status: string };
  /** Present on a 207 partial-success (IAM cleanup couldn't fully complete);
   *  the revoke itself still succeeded — tokens + DB access are gone. */
  readonly warning?: string;
  readonly email_sent: boolean;
  readonly repos_removed?: number;
  readonly failed_removals?: readonly string[];
  readonly iam_revoked?: boolean;
}

export async function revokeUser(username: string, init: Init = {}): Promise<RevokeUserResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/revoke/${encodeURIComponent(username)}`,
    { method: "POST", headers, credentials: "include", body: "{}", signal: resolveSignal(init) },
  );
  // 207 (partial IAM-cleanup failure) is still `res.ok` (in the 200-299
  // range) — the revoke itself succeeded; the page surfaces `warning`.
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Revoke failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as RevokeUserResult;
}

export interface ChangeRoleResult {
  readonly message: string;
  readonly user: { readonly username: string; readonly role: AdminUserRole };
  readonly tokens_revoked?: number;
  readonly warning?: string;
}

export async function changeUserRole(
  username: string,
  role: AdminUserRole,
  init: Init = {},
): Promise<ChangeRoleResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/users/${encodeURIComponent(username)}/role`,
    {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ role }),
      signal: resolveSignal(init),
    },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Role change failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as ChangeRoleResult;
}

export interface DeleteUserResult {
  readonly deleted: true;
  readonly id: number;
  readonly already_deleted?: boolean;
  readonly masked?: boolean;
}

export async function deleteUserById(id: number, init: Init = {}): Promise<DeleteUserResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/users/by-id/${encodeURIComponent(String(id))}`,
    { method: "DELETE", headers, credentials: "include", body: "{}", signal: resolveSignal(init) },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Delete failed: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as DeleteUserResult;
}

/**
 * Fail-soft count of users in the `"verified"` (awaiting-approval) status,
 * for the Users tab badge rendered by every admin page via `AdminLayout`.
 * Never throws — mirrors `fetchObservabilitySnapshot`'s contract in
 * `observability.ts` — because a transient nemar-cli hiccup must degrade to
 * "no badge shown" rather than break the shared admin shell on every page.
 */
export async function fetchAwaitingApprovalCount(init: Init = {}): Promise<number | null> {
  try {
    const { count } = await listAdminUsers(
      { status: "verified" },
      { ...init, timeoutMs: init.timeoutMs ?? BADGE_TIMEOUT_MS },
    );
    return count;
  } catch (err) {
    // `null` (couldn't ask) and `0` (nobody waiting) both render as "no
    // badge", so without a log line a broken users endpoint is
    // indistinguishable from an empty approval queue — and the
    // indistinguishable one reads as good news. `console.*` from the
    // Worker lands in Workers Logs.
    console.warn(
      "[users-admin-api] awaiting-approval badge degraded to null:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
