/**
 * Site-wide embed of the Open Science Assistant (OSA) chat widget (ADR 0018).
 *
 * ADR 0017 pre-authorized the CSP this needs (`script-src`/`connect-src` cdn.jsdelivr.net,
 * `connect-src`/`img-src` the OSA edge hosts, `worker-src blob:`), but nothing on this site
 * loaded the widget itself. This module is the one thing Base.astro calls to decide whether
 * and how to.
 *
 * Three build-time `PUBLIC_*` variables, inlined by Vite at `astro build` time exactly like
 * `PUBLIC_API_BASE_URL` (see `./api-base.ts`), gate the embed:
 *
 * - `PUBLIC_OSA_WIDGET_SRC`: a jsDelivr URL pinned to a full 40-character OSA commit SHA:
 *   `https://cdn.jsdelivr.net/gh/OpenScience-Collective/osa@<sha>/frontend/osa-chat-widget.js`.
 * - `PUBLIC_OSA_WIDGET_INTEGRITY`: the matching `sha384-` Subresource Integrity hash.
 * - `PUBLIC_OSA_API_ENDPOINT`: exactly one of the two OSA edge hosts in
 *   {@link OSA_API_ENDPOINTS}.
 *
 * All three or none. An operator who sets one but not the others has a half-wired build, not a
 * smaller widget, so that is refused the same way a single malformed value is: see
 * {@link resolveOsaWidget}.
 *
 * A fourth variable, `PUBLIC_OSA_NOTEBOOK_URL`, is genuinely optional rather than part of the
 * all-or-none triple: it is the base URL of the hosted JupyterLite site the widget's notebook
 * button (OSA issue #436, the three-icon launcher) opens against. UNSET is the ordinary, supported
 * state and never gates whether the widget renders: the widget falls back to its own default
 * (`https://notebook.osc.earth/osa/`). SET but malformed is a different case entirely: it must be
 * an absolute `https:` URL, and a value that fails that check is refused exactly like a malformed
 * `PUBLIC_OSA_API_ENDPOINT`, which blanks the whole widget the same way (`osaWidgetMarkup` returns
 * `""`). That is a deliberate choice, not an oversight: a typo in a value this deployment's own
 * config sets should be loud and caught at once, rather than silently falling back to a host
 * nobody chose (see `resolveOsaWidget`'s inline comment on the `notebookUrl` read for why this
 * still leaves production's fully-unset steady state untouched).
 *
 * `apiEndpoint` is passed explicitly rather than left to the widget's own environment
 * detection, which only treats OSA's own demo hosts and `localhost` as non-production. Left
 * unset, `test.nemar.org` would silently talk to the production edge, defeating the reason
 * staging is pinned to the dev worker in the first place.
 *
 * The widget script is a CLASSIC script, deliberately: it reads `document.currentScript.src`
 * to find its own runtime bundle on the same jsDelivr path, and `document.currentScript` is
 * `null` inside a `type="module"` script. `data-no-auto-init` on that same tag defers startup
 * until the `onload` handler below calls `window.OSAChatWidget.setConfig(...)` and `.init()`
 * once the script has actually loaded.
 *
 * Nothing turns this on by default for `astro dev`, a Cloudflare Pages preview, or a local
 * `bun run build`: `wrangler.toml`/`release.yml`/`ci.yml` deliberately set none of the three
 * (ADR 0018), and there is no hardcoded fallback the way `apiBase()` falls back to
 * `https://api.nemar.org`; "unset" and "off" are the same state here on purpose. To see the
 * widget locally, export the three staging values `.github/workflows/deploy-test.yml` uses
 * (or a production triple, once one is pinned) into the shell before `bun run dev` / `bun run
 * build`, e.g.:
 * `PUBLIC_OSA_WIDGET_SRC=... PUBLIC_OSA_WIDGET_INTEGRITY=... PUBLIC_OSA_API_ENDPOINT=... bun run dev`.
 *
 * A misconfigured value (set but malformed, or partially set) degrades to rendering nothing
 * and a `console.warn` naming the reason, never a thrown error and never a build failure. This
 * module's validation runs per-request inside the deployed Cloudflare Worker (`output:
 * "server"`), not while Vite bundles, so there is no build step for a bad value to fail; and a
 * component ADR 0017 already treats as optional should not be able to take the rest of the page
 * down with it. Every other malformed-`PUBLIC_*` case in this codebase already degrades this way
 * (`apiBase()`, `resolveDocsBase()`, `docsHandoffTarget()` in `./docs-authorize.ts`), so this
 * keeps the widget consistent with its neighbors.
 */

