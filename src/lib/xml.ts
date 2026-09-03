/**
 * XML text escaping, shared by every hand-built XML document in this repo.
 *
 * This lived in `og-chrome.ts` while the OG cards were its only consumers,
 * but `sitemap.ts` now depends on it too and the two concerns are unrelated:
 * a change scoped to "how the OG card escapes an SVG attribute" must not be
 * able to silently change how the sitemap escapes a `<loc>`. Neutral module,
 * one definition, two independent callers.
 */

/**
 * Escapes the five XML predefined entities. `&` is replaced first, so an
 * already-escaped `&` is not double-escaped by the later passes.
 *
 * Escaping `"` and `'` is unnecessary inside a text node but harmless there,
 * and it is required inside an attribute value — which is where the OG cards
 * use it. One function covers both positions rather than two that differ in
 * a way a caller has to remember.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
