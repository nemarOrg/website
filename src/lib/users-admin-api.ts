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
import type { ProfileGapAccount } from "./profile-gaps";
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
 * Row shape from `GET /admin/users`.
 *
 * The projection widened with nemar-cli #1251 / #1253 (`signup_source`,
 * `service_access`, `service_access_granted_at`, `given_name`,
 * `family_name`, `orcid`, `upload_access_requested_at`) so the awaiting-
 * approval queue can be read off the listing rather than one detail fetch per
 * row. It still does NOT carry city / country / affiliation / the why text —
 * those are `u.*` on {@link getAdminUser} only.
 *
 * Every added field is optional, and none of them is given a default: a
 * backend deployed before the widening omits the key, and coercing that
 * absence to `0`/`null` would report an uploader as browse-only or an open
 * request as never made. Absent means "this API cannot say"; the UI renders a
 * third state (see {@link adminTier}).
 */
export interface AdminUserListRow {
  readonly id: number;
  /**
   * NULL for ORCID/web signups that never set a username
   * (nemarOrg/nemar-cli#1012). Every write endpoint below except
   * {@link deleteUserById} and {@link approveUserById} is keyed by username,
   * so a null-username row cannot be revoked or role-changed through the
   * admin API — see {@link isActionable}. Approval is now reachable for them
   * by id, which is what nemar-cli ADR 0042 needs: a web account's upload
   * request has to be answerable.
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
  readonly signup_source?: string | null;
  /** INTEGER 0/1. `undefined` = a backend that predates nemar-cli #1251. */
  readonly service_access?: number | null;
  readonly service_access_granted_at?: string | null;
  readonly given_name?: string | null;
  readonly family_name?: string | null;
  readonly orcid?: string | null;
  /**
   * When this account asked for upload access (nemar-cli ADR 0042, migration
   * 0076). An OPEN request is this being set while `service_access` is 0;
   * once approved the stamp stays as the record of when they asked, which is
   * why {@link isAwaitingUploadApproval} reads both.
   */
  readonly upload_access_requested_at?: string | null;
}

/**
 * The access tier of a listed account, as the queue renders it.
 *
 * `"unknown"` is a real third state, not a fallback for tidiness: a listing
 * from a backend that predates `service_access` cannot say, and printing
 * "browse" there would tell an admin an uploader has no grant.
 */
export type AdminTier = "upload" | "browse" | "unknown";

export function adminTier(user: Pick<AdminUserListRow, "service_access">): AdminTier {
  if (user.service_access === undefined || user.service_access === null) return "unknown";
  return user.service_access === 1 ? "upload" : "browse";
}

export const ADMIN_TIER_LABELS: Record<AdminTier, string> = {
  upload: "Upload",
  browse: "Browse",
  unknown: "Unknown",
};

/**
 * True when this row has an OPEN upload-access request: it asked, and no
 * admin has answered.
 *
 * The grant is what closes a request, so `service_access = 0` is the "still
 * open" half rather than a second status column — the same predicate
 * `?awaiting_approval=1` applies server-side. Recomputed client-side anyway
 * so a row that arrives through another chip (a search, "All") still renders
 * its review card.
 *
 * A row whose `service_access` the backend did not send is NOT awaiting
 * approval: with the grant unknown, "asked and unanswered" cannot be
 * established, and guessing yes would put approved accounts in the queue.
 */
export function isAwaitingUploadApproval(
  user: Pick<AdminUserListRow, "service_access" | "upload_access_requested_at">,
): boolean {
  const requested = (user.upload_access_requested_at ?? "").trim().length > 0;
  return requested && user.service_access === 0;
}

