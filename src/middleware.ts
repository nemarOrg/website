import type { MiddlewareHandler } from "astro";
import { apiBase } from "./lib/api-base";
import { type AuthSession, type AuthUser, SESSION_COOKIE_NAME } from "./lib/auth";
import { verifyDevSession } from "./lib/auth-dev";
import { getCrossHostRedirect, getRetiredRedirect, hostMode, isNoindexHost } from "./lib/host";

/**
 * Content-Security-Policy shipped on every SSR page response.
 *
 * This lives in the middleware, NOT in `public/_headers`: the site is
 * `output: "server"`, so @astrojs/cloudflare emits an Advanced-Mode
 * `_worker.js` and every route is server-rendered through it. Cloudflare
 * Pages applies `_headers` only to *static asset* responses, never to
 * `_worker.js` output, so a CSP in `_headers` would never reach the pages it
 * protects. The worker sees every SSR response here, so that's where it goes.
 *
 * Directive rationale (validated against the built client bundle):
 *   - script-src 'unsafe-inline'  — the theme-bootstrap in Base.astro is
 *     `is:inline`; Astro emits no CSP nonces by default. All other scripts
 *     bundle to /_astro/*.js ('self').
 *   - script-src 'wasm-unsafe-eval' — zarrita's blosc/lz4/zstd codecs are
 *     WebAssembly (WebAssembly.instantiate), blocked under a default
 *     script-src. Permits WASM compilation only, not JS eval().
 *   - script-src 'unsafe-eval' (only on /dataset/* — see routeNeedsUnsafeEval)
 *     — those same numcodecs codecs are Emscripten+embind modules whose glue
 *     crafts invoker functions via the Function constructor at decode time,
 *     which CSP classifies as eval and 'wasm-unsafe-eval' does NOT cover.
 *     Without it every zarr chunk read throws "Failed to decode chunk via
 *     codec blosc" in-browser. Scoped to the signal-viewer route (the only
 *     page that loads the codecs) so every other page keeps the strict policy.
 *   - style-src 'unsafe-inline'   — Astro inline scoped <style> blocks.
 *   - connect-src *.nemar.org       — api/data/dashboard/zarr client fetches.
 *   - connect-src raw.githubusercontent.com — dataset/[id].astro fetches the
 *     per-version README.md straight from the GitHub raw host client-side.
 *   - img-src 'self' data:          — all images are local; markdown emits no <img>.
 *
 * README-borne script injection is already blocked at the markdown sanitizer
 * (it strips <script>, unit-tested), so this is defense-in-depth.
 */
/** Strict script-src for every route. The signal-viewer route widens this by
 * appending 'unsafe-eval' (see routeNeedsUnsafeEval); nothing else does. */
const SCRIPT_SRC_BASE = "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'";

/**
 * The interactive signal viewer is dynamically imported only on the dataset
 * detail route (`/dataset/[id]`). It pulls in zarrita, whose numcodecs
 * blosc/zstd/lz4 codecs are Emscripten+embind WASM: their invoker glue calls
 * the Function constructor at decode time, which the browser treats as eval.
 * `'wasm-unsafe-eval'` permits WASM compilation but NOT that, so those routes
 * need `'unsafe-eval'`. Scoping it here keeps every non-viewer page strict.
 *
 * Exported for the middleware unit tests.
 */
export function routeNeedsUnsafeEval(pathname: string): boolean {
  return pathname.startsWith("/dataset/");
}

