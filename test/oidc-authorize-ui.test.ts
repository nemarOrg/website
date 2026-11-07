/**
 * Source-level guards for `/oauth/authorize` (nemar-cli ADR 0119), in the style of
 * `test/private-authorize-ui.test.ts`: this repository has no Astro rendering harness, so reading the
 * page source through Vite's `?raw` is the honest cheap check for a server-rendered page with no
 * client script.
 *
 * The helpers in `src/lib/oidc-authorize.ts` are covered by their own test, which holds what each
 * panel says. What only the page decides is ORDER and WIRING: the headers are on before anything
 * else, a method other than GET or POST and a malformed POST never reach the API, each answer of the
 * API leads to exactly one destination, the consent form posts back here with the request and the
 * token, the one origin the form may reach is named only on the consent screen, and nothing about
 * the request reaches a log.
 */

import { describe, expect, it } from "vitest";
import PAGE from "../src/pages/oauth/authorize.astro?raw";

/** The frontmatter only, so a match cannot come from the template or the scoped style. */
const FRONTMATTER = PAGE.split("---")[1] ?? "";
/** The template only. */
const TEMPLATE = PAGE.split("---").slice(2).join("---").split("<style>")[0] ?? "";

function at(needle: string): number {
  const index = FRONTMATTER.indexOf(needle);
  expect(index, `expected the page to contain ${needle}`).toBeGreaterThan(-1);
  return index;
}

