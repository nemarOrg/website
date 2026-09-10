import { describe, expect, it, vi } from "vitest";
import {
  DOCS_CALLBACK_PATH,
  DOCS_DEFAULT_NEXT,
  docsCallbackUrl,
  docsGrantOutcome,
  docsHandoffTarget,
  safeDocsNext,
} from "./docs-authorize";
import { getCrossHostRedirect, getRetiredRedirect, isAppRoute } from "./host";

/**
 * Every `safeDocsNext` case pins an explicit base, so these assertions say what they mean without
 * depending on whether `PUBLIC_DOCS_BASE_URL` happens to be set in the environment running them.
 * `docs-base.test.ts` already covers the resolution itself.
 */
const DOCS = "https://docs.nemar.org";

/** The authorize page's own path, asserted against `./host.ts` below. */
const AUTHORIZE_PATH = "/auth/docs/authorize";

describe("where the authorize page is allowed to live", () => {
  // Not a test of this module, but of the constraint that decides its route. The middle hop only
  // works on a host the `Domain=app.nemar.org` session cookie reaches, and the obvious-looking
  // path for it is the one place it can never go.
  it("classifies /auth/docs/authorize as an app-host route", () => {
    expect(isAppRoute(AUTHORIZE_PATH)).toBe(true);
  });

  it("is not swallowed by the retired-/docs redirect", () => {
    expect(
      getRetiredRedirect(new URL(`https://app.nemar.org${AUTHORIZE_PATH}?next=%2Fadmin%2Fx`)),
    ).toBeNull();
    // The route this page deliberately is NOT: `/docs/*` 301s to the docs host before any other
    // routing runs, dropping `next` and bouncing the visitor straight back where they came from.
    expect(
      getRetiredRedirect(new URL("https://app.nemar.org/docs/authorize?next=%2Fadmin%2Fx")),
    ).toBe("https://docs.nemar.org/");
  });

  it("stays put on the app host and is pulled back to it from marketing, query intact", () => {
    expect(getCrossHostRedirect(new URL(`https://app.nemar.org${AUTHORIZE_PATH}`))).toBeNull();
    // A stray hit on the marketing host still lands correctly rather than losing the handoff.
    expect(
      getCrossHostRedirect(new URL(`https://nemar.org${AUTHORIZE_PATH}?next=%2Fadmin%2Fx`)),
    ).toBe(`https://app.nemar.org${AUTHORIZE_PATH}?next=%2Fadmin%2Fx`);
  });
});

describe("safeDocsNext: values it accepts", () => {
  it("accepts a docs admin path and returns it unchanged", () => {
    expect(safeDocsNext("/admin/", DOCS)).toBe("/admin/");
    expect(safeDocsNext("/admin/whatever", DOCS)).toBe("/admin/whatever");
    expect(safeDocsNext("/admin/deep/nested/page/", DOCS)).toBe("/admin/deep/nested/page/");
  });

  it("preserves a query string and fragment rather than normalizing them away", () => {
    // The docs host is what interprets these; this hop only has to not corrupt them.
    expect(safeDocsNext("/admin/page?tab=keys#section", DOCS)).toBe("/admin/page?tab=keys#section");
  });

  it("honors an explicit docs base, so staging is not measured against production", () => {
    expect(safeDocsNext("/admin/x", "https://docs-test.nemar.org")).toBe("/admin/x");
  });

  it("leaves a percent-encoded path segment encoded", () => {
    // `%2f` is not decoded by the URL parser into a path separator, so this stays one segment and
    // stays on the docs origin. Returning `raw` means the callback receives what the visitor sent.
    expect(safeDocsNext("/admin/a%20b", DOCS)).toBe("/admin/a%20b");
  });
});

