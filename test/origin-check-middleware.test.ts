/**
 * The site's cross-site form check through the REAL `onRequest` (nemarOrg/website ADR 0031): Astro's
 * built-in `security.checkOrigin` is off, so this is the only thing standing between a form on
 * another site and every state-changing route here. Nothing stands in for the check; the table sends
 * real `Request`s through the middleware and then, for the one exempt path, through the page's own
 * input reader, because the middleware cannot tell an authorization request from a consent and the
 * page does (`readAuthorizeInput`).
 *
 * What the file pins:
 * - the config switch is off, so the check is neither doubled nor missing (the other half of the
 *   pair: `onRequest` answers 403 itself);
 * - a table of (method, path spelling, content type, Origin, Sec-Fetch-Site, body) -> allowed or 403;
 * - EVERY file under `src/pages` is swept by the glob below, so a new form endpoint is covered the
 *   day it is added: a cross-site form POST to it is refused unless it is the authorization endpoint.
 */

import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import config from "../astro.config.mjs";
import {
  OIDC_FORM_CONSENT_TOKEN,
  OIDC_FORM_DECISION,
  OIDC_FORM_REQUEST,
  oidcCrossSiteRefusal,
  readAuthorizeInput,
} from "../src/lib/oidc-authorize";
import { onRequest } from "../src/middleware";

const APP = "https://app.nemar.org";
const FOREIGN = "https://rp.example.org";
const FORM = "application/x-www-form-urlencoded";
const AUTHORIZE = "/oauth/authorize";
const REQUEST =
  "client_id=oc_0123456789abcdef01234567&redirect_uri=https%3A%2F%2Fclient.example.org%2Fcallback&response_type=code&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256";
const CONSENT_BODY = new URLSearchParams({
  [OIDC_FORM_REQUEST]: REQUEST,
  [OIDC_FORM_CONSENT_TOKEN]: "1999999999.token",
  [OIDC_FORM_DECISION]: "allow",
}).toString();

type Sent = {
  method?: string;
  /** Path as the browser would put it on the wire, appended to the host as written. */
  path: string;
  contentType?: string | null;
  origin?: string | null;
  fetchSite?: string | null;
  body?: string;
};

function build(sent: Sent, host = APP): Request {
  const headers = new Headers();
  if (sent.contentType !== null) headers.set("Content-Type", sent.contentType ?? FORM);
  if (sent.origin !== null && sent.origin !== undefined) headers.set("Origin", sent.origin);
  if (sent.fetchSite) headers.set("Sec-Fetch-Site", sent.fetchSite);
  return new Request(`${host}${sent.path}`, {
    method: sent.method ?? "POST",
    headers,
    body: sent.method === "GET" ? undefined : new TextEncoder().encode(sent.body ?? REQUEST),
  });
}

/** An `APIContext` with the parts the middleware reads: no cookie, so no `/auth/me` call is made. */
function context(request: Request): APIContext {
  return {
    request,
    url: new URL(request.url),
    isPrerendered: false,
    locals: {},
    cookies: { has: () => false, get: () => undefined },
  } as unknown as APIContext;
}

type Outcome = { status: number; reached: boolean; input: string | null };

/**
 * The request through `onRequest`, then (when it gets as far as the page) through the page's own
 * reader. `reached` says the page code ran; `input` is what it read.
 */
async function send(sent: Sent, host = APP): Promise<Outcome> {
  const request = build(sent, host);
  const origin = new URL(request.url).origin;
  let reached = false;
  let input: string | null = null;
  const page = async () => {
    reached = true;
    // The reader is called for a path the page serves; elsewhere there is nothing to read.
    if (new URL(request.url).pathname === AUTHORIZE) {
      const read = await readAuthorizeInput(request, origin);
      input = read.kind;
      if (read.kind === "forbidden") return oidcCrossSiteRefusal(request.method);
    }
    return new Response("rendered", { status: 200 });
  };
  const response = (await onRequest(context(request), page)) as Response;
  return { status: response.status, reached, input };
}

describe("the config", () => {
  it("has Astro's built-in origin check off, because the middleware runs the site's own", () => {
    expect((config as { security?: { checkOrigin?: unknown } }).security?.checkOrigin).toBe(false);
  });
});

