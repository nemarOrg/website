import { afterEach, describe, expect, it, vi } from "vitest";
import { OSA_DATASET_WINDOW_PROPERTY } from "./osa-dataset";
import {
  OSA_API_ENDPOINTS,
  OSA_COMMUNITY_ID,
  OSA_WIDGET_EXCLUDED_PATHS,
  isOsaWidgetExcludedPath,
  osaWidgetMarkup,
  renderOsaWidgetScript,
  resolveOsaWidget,
} from "./osa-widget";

// A real 40-hex commit SHA and its matching sha384 SRI hash (an earlier staging pin, ADR 0018):
// real values, not placeholders shaped like them.
const VALID_SRC =
  "https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@55178121ae6fa65ee5a501e53ca74de2a17a58d7/frontend/osa-chat-widget.js";
const VALID_INTEGRITY = "sha384-FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrPk";
const VALID_ENDPOINT = "https://develop-widget.osc.earth/osa";
const VALID_NOTEBOOK_URL = "https://develop-notebook.osc.earth/";

/**
 * Reverses `escapeHtmlAttr` (unexported) well enough for these tests: the four entities that
 * function emits, and nothing else. Order matters -- `&amp;` must unescape last, or a payload
 * containing a literal `&amp;` would itself get corrupted -- so this mirrors the escaper's own
 * ordering in reverse.
 */
