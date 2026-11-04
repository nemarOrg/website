/**
 * The pure half of `/oauth/authorize` (nemar-cli ADR 0119): what the page reads from the visitor,
 * what it does with each answer the API can give, where it sends the visitor, and what it renders.
 *
 * Inputs are real-shaped: query strings and form bodies as a browser sends them, and API answers in
 * the shapes nemar-cli's `shared/contract/oidc-authorize.ts` declares (that contract is compared with
 * this module's literals by `test/oidc-authorize-contract-drift.test.ts`). This repository renders
 * no Astro page in a test, so "each kind renders" is held here, on the views the page prints, and by
 * `test/oidc-authorize-ui.test.ts`, on which view the page prints for which answer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_COPY, fillCopy } from "./account-copy";
import { safeRedirectPath } from "./auth";
import { getCrossHostRedirect, isAppRoute } from "./host";
import {
  OIDC_AUTHORIZE_HEADERS,
  OIDC_AUTHORIZE_PAGE_PATH,
  OIDC_ERROR_PAGE_CODES,
  OIDC_FORM_CONSENT_TOKEN,
  OIDC_FORM_DECISION,
  OIDC_FORM_REQUEST,
  OIDC_POST_BODY_MAX_LENGTH,
  OIDC_RULE_REFUSAL_REASONS,
  OIDC_SCOPE_COPY,
  type OidcAuthorizeOutcome,
  authorizeInputFromForm,
  authorizeInputFromQuery,
  consentView,
  errorPanelView,
  isFormActionOrigin,
  oidcAnswerOutcome,
  oidcAuthorizeMethodRefusal,
  oidcLoginRedirect,
  oidcNavigate,
  oidcPanelStatus,
  readAuthorizeInput,
  rulePanelView,
  usableLocation,
} from "./oidc-authorize";
import { isOsaWidgetExcludedPath } from "./osa-widget";

const PAGE = `https://app.nemar.org${OIDC_AUTHORIZE_PAGE_PATH}`;
const REQUEST =
  "client_id=oc_0123456789abcdef01234567&redirect_uri=https%3A%2F%2Fclient.example.org%2Fcallback&response_type=code&scope=openid+profile&state=st-123+%26+a%3Db&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256";
const LOCATION =
  "https://client.example.org/callback?code=abc&state=st&iss=https%3A%2F%2Fapi.nemar.org";

afterEach(() => {
  vi.restoreAllMocks();
});

const ok = (body: unknown) => ({ status: 200, body }) as const;

const CONSENT_BODY = {
  kind: "consent",
  client_name: "Compute portal",
  scopes: ["openid", "profile", "compute.reserve"],
  compute_spend: true,
  consent_token: "1999999999.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  redirect_origin: "https://client.example.org",
};

const RULE_BODY = {
  kind: "rule_refused",
  reason: "orcid_not_proven",
  client_name: "Compute portal",
  location:
    "https://client.example.org/callback?error=access_denied&iss=https%3A%2F%2Fapi.nemar.org",
};

// -------------------------------------------------------------------------------------------------

describe("the method", () => {
  it("lets GET and POST through and refuses every other method with the page's headers", () => {
    expect(oidcAuthorizeMethodRefusal("GET")).toBeNull();
    expect(oidcAuthorizeMethodRefusal("POST")).toBeNull();
    for (const method of ["HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const refused = oidcAuthorizeMethodRefusal(method);
      expect(refused?.status, method).toBe(405);
      expect(refused?.headers.get("Allow")).toBe("GET, POST");
      expect(refused?.headers.get("Cache-Control")).toBe("no-store");
      expect(refused?.headers.get("X-Frame-Options")).toBe("DENY");
    }
  });
});

describe("what the visitor sent", () => {
  it("a GET's request is its query string, as it arrived", () => {
    expect(authorizeInputFromQuery(`?${REQUEST}`)).toEqual({ kind: "check", request: REQUEST });
    expect(authorizeInputFromQuery("")).toEqual({ kind: "check", request: "" });
  });

  it("a POST without the consent token is an authorization request: the form body itself", () => {
    expect(authorizeInputFromForm(REQUEST)).toEqual({ kind: "check", request: REQUEST });
  });

  it("this page's consent form is read field by field", () => {
    const form = new URLSearchParams({
      [OIDC_FORM_REQUEST]: REQUEST,
      [OIDC_FORM_CONSENT_TOKEN]: "1999999999.token",
      [OIDC_FORM_DECISION]: "allow",
    }).toString();
    expect(authorizeInputFromForm(form)).toEqual({
      kind: "consent",
      request: REQUEST,
      consentToken: "1999999999.token",
      decision: "allow",
    });
  });

  it("a consent form with a field missing, repeated, or an unknown decision is invalid", () => {
    const base = {
      [OIDC_FORM_REQUEST]: REQUEST,
      [OIDC_FORM_CONSENT_TOKEN]: "t",
      [OIDC_FORM_DECISION]: "deny",
    };
    const without = (name: string) => {
      const p = new URLSearchParams(base);
      p.delete(name);
      return p.toString();
    };
    const twice = (name: string) => {
      const p = new URLSearchParams(base);
      p.append(name, "again");
      return p.toString();
    };
    for (const body of [
      without(OIDC_FORM_REQUEST),
      without(OIDC_FORM_DECISION),
      twice(OIDC_FORM_REQUEST),
      twice(OIDC_FORM_CONSENT_TOKEN),
      twice(OIDC_FORM_DECISION),
      new URLSearchParams({ ...base, [OIDC_FORM_DECISION]: "maybe" }).toString(),
    ]) {
      expect(authorizeInputFromForm(body)).toEqual({ kind: "invalid" });
    }
  });

  it("reads a GET from the URL and a POST only as a form within the size bound", async () => {
    expect(await readAuthorizeInput(new Request(`${PAGE}?${REQUEST}`))).toEqual({
      kind: "check",
      request: REQUEST,
    });
    const form = (body: string, type = "application/x-www-form-urlencoded; charset=UTF-8") =>
      new Request(PAGE, { method: "POST", headers: { "Content-Type": type }, body });
    expect(await readAuthorizeInput(form(REQUEST))).toEqual({ kind: "check", request: REQUEST });
    expect(await readAuthorizeInput(form(REQUEST, "application/json"))).toEqual({
      kind: "invalid",
    });
    expect(await readAuthorizeInput(form(REQUEST, "text/plain"))).toEqual({ kind: "invalid" });
    expect(await readAuthorizeInput(form("a".repeat(OIDC_POST_BODY_MAX_LENGTH + 1)))).toEqual({
      kind: "invalid",
    });
  });
});

describe("where a person may be sent", () => {
  it("only to an absolute https address, or http on a loopback host, with no credentials", () => {
    expect(usableLocation(LOCATION)).toBe(LOCATION);
    expect(usableLocation("http://localhost:8080/cb?code=x")).toBe(
      "http://localhost:8080/cb?code=x",
    );
    expect(usableLocation("http://127.0.0.1:3000/cb")).toBe("http://127.0.0.1:3000/cb");
    for (const bad of [
      "http://client.example.org/cb",
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative",
      "//client.example.org/cb",
      "https://user:pass@client.example.org/cb",
      "",
      42,
      null,
    ]) {
      expect(usableLocation(bad), String(bad)).toBeNull();
    }
  });

  it("the location is used as the API built it, never re-serialized", () => {
    const registeredQuery = "https://client.example.org/cb?tenant=a%20b&code=x";
    expect(usableLocation(registeredQuery)).toBe(registeredQuery);
  });
});

describe("the one origin the consent form may reach", () => {
  it("is a strict serialized origin", () => {
    for (const good of [
      "https://client.example.org",
      "https://client.example.org:8443",
      "http://localhost:8080",
      "http://127.0.0.1:3000",
    ]) {
      expect(isFormActionOrigin(good), good).toBe(true);
    }
  });

  it("refuses a host the URL parser keeps but a policy would split on", () => {
    // `new URL(v).origin === v` holds for every one of these: the URL standard allows these
    // characters in a host, so only the shape check stands between them and the policy.
    for (const bad of [
      "https://client.example.org;script-src",
      "https://a;b.example",
      "https://a'b.example",
      "https://a,b.example",
      "https://a*b.example",
    ]) {
      expect(new URL(bad).origin, bad).toBe(bad);
      expect(isFormActionOrigin(bad), bad).toBe(false);
    }
  });

  it("refuses anything that could add a source or a directive to the policy", () => {
    for (const bad of [
      "https://client.example.org/",
      "https://client.example.org/callback",
      "https://client.example.org?x=1",
      "https://client.example.org; script-src *",
      "https://client.example.org https://evil.example",
      "https://client.example.org,https://evil.example",
      "'self'",
      "*",
      "https:",
      "http://client.example.org",
      "https://Client.example.org",
      "https://user@client.example.org",
      "javascript:alert(1)",
      "",
      undefined,
      null,
    ]) {
      expect(isFormActionOrigin(bad), String(bad)).toBe(false);
    }
  });
});

describe("what each answer of the API does", () => {
  it("a redirect goes to its location", () => {
    expect(oidcAnswerOutcome(ok({ kind: "redirect", location: LOCATION }))).toEqual({
      kind: "redirect",
      location: LOCATION,
    });
  });

  it("a redirect to an unusable address is the unavailable panel, not a redirect", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const location of ["javascript:alert(1)", "http://evil.example/", "/login", undefined]) {
      expect(oidcAnswerOutcome(ok({ kind: "redirect", location }))).toEqual({
        kind: "error",
        code: "unavailable",
      });
    }
  });

  it("login and reauth carry the request to come back with", () => {
    expect(oidcAnswerOutcome(ok({ kind: "login", request: REQUEST }))).toEqual({
      kind: "login",
      request: REQUEST,
    });
    expect(oidcAnswerOutcome(ok({ kind: "reauth", request: REQUEST }))).toEqual({
      kind: "reauth",
      request: REQUEST,
    });
  });

  it("every error-page code the contract names is a panel of its own", () => {
    for (const code of OIDC_ERROR_PAGE_CODES) {
      expect(oidcAnswerOutcome(ok({ kind: "error_page", code }))).toEqual({ kind: "error", code });
    }
  });

  it("a refusal under the client's rule names the reason, the client and the way back", () => {
    expect(oidcAnswerOutcome(ok(RULE_BODY))).toEqual({
      kind: "rule_refused",
      reason: "orcid_not_proven",
      clientName: "Compute portal",
      location: RULE_BODY.location,
    });
  });

  it("the consent screen carries what it shows and the token it posts back", () => {
    expect(oidcAnswerOutcome(ok(CONSENT_BODY))).toEqual({
      kind: "consent",
      clientName: "Compute portal",
      scopes: ["openid", "profile", "compute.reserve"],
      computeSpend: true,
      consentToken: CONSENT_BODY.consent_token,
      redirectOrigin: "https://client.example.org",
    });
  });

  it("an answer whose shape is wrong is the unavailable panel", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unavailable = { kind: "error", code: "unavailable" };
    for (const body of [
      null,
      "redirect",
      { kind: "teleport" },
      { kind: "login" },
      { kind: "error_page", code: "made_up" },
      { ...RULE_BODY, reason: "made_up" },
      { ...RULE_BODY, location: "javascript:x" },
      { ...RULE_BODY, client_name: 5 },
      { ...CONSENT_BODY, redirect_origin: "https://client.example.org; form-action *" },
      { ...CONSENT_BODY, redirect_origin: "https://client.example.org/cb" },
      { ...CONSENT_BODY, scopes: [] },
      { ...CONSENT_BODY, scopes: ["openid", 5] },
      { ...CONSENT_BODY, compute_spend: "yes" },
      { ...CONSENT_BODY, consent_token: "" },
      { ...CONSENT_BODY, client_name: undefined },
    ]) {
      expect(oidcAnswerOutcome(ok(body)), JSON.stringify(body)).toEqual(unavailable);
    }
  });

  it("maps the call's own refusals: 400, 429, and everything else unavailable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(oidcAnswerOutcome({ status: 400, body: null })).toEqual({
      kind: "error",
      code: "invalid_request",
    });
    expect(oidcAnswerOutcome({ status: 429, body: null })).toEqual({
      kind: "error",
      code: "rate_limited",
    });
    for (const status of [302, 403, 404, 500, 503] as const) {
      expect(oidcAnswerOutcome({ status, body: ok(CONSENT_BODY).body })).toEqual({
        kind: "error",
        code: "unavailable",
      });
    }
    expect(oidcAnswerOutcome({ status: "network" })).toEqual({
      kind: "error",
      code: "unavailable",
    });
  });

  it("never logs a value from an answer: a code, a token or a location", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    oidcAnswerOutcome(ok({ kind: "redirect", location: "javascript:secret-code-value" }));
    oidcAnswerOutcome(
      ok({ ...CONSENT_BODY, redirect_origin: "bad", consent_token: "secret-token" }),
    );
    oidcAnswerOutcome(ok({ kind: "secret-kind-value" }));
    oidcAnswerOutcome({ status: 500, body: { code: "secret-code-value" } });
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toMatch(/secret/);
  });
});

describe("the way to sign in and back", () => {
  it("returns to this page with exactly the request the API gave", () => {
    const login = oidcLoginRedirect(REQUEST, false);
    const params = new URL(login, "https://app.nemar.org").searchParams;
    expect(login.startsWith("/login?")).toBe(true);
    expect(params.get("next")).toBe(`${OIDC_AUTHORIZE_PAGE_PATH}?${REQUEST}`);
    expect(params.has("error")).toBe(false);
    // The sign-in page keeps it: it passes the same check the sign-in page applies.
    expect(safeRedirectPath(params.get("next"))).toBe(params.get("next"));
  });

  it("a reauth says why the visitor is asked to sign in again", () => {
    const params = new URL(oidcLoginRedirect(REQUEST, true), "https://app.nemar.org").searchParams;
    expect(params.get("error")).toBe("session_required");
    expect(params.get("next")).toBe(`${OIDC_AUTHORIZE_PAGE_PATH}?${REQUEST}`);
  });

  it("a request the sign-in page would not keep returns to this page bare, never elsewhere", () => {
    const params = new URL(oidcLoginRedirect("state=a%5Cb", false), "https://app.nemar.org")
      .searchParams;
    expect(params.get("next")).toBe(OIDC_AUTHORIZE_PAGE_PATH);
  });

  it("redirects with the page's headers: 302 after a GET, 303 after a POST", () => {
    const afterGet = oidcNavigate(LOCATION, "GET");
    expect(afterGet.status).toBe(302);
    expect(afterGet.headers.get("Location")).toBe(LOCATION);
    expect(oidcNavigate(LOCATION, "POST").status).toBe(303);
    for (const [name, value] of Object.entries(OIDC_AUTHORIZE_HEADERS)) {
      expect(afterGet.headers.get(name), name).toBe(value);
    }
  });
});

describe("what each panel says", () => {
  const consent = oidcAnswerOutcome(ok(CONSENT_BODY)) as Extract<
    OidcAuthorizeOutcome,
    { kind: "consent" }
  >;

  it("the consent screen names the client, says it can act as the person, and lists the scopes", () => {
    const view = consentView(consent);
    expect(view.title).toBe("Compute portal wants to use your NEMAR account");
    expect(view.actsAsYou).toContain("Compute portal can act as you");
    expect(view.scopesTitle).toBe(ACCOUNT_COPY["oidc.consent.scopes_title"]);
    expect(view.scopeLines).toEqual([
      ACCOUNT_COPY["oidc.consent.scope.openid"],
      ACCOUNT_COPY["oidc.consent.scope.profile"],
      ACCOUNT_COPY["oidc.consent.scope.compute.reserve"],
    ]);
    expect(view.allow).toBe("Allow");
    expect(view.deny).toBe("Deny");
  });

  it("says the client can spend compute time only when the API says it can", () => {
    expect(consentView(consent).computeSpend).toBe(ACCOUNT_COPY["oidc.consent.compute_spend"]);
    expect(consentView({ ...consent, computeSpend: false }).computeSpend).toBeNull();
  });

  it("shows a scope this build has no sentence for by its name, never hides it", () => {
    expect(consentView({ ...consent, scopes: ["openid", "brand.new"] }).scopeLines).toEqual([
      ACCOUNT_COPY["oidc.consent.scope.openid"],
      "brand.new",
    ]);
  });

  it("the refusal panel gives each reason its sentence and links back to the client", () => {
    for (const reason of OIDC_RULE_REFUSAL_REASONS) {
      const view = rulePanelView({
        kind: "rule_refused",
        reason,
        clientName: "Compute portal",
        location: RULE_BODY.location,
      });
      expect(view.title).toBe("You can’t sign in to Compute portal with this account");
      expect(view.body).toBe(
        fillCopy(ACCOUNT_COPY[`oidc.rule.${reason}`], { client: "Compute portal" }),
      );
      expect(view.link).toEqual({ href: RULE_BODY.location, label: "Return to Compute portal" });
    }
  });

  it("an error panel has a sentence for every code and links nowhere", () => {
    for (const code of [...OIDC_ERROR_PAGE_CODES, "rate_limited"] as const) {
      const view = errorPanelView(code);
      expect(view.title).toBe(ACCOUNT_COPY["oidc.error.title"]);
      expect(view.body).toBe(ACCOUNT_COPY[`oidc.error.${code}`]);
      expect(view.link).toBeNull();
    }
  });

  it("answers each panel with its status", () => {
    expect(oidcPanelStatus(consent)).toBe(200);
    expect(
      oidcPanelStatus({
        kind: "rule_refused",
        reason: "account_inactive",
        clientName: "x",
        location: LOCATION,
      }),
    ).toBe(403);
    expect(oidcPanelStatus({ kind: "error", code: "rate_limited" })).toBe(429);
    expect(oidcPanelStatus({ kind: "error", code: "unavailable" })).toBe(503);
    for (const code of [
      "invalid_client",
      "invalid_redirect_uri",
      "invalid_request",
      "consent_invalid",
    ] as const) {
      expect(oidcPanelStatus({ kind: "error", code })).toBe(400);
    }
  });

  it("every oidc sentence in the copy table is one this page prints", () => {
    const printed = new Set<string>();
    const client = { client: "Compute portal" };
    const all = consentView({ ...consent, scopes: Object.keys(OIDC_SCOPE_COPY) });
    for (const s of [
      all.title,
      all.actsAsYou,
      all.computeSpend,
      all.scopesTitle,
      all.allow,
      all.deny,
      ...all.scopeLines,
    ]) {
      if (s) printed.add(s);
    }
    for (const reason of OIDC_RULE_REFUSAL_REASONS) {
      const v = rulePanelView({
        kind: "rule_refused",
        reason,
        clientName: "Compute portal",
        location: LOCATION,
      });
      printed
        .add(v.title)
        .add(v.body)
        .add(v.link?.label ?? "");
    }
    for (const code of [...OIDC_ERROR_PAGE_CODES, "rate_limited"] as const) {
      const v = errorPanelView(code);
      printed.add(v.title).add(v.body);
    }
    const unprinted = Object.entries(ACCOUNT_COPY)
      .filter(([key]) => key.startsWith("oidc."))
      .filter(([, value]) => !printed.has(fillCopy(value, client)))
      .map(([key]) => key);
    expect(unprinted).toEqual([]);
  });
});

describe("where the page lives", () => {
  it("is an app-host route: the marketing host sends it to the app host, a POST with 307's method", () => {
    expect(isAppRoute(OIDC_AUTHORIZE_PAGE_PATH)).toBe(true);
    const url = new URL(`https://nemar.org${OIDC_AUTHORIZE_PAGE_PATH}?${REQUEST}`);
    expect(getCrossHostRedirect(url)).toBe(
      `https://app.nemar.org${OIDC_AUTHORIZE_PAGE_PATH}?${REQUEST}`,
    );
    expect(
      getCrossHostRedirect(new URL(`https://app.nemar.org${OIDC_AUTHORIZE_PAGE_PATH}`)),
    ).toBeNull();
  });

  it("never carries the assistant widget", () => {
    expect(isOsaWidgetExcludedPath(OIDC_AUTHORIZE_PAGE_PATH)).toBe(true);
  });

  it("is never cacheable, framable, indexed or a referrer", () => {
    expect(OIDC_AUTHORIZE_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
      "X-Frame-Options": "DENY",
    });
  });
});
