/**
 * The same-origin proxy of the admin quality mount (website phase W9, #588; nemar-cli ADR 0137
 * decision 7, epic #2324 phase B3b): what `src/pages/admin/pipelines/runs/[stamp]/quality/[...rest].ts`
 * runs, kept here as a function of the request and its dependencies so the tests run it on real
 * `Request` and `Response` objects.
 *
 *   GET /admin/pipelines/runs/<stamp>/quality/record/<recording path>
 *   GET /admin/pipelines/runs/<stamp>/quality/file/<sha256>/<recording path>
 *
 * It meets each of nemar-cli's proxy obligations (`admin-route-contract.ts` copies them), in this
 * order, before anything is sent upstream:
 *  - the caller is an administrator (`adminGate`), else a 404 that says nothing more;
 *  - GET only (the route exports `ALL`, so a HEAD or a POST reaches this and is refused);
 *  - no `?` anywhere in the URL, a bare one included;
 *  - `rest` is read from the raw `url.pathname`, never from decoded route parameters, and the
 *    upstream path is `qualityAdminForwardPath(stamp, rest)`, built from the two strings checked;
 *  - the caller's OWN session cookie is the one credential forwarded, the same the gate read, so the
 *    backend checks the caller's own role on every request. No service key, no `Authorization`, no
 *    other cookie: the site has no identity of its own to lend;
 * and then, on every answer it gives:
 *  - `Cache-Control: no-store`, an upstream 401, 403 or 429 included;
 *  - at most `QUALITY_FILE_MAX_BYTES`, counted on the bytes as they are read, never by
 *    `Content-Length` (an answer over it is refused with a 502 and the rest is not read);
 *  - only `Content-Type`, `Content-Disposition` and `X-Content-Type-Options` of the upstream's
 *    headers, so no hop-by-hop header and no `Set-Cookie` is relayed; `nosniff` is always set;
 *  - a redirect is not followed: it is refused with a 502.
 * The forward goes through the API service binding (`apiFetch`) where the site has one.
 */

import { adminGate } from "../admin-guard";
import { type AuthSession, type CookieJar, readSessionCookie } from "../auth";
import {
  COMPUTE_PIPELINE_STAMP_ID_RE,
  QUALITY_ADMIN_SEGMENT,
  SITE_RUN_PATH,
  qualityAdminForwardPath,
} from "./admin-route-contract";
import { QUALITY_FILE_MAX_BYTES } from "./route-contract";

/** The upstream headers relayed to the browser; every other is dropped. */
export const RELAYED_HEADERS = ["content-type", "content-disposition", "x-content-type-options"];

export interface AdminProxyDeps {
  /** The signed-in caller, as the middleware resolved it from the session cookie. */
  readonly session: AuthSession | null;
  /** The API's origin (`apiBase()`). */
  readonly apiBase: string;
  /** `apiFetch` in the site: the service binding where there is one. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The byte cap, `QUALITY_FILE_MAX_BYTES` unless a test lowers it. */
  readonly maxBytes?: number;
}

/** Every answer the proxy gives carries these. */
function baseHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
}

/** A refusal of the proxy's own, `{ "error": <word> }`. */
function refuse(word: string, status: number, extra: Record<string, string> = {}): Response {
  const headers = baseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify({ error: word }), { status, headers });
}

/** The body, read and counted, or null once it runs past `limit` (nothing more is read). */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A jar over a raw `Cookie` header: the first value of each name, as a cookie jar keeps it. */
function jarOf(raw: string): CookieJar {
  const first = new Map<string, string>();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!first.has(name)) first.set(name, part.slice(eq + 1).trim());
  }
  return {
    has: (name) => first.has(name),
    get: (name) => (first.has(name) ? { value: first.get(name) as string } : undefined),
  };
}

/**
 * The one credential the proxy forwards, as `name=value`: the caller's session cookie chosen by the
 * rule the middleware and the API use (`readSessionCookie`: `__Host-nemar_session` when present,
 * the legacy `nemar_session` only when it is absent, no session when `__Host-` is repeated), or null
 * when there is none or its value is empty. No other cookie of the header is ever forwarded.
 */
export function sessionCookieOf(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const found = readSessionCookie(jarOf(rawHeader), rawHeader);
  return found && found.value !== "" ? `${found.name}=${found.value}` : null;
}

/** The stamp and the raw `rest` of a site path, or null when the path is not the proxy's. */
export function splitSitePath(pathname: string): { stamp: string; rest: string } | null {
  const prefix = `${SITE_RUN_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length < 3 || parts[1] !== QUALITY_ADMIN_SEGMENT) return null;
  return { stamp: parts[0], rest: parts.slice(2).join("/") };
}

export async function proxyAdminQuality(request: Request, deps: AdminProxyDeps): Promise<Response> {
  const url = new URL(request.url);
  const sessionCookie = sessionCookieOf(request.headers.get("cookie"));
  // Who: an administrator, else the same 404 a page outside the admin surface gives.
  if (adminGate(deps.session, url.pathname) !== null || sessionCookie === null) {
    return refuse("not_found", 404);
  }
  if (request.method !== "GET") return refuse("method_not_allowed", 405, { Allow: "GET" });
  // Any `?`, a bare one included (which `URL.search` reads as empty).
  if (request.url.includes("?")) return refuse("recording_path_invalid", 400);
  const split = splitSitePath(url.pathname);
  if (split === null) return refuse("recording_path_invalid", 400);
  if (
    !COMPUTE_PIPELINE_STAMP_ID_RE.test(split.stamp) ||
    !Number.isSafeInteger(Number(split.stamp))
  ) {
    return refuse("stamp_not_found", 404);
  }
  const forward = qualityAdminForwardPath(split.stamp, split.rest);
  if (forward === null) return refuse("recording_path_invalid", 400);

  let upstream: Response;
  try {
    upstream = await deps.fetch(`${deps.apiBase}${forward}`, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: sessionCookie },
      redirect: "manual",
    });
  } catch {
    console.warn(`[admin-quality proxy] stamp=${split.stamp} upstream_unreachable`);
    return refuse("upstream_unreachable", 502);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => {});
    return refuse("upstream_redirect", 502);
  }
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readCapped(upstream, deps.maxBytes ?? QUALITY_FILE_MAX_BYTES);
  } catch {
    return refuse("upstream_unreachable", 502);
  }
  if (bytes === null) {
    console.warn(`[admin-quality proxy] stamp=${split.stamp} answer_too_large`);
    return refuse("answer_too_large", 502);
  }
  const headers = baseHeaders();
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  // A status that carries no body is answered with none (a Response with a body would throw).
  const empty = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(empty ? null : bytes, { status: upstream.status, headers });
}