/** Build the Content-Security-Policy for a given request path. */
export function contentSecurityPolicy(pathname: string): string {
  const scriptSrc = routeNeedsUnsafeEval(pathname)
    ? `${SCRIPT_SRC_BASE} 'unsafe-eval'`
    : SCRIPT_SRC_BASE;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "connect-src 'self' https://*.nemar.org https://raw.githubusercontent.com",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Path-independent security response headers applied to every SSR page the
 * worker serves (cross-host redirects are exempt — they carry no body to
 * protect). Defined once so the three serve paths (passthrough, cache HIT,
 * cache MISS) can't drift. Static asset responses (/_astro/*, images) get
 * `nosniff` from the trimmed `public/_headers` instead, since those never hit
 * this worker. The Content-Security-Policy is added separately because it
 * varies by route.
 *
 * Exported (with the strict base CSP folded in) for the middleware unit tests.
 */
const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/**
 * Applied to every redirect this middleware issues (website#183).
 *
 * A bare `301` with no `Cache-Control` is heuristically cacheable, and
 * browsers cache permanent redirects aggressively and persistently. That
 * matters because both redirect decisions here encode a *route
 * classification* — a deploy-time choice that can change — rather than a
 * fact about the world.
 *
 * It has already changed once: `/api/notices` was classified marketing-only
 * and 301'd off the app host (website#181). Every browser that hit it in
 * that window could hold that redirect indefinitely, so the server-side fix
 * never reaches those clients. The redirect must not outlive the deploy that
 * created it.
 *
 * Cost is nil: these are empty-body responses on paths that are, by
 * definition, being requested on the wrong host.
 */
const NO_STORE_HEADER: Readonly<Record<string, string>> = { "Cache-Control": "no-store" };

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  ...STATIC_SECURITY_HEADERS,
  "Content-Security-Policy": contentSecurityPolicy("/"),
};

/**
 * Mutate `headers` in place with the security header set for `pathname`.
 * `noindex` (epic #923 Phase 6) additionally stamps `X-Robots-Tag` so
 * staging/preview hosts never get indexed; defaults false so callers on the
 * production hosts are unaffected.
 */
export function applySecurityHeaders(headers: Headers, pathname: string, noindex = false): void {
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("Content-Security-Policy", contentSecurityPolicy(pathname));
  if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
}

/** Apply the security headers to a response and return it (passthrough paths). */
function withSecurityHeaders(response: Response, pathname: string, noindex = false): Response {
  applySecurityHeaders(response.headers, pathname, noindex);
  return response;
}

