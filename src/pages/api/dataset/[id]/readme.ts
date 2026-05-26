import type { APIRoute } from "astro";
import {
  fetchGithubReadme,
  fetchManifestEntryText,
  findReadmeContentInSummary,
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
// When all four content-resolution steps come back null for a published
// version it's usually transient (manifest fetch timed out from a cold
// isolate, GitHub raw 5xx, etc.), not "this dataset has no description
// forever." Caching the empty placeholder pins the symptom for hours via
// SWR; `no-store` keeps it scoped to the one unlucky request. Selected
// over the success branch via the `source` discriminator: a non-null
// `source` (manifest/github/description) means real content was found
// and PUBLISHED_CACHE is safe. Issue #53.
const FALLBACK_CACHE = "no-store";

/**
 * `GET /api/dataset/<id>/readme?v=<version>` — returns the rendered
 * README HTML for `<id>` at `<version>`.
 *
 * Resolution order:
 *   0.  If landing says unpublished → render "not yet published" placeholder.
 *   0.5 summary.json schema 1.1+ inline `readme.content` (nemar-cli#616).
 *      Zero outbound fetches — this is the cold-paint fast path.
 *   1.  Fast path (summary.json schema 1.0 fallback, README path resolved):
 *      GitHub raw README (one outbound fetch).
 *   2.  Manifest README via presigned URL.
 *   3.  GitHub raw README (without summary signal).
 *   4.  BIDS dataset_description fallback.
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

  // Step 0.5: schema 1.1 inline content. When the generator embedded the
  // README directly in summary.json (and didn't mark it truncated), use it
  // and skip every outbound fetch below. The content is the dataset's own
  // README markdown, just delivered via the manifest pipeline instead of
  // GitHub — `kind = "manifest"` is the renderer's existing no-banner path,
  // which is the right output here. Reusing the value avoids churn from
  // adding a `"inline"` enum case for cosmetic naming; revisit if a future
  // change to `ReadmeSourceKind` needs to distinguish inline vs presigned
  // sources at render time (e.g., per-source telemetry on the renderer).
  // Back-compat: on schema 1.0 docs `findReadmeContentInSummary` returns
  // null and this branch is a no-op; Steps 1-4 run as before.
  if (summary) {
    const inlineContent = findReadmeContentInSummary(summary);
    if (inlineContent) {
      source = inlineContent;
      kind = "manifest";
    }
  }

  // Step 1: fast path — summary confirms a README exists, try GitHub raw.
  if (!source && summary && readmePath !== null && githubUrl) {
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
      "Cache-Control": source ? PUBLISHED_CACHE : FALLBACK_CACHE,
    },
  });
};