describe("safeDocsNext: absolute and protocol-relative URLs", () => {
  it("refuses an absolute URL on another host", () => {
    expect(safeDocsNext("https://evil.example/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("http://evil.example/admin/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses an absolute URL whatever the scheme's casing", () => {
    // The prefix rule never inspects a scheme, so there is no case-sensitive comparison here to
    // get wrong — these are refused at any casing, which is what this pins.
    expect(safeDocsNext("HTTPS://evil.example/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("HtTpS://evil.example/admin/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("JaVaScRiPt:alert(1)", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("javascript:alert(1)", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("DATA:text/html,<script>x</script>", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses an absolute URL on the docs host itself", () => {
    // Same destination, but a `next` is a PATH by contract. Accepting an absolute form would mean
    // the origin check has to be the only thing standing between this and an open redirect.
    expect(safeDocsNext(`${DOCS}/admin/x`, DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses a protocol-relative URL", () => {
    // The canonical open-redirect payload: a browser reads `//evil.example` in a Location as a
    // host, not a path.
    expect(safeDocsNext("//evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("//evil.example/admin/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("///evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses backslash variants of the same trick", () => {
    // WHATWG treats `\` as a path separator for special schemes, so `/\evil.example` resolves to a
    // HOST. A string check that only looked for `//` would pass every one of these.
    expect(safeDocsNext("/\\evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("\\\\evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/\\/evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/\\evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });
});

describe("safeDocsNext: paths outside the admin tree", () => {
  it("refuses a docs path that is not under /admin/", () => {
    expect(safeDocsNext("/", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/web/getting-started/", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/dashboard", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses a prefix that merely starts with the word admin", () => {
    // `/administrators` is not in the admin tree; a `startsWith("/admin")` check would take it.
    expect(safeDocsNext("/administrators", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin-secrets/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses bare /admin without its trailing slash, landing on the default instead", () => {
    // Same destination either way, so this costs nothing; the rule stays one exact prefix.
    expect(safeDocsNext("/admin", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("is case-sensitive about the admin prefix", () => {
    // Docs paths are lowercase. `/Admin/x` is not a page on that site, so guessing at it would
    // hand the callback a path that 404s after a successful sign-in.
    expect(safeDocsNext("/Admin/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/ADMIN/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses traversal out of the admin tree, encoded or not", () => {
    // Same-origin, so not an open redirect — but it escapes the tree this handoff exists for. The
    // encoded form is the one a string-only check misses: the URL parser collapses `%2e%2e` into a
    // real `..` segment.
    expect(safeDocsNext("/admin/../secret", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/..", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/%2e%2e/%2e%2e/secret", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });
});

describe("safeDocsNext: control characters and header injection", () => {
  it("refuses a value carrying CR or LF", () => {
    // The value lands in a `Location` header. A raw CRLF is a second header.
    expect(safeDocsNext("/admin/x\nLocation: https://evil.example", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/x\r\nSet-Cookie: a=b", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/x\r", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses CR/LF that only appears once decoded", () => {
    // A parser that strips the escapes before resolving the URL sees the injection the literal
    // string does not.
    expect(safeDocsNext("/admin/x%0d%0aSet-Cookie:%20a=b", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/x%0A%0D", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("refuses tabs, NUL and DEL", () => {
    // The WHATWG parser removes tabs and newlines from a URL and some proxies do not, so a value
    // containing one means different things to different readers.
    expect(safeDocsNext("/admin/\tx", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/x\u0000", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/x\u007f", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/ad\tmin/x", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });
});

describe("safeDocsNext: absent, malformed and oversized input", () => {
  it("defaults for a missing value", () => {
    expect(safeDocsNext(null, DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext(undefined, DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("defaults for a non-string, since the query value reaches it untyped", () => {
    expect(safeDocsNext(42 as unknown as string, DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext({} as unknown as string, DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("defaults on a malformed percent escape instead of throwing", () => {
    // `decodeURIComponent` throws on these, and a throw in page frontmatter is a 500.
    expect(safeDocsNext("/admin/%zz", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/100%", DOCS)).toBe(DOCS_DEFAULT_NEXT);
    expect(safeDocsNext("/admin/%E0%A4%A", DOCS)).toBe(DOCS_DEFAULT_NEXT);
  });

  it("defaults for an absurdly long value rather than reflecting it into a header", () => {
    expect(safeDocsNext(`/admin/${"a".repeat(600)}`, DOCS)).toBe(DOCS_DEFAULT_NEXT);
    // Just under the cap still goes through, so the limit is a guard rather than a surprise.
    const nearLimit = `/admin/${"a".repeat(400)}`;
    expect(safeDocsNext(nearLimit, DOCS)).toBe(nearLimit);
  });

  it("defaults when the docs base itself will not parse", () => {
    // Misconfigured `PUBLIC_DOCS_BASE_URL`. The gate fails closed rather than throwing at render.
    expect(safeDocsNext("/admin/x", "not-a-url")).toBe(DOCS_DEFAULT_NEXT);
  });

  it("never returns anything a caller has to re-validate", () => {
    // Whatever it is handed, the answer is a docs admin path. This is the property the page relies
    // on when it drops the value straight into a redirect.
    const inputs = [
      "//evil.example",
      "https://evil.example",
      "/admin/../x",
      "/admin/x\r\n",
      null,
      "",
    ];
    for (const input of inputs) {
      expect(safeDocsNext(input, DOCS).startsWith("/admin/")).toBe(true);
    }
  });
});

describe("docsCallbackUrl", () => {
  it("builds the callback URL with both parameters encoded", () => {
    expect(docsCallbackUrl(DOCS, "abc123", "/admin/whatever")).toBe(
      `${DOCS}${DOCS_CALLBACK_PATH}?code=abc123&next=%2Fadmin%2Fwhatever`,
    );
  });

  it("strips a trailing slash on the base so the path is never doubled", () => {
    expect(docsCallbackUrl(`${DOCS}/`, "abc123", "/admin/")).toBe(
      `${DOCS}${DOCS_CALLBACK_PATH}?code=abc123&next=%2Fadmin%2F`,
    );
  });

  it("encodes a next that would otherwise smuggle a parameter into the callback's query", () => {
    // `URLSearchParams` is what makes this safe; string concatenation would let the `&` through and
    // let a crafted `next` set the callback's own `code`.
    const url = docsCallbackUrl(DOCS, "abc123", "/admin/x?a=1&code=stolen");
    expect(url).toBe(
      `${DOCS}${DOCS_CALLBACK_PATH}?code=abc123&next=%2Fadmin%2Fx%3Fa%3D1%26code%3Dstolen`,
    );
    // Read back the way the callback will read it: one `code`, and it is ours.
    expect(new URL(url).searchParams.getAll("code")).toEqual(["abc123"]);
    expect(new URL(url).searchParams.get("next")).toBe("/admin/x?a=1&code=stolen");
  });

  it("encodes a code containing URL-significant characters", () => {
    // The code is opaque by contract, so nothing here may assume it is alphanumeric.
    const url = docsCallbackUrl(DOCS, "a+b/c=d&e", "/admin/");
    expect(new URL(url).searchParams.get("code")).toBe("a+b/c=d&e");
  });

  it("targets the docs host given, not a hardcoded production one", () => {
    expect(docsCallbackUrl("https://docs-test.nemar.org", "c", "/admin/")).toBe(
      `https://docs-test.nemar.org${DOCS_CALLBACK_PATH}?code=c&next=%2Fadmin%2F`,
    );
  });
});

describe("docsGrantOutcome", () => {
  it("hands off on a 200 carrying a code", () => {
    expect(docsGrantOutcome({ status: 200, body: { code: "xyz", expires_in: 60 } })).toEqual({
      kind: "handoff",
      code: "xyz",
    });
  });

  it("ignores expires_in and any other field the backend adds later", () => {
    expect(
      docsGrantOutcome({ status: 200, body: { code: "xyz", expires_in: 1, extra: true } }),
    ).toEqual({ kind: "handoff", code: "xyz" });
  });

  it("treats 401 as no session", () => {
    expect(docsGrantOutcome({ status: 401, body: { error: "unauthenticated" } })).toEqual({
      kind: "signed_out",
    });
  });

  it("treats 404 as the not-an-admin verdict", () => {
    // 404 rather than 403 is deliberate on the backend, so the admin surface is not disclosed.
    expect(docsGrantOutcome({ status: 404, body: { error: "not_found" } })).toEqual({
      kind: "not_found",
    });
  });

  it("reports a 200 with no usable code as unavailable, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(docsGrantOutcome({ status: 200, body: {} }).kind).toBe("unavailable");
      expect(docsGrantOutcome({ status: 200, body: { code: "" } }).kind).toBe("unavailable");
      expect(docsGrantOutcome({ status: 200, body: { code: 123 } }).kind).toBe("unavailable");
      expect(docsGrantOutcome({ status: 200, body: null }).kind).toBe("unavailable");
      // A non-JSON body reaches here as null from the client; four bodies, four log lines.
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("folds every other status into unavailable and logs which one it was", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 403 is the realistic one: the backend Origin allow-list refusing the SSR call.
      expect(docsGrantOutcome({ status: 403, body: { error: "Origin not allowed" } }).kind).toBe(
        "unavailable",
      );
      expect(docsGrantOutcome({ status: 429, body: {} }).kind).toBe("unavailable");
      expect(docsGrantOutcome({ status: 500, body: null }).kind).toBe("unavailable");
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a network failure as unavailable without logging it twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(docsGrantOutcome({ status: "network" })).toEqual({ kind: "unavailable" });
      // `requestDocsGrant` already logged the cause with the error in hand; a second line here
      // would say strictly less about it.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("docsHandoffTarget", () => {
  // The defect this closes: staging sets PUBLIC_API_BASE_URL but deliberately does NOT set
  // PUBLIC_DOCS_BASE_URL, so the page used to mint a grant against the staging database and then
  // redirect to the PRODUCTION docs host, which spends the code against the production API. The
  // visitor ended a staging walkthrough on a production 400 page, and every attempt left an
  // unredeemable grant row behind.
  it("refuses when the API is staging and no docs base is configured", () => {
    const target = docsHandoffTarget("https://api-test.nemar.org", null);
    expect(target.kind).toBe("misconfigured");
  });

  it("refuses on a preview or local API base too", () => {
    expect(docsHandoffTarget("http://localhost:8787", null).kind).toBe("misconfigured");
    expect(docsHandoffTarget("https://nemar-api-dev.sccn-org.workers.dev", null).kind).toBe(
      "misconfigured",
    );
  });

  it("allows the production pairing", () => {
    const target = docsHandoffTarget("https://api.nemar.org", null);
    expect(target).toEqual({ kind: "ready", docsBase: "https://docs.nemar.org" });
  });

  it("honours an explicitly configured docs base, whatever the API is", () => {
    // The day docs-test.nemar.org exists, setting the variable is the whole change.
    expect(docsHandoffTarget("https://api-test.nemar.org", "https://docs-test.nemar.org")).toEqual({
      kind: "ready",
      docsBase: "https://docs-test.nemar.org",
    });
  });

  it("tolerates a trailing slash on either value", () => {
    expect(docsHandoffTarget("https://api.nemar.org/", null).kind).toBe("ready");
    expect(docsHandoffTarget("https://api-test.nemar.org", "https://d.example/")).toEqual({
      kind: "ready",
      docsBase: "https://d.example",
    });
  });

  it("names the reason it refused, for the log", () => {
    const target = docsHandoffTarget("https://api-test.nemar.org", null);
    if (target.kind !== "misconfigured") throw new Error("expected a refusal");
    expect(target.reason).toContain("PUBLIC_DOCS_BASE_URL");
    expect(target.reason).toContain("api-test.nemar.org");
  });
});
