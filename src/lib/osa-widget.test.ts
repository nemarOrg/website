import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OSA_API_ENDPOINTS,
  OSA_COMMUNITY_ID,
  osaWidgetMarkup,
  renderOsaWidgetScript,
  resolveOsaWidget,
} from "./osa-widget";

// A real 40-hex commit SHA and its matching sha384 SRI hash, both from this PR's staging pin
// (nemarOrg/website ADR 0018): real values, not placeholders shaped like them.
const VALID_SRC =
  "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js";
const VALID_INTEGRITY = "sha384-FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrPk";
const VALID_ENDPOINT = "https://develop-widget.osc.earth/osa";

describe("resolveOsaWidget", () => {
  it("is disabled when none of the three variables are set", () => {
    expect(resolveOsaWidget()).toEqual({ kind: "disabled" });
    expect(resolveOsaWidget({})).toEqual({ kind: "disabled" });
  });

  it("resolves to ready with a fully valid triple", () => {
    const out = resolveOsaWidget({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
    expect(out).toEqual({
      kind: "ready",
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
  });

  it("accepts the production endpoint too", () => {
    const out = resolveOsaWidget({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: "https://widget.osc.earth/osa",
    });
    expect(out.kind).toBe("ready");
  });

  it("trims surrounding whitespace on all three values", () => {
    const out = resolveOsaWidget({
      src: `  ${VALID_SRC}  `,
      integrity: `  ${VALID_INTEGRITY}\n`,
      apiEndpoint: ` ${VALID_ENDPOINT} `,
    });
    expect(out).toEqual({
      kind: "ready",
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
  });

  // Partial configuration: one or two of the three set. Every combination must refuse rather
  // than render a broken tag with an empty src or integrity.
  it("refuses when only one of the three is set", () => {
    for (const partial of [
      { src: VALID_SRC },
      { integrity: VALID_INTEGRITY },
      { apiEndpoint: VALID_ENDPOINT },
    ]) {
      const out = resolveOsaWidget(partial);
      expect(out.kind, JSON.stringify(partial)).toBe("misconfigured");
    }
  });

  it("refuses when exactly one of the three is missing, with the all-or-none reason", () => {
    // Asserted on the "partially configured" wording specifically, not just kind ===
    // "misconfigured": an empty string also fails the src/integrity/apiEndpoint pattern checks
    // further down, so a kind-only assertion cannot tell the dedicated missing-field guard
    // apart from those falling through to a pattern failure with a differently worded reason.
    const full = { src: VALID_SRC, integrity: VALID_INTEGRITY, apiEndpoint: VALID_ENDPOINT };
    for (const key of ["src", "integrity", "apiEndpoint"] as const) {
      const partial = { ...full, [key]: undefined };
      const out = resolveOsaWidget(partial);
      expect(out.kind, key).toBe("misconfigured");
      if (out.kind === "misconfigured") {
        const envName =
          key === "src"
            ? "PUBLIC_OSA_WIDGET_SRC"
            : key === "integrity"
              ? "PUBLIC_OSA_WIDGET_INTEGRITY"
              : "PUBLIC_OSA_API_ENDPOINT";
        expect(out.reason).toContain("partially configured");
        expect(out.reason).toContain(envName);
      }
    }
  });

  it("names every missing field at once when two of the three are missing", () => {
    // Sequential pattern checks (src, then integrity, then apiEndpoint) would only ever surface
    // the first failure; the dedicated guard reports the whole set in one message.
    const out = resolveOsaWidget({ src: VALID_SRC });
    expect(out.kind).toBe("misconfigured");
    if (out.kind === "misconfigured") {
      expect(out.reason).toContain("PUBLIC_OSA_WIDGET_INTEGRITY");
      expect(out.reason).toContain("PUBLIC_OSA_API_ENDPOINT");
    }
  });

  // Mutation check for the src pattern: each of these breaks one specific requirement of
  // OSA_WIDGET_SRC_PATTERN. If the guard's regex were loosened (or removed), one of these
  // would flip from "misconfigured" to "ready".
  it("rejects a src that fails any part of the jsDelivr+commit-pin shape", () => {
    const bad = [
      // Wrong host entirely.
      "https://evil.example.com/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js",
      // http, not https.
      "http://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js",
      // Branch name instead of a commit SHA: the exact mistake pinning exists to prevent.
      "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@main/frontend/osa-chat-widget.js",
      // Short SHA (7 hex chars), not the full 40.
      "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@5517812/frontend/osa-chat-widget.js",
      // 40 chars but not hex.
      `https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@${"g".repeat(40)}/frontend/osa-chat-widget.js`,
      // Wrong repo.
      "https://cdn.jsdelivr.net/gh/OpenScience-Collective/other@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js",
      // Wrong file.
      "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-runtime.bundle.js",
      // Trailing garbage after a valid-looking URL.
      "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js?x=1",
      // Empty.
      "",
    ];
    for (const src of bad) {
      const out = resolveOsaWidget({
        src,
        integrity: VALID_INTEGRITY,
        apiEndpoint: VALID_ENDPOINT,
      });
      expect(out.kind, JSON.stringify(src)).toBe("misconfigured");
      // An empty src is caught by the "missing" branch (a different reason string) rather
      // than the pattern check; every other case here must name the pattern failure.
      if (out.kind === "misconfigured" && src !== "") {
        expect(out.reason).toContain("PUBLIC_OSA_WIDGET_SRC");
      }
    }
  });

  it("rejects an integrity value that is not a sha384 hash", () => {
    const bad = [
      "sha256-FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrPk", // wrong algorithm
      "FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrPk", // missing prefix
      "sha384-not base64 at all!!", // invalid base64 characters
      "sha384-", // empty digest
    ];
    for (const integrity of bad) {
      const out = resolveOsaWidget({ src: VALID_SRC, integrity, apiEndpoint: VALID_ENDPOINT });
      expect(out.kind, integrity).toBe("misconfigured");
      if (out.kind === "misconfigured") {
        expect(out.reason).toContain("PUBLIC_OSA_WIDGET_INTEGRITY");
      }
    }
  });

  it("rejects an apiEndpoint that is not one of the two known OSA edges", () => {
    const bad = [
      "https://widget.osc.earth", // missing /osa path
      "https://widget.osc.earth/osa/", // trailing slash
      "https://osa-worker.shirazi-10f.workers.dev/osa", // transitional workers.dev host, not accepted here
      "http://develop-widget.osc.earth/osa", // http, not https
      "https://evil.example.com/osa",
    ];
    for (const apiEndpoint of bad) {
      const out = resolveOsaWidget({ src: VALID_SRC, integrity: VALID_INTEGRITY, apiEndpoint });
      expect(out.kind, apiEndpoint).toBe("misconfigured");
      if (out.kind === "misconfigured") {
        expect(out.reason).toContain("PUBLIC_OSA_API_ENDPOINT");
      }
    }
  });

  it("exposes exactly the two endpoints the ADR pins", () => {
    expect(OSA_API_ENDPOINTS).toEqual([
      "https://widget.osc.earth/osa",
      "https://develop-widget.osc.earth/osa",
    ]);
  });
});

describe("renderOsaWidgetScript", () => {
  const config = { src: VALID_SRC, integrity: VALID_INTEGRITY, apiEndpoint: VALID_ENDPOINT };

  it("emits exactly one classic <script> tag with the required attributes", () => {
    const html = renderOsaWidgetScript(config);
    const matches = html.match(/<script/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).not.toContain('type="module"');
    expect(html).toContain(`src="${VALID_SRC}"`);
    expect(html).toContain(`integrity="${VALID_INTEGRITY}"`);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain("data-no-auto-init");
    expect(html).toMatch(/<\/script>$/);
  });

  it("carries the init call with the fixed community id and the given endpoint", () => {
    const html = renderOsaWidgetScript(config);
    expect(html).toContain(`communityId:'${OSA_COMMUNITY_ID}'`);
    expect(html).toContain(`apiEndpoint:'${VALID_ENDPOINT}'`);
    expect(html).toContain("window.OSAChatWidget.setConfig(");
    expect(html).toContain("window.OSAChatWidget.init();");
  });

  it("escapes HTML-attribute-breaking characters in src and integrity", () => {
    const html = renderOsaWidgetScript({
      src: `${VALID_SRC}"><script>alert(1)</script>`,
      integrity: `${VALID_INTEGRITY}"onmouseover="x`,
      apiEndpoint: VALID_ENDPOINT,
    });
    // Still exactly one real <script> tag; the payload's own "<script>" must have been
    // neutralized as text inside the src attribute, not parsed as a second element.
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("escapes a single quote in apiEndpoint so it cannot close the JS string literal", () => {
    const html = renderOsaWidgetScript({
      ...config,
      apiEndpoint: "https://develop-widget.osc.earth/osa'});fetch('https://evil.example.com",
    });
    // The raw payload must never appear un-escaped inside the onload attribute.
    expect(html).not.toContain("osa'});fetch(");
    expect(html).toContain("osa\\'");
  });

  it("escapes a literal < in apiEndpoint (defense in depth against </script> injection)", () => {
    const html = renderOsaWidgetScript({ ...config, apiEndpoint: "</script><script>evil()" });
    expect(html).not.toContain("</script><script>evil()");
  });
});

describe("osaWidgetMarkup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing and logs nothing when disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(osaWidgetMarkup({})).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders nothing but warns clearly when misconfigured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = osaWidgetMarkup({ src: VALID_SRC });
    expect(html).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[osa-widget]");
    expect(warn.mock.calls[0]?.[0]).toContain("PUBLIC_OSA_WIDGET_INTEGRITY");
  });

  it("renders the script tag and logs nothing when fully configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = osaWidgetMarkup({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
    expect(html).toContain("<script");
    expect(warn).not.toHaveBeenCalled();
  });
});