function unescapeHtmlAttr(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Pulls the raw (unescaped) `onload` JS out of a rendered widget `<script>` tag. */
function extractOnload(html: string): string {
  const match = html.match(/onload="([^"]*)"/);
  if (!match) throw new Error(`no onload attribute found in: ${html}`);
  return unescapeHtmlAttr(match[1]);
}

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
      "sha384-FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrP", // 63 characters, one short
      "sha384-FRKwdl8mzyHOIgQtbdjuLGxvRHeBPToJY37knSef3ciXaRCgRv1mzXEZIJONsrPkA", // 65 characters, one long
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

  // PUBLIC_OSA_NOTEBOOK_URL: genuinely optional, unlike the triple above, so its own tests are
  // kept separate from the missing/partial-triple cases.
  it("is ready with no notebookUrl field when PUBLIC_OSA_NOTEBOOK_URL is unset", () => {
    const out = resolveOsaWidget({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") {
      expect(out.notebookUrl).toBeUndefined();
      expect(out).not.toHaveProperty("notebookUrl");
    }
  });

  it("carries a valid notebookUrl through to the ready result, trimmed", () => {
    const out = resolveOsaWidget({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
      notebookUrl: `  ${VALID_NOTEBOOK_URL}  `,
    });
    expect(out).toEqual({
      kind: "ready",
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
      notebookUrl: VALID_NOTEBOOK_URL,
    });
  });

  it("accepts the widget's own production notebook host too", () => {
    const out = resolveOsaWidget({
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
      notebookUrl: "https://notebook.osc.earth/",
    });
    expect(out.kind).toBe("ready");
  });

  it("refuses a malformed notebookUrl even though the triple is fully valid", () => {
    const bad = [
      "notebook.osc.earth", // no scheme -- new URL() throws
      "http://notebook.osc.earth/", // http, not https
      "ftp://notebook.osc.earth/", // wrong scheme entirely
    ];
    for (const notebookUrl of bad) {
      const out = resolveOsaWidget({
        src: VALID_SRC,
        integrity: VALID_INTEGRITY,
        apiEndpoint: VALID_ENDPOINT,
        notebookUrl,
      });
      expect(out.kind, notebookUrl).toBe("misconfigured");
      if (out.kind === "misconfigured") {
        expect(out.reason).toContain("PUBLIC_OSA_NOTEBOOK_URL");
      }
    }
  });

  it("is disabled when nothing at all is set, including notebookUrl", () => {
    expect(resolveOsaWidget({ notebookUrl: "" })).toEqual({ kind: "disabled" });
  });

  it("does not misconfigure over a malformed notebookUrl when the triple is unset", () => {
    // notebookUrl is meaningless without the widget itself being on; a stray value here while
    // the triple is entirely absent leaves production's disabled steady state untouched.
    expect(resolveOsaWidget({ notebookUrl: "not-a-url" })).toEqual({ kind: "disabled" });
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

  it("omits notebookUrl from setConfig entirely when not given", () => {
    const html = renderOsaWidgetScript(config);
    expect(html).not.toContain("notebookUrl");
  });

  it("carries notebookUrl in the same setConfig call when given", () => {
    const html = renderOsaWidgetScript({ ...config, notebookUrl: VALID_NOTEBOOK_URL });
    expect(html).toContain(`notebookUrl:'${VALID_NOTEBOOK_URL}'`);
    // Same setConfig({...}) call as communityId/apiEndpoint, not a second call.
    expect((html.match(/setConfig\(/g) ?? []).length).toBe(1);
  });

  it("escapes a single quote in notebookUrl so it cannot close the JS string literal", () => {
    const html = renderOsaWidgetScript({
      ...config,
      notebookUrl: "https://evil.example.com/'});fetch('https://evil.example.com",
    });
    // The raw payload must never appear un-escaped inside the onload attribute.
    expect(html).not.toContain("com/'});fetch(");
    expect(html).toContain("com/\\'});fetch(");
  });

  it("escapes a literal < in notebookUrl (defense in depth against </script> injection)", () => {
    const html = renderOsaWidgetScript({ ...config, notebookUrl: "</script><script>evil()" });
    expect(html).not.toContain("</script><script>evil()");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  describe("the onload handler, executed", () => {
    /** A real, hand-written stand-in for the widget's global object -- not a spy replacing the
     *  code under test, the same "real-shape input" policy `freshStorage()` in
     *  `notices-api.test.ts` follows for `Storage`. Records every call it receives so assertions
     *  can inspect them, exactly the way the widget itself would receive and act on them. */
    function fakeOsaChatWidget(withSetDataset: boolean) {
      const calls: { setConfig: unknown[]; setDataset: unknown[]; init: number } = {
        setConfig: [],
        setDataset: [],
        init: 0,
      };
      const widget: Record<string, unknown> = {
        setConfig: (v: unknown) => calls.setConfig.push(v),
        init: () => {
          calls.init += 1;
        },
      };
      if (withSetDataset) {
        widget.setDataset = (v: unknown) => calls.setDataset.push(v);
      }
      return { widget, calls };
    }

    /** Runs the generated `onload` JS against a real global object shaped like the browser's
     *  `window`, carrying `OSAChatWidget` and (optionally) a recorded dataset announcement. */
    function runOnload(html: string, win: Record<string, unknown>): void {
      const body = extractOnload(html);
      new Function("window", body)(win);
    }

    it("calls setConfig then init when nothing was recorded", () => {
      const { widget, calls } = fakeOsaChatWidget(true);
      runOnload(renderOsaWidgetScript(config), { OSAChatWidget: widget });
      expect(calls.setConfig).toEqual([
        { communityId: OSA_COMMUNITY_ID, apiEndpoint: VALID_ENDPOINT },
      ]);
      expect(calls.setDataset).toEqual([]);
      expect(calls.init).toBe(1);
    });

    it("replays a recorded dataset value into setDataset before init", () => {
      const { calls } = fakeOsaChatWidget(true);
      const order: string[] = [];
      const win: Record<string, unknown> = {
        OSAChatWidget: {
          setConfig: (v: unknown) => {
            calls.setConfig.push(v);
            order.push("setConfig");
          },
          setDataset: (v: unknown) => {
            calls.setDataset.push(v);
            order.push("setDataset");
          },
          init: () => {
            calls.init += 1;
            order.push("init");
          },
        },
        [OSA_DATASET_WINDOW_PROPERTY]: { id: "nm000103", zarr: true },
      };
      runOnload(renderOsaWidgetScript(config), win);
      expect(calls.setDataset).toEqual([{ id: "nm000103", zarr: true }]);
      expect(order).toEqual(["setConfig", "setDataset", "init"]);
    });

    it("does not call setDataset, and does not throw, when nothing was recorded", () => {
      const { widget, calls } = fakeOsaChatWidget(true);
      expect(() =>
        runOnload(renderOsaWidgetScript(config), { OSAChatWidget: widget }),
      ).not.toThrow();
      expect(calls.setDataset).toEqual([]);
      expect(calls.init).toBe(1);
    });

    it("does not throw when a value is recorded but the widget has no setDataset (today's pin)", () => {
      const { widget, calls } = fakeOsaChatWidget(false);
      const win = {
        OSAChatWidget: widget,
        [OSA_DATASET_WINDOW_PROPERTY]: { id: "nm000103" },
      };
      expect(() => runOnload(renderOsaWidgetScript(config), win)).not.toThrow();
      expect(calls.init).toBe(1);
    });
  });
});

describe("osaWidgetMarkup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing and logs nothing when disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(osaWidgetMarkup("/", {})).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders nothing but warns clearly when misconfigured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = osaWidgetMarkup("/", { src: VALID_SRC });
    expect(html).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[osa-widget]");
    expect(warn.mock.calls[0]?.[0]).toContain("PUBLIC_OSA_WIDGET_INTEGRITY");
  });

  it("renders the script tag and logs nothing when fully configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = osaWidgetMarkup("/", {
      src: VALID_SRC,
      integrity: VALID_INTEGRITY,
      apiEndpoint: VALID_ENDPOINT,
    });
    expect(html).toContain("<script");
    expect(warn).not.toHaveBeenCalled();
  });

  const configured = { src: VALID_SRC, integrity: VALID_INTEGRITY, apiEndpoint: VALID_ENDPOINT };

  it("renders nothing on a credential page, however fully it is configured", () => {
    // Each carries, or asks the reader to grant, something "Share page URL" must never send.
    const credentialPages = [
      "/cli/authorize",
      "/login",
      "/login/verify",
      "/login/pending",
      "/signup",
      "/auth/docs/authorize",
      "/auth/orcid/complete",
      "/settings",
    ];
    for (const pathname of credentialPages) {
      expect(osaWidgetMarkup(pathname, configured), pathname).toBe("");
    }
  });

  it("still renders on pages that only share a prefix with one", () => {
    for (const pathname of [
      "/",
      "/discover",
      "/dataset/nm000103",
      "/loginx",
      "/settings-help",
      "/authors",
    ]) {
      expect(isOsaWidgetExcludedPath(pathname), pathname).toBe(false);
      expect(osaWidgetMarkup(pathname, configured), pathname).toContain("<script");
    }
  });

  it("excludes every listed path, and each one's subpaths", () => {
    for (const excluded of OSA_WIDGET_EXCLUDED_PATHS) {
      expect(isOsaWidgetExcludedPath(excluded), excluded).toBe(true);
      expect(isOsaWidgetExcludedPath(`${excluded}/anything`), excluded).toBe(true);
    }
  });
});
