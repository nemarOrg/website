import type { APIRoute } from "astro";
import { getDataset, isManagedDatasetId, resolveCanonical } from "../../lib/api";
import {
  getLandingOutcome,
  getMetadataOutcome,
  outcomeValue,
  resolveDatasetPageStatus,
} from "../../lib/data-api";
import { resolveDataBase } from "../../lib/data-base";
import { buildUseThisData, renderUseThisDataMarkdown } from "../../lib/use-this-data";
import { zarrBase } from "../../lib/zarr-base";

/**
 * Markdown mirror of the dataset detail page's "Use this data" section
 * (website#284 phase 2), served at `/dataset/<id>.md`. Astro's
 * endpoint-extension convention gives this route precedence over
 * `[id].astro` for a request whose id literally ends in `.md` -- see
 * `src/pages/version.json.ts` for the repo's existing precedent, and the PR
 * description for the empirical verification (curl against both routes).
 *
 * This MIRRORS the page's own behaviour exactly, not a parallel
 * implementation of it: the same `ds*` -> canonical 301, the same
 * `resolveDatasetPageStatus` 404/503 split, and the same SSR fan-out
 * (landing + metadata + catalog row, no new fetches). A private dataset
 * needs no special casing -- `getLanding`/`getMetadata` already 404 for one
 * (verified against data.nemar.org), so `resolveDatasetPageStatus` returns
 * `not_found` here exactly as it does for the page.
 */
export const GET: APIRoute = async ({ params, url, redirect }) => {
  const id = params.id;
  if (!id) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  // Mirrors [id].astro's ds* -> canonical redirect, preserving the query
  // string and appending .md so the hop lands back on this same route.
  if (/^ds\d{6}$/.test(id)) {
    const canonical = await resolveCanonical(id).catch(() => null);
    if (canonical) {
      return redirect(`/dataset/${canonical}.md${url.search}`, 301);
    }
  }

  const versionParam = url.searchParams.get("v");

  const [landingOut, metadataOut, catalogRow] = await Promise.all([
    getLandingOutcome(id),
    getMetadataOutcome(id),
    isManagedDatasetId(id)
      ? getDataset(id).catch((err) => {
          console.warn(
            `[dataset/${id}.md] catalog row fetch failed, omitting zarr/channel facts: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
      : Promise.resolve(null),
  ]);

  const status = resolveDatasetPageStatus(landingOut, metadataOut);
  if (status.kind === "not_found") {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (status.kind === "degraded") {
    console.warn(`[dataset/${id}.md] ${status.signal} fetch failed: ${status.outcome}`);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const landing = outcomeValue(landingOut);
  const metadata = outcomeValue(metadataOut);
  if (!landing || !metadata) {
    console.error(
      `[dataset/${id}.md] safety-net 500: landing=${landingOut.kind} metadata=${metadataOut.kind}`,
    );
    return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }

  const selectedVersion =
    versionParam && landing.versions.some((v) => v.version === versionParam)
      ? versionParam
      : (landing.latest ?? landing.versions[0]?.version ?? null);

  const model = buildUseThisData({
    id,
    metadata,
    catalogRow,
    selectedVersion,
    dataBase: resolveDataBase(),
    zarrBase: zarrBase(),
  });

  const body = renderUseThisDataMarkdown(model);

  // Same edge-cache policy as the HTML page (dataset detail rarely changes
  // within the window; see [id].astro's identical Cache-Control comment).
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
  });
};
