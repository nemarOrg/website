/**
 * Notices: the site-wide banner feed plus the admin CRUD behind it.
 *
 * Two different backends, deliberately:
 * - `GET /notices` (nemar-cli `backend/src/index.ts`, `optionalAuthMiddleware`)
 *   is the public read path. It returns only active notices and filters by
 *   the caller's role: anonymous sees `scope: "all"`, a member also sees
 *   `"members"`, an admin/owner also sees `"admins"`. It fails soft to
 *   `{ notices: [] }` rather than erroring.
 * - `GET|POST|DELETE /admin/notices` (backend/src/routes/admin/notices.ts,
 *   behind `authMiddleware` + `adminMiddleware`) is the admin path, and its
 *   list includes expired notices so an admin can see and clean them up.
 *
 * There is no update endpoint. A notice is created and deleted; editing
 * means delete-and-recreate, which mints a new id — see
 * {@link dismissalKey} for why that matters to dismissal state.
 */
import { apiBase, dashboardApiBase, readError } from "./api-base";
import { DashboardApiError } from "./dashboard-api";

/**
 * Severity, constrained to these three by BOTH `z.enum` in
 * `admin/notices.ts` and a `CHECK` constraint in migration 0016. Adding a
 * fourth (e.g. a distinct `maintenance`) requires an upstream migration,
 * so the website maps presentation onto these three rather than inventing
 * levels the backend would reject.
 */
export type NoticeLevel = "info" | "warning" | "critical";

/** Audience. The public endpoint applies this server-side from the session. */
export type NoticeScope = "all" | "admins" | "members";

export const NOTICE_LEVELS: readonly NoticeLevel[] = ["info", "warning", "critical"];
export const NOTICE_SCOPES: readonly NoticeScope[] = ["all", "admins", "members"];

/**
 * A notice row. Mirrors migration 0016 plus the service's projection in
 * `backend/src/services/notices.ts` — `created_by` is a column but is not
 * projected by either endpoint, so it is deliberately absent here.
 * `expires_at` is the only nullable field.
 */
export interface Notice {
  readonly id: number;
  readonly message: string;
  readonly level: NoticeLevel;
  readonly scope: NoticeScope;
  readonly created_at: string;
  /** RFC3339 with offset, as `POST /admin/notices` requires. Null = never expires. */
  readonly expires_at: string | null;
}

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  readonly timeoutMs?: number;
  /**
   * Explicit API origin, overriding the cookie-presence heuristic in
   * `dashboardApiBase`.
   *
   * That heuristic ("has a cookie header, therefore SSR") holds for the
   * authenticated admin clients but breaks for the *public* notices feed:
   * an anonymous visitor's request has no cookie, so the heuristic returns
   * the relative `/api/v1`, which is unfetchable from the server and throws
   * "Failed to parse URL". Because the banner fails soft, the symptom is
   * not an error — it is a banner that silently never appears for
   * signed-out visitors, which is most of the marketing surface.
   *
   * `src/pages/api/notices.ts` therefore passes {@link apiBase} explicitly.
   */
  readonly baseUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The banner is chrome on every page, so it gets a tight deadline: a page
 * that renders without its banner is far better than one that waits on it.
 */
export const BANNER_TIMEOUT_MS = 2500;

/**
 * Combines a caller-supplied abort signal with a deadline. Mirrors
 * `resolveSignal` in `imports-admin-api.ts` / `users-admin-api.ts`, for the
 * reason documented there: a `try/catch` around `fetch` covers a request
 * that fails, not one that opens and never writes a response.
 */
function resolveSignal(init: Init, fallbackMs = DEFAULT_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? fallbackMs);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
}

/** API origin for a call: explicit override, else the cookie heuristic. */
function baseFor(init: Init): string {
  return init.baseUrl ?? dashboardApiBase(init.cookieHeader);
}

function headersFor(init: Init, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withBody) headers["Content-Type"] = "application/json";
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  return headers;
}

/**
 * True when this notice's expiry has passed.
 *
 * Computed here rather than trusted from the server because of
 * **nemar-cli#1024**: the backend filters with
 * `expires_at > datetime('now')`, comparing an ISO-8601 value (`T`
 * separator, stored that way because `POST` validates with
 * `z.string().datetime({offset: true})`) against SQLite's
 * `YYYY-MM-DD HH:MM:SS`. Those are compared as strings, and `T` (0x54)
 * sorts after a space (0x20), so whenever the date halves match the notice
 * is judged unexpired. Net effect: a notice expiring *later today* keeps
 * being served until the next UTC day.
 *
 * The nemar-cli CLI already computes expiry client-side for the same reason
 * (`src/commands/admin.ts`), so this matches existing behaviour rather than
 * inventing a private workaround. When #1024 lands this becomes a harmless
 * second opinion.
 *
 * An unparseable `expires_at` is treated as NOT expired: dropping a banner
 * because a timestamp was malformed would hide a message an admin meant to
 * show, which is the worse failure.
 */