/**
 * Whether an admin can approve this account (`POST /admin/approve/by-id/:id`).
 *
 * Mirrors `isApprovable` in nemar-cli `backend/src/routes/admin/users.ts`:
 * `verified` and `revoked` always — `revoked_iam_pending` is the same
 * DB-level "revoked" family for approval purposes — plus `pending` for an
 * ORCID-verified WEB signup, which is the one status the backend admits from
 * a source that has no username to be approved by.
 *
 * Two conditions the backend enforces are deliberately NOT mirrored here:
 *
 * - **A verified email.** Since nemar-cli ADR 0040 phase 2 approval requires
 *   one from every signup source, but `email_verified` on a listing row can
 *   be stale relative to a code the user redeemed a second ago. The backend
 *   refuses with a message naming exactly that ("User must verify their email
 *   address first"), which is more useful than a button that silently is not
 *   there. The review card warns instead.
 * - **A username.** Approval is keyed by numeric id precisely so a web row
 *   without one is reachable, so this is not gated on `isActionable` the way
 *   revoke and role change are.
 *
 * Extracted from `UserAdminRow.astro`, where it was a four-condition inline
 * boolean that no test could reach: dropping the `signup_source` guard — which
 * would offer Approve on every unverified CLI signup, for the backend to
 * refuse — changed nothing observable in the suite.
 */
export function canApproveUser(user: Pick<AdminUserListRow, "status" | "signup_source">): boolean {
  if (
    user.status === "verified" ||
    user.status === "revoked" ||
    user.status === "revoked_iam_pending"
  ) {
    return true;
  }
  return user.status === "pending" && user.signup_source === "web";
}

/**
 * Human text for a failed admin action, combining the two halves the backend
 * sends. These routes put a readable sentence in `error` (see this file's
 * header) and, on the approve routes, a second more specific one in
 * `message` — "User is not eligible for approval" plus "User must verify
 * their email address first; approval cannot skip the inbox check". Showing
 * only the first tells an admin nothing they can act on; showing only the
 * second drops the headline. Joined when they differ, deduped when they
 * don't.
 */
export function adminActionMessage(
  code: string | undefined,
  message: string | undefined,
  fallback: string,
): string {
  const head = (code ?? "").trim();
  const tail = (message ?? "").trim();
  if (head && tail && head !== tail) return `${head} — ${tail}`;
  return head || tail || fallback;
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
  /** Tiered-access grant (website ADR 0010; nemar-cli ADR 0040 makes admin
   *  approval its single writer). */
  readonly service_access?: number;
  readonly service_access_granted_at?: string | null;
  readonly upload_access_requested_at?: string | null;
  readonly signup_source?: string | null;
  /**
   * The why text from the upload-access request. It reuses `users.description`
   * (nemar-cli ADR 0042 — there is no request table, because there is no
   * second request), so on a CLI account created before that it may instead
   * hold the sign-up description. Rendered as the requester's own words
   * either way, never parsed.
   */
  readonly description?: string | null;
  readonly dataset_count: number;
  readonly active_tokens: number;
}

/**
 * The account shape `profileGaps` reads, from an admin detail row
 * (website#309), so the review card and the user page report exactly what the
 * account holder is told on their own dashboard.
 *
 * Built from the DETAIL row and never from a listing row: `GET /admin/users`
 * is an explicit column projection that carries no city or country, and a
 * field the listing does not select is not a field the user left blank —
 * reading one as the other would have an admin chasing someone over a column
 * nobody asked for.
 *
 * `status` is deliberately not passed. The admin lifecycle vocabulary
 * (`pending` / `verified` / `approved` / `revoked`) is not the session's
 * two-state one, and `email_verified` already carries the only fact the gap
 * list needs from it.
 */
export function gapAccountFromDetail(detail: AdminUserDetail): ProfileGapAccount {
  return {
    email_verified: detail.email_verified === 1,
    // Uncollapsed (`AdminUserRole | null`, not the session's collapsed
    // `"user" | "admin"`): `ProfileGapAccount["role"]` accepts both shapes so
    // the `orcid_verified` gap's admin/owner exemption reads the same "admin"
    // and "owner" whichever surface passed the account.
    role: detail.role,
    username: detail.username,
    given_name: detail.given_name ?? null,
    family_name: detail.family_name ?? null,
    orcid_verified: detail.orcid_verified === 1,
    github_username: detail.github_username,
    city: detail.city ?? null,
    country: detail.country ?? null,
  };
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

/**
 * Build the `GET /admin/users` query string. Exported so the parameter
 * spelling is testable without a fetch: `awaiting_approval=1` is a
 * server-side predicate (`upload_access_requested_at IS NOT NULL AND
 * service_access = 0`) that cannot be computed from what the listing used to
 * return, so getting the name or the value wrong silently returns every user
 * instead of the queue.
 */
export function adminUsersQuery(query: {
  status?: AdminUserStatus;
  role?: AdminUserRole;
  includeDeleted?: boolean;
  awaitingApproval?: boolean;
}): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.role) params.set("role", query.role);
  if (query.includeDeleted) params.set("include_deleted", "true");
  if (query.awaitingApproval) params.set("awaiting_approval", "1");
  return params.toString();
}

