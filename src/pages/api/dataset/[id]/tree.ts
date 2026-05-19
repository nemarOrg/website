import type { APIRoute } from "astro";
import { buildTree, buildTreeFromPaths } from "../../../../lib/bids-tree";
import { getManifest, getSummary } from "../../../../lib/data-api";
import { renderBidsTree, renderNoManifest } from "../../../../lib/render-tree";

/**
 * `GET /api/dataset/<id>/tree?v=<version>` — returns the rendered BIDS
 * file tree HTML for `<id>` at `<version>`. Used by the detail page to
 * defer the manifest fetch off the SSR critical path. Edge-cached.
 *
 * Fast path: summary.json is small (~50-200 KB) and contains the full
 * path list needed to build the tree. Falls back to fetching the full
 * manifest when summary is unavailable.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  const basePath = `https://data.nemar.org/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;

  const summary = await getSummary(id, version, { timeoutMs: 1_500 });

  let html: string;
  if (summary) {
    html = renderBidsTree(buildTreeFromPaths(summary.paths), basePath);
  } else {
    const manifest = await getManifest(id, version, { timeoutMs: 5_000 });
    html = manifest ? renderBidsTree(buildTree(manifest), basePath) : renderNoManifest(version);
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Long edge cache; tree only changes when a new dataset version is
      // published. Stale-while-revalidate keeps responses snappy after the
      // 10-minute window expires.
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
    },
  });
};