export function isNoticeExpired(notice: Pick<Notice, "expires_at">, now: Date): boolean {
  if (!notice.expires_at) return false;
  const expiry = Date.parse(notice.expires_at);
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}

const LEVEL_RANK: Record<NoticeLevel, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Most urgent first, then most recently created.
 *
 * Reproduces the backend's own `ORDER BY` (services/notices.ts) so the
 * stack reads the same whichever endpoint supplied it, and so a transient
 * `critical` maintenance banner always sits above a long-lived `info`
 * announcement rather than below it.
 *
 * Total: an unparseable `created_at` sorts last within its level instead of
 * throwing inside the comparator.
 */
export function sortNotices(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => {
    const byLevel = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    if (byLevel !== 0) return byLevel;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
}

/** Active (unexpired) notices, most urgent first. */
export function activeNotices(notices: readonly Notice[], now: Date): Notice[] {
  return sortNotices(notices.filter((n) => !isNoticeExpired(n, now)));
}

/**
 * Storage key for a dismissal.
 *
 * Keyed by notice id, so dismissing a standing announcement never
 * suppresses a maintenance banner posted later, and vice versa — each
 * notice is dismissed on its own. Ids are stable for a notice's lifetime
 * (there is no update endpoint; an "edit" is a delete plus a create, which
 * mints a new id and correctly re-surfaces the banner to everyone).
 */
export function dismissalKey(id: number): string {
  return `nemar:notice-dismissed:${id}`;
}

/**
 * Where a dismissal is remembered, by severity.
 *
 * `info` and `warning` persist in `localStorage`: a standing announcement
 * (say a months-long "the site has moved" banner) that reappeared on every
 * visit after being dismissed would be an irritation, not information.
 *
 * `critical` uses `sessionStorage`, so it can be dismissed to get it out of
 * the way but returns on the next visit while it is still live. An active
 * outage or data-loss warning should keep asserting itself; that is the
 * whole point of the level.
 */
export function dismissalStore(level: NoticeLevel): "local" | "session" {
  return level === "critical" ? "session" : "local";
}

/**
 * Active notices for the current visitor, from the public endpoint.
 *
 * Never throws — the banner is chrome, and a notices outage must not break
 * page render or surface an error to a visitor who was never told a banner
 * was coming. Returns `[]` on any failure, which is also what the backend
 * itself does on a DB error.
 *
 * Applies {@link activeNotices} on top of whatever the server returns:
 * server-side expiry filtering is currently unreliable (nemar-cli#1024).
 */
export async function fetchActiveNotices(init: Init = {}, now = new Date()): Promise<Notice[]> {
  try {
    const fetchImpl = init.fetch ?? fetch;
    const res = await fetchImpl(`${baseFor(init)}/notices`, {
      method: "GET",
      headers: headersFor(init, false),
      credentials: "include",
      signal: resolveSignal(init, init.timeoutMs ?? BANNER_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { notices?: readonly Notice[] };
    return activeNotices(body.notices ?? [], now);
  } catch (err) {
    console.warn(
      "[notices-api] banner fetch failed, rendering no notices:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Admin list: every notice, including expired ones, newest first. */
export async function listAdminNotices(init: Init = {}): Promise<Notice[]> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${baseFor(init)}/admin/notices`, {
    method: "GET",
    headers: headersFor(init, false),
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not list notices: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  const body = (await res.json()) as { notices?: readonly Notice[] };
  return [...(body.notices ?? [])];
}

export interface CreateNoticeInput {
  readonly message: string;
  readonly level: NoticeLevel;
  readonly scope: NoticeScope;
  /** RFC3339 with offset; omit for a notice that never expires. */
  readonly expires_at?: string;
}

/**
 * Converts an `<input type="datetime-local">` value to the RFC3339 form the
 * backend demands.
 *
 * `datetime-local` yields `2026-07-25T14:30` — no seconds, no zone — which
 * `z.string().datetime({ offset: true })` rejects outright. `new Date(v)`
 * interprets that as the admin's *local* time (which is what they typed and
 * meant), and `toISOString()` renders it as UTC with a `Z`, accepted by that
 * validator.
 *
 * Returns undefined for empty input (a notice with no expiry) and for an
 * unparseable value, so the caller can reject it rather than post garbage.
 */
export function toRfc3339(datetimeLocalValue: string): string | undefined {
  const trimmed = datetimeLocalValue.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export async function createNotice(input: CreateNoticeInput, init: Init = {}): Promise<Notice> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${baseFor(init)}/admin/notices`, {
    method: "POST",
    headers: headersFor(init, true),
    credentials: "include",
    body: JSON.stringify(input),
    signal: resolveSignal(init),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not create notice: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
  return (await res.json()) as Notice;
}

export async function deleteNotice(id: number, init: Init = {}): Promise<void> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${baseFor(init)}/admin/notices/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: headersFor(init, true),
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new DashboardApiError(
      `Could not delete notice: ${detail.message ?? detail.code ?? res.statusText}`,
      res.status,
      detail.code,
    );
  }
}