/**
 * Four responsibilities in one handler:
 *
 *   1. Two-host routing. `nemar.org` and `app.nemar.org` share one Astro
 *      build but expose different surfaces. Authenticated routes requested
 *      on the marketing host (and marketing routes requested on the app
 *      host) get 301'd to the right home. Any other hostname runs in
 *      single-host mode (localhost, preview *.pages.dev) with no redirect,
 *      so QA against a preview URL doesn't need both domains wired up.
 *
 *   2. Read the `nemar_session` cookie, resolve it to a user via
 *      `GET ${apiBase}/auth/me`, and stash the result on
 *      `context.locals.session`. Skipped on the marketing host so anonymous
 *      traffic never pays the round-trip and a stale wildcard cookie can't
 *      accidentally personalize a cacheable response. In `astro dev` mode
 *      the cookie may have been issued by the local dev mock; that path
 *      verifies against the dev HMAC secret first.
 *
 *   3. Edge-cache GETs for unauthenticated traffic via Cloudflare's
 *      `caches.default`. Authenticated traffic skips the cache entirely so
 *      personalized responses (e.g. the Nav's UserMenu) don't get served to
 *      anonymous visitors out of the edge.
 *
 *   4. Stamp `X-Robots-Tag: noindex` on staging (`test.nemar.org`) and
 *      preview (`*.pages.dev`) hosts (epic #923) so they never show up in
 *      search results next to production. See `isNoindexHost` in
 *      `lib/host.ts`; `robots.txt.ts` covers the crawler-side signal.
 *
 * The cache key is the full request URL, so query-string filters on /discover
 * get their own entries. App-host requests fan out one extra HTTP call to
 * /auth/me; that overhead is acceptable since the cache is bypassed for
 * authed traffic anyway. Marketing-host requests never call /auth/me
 * regardless of any cookies present.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const url = new URL(context.request.url);
  // Staging (test.nemar.org) and preview (*.pages.dev) hosts get a blanket
  // noindex so they never compete with production in search results. See
  // isNoindexHost in lib/host.ts; computed once and threaded through every
  // serve path below. Cross-host redirects (no body to protect) are exempt.
  const noindex = isNoindexHost(url.hostname);

  // Retired paths (in-site /docs -> docs.nemar.org, /citation-dashboard ->
  // dashboard.nemar.org) take priority over cross-host routing so they never
  // bounce through the app host first.
  const retired = getRetiredRedirect(url);
  if (retired) {
    return new Response(null, {
      status: 301,
      headers: { Location: retired, ...NO_STORE_HEADER },
    });
  }

  const redirectTarget = getCrossHostRedirect(url);
  if (redirectTarget) {
    // 307 preserves method + body on POST/PUT/DELETE; 301 is fine for GET/HEAD
    // navigation.
    const method = context.request.method;
    const status = method === "GET" || method === "HEAD" ? 301 : 307;
    return new Response(null, {
      status,
      headers: { Location: redirectTarget, ...NO_STORE_HEADER },
    });
  }

  if (hostMode(url.hostname) === "marketing") {
    context.locals.session = null;
  } else {
    await applySession(context);
  }

  const request = context.request;
  if (request.method !== "GET") return withSecurityHeaders(await next(), url.pathname, noindex);
  if (context.locals.session) return withSecurityHeaders(await next(), url.pathname, noindex);

  type Runtime = { caches?: CacheStorage };
  const runtime = (context.locals as { runtime?: Runtime } | undefined)?.runtime;
  const cacheStorage: CacheStorage | undefined =
    runtime?.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  if (!cacheStorage) return withSecurityHeaders(await next(), url.pathname, noindex);

  // Cache namespace is versioned so bumps orphan the previous generation on
  // next deploy. v1 -> v2: pre-PR-#54 entries persisted SWR-poisoned fallback
  // HTML from /api/dataset/<id>/readme and /api/dataset/<id>/tree with
  // s-maxage=600 stale-while-revalidate=86400, and stayed served as HIT from
  // each PoP for up to 24 h after PR #54 (fixes #53) tagged future fallbacks
  // with Cache-Control: no-store. Bumping here unreferences that entire
  // fleet. Bump again on any future change to cache-policy semantics or
  // partial-rendering logic. Issue #65.
  const cache = await cacheStorage.open("nemar-edge-v2").catch((err) => {
    // The cache layer is broken (quota error, runtime error), not just
    // unavailable. Log so we notice systemic failures, but keep serving
    // (cache is best-effort).
    console.warn("[edge-cache] cacheStorage.open failed; bypassing cache", err);
    return null;
  });
  if (!cache) return withSecurityHeaders(await next(), url.pathname, noindex);

  const cached = await cache.match(request);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-nemar-cache", "HIT");
    applySecurityHeaders(headers, url.pathname, noindex);
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const response = await next();
  if (response.status === 200 && isPublicCacheable(response)) {
    const clone = response.clone();
    type EdgeCtx = { waitUntil?: (p: Promise<unknown>) => void };
    const ctx = (context.locals as { runtime?: { ctx?: EdgeCtx } } | undefined)?.runtime?.ctx;
    const putPromise = cache.put(request, clone).catch(() => {
      /* cache.put rejects on Vary:* / Range responses — drop silently. */
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(putPromise);
    } else {
      void putPromise;
    }
    const headers = new Headers(response.headers);
    headers.set("x-nemar-cache", "MISS");
    applySecurityHeaders(headers, url.pathname, noindex);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return withSecurityHeaders(response, url.pathname, noindex);
};

