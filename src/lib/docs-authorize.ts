/**
 * Pure helpers for `/auth/docs/authorize`, the middle hop of the docs-site admin handoff
 * (nemarOrg/nemar-cli#1338).
 *
 * `docs.nemar.org/admin/*` is gated to admins, but the docs site is a separate host and the
 * session cookie is deliberately scoped `Domain=app.nemar.org` (see the module comment in
 * `./host.ts`) so it never attaches to `data.nemar.org` byte-range fetches or `api.nemar.org`
 * search. A cookie scoped to one host cannot authenticate another, so the docs host gets a
 * credential of its own through a three-hop handoff: a Pages Function on the docs host 302s an
 * unauthenticated visitor here, this page proves an admin session and asks the backend for a
 * one-time code, and the docs callback exchanges that code for a docs-scoped cookie. This page is
 * the only hop that already holds the app session, which is why the admin proof happens here and
 * not on the docs host.
 *
 * Two things live in this module rather than in the page, for the reason `adminGate` lives apart
 * from the admin pages: a pure function is directly unit-testable without Astro.
 *
 * The `next` validation is the important one. A visitor arrives carrying an attacker-supplied
 * `next`, and the value ends up in a `Location` header pointed at another host, so this is an
 * open-redirect boundary rather than a tidiness check. It is written as two independent gates —
 * a string-shape gate and a URL-resolution gate — because the two see different attacks: the
 * string gate catches what a `Location` header parser would do with a raw control character,
 * and the resolution gate catches the WHATWG normalizations a string view misses (a backslash
 * that is really a path separator, a percent-encoded `..`).
 */

import { resolveDocsBase } from "./docs-base";

/**
 * Where the docs host exchanges a code for its own cookie. Named here because this page builds
 * the URL and the docs-side Function serves it; a typo in either half is invisible until someone
 * clicks through the whole flow.
 */
export const DOCS_CALLBACK_PATH = "/__docs-auth/callback";

/**
 * Where a visitor lands when `next` is absent or refused: the docs admin index, never the docs
 * root. Someone who reached this flow at all was trying to open an admin page, and a refused
 * `next` is far more often a mangled link than an attack — dropping them at the top of the tree
 * they were headed for costs one click, while dropping them on the marketing docs root reads as
 * the sign-in having silently failed.
 */
export const DOCS_DEFAULT_NEXT = "/admin/";

/** The only prefix a `next` may carry. See {@link safeDocsNext}. */
const ADMIN_PREFIX = "/admin/";

/**
 * Cap on a `next` we will re-emit. The value is echoed into a `Location` header on a redirect to
 * another host, and no real docs path is anywhere near this long; an absurd one is either a
 * mistake or someone probing what this endpoint will reflect.
 */
const MAX_NEXT_LENGTH = 512;

/**
 * Copy for the page's one rendered state — the error panel. Deliberately a single sentence with
 * no status code, no upstream body and no hint about what the admin surface is: everything this
 * page could say about *why* the grant failed is either useless to the visitor or a disclosure
 * (`adminGate` answers a signed-in non-admin with 404 for exactly that reason).
 */
export const DOCS_AUTHORIZE_COPY = {
  errorTitle: "Couldn't complete docs sign-in",
  errorBody:
    "We couldn't complete sign-in for the documentation site. Try again in a moment, and if it keeps happening tell us at support@nemar.org.",
} as const;

/**
 * True when any character would be stripped, or would terminate a header, before a `Location`
 * value is parsed. `\r` and `\n` are the header-injection pair; the rest matter because parsers
 * disagree about them — a tab or a NUL inside a URL is removed by the WHATWG parser and kept by
 * some proxies, so a value carrying one means something different depending on who reads it.
 *
 * A character-code loop rather than a regex: a control-character class in a regex is exactly what
 * Biome's `noControlCharactersInRegex` exists to flag, and the loop is no less clear.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** True when the path portion contains a `..` segment. A query or fragment `..` is inert. */