import { OSA_DATASET_WINDOW_PROPERTY } from "./osa-dataset";

/** The community id every deployment of this widget uses. Not read from the environment: it
 *  identifies the NEMAR OSA configuration itself, not a place a build might legitimately
 *  differ. */
export const OSA_COMMUNITY_ID = "nemar";

/**
 * The only two hosts `PUBLIC_OSA_API_ENDPOINT` may name. Anything else, including either of
 * the transitional `*.workers.dev` names `src/middleware.ts` still allows in `connect-src` for
 * cached widget builds elsewhere, is refused: a build pointed at an endpoint this list does
 * not include has no matching `img-src`/`connect-src` allowance and every widget fetch would be
 * silently blocked by the CSP this repository ships.
 */
export const OSA_API_ENDPOINTS = [
  "https://widget.osc.earth/osa",
  "https://develop-widget.osc.earth/osa",
] as const;

export type OsaApiEndpoint = (typeof OSA_API_ENDPOINTS)[number];

const OSA_WIDGET_SRC_PATTERN =
  /^https:\/\/cdn\.jsdelivr\.net\/gh\/OpenScience-Collective\/osa@[0-9a-f]{40}\/frontend\/osa-chat-widget\.js$/;

// A sha384 digest is 48 bytes, which base64 always writes as exactly 64 characters, unpadded.
const OSA_WIDGET_INTEGRITY_PATTERN = /^sha384-[A-Za-z0-9+/]{64}$/;

/** Explicit overrides for each variable, for tests. Any field left undefined falls back to the
 *  matching `PUBLIC_OSA_*` build variable, the same shape as `resolveDocsBase`'s single override
 *  in `./docs-base.ts`, widened to four fields. */
export interface OsaWidgetOverrides {
  src?: string;
  integrity?: string;
  apiEndpoint?: string;
  notebookUrl?: string;
}

export type OsaWidgetResolution =
  | { kind: "disabled" }
  | { kind: "misconfigured"; reason: string }
  | {
      kind: "ready";
      src: string;
      integrity: string;
      apiEndpoint: OsaApiEndpoint;
      /** Absent when `PUBLIC_OSA_NOTEBOOK_URL` is unset; the widget's own default then applies. */
      notebookUrl?: string;
    };

type OsaEnvKey =
  | "PUBLIC_OSA_WIDGET_SRC"
  | "PUBLIC_OSA_WIDGET_INTEGRITY"
  | "PUBLIC_OSA_API_ENDPOINT"
  | "PUBLIC_OSA_NOTEBOOK_URL";

/** `PUBLIC_OSA_NOTEBOOK_URL` must be an absolute `https:` URL: same shape check
 *  `isUsableDocsBase` in `./docs-authorize.ts` starts from, without that function's NEMAR-host
 *  allowlist -- a JupyterLite deployment has no fixed set of hosts the way the two OSA edges do. */
function isAbsoluteHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

function envValue(name: OsaEnvKey): string | undefined {
  const env =
    typeof import.meta.env !== "undefined"
      ? (import.meta.env as unknown as Record<string, string | undefined>)
      : undefined;
  return env?.[name];
}

/**
 * Decide whether/how to render the widget from the three `PUBLIC_OSA_*` build variables (or the
 * given overrides, for tests). Pure (no logging, no rendering), mirroring
 * `docsHandoffTarget` in `./docs-authorize.ts`: the caller (Base.astro, or a test) decides what
 * to do with a `misconfigured` result.
 */