export async function listAdminUsers(
  query: {
    status?: AdminUserStatus;
    role?: AdminUserRole;
    includeDeleted?: boolean;
    awaitingApproval?: boolean;
  } = {},
  init: Init = {},
): Promise<AdminUserListResponse> {
  const qs = adminUsersQuery(query);
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
  /** `username` is nullable because {@link approveUserById} can address a
   *  web/ORCID row, which has none. `service_access` is echoed by the
   *  repair path (an already-`approved` row that was missing the grant). */
  readonly user: {
    readonly username: string | null;
    readonly email: string;
    readonly status: "approved";
    readonly service_access?: boolean;
  };
  /** Present on the repair path only: the status did not change, just the
   *  grant, so no approval email was sent. */
  readonly note?: string;
  readonly email_sent: boolean;
}

/**
 * Approve by stable numeric id (`POST /admin/approve/by-id/:id`).
 *
 * The only approve client, deliberately. `POST /admin/approve/:username`
 * still exists on the backend and is what the CLI uses, but it cannot address
 * a web/ORCID account, whose `username` is NULL by design (nemar-cli
 * migration 0026) — and under ADR 0040 approval IS the upload grant, so that
 * account would have no way to be granted one. The id-keyed route works for
 * CLI accounts identically, so keeping a second, weaker client here would
 * only invite a caller to pick the one that cannot do the job.
 *
 * The thrown error carries the backend's own sentences rather than a prefixed
 * one, because the message an admin needs here is specific: a `pending`
 * account with `email_verified = 0` is refused with "User must verify their
 * email address first; approval cannot skip the inbox check", which tells the
 * admin exactly what to ask the user for. See {@link adminActionMessage}.
 */