describe("(method, path, content type, Origin, Sec-Fetch-Site, body) -> allowed or 403", () => {
  type Row = [name: string, sent: Sent, expected: { status: number; input?: string | null }];
  const rows: Row[] = [
    // The exemption: an authorization request by POST, from anywhere.
    [
      "cross-site authorization POST",
      { path: AUTHORIZE, origin: FOREIGN, fetchSite: "cross-site" },
      { status: 200, input: "check" },
    ],
    [
      "same-origin authorization POST",
      { path: AUTHORIZE, origin: APP, fetchSite: "same-origin" },
      { status: 200, input: "check" },
    ],
    [
      "null-Origin authorization POST",
      { path: AUTHORIZE, origin: "null" },
      { status: 200, input: "check" },
    ],
    [
      "no-Origin authorization POST",
      { path: AUTHORIZE, origin: null },
      { status: 200, input: "check" },
    ],
    [
      "sibling-subdomain authorization POST",
      { path: AUTHORIZE, origin: "https://x.nemar.org", fetchSite: "same-site" },
      { status: 200, input: "check" },
    ],
    [
      "charset parameter and case",
      {
        path: AUTHORIZE,
        origin: FOREIGN,
        contentType: "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
      },
      { status: 200, input: "check" },
    ],
    [
      "the query on the URL is not the request",
      { path: `${AUTHORIZE}?client_id=other`, origin: FOREIGN },
      { status: 200, input: "check" },
    ],
    // The consent POST: same path and type, so the middleware lets it in and the PAGE refuses it.
    [
      "cross-site consent POST",
      { path: AUTHORIZE, origin: FOREIGN, fetchSite: "cross-site", body: CONSENT_BODY },
      { status: 403, input: "forbidden" },
    ],
    [
      "null-Origin consent POST",
      { path: AUTHORIZE, origin: "null", body: CONSENT_BODY },
      { status: 403, input: "forbidden" },
    ],
    [
      "no-Origin consent POST",
      { path: AUTHORIZE, origin: null, body: CONSENT_BODY },
      { status: 403, input: "forbidden" },
    ],
    [
      "sibling-subdomain consent POST",
      {
        path: AUTHORIZE,
        origin: "https://x.nemar.org",
        fetchSite: "same-site",
        body: CONSENT_BODY,
      },
      { status: 403, input: "forbidden" },
    ],
    [
      "forged Origin, browser says cross-site",
      { path: AUTHORIZE, origin: APP, fetchSite: "cross-site", body: CONSENT_BODY },
      { status: 403, input: "forbidden" },
    ],
    [
      "consent decision alone, cross-site",
      { path: AUTHORIZE, origin: FOREIGN, body: `${REQUEST}&${OIDC_FORM_DECISION}=allow` },
      { status: 403, input: "forbidden" },
    ],
    [
      "consent token alone, cross-site",
      { path: AUTHORIZE, origin: FOREIGN, body: `${REQUEST}&${OIDC_FORM_CONSENT_TOKEN}=t` },
      { status: 403, input: "forbidden" },
    ],
    [
      "same-origin consent POST",
      { path: AUTHORIZE, origin: APP, fetchSite: "same-origin", body: CONSENT_BODY },
      { status: 200, input: "consent" },
    ],
    [
      "same-origin consent POST, no Sec-Fetch-Site",
      { path: AUTHORIZE, origin: APP, body: CONSENT_BODY },
      { status: 200, input: "consent" },
    ],
    // Path spellings: not the exact path, so the built-in's rule, so 403 (and the page never runs).
    ["trailing slash", { path: `${AUTHORIZE}/`, origin: FOREIGN }, { status: 403, input: null }],
    [
      "double leading slash",
      { path: `/${AUTHORIZE}`, origin: FOREIGN },
      { status: 403, input: null },
    ],
    [
      "upper-case path",
      { path: "/OAUTH/authorize", origin: FOREIGN },
      { status: 403, input: null },
    ],
    ["encoded slash", { path: `${AUTHORIZE}%2f`, origin: FOREIGN }, { status: 403, input: null }],
    [
      "encoded letter",
      { path: "/oauth/%61uthorize", origin: FOREIGN },
      { status: 403, input: null },
    ],
    [
      "trailing-slash consent, cross-site",
      { path: `${AUTHORIZE}/`, origin: FOREIGN, body: CONSENT_BODY },
      { status: 403, input: null },
    ],
    [
      "trailing-slash consent, same-origin",
      { path: `${AUTHORIZE}/`, origin: APP, body: CONSENT_BODY },
      { status: 200, input: null },
    ],
    // Content types: only the urlencoded form is exempt.
    [
      "multipart",
      { path: AUTHORIZE, origin: FOREIGN, contentType: "multipart/form-data; boundary=x" },
      { status: 403, input: null },
    ],
    [
      "text/plain",
      { path: AUTHORIZE, origin: FOREIGN, contentType: "text/plain" },
      { status: 403, input: null },
    ],
    [
      "no content type",
      { path: AUTHORIZE, origin: FOREIGN, contentType: null },
      { status: 403, input: null },
    ],
    [
      "form type named in a parameter of text/plain",
      { path: AUTHORIZE, origin: FOREIGN, contentType: `text/plain; x=${FORM}` },
      { status: 403, input: null },
    ],
    [
      "same-origin multipart is the built-in's: allowed through, and the page refuses it as invalid",
      { path: AUTHORIZE, origin: APP, contentType: "multipart/form-data; boundary=x" },
      { status: 200, input: "invalid" },
    ],
    [
      "cross-site JSON is left to CORS, as in Astro",
      { path: AUTHORIZE, origin: FOREIGN, contentType: "application/json" },
      { status: 200, input: "invalid" },
    ],
    // Methods.
    ["PUT", { method: "PUT", path: AUTHORIZE, origin: FOREIGN }, { status: 403, input: null }],
    ["PATCH", { method: "PATCH", path: AUTHORIZE, origin: FOREIGN }, { status: 403, input: null }],
    [
      "DELETE",
      { method: "DELETE", path: AUTHORIZE, origin: FOREIGN },
      { status: 403, input: null },
    ],
    // Other routes keep exactly what they had.
    [
      "cross-site form POST to a settings endpoint",
      { path: "/api/auth/logout", origin: FOREIGN },
      { status: 403, input: null },
    ],
    [
      "cross-site form POST, null Origin",
      { path: "/api/auth/logout", origin: "null" },
      { status: 403, input: null },
    ],
    [
      "cross-site form POST, no Origin",
      { path: "/api/auth/logout", origin: null },
      { status: 403, input: null },
    ],
    [
      "same-origin form POST",
      { path: "/api/auth/logout", origin: APP },
      { status: 200, input: null },
    ],
    [
      "cross-site JSON POST is left to CORS",
      { path: "/api/auth/logout", origin: FOREIGN, contentType: "application/json" },
      { status: 200, input: null },
    ],
    [
      "GET is safe",
      { method: "GET", path: "/settings", origin: FOREIGN },
      { status: 200, input: null },
    ],
  ];

  for (const [name, sent, expected] of rows) {
    it(name, async () => {
      const out = await send(sent);
      expect(out.status).toBe(expected.status);
      if (expected.input !== undefined) expect(out.input).toBe(expected.input);
      // A refusal at the middleware never reaches the page.
      if (out.status === 403 && expected.input === null) expect(out.reached).toBe(false);
    });
  }

  it("refuses on the marketing host too, before the 307 to the app host (as the built-in did)", async () => {
    const other = await send({ path: "/oauth/authorize/", origin: FOREIGN }, "https://nemar.org");
    expect(other.status).toBe(403);
    const exempt = await send({ path: AUTHORIZE, origin: FOREIGN }, "https://nemar.org");
    // The exempt POST is redirected with its method kept; the page is not reached on this host.
    expect(exempt.status).toBe(307);
  });
});

