import type { APIRoute } from "astro";
import { buildTree, buildTreeFromPaths } from "../../../../lib/bids-tree";
import {
  getLandingOutcome,
  getManifest,
  getSummary,
  isUnpublished,
  outcomeValue,
} from "../../../../lib/data-api";
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
// Once landing reports a published version we expect a manifest to exist; a
// missing one is a transient upstream symptom (cold-isolate fetch timeout,
// data.nemar.org 5xx, summary slow-path stall) — not a state we should pin
// at the edge. `no-store` keeps the failure local to the one unlucky request
// instead of broadcasting it via s-maxage + SWR. Issue #53.
const FALLBACK_CACHE = "no-store";

/**
 * `GET /api/dataset/<id>/tree?v=<version>` — returns the rendered BIDS
 * file tree HTML for `<id>` at `<version>`.
 *
 * Resolution order:
 *   0. If landing says unpublished → render "not yet published" placeholder.
 *   1. Fast path: summary.json's flat path list builds the tree.
 *   2. Slow path: full manifest builds the tree.
 *   3. No-manifest empty state.
 *
 * Landing + summary fetched in parallel so unpublished detection and the
 * fast path don't add serial RTT. Manifest only fires when summary is
 * absent or malformed.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  const [landingOut, summary] = await Promise.all([
    getLandingOutcome(id, { timeoutMs: 1_500 }),
    getSummary(id, version, { timeoutMs: 1_500 }),
  ]);

  // Real 404 when the dataset itself doesn't exist — short-circuits the
  // fall-through that would otherwise render an empty "no manifest" state
  // for what's actually a typo'd URL.
  if (landingOut.kind === "not_found") {
    return new Response("Dataset not found", { status: 404 });
  }
  if (landingOut.kind !== "ok") {
    console.warn(
      `[tree/${id}] landing fetch failed (${landingOut.kind}); proceeding to manifest path`,
    );
  }

  const landing = outcomeValue(landingOut);
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
  const summaryUsable =
    summary !== null && Array.isArray(summary.paths) && summary.paths.length > 0;

  let html: string;
  let fellBackToEmpty = false;
  if (summaryUsable) {
    html = renderBidsTree(buildTreeFromPaths(summary.paths), basePath);
  } else {
    if (summary === null) {
      console.warn(`[tree/${id}] summary null; falling back to manifest path`);
    } else {
      console.warn(`[tree/${id}] summary present but paths empty; falling back to manifest`);
    }
    const manifest = await getManifest(id, version, { timeoutMs: 5_000 });
    if (manifest) {
      html = renderBidsTree(buildTree(manifest), basePath);
    } else {
      html = renderNoManifest(version);
      fellBackToEmpty = true;
    }
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": fellBackToEmpty ? FALLBACK_CACHE : PUBLISHED_CACHE,
    },
  });
};