async function applySession(context: Parameters<MiddlewareHandler>[0]): Promise<void> {
  const cookie = context.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    context.locals.session = null;
    return;
  }

  // Dev fast path: if the cookie was issued by the local
  // /api/auth/code/verify dev mock, it's HMAC-signed with the dev secret
  // and verifies without touching the network. A non-dev cookie won't
  // match the dev secret; we fall through to the backend lookup.
  if (import.meta.env.DEV) {
    const local = await verifyDevSession(cookie);
    if (local) {
      context.locals.session = local;
      return;
    }
  }

  // Forward the full cookie header (not just our session cookie) so the
  // backend sees the request as it came from the browser. A cookie that
  // depends on a sibling (CSRF token, etc.) won't verify if we strip it.
  const fullCookie = context.request.headers.get("cookie") ?? `${SESSION_COOKIE_NAME}=${cookie}`;
  let session: AuthSession | null = null;
  try {
    const res = await fetch(`${apiBase()}/auth/me`, {
      method: "GET",
      headers: { Cookie: fullCookie, Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      session = parseAuthMeResponse(data);
    } else if (res.status >= 500) {
      console.warn(`[auth] /auth/me returned ${res.status}; treating request as unauthenticated`);
    } else if (res.status !== 401 && res.status !== 404) {
      // 403, 410, etc. from /auth/me usually mean the session is poisoned
      // (suspended account, explicitly invalidated). Worth a tail-log signal.
      console.warn(
        `[auth] /auth/me returned unexpected ${res.status}; treating as unauthenticated`,
      );
    }
  } catch (err) {
    console.warn("[auth] /auth/me fetch failed; treating request as unauthenticated", err);
  }
  context.locals.session = session;
}

/**
 * Validates the /auth/me response shape at the trust boundary. Anything
 * malformed becomes null rather than coercing through a runtime cast.
 *
 * Normalize-don't-reject at this boundary: the backend ships `id` as a
 * number (INTEGER PRIMARY KEY) and uses `"member"` as the default role.
 * Earlier versions of this parser strictly required string ids and a
 * `"user" | "admin"` role, which silently rejected every valid sign-in.
 * Now we coerce id to string and map `"member"` to the website's `"user"`
 * role; anything else (unknown role string, malformed object) still
 * returns null.
 *
 * Exported for the middleware unit tests.
 */
export function parseAuthMeResponse(raw: unknown): AuthSession | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { user?: unknown };
  const u = body.user;
  if (!u || typeof u !== "object") return null;
  const user = u as Record<string, unknown>;

  let id: string;
  if (typeof user.id === "string" && user.id.length > 0) {
    id = user.id;
  } else if (typeof user.id === "number" && Number.isFinite(user.id)) {
    id = String(user.id);
  } else {
    return null;
  }

  if (typeof user.email !== "string" || user.email.length === 0) return null;

  // Backend ships UserRole = "owner" | "admin" | "member" (hierarchy
  // owner > admin > member). The website only has "admin" vs "user", so
  // `"owner"` collapses to `"admin"` (full admin UI) and `"member"` /
  // `"user"` collapse to `"user"`. Anything else returns null.
  let role: "user" | "admin";
  if (user.role === "owner" || user.role === "admin") {
    role = "admin";
  } else if (user.role === "user" || user.role === "member") {
    role = "user";
  } else {
    return null;
  }
  // Uncollapsed backend role, kept alongside the collapsed `role` above for
  // owner-only admin-portal actions (see AuthUser.backend_role). Only set
  // for the backend's actual enum ("owner"/"admin"/"member"); the "user"
  // branch above is a defensive fallback for a shape the backend doesn't
  // send, so it carries no backend_role.
  const backendRole: "owner" | "admin" | "member" | undefined =
    user.role === "owner" || user.role === "admin" || user.role === "member"
      ? user.role
      : undefined;

  if (user.status !== "active" && user.status !== "pending" && user.status !== "disabled") {
    return null;
  }

  // Required fields validated; layer on the optional profile fields the
  // Settings surface reads. Each is only attached when the backend actually
  // sent a usable value, so a sparse /auth/me (today's shape) yields exactly
  // the id/email/role/status object the middleware tests assert on, and the
  // page falls back gracefully when a field is missing.
  const out: AuthUser = { id, email: user.email, role, status: user.status };
  const withOptional = out as { -readonly [K in keyof AuthUser]: AuthUser[K] };
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  withOptional.backend_role = backendRole;
  withOptional.given_name = str(user.given_name);
  withOptional.family_name = str(user.family_name);
  withOptional.orcid = str(user.orcid);
  if (typeof user.orcid_verified === "boolean") withOptional.orcid_verified = user.orcid_verified;
  withOptional.github_username = str(user.github_username);
  withOptional.city = str(user.city);
  withOptional.country = str(user.country);
  withOptional.affiliation = str(user.affiliation);
  // Drop keys that resolved to undefined so the object stays clean (and the
  // existing `toEqual` assertions on the minimal shape keep passing).
  for (const k of Object.keys(withOptional) as (keyof AuthUser)[]) {
    if (withOptional[k] === undefined) delete withOptional[k];
  }

  return { user: out };
}

export function isPublicCacheable(response: Response): boolean {
  const cc = response.headers.get("Cache-Control");
  if (!cc) return false;
  const lower = cc.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  if (!lower.includes("public")) return false;
  return /max-age=\d+|s-maxage=\d+/.test(lower);
}
