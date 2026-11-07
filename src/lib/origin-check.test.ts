/**
 * The site's cross-site form check (nemarOrg/website ADR 0031): the rule it copies from Astro, the one
 * exemption it adds, and how narrow that exemption is. Real `Request`s throughout; nothing stands in
 * for the check. The middleware wiring and the route-table sweep are in
 * `test/origin-check-middleware.test.ts`.
 */

import { describe, expect, it } from "vitest";
// Astro's own check, imported by path (the package does not export it): the copy is held to it.
import { createOriginCheckMiddleware } from "../../node_modules/astro/dist/core/app/middlewares.js";
import { OIDC_AUTHORIZE_PAGE_PATH } from "./oidc-authorize";
import {
  AUTHORIZATION_ENDPOINT_PATH,
  crossSiteFormRefusal,
  hasFormLikeHeader,
  isAuthorizationRequestPost,
  isSameOriginPost,
} from "./origin-check";

const ORIGIN = "https://app.nemar.org";
const FOREIGN = "https://rp.example.org";
const FORM = "application/x-www-form-urlencoded";

type Case = {
  method?: string;
  path?: string;
  contentType?: string | null;
  origin?: string | null;
};

function request(c: Case): Request {
  const headers = new Headers();
  if (c.contentType !== null && c.contentType !== undefined) {
    headers.set("Content-Type", c.contentType);
  }
  if (c.origin !== null && c.origin !== undefined) headers.set("Origin", c.origin);
  const method = c.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${ORIGIN}${c.path ?? "/settings"}`, {
    method,
    headers,
    // Bytes, not a string: a string body would add its own `text/plain` Content-Type.
    body: hasBody ? new TextEncoder().encode("a=b") : undefined,
  });
}

/** Astro's built-in answer for the same request: a status, or null when it calls `next`. */
async function builtIn(req: Request): Promise<number | null> {
  const mw = createOriginCheckMiddleware();
  const ctx = { request: req, url: new URL(req.url), isPrerendered: false };
  const res = (await mw(ctx as never, (async () => new Response("next")) as never)) as Response;
  return (await res.clone().text()) === "next" ? null : res.status;
}

async function ours(req: Request): Promise<number | null> {
  return crossSiteFormRefusal(req, new URL(req.url).origin)?.status ?? null;
}

describe("the rule copied from Astro", () => {
  const methods = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
  const types: (string | null)[] = [
    null,
    "",
    FORM,
    `${FORM}; charset=UTF-8`,
    "APPLICATION/X-WWW-FORM-URLENCODED",
    "multipart/form-data; boundary=x",
    "text/plain",
    "text/plain;charset=UTF-8",
    "application/json",
    "application/json; note=text/plain",
    "text/html",
    "application/x-www-form-urlencoded, text/plain",
  ];
  const origins: (string | null)[] = [
    null,
    ORIGIN,
    FOREIGN,
    "null",
    `${ORIGIN}/`,
    "http://app.nemar.org",
  ];

  it("answers every (method, content type, Origin) off the exempt path exactly as Astro's built-in does", async () => {
    let compared = 0;
    for (const method of methods) {
      for (const contentType of types) {
        for (const origin of origins) {
          const req = request({ method, contentType, origin });
          expect(await ours(req), `${method} ${contentType} ${origin}`).toBe(await builtIn(req));
          compared += 1;
        }
      }
    }
    expect(compared).toBe(methods.length * types.length * origins.length);
  });

  it("words the refusal as Astro does", async () => {
    const refused = crossSiteFormRefusal(request({ origin: FOREIGN, contentType: FORM }), ORIGIN);
    expect(refused?.status).toBe(403);
    expect(await refused?.text()).toBe("Cross-site POST form submissions are forbidden");
  });

  it("hasFormLikeHeader agrees with Astro's on a sweep", async () => {
    const { hasFormLikeHeader: theirs } = await import(
      "../../node_modules/astro/dist/core/app/middlewares.js"
    );
    for (const type of [
      ...types,
      "multipart/mixed",
      "text/plain-x",
      "x/application/x-www-form-urlencoded",
    ]) {
      expect(hasFormLikeHeader(type), String(type)).toBe(theirs(type));
    }
  });
});

describe("the one exemption", () => {
  it("is the authorization endpoint, and the page's own path is the same string", () => {
    expect(AUTHORIZATION_ENDPOINT_PATH).toBe(OIDC_AUTHORIZE_PAGE_PATH);
  });

  it("lets a cross-site urlencoded POST to exactly that path through, whatever its Origin", async () => {
    for (const origin of [FOREIGN, "null", "https://evil.nemar.org", null, ORIGIN]) {
      for (const contentType of [
        FORM,
        `${FORM}; charset=UTF-8`,
        "Application/X-WWW-Form-URLencoded",
      ]) {
        const req = request({ path: AUTHORIZATION_ENDPOINT_PATH, contentType, origin });
        expect(await ours(req), `${origin} ${contentType}`).toBeNull();
      }
    }
  });

  // Each of these reaches the page, or something else, and is NOT exempt: the built-in's 403.
  const refused: [string, Case][] = [
    [
      "GET is safe anyway",
      { method: "GET", path: "/oauth/authorize", contentType: FORM, origin: FOREIGN },
    ],
    ["trailing slash", { path: "/oauth/authorize/" }],
    ["double leading slash", { path: "//oauth/authorize" }],
    ["upper case", { path: "/OAUTH/authorize" }],
    ["upper case leaf", { path: "/oauth/AUTHORIZE" }],
    ["encoded slash", { path: "/oauth/authorize%2f" }],
    ["encoded letter", { path: "/oauth/%61uthorize" }],
    ["encoded slash inside", { path: "/oauth%2fauthorize" }],
    [
      "dot segment still resolves to the page, so it IS the exact path",
      { path: "/oauth/./authorize", exempt: true } as Case,
    ],
    ["suffix", { path: "/oauth/authorize.json" }],
    ["semicolon parameter", { path: "/oauth/authorize;x=1" }],
    ["prefix of a longer path", { path: "/oauth/authorize/extra" }],
    ["a sibling under /oauth", { path: "/oauth/token" }],
    ["another form endpoint", { path: "/cli/authorize" }],
    ["multipart", { path: "/oauth/authorize", contentType: "multipart/form-data; boundary=x" }],
    ["text/plain", { path: "/oauth/authorize", contentType: "text/plain" }],
    [
      "text/plain naming the form type in a parameter",
      { path: "/oauth/authorize", contentType: `text/plain; x=${FORM}` },
    ],
    [
      "multipart naming the form type in a parameter",
      { path: "/oauth/authorize", contentType: `multipart/form-data; boundary=${FORM}` },
    ],
    [
      "two content types folded together",
      { path: "/oauth/authorize", contentType: `${FORM}, text/plain` },
    ],
    ["no content type", { path: "/oauth/authorize", contentType: null }],
    ["PUT", { method: "PUT", path: "/oauth/authorize", contentType: FORM }],
    ["PATCH", { method: "PATCH", path: "/oauth/authorize", contentType: FORM }],
    ["DELETE", { method: "DELETE", path: "/oauth/authorize", contentType: FORM }],
  ];
  for (const [name, c] of refused) {
    const exempt = (c as { exempt?: boolean }).exempt === true;
    if (name.startsWith("GET")) continue;
    it(`${exempt ? "is exempt" : "is refused"}: ${name}`, async () => {
      const req = request({ origin: FOREIGN, contentType: FORM, ...c });
      expect(await ours(req)).toBe(exempt ? null : 403);
    });
  }

  it("an empty Content-Type is not form-like, so (as in Astro) it is not refused and not exempt either", async () => {
    const req = request({ path: "/settings", contentType: "", origin: FOREIGN });
    expect(req.headers.has("content-type")).toBe(true);
    expect(await ours(req)).toBe(await builtIn(req));
    expect(isAuthorizationRequestPost("POST", "/oauth/authorize", "")).toBe(false);
  });

  it("exempts the spellings the URL parser itself normalizes to the exact path, which is the page Astro routes them to", async () => {
    // Backslash, dot segments (plain or %2e), a tab and `..` all collapse to `/oauth/authorize` before
    // Astro routes the request, so they ARE the exact path and are exempt; any spelling that is not
    // normalized away reaches the page (or nothing) and is refused cross-site (the cases above).
    for (const path of [
      "/oauth\\authorize",
      "/oauth/./authorize",
      "/oauth/%2e/authorize",
      "/oauth/%2E/authorize",
      "/oauth/x/../authorize",
      "/oauth/auth\torize",
      "/oauth/%2e%2e/oauth/authorize",
    ]) {
      const req = request({ path, origin: FOREIGN, contentType: FORM });
      expect(new URL(req.url).pathname, path).toBe("/oauth/authorize");
      expect(await ours(req), path).toBeNull();
    }
  });

  it("matches the URL parser's path, so the dot-segment spelling is the exact path and nothing else is", () => {
    expect(new URL(`${ORIGIN}/oauth/./authorize`).pathname).toBe("/oauth/authorize");
    for (const path of [
      "/oauth/authorize/",
      "//oauth/authorize",
      "/OAUTH/authorize",
      "/oauth/authorize%2f",
      "/oauth/authorize%2F",
    ]) {
      expect(
        isAuthorizationRequestPost("POST", new URL(`${ORIGIN}${path}`).pathname, FORM),
        path,
      ).toBe(false);
    }
    expect(isAuthorizationRequestPost("POST", "/oauth/authorize", FORM)).toBe(true);
    expect(isAuthorizationRequestPost("post", "/oauth/authorize", FORM)).toBe(false);
  });

  it("keeps the consent POST, same-origin or not, out of the exemption's reach by Origin alone", async () => {
    // Same path and type as the authorization POST: the middleware lets both through. What tells the
    // consent apart is the page (`readAuthorizeInput`, tested in `oidc-authorize.test.ts`), so this
    // holds the other half: the helper the page uses.
    expect(isSameOriginPost(request({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(isSameOriginPost(request({}), ORIGIN)).toBe(false);
    expect(isSameOriginPost(request({ origin: "null" }), ORIGIN)).toBe(false);
    expect(isSameOriginPost(request({ origin: FOREIGN }), ORIGIN)).toBe(false);
    const sfs = (value: string) =>
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Sec-Fetch-Site": value },
      });
    expect(isSameOriginPost(sfs("same-origin"), ORIGIN)).toBe(true);
    for (const value of ["cross-site", "same-site", "none", ""]) {
      expect(isSameOriginPost(sfs(value), ORIGIN), value).toBe(false);
    }
  });
});
