import { describe, expect, it } from "vitest";
import { resolveDocsBase } from "./docs-base";

describe("resolveDocsBase", () => {
  it("falls back to the production docs host when nothing overrides it", () => {
    // This is the case that actually ships today: the staging build sets
    // PUBLIC_API_BASE_URL and PUBLIC_DATA_BASE_URL but deliberately not
    // PUBLIC_DOCS_BASE_URL, because no docs-test host exists. Staging must
    // therefore still resolve a working production link, not an empty or
    // malformed one.
    expect(resolveDocsBase()).toBe("https://docs.nemar.org");
  });

  it("honours an explicit override", () => {
    expect(resolveDocsBase("https://docs-test.nemar.org")).toBe("https://docs-test.nemar.org");
  });

  it("strips a trailing slash so callers can append their own", () => {
    // The footer builds `https://${host}/`; a base that kept its slash would
    // produce a double slash once a path is appended by any other caller.
    expect(resolveDocsBase("https://docs-test.nemar.org/")).toBe("https://docs-test.nemar.org");
  });

  it("returns a URL that parses, so `new URL(...).host` cannot throw at render", () => {
    // The footer derives its visible label via `new URL(resolveDocsBase()).host`.
    // A non-absolute return value would throw during SSR and take the whole
    // page down rather than degrade.
    expect(new URL(resolveDocsBase()).host).toBe("docs.nemar.org");
  });
});
