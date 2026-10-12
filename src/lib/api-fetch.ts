/**
 * The way this site's server code calls `api.nemar.org`.
 *
 * Every server-side call leaves from the same small pool of Cloudflare egress
 * addresses, so the API's per-IP rate limiter counts every visitor as one
 * client (nemar-cli#1709). Where the project has a service binding to the API
 * Worker, a call goes over it instead, carrying the visitor this request acts
 * for in `X-Forwarded-For`: a request with no `CF-Connecting-IP` is counted by
 * that visitor in a bucket of its own (nemar-cli ADR 0098). Where there is no
 * binding (`astro dev`, previews, a project not wired yet) the call is an
 * ordinary `fetch`, counted by the shared address as before.
 *
 * Only a URL on the API's own origin takes the binding; anything else is a
 * plain `fetch`, so a call site never has to decide.
 *
 * Server code only. The binding and the visitor come from the request context
 * the middleware opens (`request-context.ts`), which pulls in a Node module
 * the browser bundle must not carry, so a module that also runs in the browser
 * keeps `fetch` for its browser calls.
 */

import { apiBase } from "./api-base";
import { type ApiBinding, currentApiRoute } from "./request-context";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The same ceiling `fetch` applies before it gives up on a redirect chain. */
const MAX_REDIRECTS = 20;
/** Headers a caller must not choose: the API reads the visitor from `X-Forwarded-For` alone. */
const IDENTITY_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"];
/** Headers that must not follow a redirect to another origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie"];

let warnedNoVisitor = false;
let reportedFirstCall = false;

/** Forget what this isolate has already said. For the unit tests only. */
export function resetApiFetchWarningsForTests(): void {
  warnedNoVisitor = false;
  reportedFirstCall = false;
}

/** `fetch`, over the API service binding when this request has one and `input` is on the API's origin. */
export async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const route = currentApiRoute();
  const binding = route?.apiBinding;
  if (!binding || !isApiUrl(url)) return fetch(url, init);
  return viaBinding(binding, route?.visitorIp, url, init);
}

function isApiUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(apiBase()).origin;
  } catch {
    // A relative URL (a browser call) or one that does not parse is not the API's.
    return false;
  }
}

/** The visitor's address as a header value, or `undefined` when there is nothing safe to forward. */
function visitorAddress(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  // The API validates the literal; this only keeps a malformed value off the wire.
  if (!value || value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return undefined;
  return value;
}

async function viaBinding(
  binding: ApiBinding,
  visitorIp: string | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  const visitor = visitorAddress(visitorIp);
  if (visitor) {
    headers.set("x-forwarded-for", visitor);
  } else if (!warnedNoVisitor) {
    warnedNoVisitor = true;
    console.warn(
      "[api-fetch] a request reached the API service binding with no visitor address; its calls share the API's unattributed rate-limit bucket (logged once per isolate)",
    );
  }

  const method = (init.method ?? "GET").toUpperCase();
  const redirect = init.redirect ?? "follow";
  // A request with a body cannot be replayed down a redirect chain, and a caller that
  // asked for "manual" wants the 3xx itself; both go straight to the binding.
  if ((method !== "GET" && method !== "HEAD") || redirect === "manual") {
    return reportFirstCall(await binding.fetch(url, { ...init, headers }));
  }

  // A binding follows a redirect by sending the new URL back to the bound Worker, whatever
  // its origin, so a redirect off the API's origin has to be followed here, as `fetch` would.
  let target = url;
  let hopHeaders = headers;
  for (let hops = 0; ; hops++) {
    const onApi = isApiUrl(target);
    const res = onApi
      ? reportFirstCall(
          await binding.fetch(target, { ...init, headers: hopHeaders, redirect: "manual" }),
        )
      : await fetch(target, { ...init, headers: hopHeaders, redirect: "follow" });
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => {});
    if (redirect === "error")
      throw new TypeError(`redirected from ${target} with redirect: "error"`);
    if (hops >= MAX_REDIRECTS) throw new TypeError(`too many redirects from ${url}`);
    const next = new URL(location, target);
    if (next.origin !== new URL(target).origin) {
      hopHeaders = new Headers(hopHeaders);
      for (const name of CREDENTIAL_HEADERS) hopHeaders.delete(name);
    }
    if (!isApiUrl(next.toString())) {
      // Off the API: the visitor header means nothing there.
      hopHeaders = new Headers(hopHeaders);
      hopHeaders.delete("x-forwarded-for");
    }
    target = next.toString();
  }
}

/** Say once per isolate how the API counted the first call over the binding, then pass the response on. */
function reportFirstCall(res: Response): Response {
  if (reportedFirstCall) return res;
  reportedFirstCall = true;
  const bucket = res.headers.get("x-ratelimit-bucket");
  const line = `[api-fetch] first call over the API service binding: status ${res.status}, rate-limit bucket ${bucket ?? "none"} (logged once per isolate)`;
  // "site-ip" is the bucket a forwarded visitor lands in; anything else means the API did not
  // read the visitor, which is the one thing worth reading this line for.
  if (bucket === "site-ip") console.info(line);
  else console.warn(line);
  return res;
}
