import type { APIRoute } from "astro";
import {
  fetchGithubReadme,
  fetchManifestEntryText,
  findReadmeEntry,
  findReadmePathInSummary,
  getLandingOutcome,
  getManifest,
  getMetadata,
  getSummary,
  isUnpublished,
  outcomeValue,
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
 * README HTML for `<id>` at `<version>`.
 *
 * Resolution order:
 *   0. If landing says unpublished → render "not yet published" placeholder.
 *   1. Fast path (summary.json present + summary.readme.path resolved):
 *      GitHub raw README (no presigned URL needed).
 *   2. Manifest README via presigned URL.
 *   3. GitHub raw README (without summary signal).
 *   4. BIDS dataset_description fallback.
 *
 * Each step only runs if the previous step yielded nothing, so a dataset
 * without a linked GitHub repo (or with a GitHub fetch failure) still
 * gets the manifest path. Landing + summary + metadata fetched in parallel
 * so unpublished detection and the fast path don't add serial RTT.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  const [landingOut, summary, metadata] = await Promise.all([
    getLandingOutcome(id, { timeoutMs: 1_500 }),
    getSummary(id, version, { timeoutMs: 1_500 }),
    getMetadata(id, { timeoutMs: 4_000 }),
  ]);

  // Real 404 when the dataset itself doesn't exist — short-circuits the
  // fall-through that would otherwise render an empty "no manifest" state
  // for what's actually a typo'd URL.
  if (landingOut.kind === "not_found") {
    return new Response("Dataset not found", { status: 404 });
  }
  if (landingOut.kind !== "ok") {
    console.warn(
      `[readme/${id}] landing fetch failed (${landingOut.kind}); proceeding to manifest path`,
    );
  }

  const landing = outcomeValue(landingOut);
  if (isUnpublished(landing)) {
    return new Response(renderUnpublishedReadme(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": UNPUBLISHED_CACHE,
      },
    });
  }

  const githubUrl = metadata?.external_links.github_url ?? null;
  const readmePath = summary ? findReadmePathInSummary(summary) : null;

  let source: string | null = null;
  let kind: ReadmeSourceKind = null;

  // Step 1: fast path — summary confirms a README exists, try GitHub raw.
  if (summary && readmePath !== null && githubUrl) {
    source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
    if (source) kind = "github";
  }

  // Step 2: manifest README. Runs when summary was absent OR when the GitHub
  // fast path produced nothing (no GH URL, GH unreachable, or summary
  // reported a README the GH repo doesn't actually serve). Falling through
  // here avoids silently dropping the README for datasets without GitHub.
  if (!source) {
    if (summary === null) {
      console.warn(`[readme/${id}] summary null; falling back to manifest path`);
    }
    const manifest = await getManifest(id, version, { timeoutMs: 4_000 });
    if (manifest) {
      const entry = findReadmeEntry(manifest);
      if (entry?.url) {
        source = await fetchManifestEntryText(entry.url, { timeoutMs: 2_500 });
        if (source) kind = "manifest";
      }
    }
  }

  // Step 3: GitHub raw without a summary signal (manifest also missed).
  if (!source && githubUrl) {
    source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
    if (source) kind = "github";
  }

  // Step 4: BIDS dataset_description.
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
