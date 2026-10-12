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
 * plain `fetch`, so a call site never has to decide. `init` is a plain
 * `RequestInit` (a `Request` passed as `init` would lose its method and body on
 * the binding path), and a followed redirect reports `redirected: false`.
 *
 * Server code only. The binding and the visitor come from the request context
 * the middleware opens (`request-context.ts`), which pulls in a Node module
 * the browser bundle must not carry, so a module that also runs in the browser
 * keeps `fetch` for its browser calls.
 *
 * ADR 0026 has the decisions. The rest of this file is the part that is easy
 * to get wrong: what a binding does with a redirect, and what to say when the
 * API's counting fails without an error.
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

/** A line that can repeat is logged at most this often, with a count of what it skipped. */
const LOG_EVERY_MS = 60_000;

/** The last count the API reported for a visitor, and how many comparisons in a row showed no fall. */
interface Sighting {
  at: number;
  remaining: number;
  streak: number;
}
/** Visitors remembered at once; the least recently seen is dropped past this. */
const SIGHTINGS_KEPT = 200;
/**
 * Calls closer together than this race the API's counter (a page's calls run in parallel, each
 * reading the count before the others have written), so they say nothing about it.
 */
const MIN_GAP_MS = 1_000;
/** Calls farther apart than this may have crossed into a new window, where the count starts over. */
const MAX_GAP_MS = 10_000;
/** Comparisons in a row that must show no fall before the counter is called stuck. */
const STREAK_TO_WARN = 3;

const loggedAt = new Map<string, { at: number; skipped: number }>();
const reportedBuckets = new Set<string>();
const sightings = new Map<string, Sighting>();
let warnedStuckCounter = false;

/** Forget what this isolate has already said. For the unit tests only. */
export function resetApiFetchWarningsForTests(): void {
  loggedAt.clear();
  reportedBuckets.clear();
  sightings.clear();
  warnedStuckCounter = false;
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

/** The path of `url` for a log line or an error: never the query, which can carry what a visitor typed. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unreadable URL)";
  }
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * The visitor's address as a header value, or why there is none. Held to the rules the API
 * applies (a bare IPv4 without leading zeros, or an IPv6 literal without brackets, port or
 * zone), so an address the API would not read is said so here instead of silently pooling.
 */
function visitorAddress(raw: string | undefined): { address: string } | { problem: string } {
  const value = raw?.trim();
  if (!value) return { problem: "absent" };
  if (IPV4.test(value)) return { address: value };
  if (value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value)) {
    try {
      new URL(`http://[${value}]/`);
      return { address: value };
    } catch {
      // Not an IPv6 literal; reported below with the rest.
    }
  }
  return { problem: `malformed, length ${value.length}` };
}

/** Log `message` unless the same `key` was logged in the last minute; say how many it skipped. */
function logAtMostPerMinute(
  key: string,
  level: "warn" | "error",
  message: (skipped: number) => string,
): void {
  const now = Date.now();
  const last = loggedAt.get(key);
  if (last && now - last.at < LOG_EVERY_MS) {
    last.skipped++;
    return;
  }
  loggedAt.set(key, { at: now, skipped: 0 });
  console[level](message(last?.skipped ?? 0));
}

const skippedNote = (skipped: number) =>
  skipped > 0 ? ` (${skipped} more since the last line)` : "";

async function viaBinding(
  binding: ApiBinding,
  visitorIp: string | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const name of IDENTITY_HEADERS) headers.delete(name);
  const visitor = visitorAddress(visitorIp);
  if ("address" in visitor) {
    headers.set("x-forwarded-for", visitor.address);
  } else {
    logAtMostPerMinute(
      "no-visitor",
      "warn",
      (skipped) =>
        `[api-fetch] ${pathOf(url)}: no usable visitor address (${visitor.problem}); calls like it share the API's unattributed rate-limit bucket, and the sign-in routes share one allowance for the whole site${skippedNote(skipped)}`,
    );
  }
  const visitorKey = "address" in visitor ? visitor.address : undefined;

  const method = (init.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const redirect = init.redirect ?? "follow";

  // A binding follows a redirect by sending the new URL back to the bound Worker, whatever its
  // origin (measured under workerd, website#449), so this asks the binding for each redirect
  // itself and follows it as `fetch` would: through the binding for the API's origin, on the
  // public network for another.
  let target = url;
  let hopHeaders = headers;
  for (let hops = 0; ; hops++) {
    const res = isApiUrl(target)
      ? observe(
          await callBinding(binding, target, { ...init, headers: hopHeaders, redirect: "manual" }),
          visitorKey,
        )
      : await publicHop(url, target, init, hopHeaders);
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    // A caller that asked for "manual" wants the 3xx itself.
    if (!location || redirect === "manual") return res;
    if (redirect === "error") {
      await discard(res);
      throw new TypeError(`${pathOf(target)} redirected, and the request said redirect: "error"`);
    }
    // A request with a body cannot be replayed down a redirect, so the 3xx is the answer; the
    // caller sees it, where a binding left to follow it would send it to the wrong Worker.
    if (hasBody) return res;
    await discard(res);
    if (hops >= MAX_REDIRECTS) throw new TypeError(`too many redirects from ${pathOf(url)}`);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch (cause) {
      throw new TypeError(`the redirect from ${pathOf(target)} has an invalid Location`, { cause });
    }
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

/** Release a response that is being discarded; a failure to cancel it changes nothing about the answer. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {
    /* the body is unread and unwanted; a stream that will not cancel is released when it is collected */
  });
}

function isAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

/** A call over the binding. Its failure is the caller's to handle, and is said here so it is not read as the API's. */
async function callBinding(binding: ApiBinding, url: string, init: RequestInit): Promise<Response> {
  try {
    return await binding.fetch(url, init);
  } catch (err) {
    if (!isAbort(err, init.signal)) {
      const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logAtMostPerMinute(
        "binding-failed",
        "error",
        (skipped) =>
          `[api-fetch] a call over the API service binding failed (${pathOf(url)}), and is not retried on the public network (ADR 0026): ${what}${skippedNote(skipped)}`,
      );
    }
    throw err;
  }
}

/** A hop of a redirect that left the API's origin, on the public network. */
async function publicHop(
  original: string,
  target: string,
  init: RequestInit,
  headers: Headers,
): Promise<Response> {
  try {
    return await fetch(target, { ...init, headers, redirect: "follow" });
  } catch (err) {
    if (isAbort(err, init.signal)) throw err;
    const host = new URL(target).host;
    const what = err instanceof Error ? err.message : String(err);
    throw new TypeError(
      `a redirect from ${pathOf(original)} to ${host} failed on the public network: ${what}`,
      { cause: err },
    );
  }
}

/**
 * Watch how the API counts the calls that went over the binding, then pass the response on.
 *
 * The counting can fail without an error, in ways that leave every answer looking healthy, so
 * it is checked from the headers the API sets on each response. The watching never changes a
 * response and never throws:
 *
 * - a call counted under the shared address, in the unattributed bucket, or not at all: the
 *   API did not read the visitor, or its limiter did not run; each is said once per isolate;
 * - a counter that does not persist for a call that arrives over a binding (Cloudflare's
 *   documentation does not say it does): `X-RateLimit-Remaining` for one visitor never falls.
 */
function observe(res: Response, visitor: string | undefined): Response {
  try {
    reportBucket(res);
    if (visitor && res.headers.get("x-ratelimit-bucket") === "site-ip") noteCount(visitor, res);
  } catch (err) {
    logAtMostPerMinute(
      "observe-failed",
      "error",
      (skipped) =>
        `[api-fetch] could not read the API's rate-limit headers: ${err instanceof Error ? err.message : String(err)}${skippedNote(skipped)}`,
    );
  }
  return res;
}

function reportBucket(res: Response): void {
  const bucket = res.headers.get("x-ratelimit-bucket");
  // A 5xx or a maintenance answer may come from before the limiter; it says nothing either way.
  const kind = bucket ?? (res.status >= 500 ? undefined : "none");
  if (!kind || reportedBuckets.has(kind)) return;
  const remaining = res.headers.get("x-ratelimit-remaining") ?? "none";
  const where = `status ${res.status}, remaining ${remaining}, API ${new URL(apiBase()).host}; logged once per isolate`;
  if (kind === "site-ip") {
    reportedBuckets.add(kind);
    console.info(
      `[api-fetch] a call over the API service binding was counted per visitor (${where})`,
    );
  } else if (kind === "ip") {
    reportedBuckets.add(kind);
    console.warn(
      `[api-fetch] a call over the API service binding was counted under the shared address, so the API did not read the visitor (${where})`,
    );
  } else if (kind === "site-unattributed") {
    reportedBuckets.add(kind);
    console.warn(
      `[api-fetch] a call over the API service binding was counted in the unattributed bucket (${where})`,
    );
  } else if (kind === "none") {
    reportedBuckets.add(kind);
    console.warn(
      `[api-fetch] an answer over the API service binding carried no rate-limit headers: some routes drop them, but if every call does, the API's limiter is not running (${where})`,
    );
  }
}

/**
 * Compare what the API says a visitor has left with what it said a moment ago. A counter that
 * persists falls with each call in a window, so a few comparisons in a row with no fall mean
 * it is not counting. Only calls 1 to 10 seconds apart are compared: closer ones race the
 * counter, and farther ones may have crossed into a new window.
 */
function noteCount(visitor: string, res: Response): void {
  if (warnedStuckCounter || res.status === 429) return;
  const raw = res.headers.get("x-ratelimit-remaining");
  const remaining = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  const now = Date.now();
  const prev = sightings.get(visitor);
  if (!prev || now - prev.at > MAX_GAP_MS) {
    remember(visitor, { at: now, remaining, streak: 0 });
    return;
  }
  if (now - prev.at < MIN_GAP_MS) return;
  const streak = remaining >= prev.remaining ? prev.streak + 1 : 0;
  remember(visitor, { at: now, remaining, streak });
  if (streak >= STREAK_TO_WARN) {
    warnedStuckCounter = true;
    console.error(
      `[api-fetch] the API's rate-limit count did not fall over ${STREAK_TO_WARN + 1} calls for one visitor, seconds apart (remaining stayed at ${remaining}); calls over the binding may not be limited at all (logged once per isolate)`,
    );
  }
}

function remember(visitor: string, sighting: Sighting): void {
  sightings.delete(visitor);
  if (sightings.size >= SIGHTINGS_KEPT) {
    const oldest = sightings.keys().next().value;
    if (oldest !== undefined) sightings.delete(oldest);
  }
  sightings.set(visitor, sighting);
}
