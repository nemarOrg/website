import type { APIRoute } from "astro";
import {
  fetchGithubReadme,
  fetchManifestEntryText,
  findReadmeEntry,
  getLanding,
  getManifest,
  getMetadata,
  isUnpublished,
} from "../../../../lib/data-api";
import {
  type ReadmeSourceKind,
  renderReadme,
  renderUnpublishedReadme,
} from "../../../../lib/render-readme";

const PUBLISHED_CACHE = "public, max-age=300, s-maxage=600, stale-while-revalidate=86400";
// Short SWR for the unpublished branch: a dataset can flip to published at any
// moment, and we don't want the CF edge to keep serving "not yet published"
// HTML for hours after a real release. 60s s-maxage + 300s SWR caps the
// staleness window without hammering origin.
const UNPUBLISHED_CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

/**
 * `GET /api/dataset/<id>/readme?v=<version>` — returns the rendered
 * README HTML for `<id>` at `<version>`. Resolution order:
 *   - if landing says unpublished: render placeholder
 *   - else: manifest README -> GitHub raw README -> BIDS description
 * Edge-cached. All three upstream fetches fire in parallel so the
 * unpublished detection doesn't serialize ahead of the published-path
 * latency budget.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  // Fire all three upstream fetches in parallel so unpublished detection
  // doesn't add a serial RTT to the published-dataset latency budget.
  const [landing, manifest, metadata] = await Promise.all([
    getLanding(id, { timeoutMs: 1_500 }),
    getManifest(id, version, { timeoutMs: 4_000 }),
    getMetadata(id, { timeoutMs: 4_000 }),
  ]);

  if (landing === null) {
    console.warn(`[readme/${id}] getLanding returned null; proceeding to manifest path`);
  }

  if (isUnpublished(landing)) {
    return new Response(renderUnpublishedReadme(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": UNPUBLISHED_CACHE,
      },
    });
  }

  let source: string | null = null;
  let kind: ReadmeSourceKind = null;

  if (manifest) {
    const entry = findReadmeEntry(manifest);
    if (entry?.url) {
      source = await fetchManifestEntryText(entry.url, { timeoutMs: 2_500 });
      if (source) kind = "manifest";
    }
  }
  const githubUrl = metadata?.external_links.github_url ?? null;
  if (!source && githubUrl) {
    source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
    if (source) kind = "github";
  }
  if (!source && metadata?.description && metadata.description !== metadata.name) {
    source = metadata.description;
    kind = "description";
  }

  const html = renderReadme(source, kind, githubUrl);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": PUBLISHED_CACHE,
    },
  });
};