function hasDotDotSegment(value: string): boolean {
  const pathOnly = value.split(/[?#]/, 1)[0] ?? "";
  return pathOnly.split("/").includes("..");
}

/**
 * Gate one: the string shape.
 *
 * The `/admin/` prefix requirement is the rule, and it is worth being explicit about how much it
 * subsumes. `https://evil.example/x`, `HTTPS://evil.example/x`, `javascript:alert(1)` and
 * `//evil.example` all fail it before any scheme is inspected, at any casing, because none of
 * them can begin with `/admin/` — the check never looks at a scheme, so there is no
 * case-sensitivity bug available to it. What the prefix does NOT cover is the two shapes checked
 * alongside it here.
 */
function isPlainAdminPath(value: string): boolean {
  if (hasControlChar(value)) return false;
  // A backslash is a path separator to the WHATWG URL parser for special schemes, so
  // `/\evil.example` resolves as a HOST rather than a path — the trick `safeRedirectPath`
  // rejects the same way. Gate two catches it too; rejecting it here as well means the value we
  // re-emit never contains one, whatever the resolver thought of it.
  if (value.includes("\\")) return false;
  if (!value.startsWith(ADMIN_PREFIX)) return false;
  // `/admin/../secret` stays on the docs origin, so it is not an open redirect — but it leaves
  // the `/admin/` tree this handoff exists to reach, which makes it a mangled link at best.
  return !hasDotDotSegment(value);
}

/**
 * The docs path to hand to the callback: `raw` when it is a docs admin path, {@link
 * DOCS_DEFAULT_NEXT} otherwise. Never throws and never returns anything a caller has to
 * re-validate.
 *
 * `raw` is checked in both its literal and its once-decoded form, because `%2F%2Fevil.example` is
 * a protocol-relative URL wearing an encoding and only the decoded view sees that. Both forms
 * must pass, so a value whose two views disagree (`/%61dmin/x`, an admin path only after
 * decoding) is refused rather than guessed at.
 *
 * `docsBase` is injectable for the same reason `resolveDocsBase` takes an override: the resolved
 * origin is what gate two compares against, and a test should not have to reach through
 * `import.meta.env` to state it.
 */
export function safeDocsNext(raw: string | null | undefined, docsBase?: string): string {
  if (typeof raw !== "string" || raw.length === 0) return DOCS_DEFAULT_NEXT;
  if (raw.length > MAX_NEXT_LENGTH) return DOCS_DEFAULT_NEXT;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape (`%zz`, a trailing `%`) is not a path anything can reason about, and
    // `decodeURIComponent` throwing is the only signal of it.
    return DOCS_DEFAULT_NEXT;
  }
  if (!isPlainAdminPath(raw) || !isPlainAdminPath(decoded)) return DOCS_DEFAULT_NEXT;

  // Gate two: resolve it the way a browser will. `new URL(value, docsOrigin)` applies every
  // normalization the string gate cannot see, so a value that survives gate one and still lands
  // off-origin or outside `/admin/` is refused here — `%2e%2e` is the case that matters, which
  // the URL parser collapses into a real `..` segment.
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(docsBase ?? resolveDocsBase());
    resolved = new URL(raw, base);
  } catch {
    return DOCS_DEFAULT_NEXT;
  }
  // `URL.origin` is already scheme- and host-lowercased by the parser, so this comparison is
  // case-insensitive about both without doing anything itself.
  if (resolved.origin !== base.origin) return DOCS_DEFAULT_NEXT;
  if (!resolved.pathname.startsWith(ADMIN_PREFIX)) return DOCS_DEFAULT_NEXT;

  return raw;
}

/**
 * The docs callback URL for a minted code. Both parameters go through `URLSearchParams`, so the
 * `next` path is encoded once here and arrives at the callback decoded once — never assembled by
 * string concatenation, which is how a `next` containing `&` would smuggle a parameter into the
 * callback's own query.
 */
export function docsCallbackUrl(docsBase: string, code: string, next: string): string {
  const params = new URLSearchParams({ code, next });
  return `${docsBase.replace(/\/$/, "")}${DOCS_CALLBACK_PATH}?${params.toString()}`;
}

/**
 * What the page does next, given the backend's answer to `POST /auth/docs/grant`.
 *
 * `not_found` is a real outcome rather than an error: the backend answers a signed-in non-admin
 * with 404 rather than 403 so the existence of the admin surface is not disclosed (the same
 * choice `adminGate` makes), and this page forwards that verdict to `/404` unchanged.
 */
export type DocsGrantOutcome =
  | { readonly kind: "handoff"; readonly code: string }
  | { readonly kind: "signed_out" }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

/**
 * The shape {@link docsGrantOutcome} accepts: structurally identical to `DocsGrantResult` from
 * `./docs-auth-api.ts`, so the client's return value passes straight through without an adapter
 * and a test can state a status and a body as plain data.
 */
type RawResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

/**
 * Map a grant result onto one of the page's four outcomes.
 *
 * Only three statuses are contract (200, 401, 404); everything else — a 403 from the backend's
 * Origin allow-list, a 5xx, a rate-limit 429, a 200 whose body is not the documented shape — is
 * one `unavailable`, because there is nothing different a visitor could do about any of them.
 * They are logged rather than silently collapsed, since they mean very different things to
 * whoever reads the log.
 *
 * `expires_in` is deliberately ignored. The code goes straight into a redirect the visitor's
 * browser follows immediately, so a lifetime this page could only compare against its own clock
 * buys nothing; the backend is the one that enforces it, at redemption.
 */
export function docsGrantOutcome(result: RawResult): DocsGrantOutcome {
  if (result.status === "network") return { kind: "unavailable" };
  if (result.status === 401) return { kind: "signed_out" };
  if (result.status === 404) return { kind: "not_found" };
  if (result.status === 200) {
    const body = result.body;
    const code =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string"
        ? ((body as Record<string, unknown>).code as string)
        : "";
    if (code.length === 0) {
      console.warn("[docs-authorize] grant answered 200 with no usable code", { body });
      return { kind: "unavailable" };
    }
    return { kind: "handoff", code };
  }
  console.warn(`[docs-authorize] grant answered ${result.status}`);
  return { kind: "unavailable" };
}
