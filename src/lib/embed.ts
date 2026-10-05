/**
 * The embeddable signal viewer's URL contract (website#410, ADR 0023).
 *
 * `/dataset/<id>/embed` is a chrome-free copy of the dataset page's viewer
 * that partner sites (EBRAINS, Neurobagel, OpenNeuro, ...) put in an iframe.
 * Everything here is pure and shared by the three places that have to agree
 * on that contract:
 *
 * - `src/middleware.ts`, which lets this route, and only this route, be
 *   framed by another site (`routeAllowsFraming`);
 * - the embed page and its client controller, which read `?theme=` and build
 *   the links back to the dataset page;
 * - the dataset page's "Embed" control, which hands out the iframe snippet.
 *
 * The route takes the dataset page's own query contract: `?view=` names the
 * recording (resolved by `resolveViewParam`, so a value means the same thing
 * on both pages) and `?v=` pins a version. `?theme=` is the one addition.
 */

import { VIEW_PARAM } from "./eeg-viewer/recording-nav";
import { MARKETING_BASE_URL, isProductionHost } from "./host";

/**
 * `/dataset/<id>/embed`, with or without a trailing slash (the site runs with
 * `trailingSlash: "ignore"`, so Astro serves both).
 *
 * Deliberately matched on the raw, undecoded path. Astro decodes a path
 * before routing, so a percent-encoded spelling such as `/dataset/x/%65mbed`
 * still renders the embed page, but it does not match here and is served
 * with the site-wide `frame-ancestors 'self'`. That is the safe direction to
 * be wrong in: an unusual spelling of this route can only ever be less
 * frameable, never make another route frameable.
 */
const EMBED_ROUTE_RE = /^\/dataset\/([^/]+)\/embed\/?$/;

/** The dataset id segment of an embed path, raw; null for any other path. */
export function embedRouteDatasetId(pathname: string): string | null {
  return EMBED_ROUTE_RE.exec(pathname)?.[1] ?? null;
}

/** True for the embed route, and only for it. */
export function isEmbedRoute(pathname: string): boolean {
  return embedRouteDatasetId(pathname) !== null;
}

/**
 * The dataset id as the embed may print it, or null when it may not.
 *
 * Any site can frame this route, and its id segment is whatever the URL says,
 * so a page that echoed it ("NEMAR has no dataset <id>.") would let anyone put
 * their own sentence on a nemar.org page inside their frame. Ids that look
 * like ids (NEMAR's and OpenNeuro's are short runs of letters, digits, dots,
 * dashes and underscores) are echoed; anything else is not, and the page says
 * "no such dataset" instead.
 */
export function displayableDatasetId(id: string): string | null {
  return /^[A-Za-z0-9._-]{1,40}$/.test(id) ? id : null;
}

/**
 * A `?v=` value as the embed may print it ("Version <v> is not published"), or
 * null. Same reason and same shape as `displayableDatasetId`: published
 * versions are short tokens such as `v1.0.1`, and anything else is the framing
 * site's own text, which the note then calls "that version".
 */
export function displayableVersion(version: string): string | null {
  return /^[A-Za-z0-9._-]{1,40}$/.test(version) ? version : null;
}

/** Query parameter an embedder uses to match the embed to its own page. */
export const EMBED_THEME_PARAM = "theme";

export type EmbedTheme = "light" | "dark";

/**
 * `?theme=light|dark`, or null for anything else (absent, empty, a value this
 * build does not know). Null means "follow the visitor's system preference",
 * which is also what an unrecognized value falls back to rather than an error:
 * a typo in a partner's snippet should cost them the theme, not the viewer.
 *
 * The other copy of this rule is the `is:inline` theme bootstrap in the
 * `<head>` of `src/layouts/Embed.astro`, which applies it before first paint
 * and cannot import this module. The two are kept in step by hand: the unit
 * tests cover this function only, not the inline script.
 */
export function parseEmbedTheme(raw: string | null | undefined): EmbedTheme | null {
  const value = raw?.trim().toLowerCase();
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The origin a snippet should name.
 *
 * The serving origin in single-host mode, so a snippet copied on staging or
 * a preview deploy embeds that deploy. On the production hosts it is always
 * `MARKETING_BASE_URL`: a signed-in visitor reads the dataset page on
 * `app.nemar.org` (website#210), and a snippet naming that host would bake a
 * cross-host redirect into every partner page that pastes it, as would one
 * naming `ww2.nemar.org`, which is due to retire.
 */
export function embedSnippetOrigin(location: { origin: string; hostname: string }): string {
  return isProductionHost(location.hostname) ? MARKETING_BASE_URL : location.origin;
}

/**
 * Absolute URL of the embed for one recording. `version` pins `?v=`; leave it
 * out to follow the dataset's latest version.
 */
export function embedUrl(
  origin: string,
  datasetId: string,
  viewSpec: string,
  version?: string | null,
): string {
  const url = new URL(`/dataset/${encodeURIComponent(datasetId)}/embed`, origin);
  url.searchParams.set(VIEW_PARAM, viewSpec);
  if (version) url.searchParams.set("v", version);
  return url.toString();
}

/**
 * Absolute URL of the dataset page, optionally opened on a recording. This is
 * where every link out of the embed goes ("Open on NEMAR", the recording
 * name, the NEMAR mark on the plot), always on the origin that served the
 * embed, so a staging embed links to staging.
 */
export function datasetPageUrl(
  origin: string,
  datasetId: string,
  opts: { version?: string | null; viewSpec?: string | null } = {},
): string {
  const url = new URL(`/dataset/${encodeURIComponent(datasetId)}`, origin);
  if (opts.version) url.searchParams.set("v", opts.version);
  if (opts.viewSpec) url.searchParams.set(VIEW_PARAM, opts.viewSpec);
  return url.toString();
}

/**
 * The recommended iframe height (CSS px). The viewer fills the frame at any
 * height (`fitHeight`), and 560 is where a typical recording's toolbar,
 * trace, minimap and legend all fit with room for the trace to be read.
 * There is no auto-resize protocol (website#410, judgment call 13): a fixed
 * height is the contract.
 */
export const EMBED_IFRAME_HEIGHT = 560;

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The `<iframe>` a partner pastes.
 *
 * `referrerpolicy="origin"` is load-bearing for website#410 phase 2: it makes
 * the browser send the embedding site's origin, never its page path, even
 * when that site's own policy would send nothing, so the edge can count which
 * sites embed the viewer without learning which of their pages did.
 *
 * Attribute values are escaped, which matters even for values built here: a
 * pinned version puts a second parameter in `src`, and its `&` must be
 * `&amp;` in HTML.
 */
export function embedSnippet(src: string, recordingName: string): string {
  const attrs = [
    `src="${escapeHtmlAttr(src)}"`,
    'width="100%"',
    `height="${EMBED_IFRAME_HEIGHT}"`,
    'style="border:0"',
    'loading="lazy"',
    'referrerpolicy="origin"',
    "allowfullscreen",
    `title="${escapeHtmlAttr(`NEMAR signal viewer: ${recordingName}`)}"`,
  ];
  return `<iframe ${attrs.join(" ")}></iframe>`;
}