export function resolveOsaWidget(overrides: OsaWidgetOverrides = {}): OsaWidgetResolution {
  const src = (overrides.src ?? envValue("PUBLIC_OSA_WIDGET_SRC") ?? "").trim();
  const integrity = (overrides.integrity ?? envValue("PUBLIC_OSA_WIDGET_INTEGRITY") ?? "").trim();
  const apiEndpoint = (overrides.apiEndpoint ?? envValue("PUBLIC_OSA_API_ENDPOINT") ?? "").trim();
  // Genuinely optional (unlike the triple above): read here, but not consulted at all by the
  // disabled/missing checks below, and only validated once the triple has already resolved to
  // "ready". A typo in this alone, while the widget itself is off, has nothing to misconfigure.
  const notebookUrl = (overrides.notebookUrl ?? envValue("PUBLIC_OSA_NOTEBOOK_URL") ?? "").trim();

  if (!src && !integrity && !apiEndpoint) {
    // The state production is in today (ADR 0018): nothing set, nothing rendered, nothing
    // logged. This is the expected steady state, not a misconfiguration.
    return { kind: "disabled" };
  }

  const missing: string[] = [];
  if (!src) missing.push("PUBLIC_OSA_WIDGET_SRC");
  if (!integrity) missing.push("PUBLIC_OSA_WIDGET_INTEGRITY");
  if (!apiEndpoint) missing.push("PUBLIC_OSA_API_ENDPOINT");
  if (missing.length > 0) {
    return {
      kind: "misconfigured",
      reason: `OSA widget is partially configured; missing ${missing.join(", ")}. All three PUBLIC_OSA_* variables are required together, or none at all.`,
    };
  }

  if (!OSA_WIDGET_SRC_PATTERN.test(src)) {
    return {
      kind: "misconfigured",
      reason: `PUBLIC_OSA_WIDGET_SRC is ${JSON.stringify(src)}, which is not a jsDelivr URL pinned to a 40-character commit SHA under OpenScience-Collective/osa/frontend/osa-chat-widget.js`,
    };
  }
  if (!OSA_WIDGET_INTEGRITY_PATTERN.test(integrity)) {
    return {
      kind: "misconfigured",
      reason: `PUBLIC_OSA_WIDGET_INTEGRITY is ${JSON.stringify(integrity)}, which is not a sha384 Subresource Integrity value`,
    };
  }
  if (!(OSA_API_ENDPOINTS as readonly string[]).includes(apiEndpoint)) {
    return {
      kind: "misconfigured",
      reason:
        `PUBLIC_OSA_API_ENDPOINT is ${JSON.stringify(apiEndpoint)}, which is not one of the ` +
        `known OSA edge endpoints (${OSA_API_ENDPOINTS.join(", ")})`,
    };
  }
  if (notebookUrl && !isAbsoluteHttpsUrl(notebookUrl)) {
    return {
      kind: "misconfigured",
      reason: `PUBLIC_OSA_NOTEBOOK_URL is ${JSON.stringify(notebookUrl)}, which is not an absolute https: URL`,
    };
  }

  return {
    kind: "ready",
    src,
    integrity,
    apiEndpoint: apiEndpoint as OsaApiEndpoint,
    ...(notebookUrl ? { notebookUrl } : {}),
  };
}

/**
 * HTML-attribute escaping for the values placed in the emitted `<script>` tag.
 *
 * Deliberately local rather than `escapeXml` in `./xml.ts`: that module's own docstring scopes
 * it to "every hand-built XML document in this repo" (the OG cards and the sitemap) specifically
 * so an unrelated caller does not couple its escaping needs to theirs. This is HTML, not XML,
 * and the two rule sets happen to coincide only for the five characters both escape here.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escapes a value for embedding inside a single-quoted JS string literal. `<` is escaped too:
 * defense in depth against the value ever spelling `</script>`, the same reasoning
 * `escapeJsonLdForScript` in `./jsonld.ts` documents for JSON-LD bodies.
 */
function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\u003C");
}