describe("the order of things", () => {
  it("sets the page's headers before anything else runs", () => {
    const headersAt = at("Object.entries(OIDC_AUTHORIZE_HEADERS)");
    expect(at("Astro.response.headers.set(name, value)")).toBeGreaterThan(headersAt);
    expect(at("oidcAuthorizeMethodRefusal(Astro.request.method)")).toBeGreaterThan(headersAt);
  });

  it("refuses any method but GET and POST before the request is read or the API called", () => {
    const methodAt = at("oidcAuthorizeMethodRefusal(Astro.request.method)");
    expect(FRONTMATTER).toContain("if (methodRefusal !== null) return methodRefusal;");
    expect(at("await readAuthorizeInput(Astro.request, Astro.url.origin)")).toBeGreaterThan(methodAt);
    expect(at("await requestOidcCheck(")).toBeGreaterThan(methodAt);
    expect(at("await requestOidcConsent(")).toBeGreaterThan(methodAt);
  });

  it("a cross-site POST that names a consent field is refused with a 403 before the API is called", () => {
    // The middleware exempts the authorization-request POST (`src/lib/origin-check.ts`); the page is
    // where a cross-site consent dies. The reader is given this site's origin, and its `forbidden`
    // answer returns the 403 straight away: before the API calls, before anything is rendered.
    const readAt = at("await readAuthorizeInput(Astro.request, Astro.url.origin)");
    const forbiddenAt = at('if (input.kind === "forbidden") return oidcCrossSiteRefusal(method);');
    expect(forbiddenAt).toBeGreaterThan(readAt);
    expect(forbiddenAt).toBeLessThan(at("await requestOidcCheck("));
    expect(forbiddenAt).toBeLessThan(at("await requestOidcConsent("));
    // The consent route is reached from the `consent` kind only, which the reader makes only for a
    // same-origin POST (`src/lib/oidc-authorize.test.ts` holds that half).
    expect(FRONTMATTER.match(/input\.kind === "consent"/g)).toHaveLength(1);
  });

  it("a request this page cannot read never reaches the API", () => {
    expect(FRONTMATTER).toMatch(
      /if \(input\.kind === "invalid"\) \{\s*outcome = \{ kind: "error", code: "invalid_request" \};\s*\} else if \(input\.kind === "consent"\)/,
    );
    expect(FRONTMATTER.match(/await requestOidcCheck\(/g)).toHaveLength(1);
    expect(FRONTMATTER.match(/await requestOidcConsent\(/g)).toHaveLength(1);
  });

  it("only the consent form's answer goes to the consent route", () => {
    expect(FRONTMATTER).toMatch(
      /input\.kind === "consent"\) \{\s*outcome = oidcAnswerOutcome\(\s*await requestOidcConsent\(/,
    );
  });
});

describe("the API calls", () => {
  it("forward the visitor's own cookie and pin Origin to this request's origin", () => {
    expect(FRONTMATTER).toContain('cookieHeader: Astro.request.headers.get("cookie") ?? undefined');
    expect(FRONTMATTER).toContain("origin: Astro.url.origin");
    expect(FRONTMATTER).not.toMatch(/origin:\s*"https:\/\//);
    expect(FRONTMATTER.match(/\.\.\.call,/g)).toHaveLength(2);
  });

  it("send the request as read, and the consent form's own token and decision", () => {
    expect(FRONTMATTER).toContain("await requestOidcCheck({ ...call, request: input.request })");
    expect(FRONTMATTER).toMatch(
      /request: input\.request,\s*consentToken: input\.consentToken,\s*decision: input\.decision,/,
    );
  });
});

describe("each answer leads to exactly one destination", () => {
  it("a redirect goes to the API's location, sign-in through the sign-in page, all with the page's headers", () => {
    expect(FRONTMATTER).toMatch(
      /if \(outcome\.kind === "redirect"\) \{\s*return oidcNavigate\(outcome\.location, method\);\s*\}/,
    );
    // Sign-in again only for reauth: the sign-in page then says why.
    expect(FRONTMATTER).toMatch(
      /if \(outcome\.kind === "login" \|\| outcome\.kind === "reauth"\) \{\s*return oidcNavigate\(oidcLoginRedirect\(outcome\.request, outcome\.kind === "reauth"\), method\);\s*\}/,
    );
    expect(FRONTMATTER.match(/return oidcNavigate\(/g)).toHaveLength(2);
    expect(FRONTMATTER).not.toMatch(/Astro\.redirect\(/);
    expect(FRONTMATTER).not.toMatch(/new Response\(/);
  });

  it("every other answer renders a panel with its status", () => {
    expect(FRONTMATTER).toContain(
      'const consent = outcome.kind === "consent" ? consentView(outcome) : null;',
    );
    expect(FRONTMATTER).toMatch(/outcome\.kind === "rule_refused"\s*\?\s*rulePanelView\(outcome\)/);
    expect(FRONTMATTER).toMatch(/outcome\.kind === "error"\s*\?\s*errorPanelView\(outcome\.code\)/);
    expect(FRONTMATTER).toContain("Astro.response.status = oidcPanelStatus(outcome);");
  });
});

describe("the consent screen", () => {
  it("keeps the form's Origin: same-origin referrer policy on the consent screen only", () => {
    // Under no-referrer a same-origin form post carries `Origin: null` and the site's cross-site
    // form check refuses every Allow and Deny. Redirects and the other panels keep no-referrer.
    expect(FRONTMATTER).toMatch(
      /if \(outcome\.kind === "consent"\) \{[\s\S]{0,600}Astro\.response\.headers\.set\("Referrer-Policy", OIDC_CONSENT_REFERRER_POLICY\);/,
    );
    expect(FRONTMATTER.match(/OIDC_CONSENT_REFERRER_POLICY\)/g)).toHaveLength(1);
  });

  it("says where either answer sends the person", () => {
    expect(TEMPLATE).toContain("{consent.redirectHost}");
  });

  it("names the one origin the form may reach, on the consent screen only", () => {
    expect(FRONTMATTER).toMatch(
      /if \(outcome\.kind === "consent"\) \{[\s\S]{0,400}Astro\.response\.headers\.set\(OIDC_FORM_ACTION_ORIGIN_HEADER, outcome\.redirectOrigin\);/,
    );
    expect(FRONTMATTER.match(/headers\.set\(OIDC_FORM_ACTION_ORIGIN_HEADER/g)).toHaveLength(1);
  });

  it("posts back to this page, never to the API or the client", () => {
    expect(TEMPLATE).toContain('method="post" action={OIDC_AUTHORIZE_PAGE_PATH}');
    expect(TEMPLATE.match(/<form\b/g)).toHaveLength(1);
  });

  it("carries the request the check read and the token, and nothing else, as hidden fields", () => {
    expect(FRONTMATTER).toContain(
      'const formRequest = input.kind === "check" ? input.request : "";',
    );
    expect(TEMPLATE).toContain(
      '<input type="hidden" name={OIDC_FORM_REQUEST} value={formRequest} />',
    );
    expect(TEMPLATE).toContain(
      '<input type="hidden" name={OIDC_FORM_CONSENT_TOKEN} value={consentToken} />',
    );
    expect(TEMPLATE.match(/type="hidden"/g)).toHaveLength(2);
  });

  it("asks with two buttons, deny and allow, that the person has to press", () => {
    expect(TEMPLATE).toMatch(/name=\{OIDC_FORM_DECISION\} value="deny"/);
    expect(TEMPLATE).toMatch(/name=\{OIDC_FORM_DECISION\} value="allow"/);
    expect(TEMPLATE).not.toMatch(/autofocus/);
  });

  it("prints the view's sentences, the scope list and the compute warning", () => {
    for (const expr of [
      "{consent.title}",
      "{consent.actsAsYou}",
      "{consent.computeSpend}",
      "{consent.scopesTitle}",
      "{consent.deny}",
      "{consent.allow}",
    ]) {
      expect(TEMPLATE).toContain(expr);
    }
    expect(TEMPLATE).toMatch(/consent\.scopeLines\.map\(\(line\) => \(\s*<li>\{line\}<\/li>/);
  });
});

describe("the refusal and error panels", () => {
  it("print the view's title and body, and link only where the view gives a link", () => {
    expect(TEMPLATE).toContain("{panel.title}");
    expect(TEMPLATE).toContain("{panel.body}");
    expect(TEMPLATE).toContain('<a href={panel.link.href} rel="noreferrer">{panel.link.label}</a>');
    expect(TEMPLATE).toMatch(/panel\.link !== null &&/);
  });
});

describe("nothing about the request reaches a log or the page unescaped", () => {
  it("never logs", () => {
    expect(FRONTMATTER).not.toMatch(/console\.\w+\(/);
  });

  it("renders no raw HTML and no client-side script", () => {
    expect(PAGE).not.toMatch(/set:html/);
    expect(PAGE).not.toMatch(/<script(?![^>]*\bis:raw\b)/);
  });

  it("never prints the request, the outcome or the input directly", () => {
    expect(TEMPLATE).not.toMatch(/\{\s*(input|outcome|call)\b/);
  });
});
