import type { APIRoute } from "astro";
import { buildTree } from "../../../../lib/bids-tree";
import { getLanding, getManifest, isUnpublished } from "../../../../lib/data-api";
import {
  renderBidsTree,
  renderNoManifest,
  renderUnpublishedTree,
} from "../../../../lib/render-tree";

const PUBLISHED_CACHE = "public, max-age=300, s-maxage=600, stale-while-revalidate=86400";
// Short SWR for the unpublished branch: a dataset can flip to published at any
// moment, and we don't want the CF edge to keep serving "not yet published"
// HTML for hours after a real release. 60s s-maxage + 300s SWR caps the
// staleness window without hammering origin.
const UNPUBLISHED_CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

/**
 * `GET /api/dataset/<id>/tree?v=<version>` — returns the rendered BIDS
 * file tree HTML for `<id>` at `<version>`. Used by the detail page to
 * defer the manifest fetch off the SSR critical path. Both upstream
 * fetches fire in parallel so the unpublished detection doesn't add
 * serial RTT to the published-dataset latency budget. Edge-cached.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  const [landing, manifest] = await Promise.all([
    getLanding(id, { timeoutMs: 1_500 }),
    getManifest(id, version, { timeoutMs: 5_000 }),
  ]);

  if (landing === null) {
    console.warn(`[tree/${id}] getLanding returned null; proceeding to manifest path`);
  }

  if (isUnpublished(landing)) {
    return new Response(renderUnpublishedTree(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": UNPUBLISHED_CACHE,
      },
    });
  }

  const basePath = `https://data.nemar.org/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
  const html = manifest ? renderBidsTree(buildTree(manifest), basePath) : renderNoManifest(version);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": PUBLISHED_CACHE,
    },
  });
};
