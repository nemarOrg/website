/**
 * Single source of truth for the documentation-site base URL.
 *
 * Mirrors `resolveDataBase` / `apiBase` / `zarrBase` so the footer's Data
 * column resolves all of its hosts the same way instead of hardcoding two of
 * three (website#220). `PUBLIC_DOCS_BASE_URL` overrides the default.
 *
 * Unlike its siblings, this var is **deliberately not set by the staging
 * build**: there is no `docs-test.nemar.org` today (the name does not resolve),
 * so pointing staging at one would trade a correct link for a dead one. The
 * resolver exists anyway, because the alternative — leaving the host inlined in
 * the markup — is what made this column inconsistent in the first place. If a
 * docs staging host is ever stood up, adding `PUBLIC_DOCS_BASE_URL` to
 * `.github/workflows/deploy-test.yml` is the whole change.
 */
const PROD_DOCS_BASE = "https://docs.nemar.org";

export function resolveDocsBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_DOCS_BASE_URL) || null;
  return (fromEnv ?? PROD_DOCS_BASE).replace(/\/$/, "");
}
