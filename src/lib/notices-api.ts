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
 * Severity, constrained by BOTH a `z.enum` in `admin/notices.ts` and a
 * `CHECK` constraint on the `notices` table (nemar-cli#1025). Ordered here
 * most urgent first — {@link LEVEL_RANK} depends on that.
 *
 * - `critical`     live outage, data at risk
 * - `warning`      degraded right now
 * - `maintenance`  planned or in-progress work window
 * - `announcement` good news: a conference, a release, a milestone
 * - `tip`          low-key hint or standing note
 *
 * `info` was renamed to `tip` upstream. It is absent here because it can no
 * longer be *read back*: the backend still accepts it on write and
 * normalizes it to `tip` before storing, so nothing that posts `info`
 * breaks — but no response will ever carry it.
 */
export type NoticeLevel = "critical" | "warning" | "maintenance" | "announcement" | "tip";

/** Audience. The public endpoint applies this server-side from the session. */
export type NoticeScope = "all" | "admins" | "members";

export const NOTICE_LEVELS: readonly NoticeLevel[] = [
  "critical",
  "warning",
  "maintenance",
  "announcement",
  "tip",
];
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

/** Urgency rank, derived from NOTICE_LEVELS so the two can't disagree. */
const LEVEL_RANK: Record<NoticeLevel, number> = Object.fromEntries(
  NOTICE_LEVELS.map((level, index) => [level, index]),
) as Record<NoticeLevel, number>;

/**
 * Levels a backend may still return that aren't in the current vocabulary.
 * `info` was renamed to `tip` by nemar-cli#1025, which is on that repo's
 * `dev` but not yet promoted to `main` — so production `api.nemar.org` still
 * serves `info` today.
 */
const LEGACY_LEVEL_ALIASES: Readonly<Record<string, NoticeLevel>> = { info: "tip" };

/**
 * Maps whatever the backend sent onto a level this frontend can render.
 *
 * The website and the API deploy independently, so at any moment either can
 * be ahead: production serves `info` while this build knows only `tip`, and
 * after a future vocabulary change the reverse could hold. Both directions
 * have to be survivable, because the failure is ugly and silent — an
 * unmapped level yields `undefined` from `LEVEL_RANK`, `NaN` out of the sort
 * comparator (which makes the *whole* stack order arbitrary, not just that
 * row) and a `site-notice--<unknown>` class with no styling, so the banner
 * renders unreadable rather than not at all.
 *
 * Unknown levels fall back to `tip`: the quietest treatment, on the
 * principle that a message we can't classify should still be shown, just
 * not shouted.
 */
export function presentationLevel(level: string): NoticeLevel {
  if ((NOTICE_LEVELS as readonly string[]).includes(level)) return level as NoticeLevel;
  return LEGACY_LEVEL_ALIASES[level] ?? "tip";
}

/** One run of a notice message: literal text, or a URL to render as a link. */
export type MessageSegment =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "link"; readonly value: string };

/**
 * Matches an explicit http(s) URL.
 *
 * Anchored on the scheme deliberately — that is what makes the result safe
 * to assign to `href`. A looser pattern (bare `www.`, or "anything with a
 * dot") would eventually match something whose scheme is attacker-chosen,
 * and `javascript:alert(1)` in an href is script execution. Requiring
 * `https?://` means the scheme can never come from the message.
 *
 * The trailing class excludes `.,;:!?'"` so ordinary sentence punctuation
 * after a URL isn't swallowed into it ("see https://nemar.org." should link
 * the URL, not the full stop). Parentheses are excluded from the body for
 * the same reason with "(see https://nemar.org)" — the tradeoff is that a
 * URL genuinely containing parens is cut short, which is rarer in a short
 * operational banner than a parenthesised aside.
 */
const URL_PATTERN = /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g;

/**
 * Splits a message into text and link runs.
 *
 * Returns data rather than markup on purpose: the banner builds real DOM
 * nodes from it and the admin list renders it through Astro's escaping, so
 * neither path ever concatenates HTML. That is the property that keeps an
 * admin-authored message from becoming an injection vector, and it is why
 * this is a pure function with its own tests instead of a regex applied
 * inline at two call sites.
 */