export async function approveUserById(id: number, init: Init = {}): Promise<ApproveUserResult> {
  const fetchImpl = init.fetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  const res = await fetchImpl(
    `${dashboardApiBase(init.cookieHeader)}/admin/approve/by-id/${encodeURIComponent(String(id))}`,
    { method: "POST", headers, credentials: "include", body: "{}", signal: resolveSignal(init) },
  );
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      adminActionMessage(detail.code, detail.message, res.statusText),
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
 * Fail-soft count of accounts with an OPEN upload-access request, for the
 * Users tab badge rendered by every admin page via `AdminLayout`.
 *
 * This used to count `status = "verified"`, which was the best available
 * approximation before nemar-cli ADR 0042: "verified with no grant" was every
 * base-tier account, whether or not anyone in it wanted to upload — a badge
 * reading several hundred, none of them actionable. `?awaiting_approval=1` is
 * the real predicate.
 *
 * Never throws — mirrors `fetchObservabilitySnapshot`'s contract in
 * `observability.ts` — because a transient nemar-cli hiccup must degrade to
 * "no badge shown" rather than break the shared admin shell on every page.
 */
export async function fetchAwaitingApprovalCount(init: Init = {}): Promise<number | null> {
  try {
    const { count } = await listAdminUsers(
      { awaitingApproval: true },
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

// ---------------------------------------------------------------------------
// Upload-access review details
// ---------------------------------------------------------------------------

/**
 * How many open requests get their full review card in one render.
 *
 * The listing does not carry city, country, affiliation or the request text —
 * `GET /admin/users` is an explicit column projection and only
 * `GET /admin/users/:username` selects `u.*` — so each of those costs its own
 * HTTP call. The queue is small by construction (a request is answered once
 * and never re-opened, nemar-cli ADR 0042) but nothing in the API caps what
 * comes back, so the fan-out is bounded here rather than trusted.
 */
export const REVIEW_DETAIL_LIMIT = 25;

export interface ReviewDetails {
  /** Keyed by `AdminUserListRow.id`. Absent for a row that was over the limit
   *  or whose fetch failed; `UserAdminRow` renders every listed field either
   *  way and only the enrichment goes missing. */
  readonly details: ReadonlyMap<number, AdminUserDetail>;
  /** Fetches that threw. Surfaced to the admin, because a card silently
   *  missing its location and request text looks like a user who supplied
   *  neither. */
  readonly failures: number;
  /** True when more open requests exist than the limit fetched. */
  readonly truncated: boolean;
}

/**
 * Fetch the review details for the open requests in a listing.
 *
 * Bounded and fail-soft, and the two are separate promises: the bound stops
 * an unpaginated queue from fanning out unboundedly, and the fail-soft stops
 * one bad row from costing the admin the Approve button on every other one.
 * A failure is COUNTED rather than swallowed — `null` details and "the user
 * left it blank" look identical on the card otherwise.
 *
 * Rows with no username are skipped: the detail route is username-keyed. In
 * practice there are none here — a username is a precondition of the request
 * itself (nemar-cli ADR 0042) — but the type allows it and the URL cannot.
 */
export async function loadReviewDetails(
  users: readonly AdminUserListRow[],
  init: Init & { readonly limit?: number } = {},
): Promise<ReviewDetails> {
  const limit = init.limit ?? REVIEW_DETAIL_LIMIT;
  const open = users.filter(isAwaitingUploadApproval);
  const fetchable = open.filter(
    (u): u is AdminUserListRow & { username: string } =>
      typeof u.username === "string" && u.username.length > 0,
  );
  const targets = fetchable.slice(0, limit);

  const details = new Map<number, AdminUserDetail>();
  let failures = 0;
  await Promise.all(
    targets.map(async (u) => {
      try {
        details.set(u.id, await getAdminUser(u.username, init));
      } catch (err) {
        console.warn(`[users-admin-api] review detail failed for ${u.username}`, err);
        failures += 1;
      }
    }),
  );

  // Counted over the OPEN requests, not the fetchable ones: an admin who sees
  // 30 cards and full detail on 25 needs to know about all five that are
  // short, whether the reason was the bound or a missing username.
  return { details, failures, truncated: open.length > limit };
}

// ---------------------------------------------------------------------------
// Admin action error copy
// ---------------------------------------------------------------------------

/**
 * Transport-level codes, which are the only ones that are NOT human text.
 * Every `/admin/users*` route puts a readable sentence straight in `error`
 * (see this file's header), so `code` is usually already the right thing to
 * show; these two come from the proxy in front of them.
 */
const TRANSPORT_MESSAGES: Record<string, string> = {
  upstream_unreachable: "Can't reach the user service. Try again in a moment.",
  unauthenticated: "Sign in again to continue.",
};

/** The shape both renderers below read off a thrown `DashboardApiError`,
 *  declared structurally so this module does not have to import the class
 *  (it already imports it for throwing, but the renderers are also handed
 *  plain `unknown` from a catch). */
interface ApiFailure {
  readonly code?: string;
  readonly message: string;
}

function asApiFailure(err: unknown): ApiFailure | null {
  if (!(err instanceof DashboardApiError)) return null;
  return { code: err.code, message: err.message };
}

/**
 * Copy for a failed admin action, for every route EXCEPT approve.
 *
 * Prefers `code`, because on these routes the code IS the sentence
 * ("Cannot revoke your own access", "Owner access required") and the
 * client-side `message` only wraps it in a prefix.
 */
export function adminActionErrorText(err: unknown): string {
  const failure = asApiFailure(err);
  if (!failure) return err instanceof Error ? err.message : "Action failed.";
  if (failure.code && TRANSPORT_MESSAGES[failure.code]) return TRANSPORT_MESSAGES[failure.code];
  return failure.code || failure.message;
}

/**
 * Copy for a failed approve, which is the exception and the reason these are
 * two functions rather than one.
 *
 * `approveUserById` already builds its message from BOTH halves of the body
 * via {@link adminActionMessage}, and on the refusal that matters the useful
 * half is the second one: an ineligible account answers
 * `error: "User is not eligible for approval"` plus
 * `message: "User must verify their email address first; approval cannot
 * skip the inbox check"`. Preferring `code` here would return the headline
 * and throw away the only sentence that says what to do.
 */
export function approveErrorText(err: unknown): string {
  const failure = asApiFailure(err);
  if (!failure) return adminActionErrorText(err);
  if (failure.code && TRANSPORT_MESSAGES[failure.code]) return TRANSPORT_MESSAGES[failure.code];
  return failure.message;
}