/**
 * Renders the one `<script>` tag the embed needs. `config.apiEndpoint` is already one of
 * {@link OSA_API_ENDPOINTS} by the time a `"ready"` resolution reaches here, but every value is
 * still escaped: a config object is not a promise about what a future caller passes it.
 *
 * `config.notebookUrl`, when given, rides in the same `setConfig` call as an extra field; left
 * out entirely when absent, so the widget's own default (`https://notebook.osc.earth/osa/`) applies
 * rather than this module asserting one.
 *
 * Before `.init()`, the generated handler also replays any dataset context `./osa-dataset.ts`'s
 * `announceOsaDataset` has already recorded on `window` (see that module's doc for why this side
 * of the replay exists), feature-detecting `setDataset` exactly as `announceOsaDataset` does: the
 * widget build this is pinned to today does not have one, and calling it if it's not a function
 * would throw inside the `onload` handler and abort the `init()` call that follows it. The call
 * itself is also wrapped in a try/catch that warns and never rethrows: a `setDataset` that IS a
 * function but throws anyway is third-party code misbehaving, and must not take the `.init()`
 * call that follows it down too.
 */
export function renderOsaWidgetScript(config: {
  src: string;
  integrity: string;
  apiEndpoint: string;
  notebookUrl?: string;
}): string {
  const setConfigFields = [
    `communityId:'${escapeJsString(OSA_COMMUNITY_ID)}'`,
    `apiEndpoint:'${escapeJsString(config.apiEndpoint)}'`,
  ];
  if (config.notebookUrl) {
    setConfigFields.push(`notebookUrl:'${escapeJsString(config.notebookUrl)}'`);
  }
  const datasetProperty = JSON.stringify(OSA_DATASET_WINDOW_PROPERTY);
  const applyRecordedDataset = `var d=window[${datasetProperty}];if(d!==undefined&&typeof window.OSAChatWidget.setDataset==='function'){try{window.OSAChatWidget.setDataset(d);}catch(e){console.warn('[osa-widget] setDataset threw:',e);}}`;
  const initCall =
    `window.OSAChatWidget.setConfig({${setConfigFields.join(",")}});` +
    `${applyRecordedDataset}window.OSAChatWidget.init();`;
  return (
    `<script src="${escapeHtmlAttr(config.src)}" integrity="${escapeHtmlAttr(config.integrity)}" ` +
    `crossorigin="anonymous" data-no-auto-init onload="${escapeHtmlAttr(initCall)}"></script>`
  );
}

/**
 * Pages the widget is never mounted on, even when it is configured: the ones that grant a
 * credential or carry one in the URL. `/cli/authorize?code=` carries a device code and
 * `/login/verify?email=` an email address, and the widget's "Share page URL" option sends the
 * current URL to OSA and on to the model provider. A third-party script also has no business on
 * a page that asks the reader to approve access. Each entry matches itself and every path below
 * it, never a sibling that merely starts with the same letters (`/loginx` is not `/login`).
 */
export const OSA_WIDGET_EXCLUDED_PATHS = [
  "/cli/authorize",
  "/login",
  "/signup",
  "/auth",
  "/settings",
] as const;

export function isOsaWidgetExcludedPath(pathname: string): boolean {
  return OSA_WIDGET_EXCLUDED_PATHS.some(
    (excluded) => pathname === excluded || pathname.startsWith(`${excluded}/`),
  );
}

/**
 * What `Base.astro` actually calls: resolve, log a misconfiguration once per render, and render.
 * Returns `""` for both `"disabled"` and `"misconfigured"`; the layout embeds the result with
 * `set:html` unconditionally rather than branching on the resolution kind itself.
 */
export function osaWidgetMarkup(pathname: string, overrides: OsaWidgetOverrides = {}): string {
  if (isOsaWidgetExcludedPath(pathname)) return "";
  const resolution = resolveOsaWidget(overrides);
  if (resolution.kind === "ready") return renderOsaWidgetScript(resolution);
  if (resolution.kind === "misconfigured") {
    console.warn(`[osa-widget] ${resolution.reason}`);
  }
  return "";
}