export function linkifyMessage(message: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of message.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ type: "text", value: message.slice(cursor, start) });
    segments.push({ type: "link", value: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < message.length) segments.push({ type: "text", value: message.slice(cursor) });
  return segments;
}

/**
 * Most urgent first, then most recently created.
 *
 * Reproduces the backend's own `ORDER BY` (services/notices.ts) so the
 * stack reads the same whichever endpoint supplied it, and so a transient
 * `maintenance` or `critical` banner always sits above a long-lived `tip`
 * or `announcement` rather than below it.
 *
 * Total: this is a plain string comparison, not a date parse, so a garbled
 * `created_at` can never throw here — it just lands wherever it sorts
 * lexicographically. The `?? ""` guards only against a *missing* value,
 * which the type says can't happen but the unvalidated `res.json()` cast
 * means it can; without it a null would throw on `.localeCompare` inside a
 * comparator during SSR, and Astro drops a page whose render throws.
 */
export function sortNotices(notices: readonly Notice[]): Notice[] {
  return [...notices].sort((a, b) => {
    const byLevel = LEVEL_RANK[presentationLevel(a.level)] - LEVEL_RANK[presentationLevel(b.level)];
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
 * Levels describing live or imminent operational state. These re-assert on
 * the next visit even after being dismissed — see {@link dismissalStore}.
 */
const OPERATIONAL_LEVELS: readonly NoticeLevel[] = ["critical", "warning", "maintenance"];

/**
 * Where a dismissal is remembered, by severity.
 *
 * The split is *operationally live* vs *read-once*, not raw severity:
 *
 * - `critical` / `warning` / `maintenance` use `sessionStorage`, so they can
 *   be dismissed to get them out of the way but return on the next visit
 *   while still live. An outage, a degradation, or an upcoming maintenance
 *   window should keep asserting itself until it expires — that is what the
 *   levels are for.
 * - `announcement` / `tip` persist in `localStorage`. A conference notice or
 *   a months-long "the site has moved" banner that reappeared on every visit
 *   after being dismissed would be an irritation, not information.
 */
export function dismissalStore(level: string): "local" | "session" {
  return OPERATIONAL_LEVELS.includes(presentationLevel(level)) ? "session" : "local";
}

/**
 * Resolves the `Storage` a notice's dismissal belongs in, or null when
 * storage is unreachable.
 *
 * `localStorage`/`sessionStorage` **throw on property access** in some
 * privacy modes and in sandboxed iframes — not on use, on access — so this
 * has to be inside the try, not just the get/set calls.
 *
 * Takes the two stores as arguments rather than reaching for the globals so
 * it is unit-testable with real `Storage` objects (jsdom's are genuine
 * implementations, not mocks).
 */
export function resolveDismissalStorage(
  level: string,
  getLocal: () => Storage,
  getSession: () => Storage,
): Storage | null {
  try {
    return dismissalStore(level) === "session" ? getSession() : getLocal();
  } catch {
    return null;
  }
}

/**
 * True when this notice has already been dismissed.
 *
 * Fails to `false` — "not dismissed", i.e. show the notice. That is the safe
 * direction: an unreadable store means an already-dismissed banner reappears
 * (mildly annoying), never that a live banner stays hidden (information
 * lost).
 */
export function isNoticeDismissed(notice: Pick<Notice, "id">, storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(dismissalKey(notice.id)) === "1";
  } catch {
    return false;
  }
}

/**
 * Records a dismissal. Returns whether it will actually persist, so a caller
 * can tell "dismissed for good" from "dismissed until reload" — the banner
 * closes either way, because the click asked for that much regardless.
 */
export function rememberNoticeDismissal(
  notice: Pick<Notice, "id">,
  storage: Storage | null,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(dismissalKey(notice.id), "1");
    return true;
  } catch {
    // Quota exceeded, or a store that reads but refuses writes.
    return false;
  }
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
