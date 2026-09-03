import { apiBase } from "./api-base";
import { resolveDataBase } from "./data-base";
import { resolveDocsBase } from "./docs-base";
import { MARKETING_BASE_URL } from "./host";

/**
 * Pure body for `/llms.txt` (website#284 phase 6, issue #289). No I/O --
 * `src/pages/llms.txt.ts` is the thin route wrapper, matching how
 * `robots.ts`/`robots.txt.ts` split.
 *
 * WHY THIS EXISTS, plainly: it is a cheap no-regret addition, not a
 * findability or SEO play. The evidence (nemar-cli's
 * `.context/research-agent-findability.md`, 2026-09-03) is that llms.txt
 * sees close to no real use -- 97% of published files got zero requests in
 * Ahrefs' measured month -- and Google has said on the record that Search
 * ignores it. This file costs nothing to keep correct and is shipped for
 * that reason alone.
 *
 * SAME BODY ON EVERY HOST. Unlike `sitemap.xml.ts`, this route does no
 * upstream catalog fetch, so there is nothing expensive to gate behind
 * `isNoindexHost`. Non-production hosts are already `Disallow: /` in
 * robots.txt and carry `X-Robots-Tag: noindex` (see `isNoindexHost` in
 * `host.ts`), so a second, gated body here would just be a second thing to
 * keep in sync for no benefit.
 *
 * Host resolution mirrors `Footer.astro`'s Data column: `resolveDataBase`,
 * `apiBase`, and `resolveDocsBase` resolve the data/api/docs hosts the same
 * way the footer does, so a staging build correctly advertises its own
 * `-test` backends instead of hardcoding production. The one exception is
 * nemar.org itself -- those links are pinned to `MARKETING_BASE_URL` rather
 * than the request hostname, so a fetch on a non-canonical host (staging,
 * a `*.pages.dev` preview) never advertises that host as canonical. This is
 * the same rule `robots.ts` applies to its `Sitemap:` directive.
 */
export function llmsTxtBody(): string {
  const dataBase = resolveDataBase();
  const dataHost = new URL(dataBase).host;
  const apiOrigin = apiBase();
  const apiHost = new URL(apiOrigin).host;
  const docsBase = resolveDocsBase();

  const header = "# NEMAR";

  const summary = [
    "> The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) is a",
    "> catalog and browser for neuroimaging datasets (EEG, MEG, iEEG, EMG, and",
    "> more) in BIDS format. Dataset bytes are not hosted on nemar.org --",
    "> they are served from data.nemar.org, described below.",
  ].join("\n");

  const dataSection = [
    "## Data",
    "",
    `- [${dataHost}](${dataBase}/): BIDS-shaped file access over HTTPS. A dataset's current release is served under \`/<id>/latest/\`; earlier releases are under \`/<id>/<version>/\`.`,
  ].join("\n");

  const apiSection = [
    "## API",
    "",
    `- [${apiHost}/datasets](${apiOrigin}/datasets): paginated dataset catalog, JSON.`,
    `- [${apiHost}/datasets/search?q=EEG](${apiOrigin}/datasets/search?q=EEG): full-text and faceted dataset search, JSON. The \`q\` query parameter is required; a bare GET with no \`q\` returns 400.`,
  ].join("\n");

  const docsSection = [
    "## Docs",
    "",
    `- [For agents](${docsBase}/platform/for-agents/): the data.nemar.org layout, API examples with curl, the CLI, and when to stream via Zarr instead of downloading.`,
    `- [Zarr contract](${docsBase}/platform/zarr/): the zarr.nemar.org index.json contract for streaming a single recording without a full download.`,
  ].join("\n");

  const datasetsSection = [
    "## Datasets",
    "",
    `- [/dataset/<id>](${MARKETING_BASE_URL}/dataset/<id>): server-rendered dataset page with a schema.org Dataset JSON-LD block in the page head; a markdown mirror is served at \`/dataset/<id>.md\`.`,
  ].join("\n");

  const licenseSection = [
    "## License",
    "",
    "Dataset licenses vary per dataset. Most are CC0 or CC-BY; a minority carry a non-commercial or no-derivatives term (for example CC-BY-NC-SA). Check each dataset's own license before reuse -- it is not the same across NEMAR.",
  ].join("\n");

  return `${[header, summary, dataSection, apiSection, docsSection, datasetsSection, licenseSection].join("\n\n")}\n`;
}