describe("every route in the site", () => {
  // Every file under src/pages, keys only: the loaders are never called.
  const files = Object.keys(import.meta.glob("../src/pages/**/*.{ts,astro}"));

  /** A request path that routes to a page file, filling dynamic segments with a harmless value. */
  function routeOf(file: string): string {
    const rel = file.replace("../src/pages", "").replace(/\.(ts|astro)$/, "");
    const path = rel
      .replace(/\/index$/, "")
      .replace(/\[\.\.\.[^\]]+\]/g, "a/b")
      .replace(/\[[^\]]+\]/g, "x");
    return path === "" ? "/" : path;
  }

  it("found the routes", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("../src/pages/oauth/authorize.astro");
    expect(files).toContain("../src/pages/api/v1/[...path].ts");
  });

  it("refuses a cross-site form POST to every one of them but the authorization endpoint", async () => {
    const exempt: string[] = [];
    for (const file of files) {
      const path = routeOf(file);
      for (const contentType of [FORM, "multipart/form-data; boundary=x", "text/plain"]) {
        for (const origin of [FOREIGN, "null", null]) {
          const out = await send({ path, contentType, origin });
          const allowed = out.status !== 403;
          if (allowed) exempt.push(`${path} (${contentType})`);
        }
      }
    }
    // The only (route, type) pair let through is the authorization endpoint with the urlencoded type.
    expect([...new Set(exempt)]).toEqual([`${AUTHORIZE} (${FORM})`]);
  });

  it("lets a same-origin form POST reach every route", async () => {
    for (const file of files) {
      const path = routeOf(file);
      const out = await send({ path, origin: APP });
      expect(out.status, path).not.toBe(403);
    }
  });
});
