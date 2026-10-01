/**
 * Source-level guards for `/auth/private/authorize`, in the style of `test/docs-authorize-ui.test.ts`:
 * this repo has no Astro rendering harness, so reading the page source via Vite's `?raw` (never
 * `node:fs`, since `astro check` type-checks every file with no `@types/node`) is the honest cheap
 * check for a server-rendered page with no client script.
 *
 * The helpers in `src/lib/private-authorize.ts` are covered by their own test. What only the page
 * decides is ORDER and WIRING: the `state` is refused before a signed-out visitor is sent to sign
 * in and before a grant is minted, the grant is only requested once the session and the target
 * host are both settled, the backend call carries the pinned `Origin` and the visitor's cookie,
 * every response carries the no-store/no-referrer headers, and the `state` never reaches the
 * callback or a log line. Each can be broken by a plausible refactor while the helper tests stay
 * green.
 */

import { describe, expect, it } from "vitest";
import PAGE from "../src/pages/auth/private/authorize.astro?raw";

/** The frontmatter only, so a match cannot come from the template or the scoped style. */
const FRONTMATTER = PAGE.split("---")[1] ?? "";

/** Offset of `needle`, failing loudly when it is missing so an ordering check cannot pass on -1. */
function at(needle: string): number {
  const index = FRONTMATTER.indexOf(needle);
  expect(index, `expected the page to contain ${needle}`).toBeGreaterThan(-1);
  return index;
}

describe("the order of checks", () => {
  it("validates the state before the session check, the target check and the grant", () => {
    const stateAt = at("privateState(url.searchParams.get(PRIVATE_AUTHORIZE_STATE_PARAM))");
    expect(at("getSession(Astro.locals)")).toBeGreaterThan(stateAt);
    expect(at("privateHandoffTarget(")).toBeGreaterThan(stateAt);
    expect(at("await requestPrivateGrant(")).toBeGreaterThan(stateAt);
  });

  it("does everything else only inside the valid-state branch", () => {
    // The default panel is the invalid-request one, and the only way off it is this branch.
    expect(FRONTMATTER).toContain('let panel: PrivateAuthorizePanel = "invalid_request";');
    const branchAt = at("if (state !== null) {");
    expect(at("getSession(Astro.locals)")).toBeGreaterThan(branchAt);
  });

  it("sends a signed-out visitor to sign in before any grant is requested", () => {
    const signedOutAt = at("if (!session) {");
    expect(at("await requestPrivateGrant(")).toBeGreaterThan(signedOutAt);
  });

  it("only calls the backend inside the ready branch", () => {
    // A grant minted on a deployment that cannot name its private site could only be spent by a
    // host that never saw it. Refusing after minting would be too late.
    const readyAt = at('handoff.kind === "ready"');
    expect(at("await requestPrivateGrant(")).toBeGreaterThan(readyAt);
    expect(FRONTMATTER.match(/await requestPrivateGrant\(/g)).toHaveLength(1);
  });

  it("reads the private-site base from server configuration, never from the request", () => {
    expect(FRONTMATTER).toContain(
      "privateHandoffTarget(apiBase(), import.meta.env.PRIVATE_SITE_BASE ?? null)",
    );
    expect(FRONTMATTER).not.toMatch(/searchParams\.get\("(base|host|target|redirect_uri)"\)/);
  });
});

describe("the backend call", () => {
  it("pins Origin to the request's own origin, never a hardcoded host", () => {
    expect(FRONTMATTER).toContain("origin: Astro.url.origin");
    expect(FRONTMATTER).not.toMatch(/origin:\s*"https:\/\//);
  });

  it("forwards the visitor's own cookie header", () => {
    expect(FRONTMATTER).toContain('cookieHeader: Astro.request.headers.get("cookie")');
  });

  it("forwards the validated state, not the raw query value", () => {
    expect(FRONTMATTER).toMatch(/await requestPrivateGrant\(\{[\s\S]{0,160}\bstate,\s*\}\)/);
  });
});

describe("each outcome maps to one destination", () => {
  it("hands a minted code to the private site's callback, without the state", () => {
    expect(FRONTMATTER).toMatch(
      /outcome\.kind === "handoff"\)\s*\{\s*redirectTo = privateCallbackUrl\(handoff\.base, outcome\.code, next\);/,
    );
    expect(FRONTMATTER).not.toMatch(/privateCallbackUrl\([^)]*\bstate\b/);
  });

  it("treats a backend 401 as no session, with the reason shown on the sign-in page", () => {
    expect(FRONTMATTER).toMatch(
      /outcome\.kind === "signed_out"\)\s*\{[\s\S]{0,300}redirectTo = privateLoginRedirect\(returnPath, true\);/,
    );
  });

  it("builds the sign-in return address from the validated values, not the raw query", () => {
    expect(FRONTMATTER).toContain("privateAuthorizeReturnPath(state, next)");
    expect(FRONTMATTER).not.toContain("url.search}");
    expect(FRONTMATTER).not.toMatch(/url\.search\b(?!Params)/);
  });

  it("renders the panel for every other outcome, and refuses a misconfigured host with a panel", () => {
    expect(FRONTMATTER).toContain("panel = outcome.kind;");
    expect(FRONTMATTER).toMatch(/handoff\.reason[\s\S]{0,120}panel = "misconfigured";/);
    expect(FRONTMATTER).toContain("Astro.response.status = PRIVATE_AUTHORIZE_STATUS[panel];");
  });
});

describe("headers on every response", () => {
  it("never calls the bare Astro.redirect; every redirect goes through handoffRedirect", () => {
    expect(FRONTMATTER).not.toMatch(/return Astro\.redirect\(/);
    expect(FRONTMATTER).toContain("return handoffRedirect(redirectTo);");
  });

  it("the handoffRedirect helper carries the page's headers", () => {
    expect(FRONTMATTER).toMatch(
      /function handoffRedirect\([\s\S]{0,200}Location: location, \.\.\.PRIVATE_AUTHORIZE_HEADERS/,
    );
  });

  it("sets the headers on the rendered response before anything else runs", () => {
    const headersAt = at("Astro.response.headers.set(name, value)");
    expect(FRONTMATTER.indexOf("Object.entries(PRIVATE_AUTHORIZE_HEADERS)")).toBeLessThan(
      headersAt,
    );
    expect(at("privateState(")).toBeGreaterThan(headersAt);
  });
});

describe("nothing about the request reaches a log or the visitor", () => {
  it("never logs the URL, the query or the state", () => {
    for (const call of FRONTMATTER.match(/console\.\w+\([^;]*\);/g) ?? []) {
      expect(call).not.toMatch(/\b(url|state|next|Astro\.request|Astro\.url|searchParams)\b/);
    }
  });

  it("renders only the fixed copy", () => {
    expect(PAGE).toContain("{copy.title}");
    expect(PAGE).toContain("{copy.body}");
    expect(PAGE).not.toMatch(/\{\s*(outcome|state|next)\b/);
  });

  it("has no client-side script", () => {
    expect(PAGE).not.toMatch(/<script(?![^>]*\bis:raw\b)/);
  });
});
