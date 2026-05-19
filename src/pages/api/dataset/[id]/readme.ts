import type { APIRoute } from "astro";
import {
  fetchGithubReadme,
  fetchManifestEntryText,
  findReadmeEntry,
  findReadmePathInSummary,
  getManifest,
  getMetadata,
  getSummary,
} from "../../../../lib/data-api";
import { type ReadmeSourceKind, renderReadme } from "../../../../lib/render-readme";

/**
 * `GET /api/dataset/<id>/readme?v=<version>` — returns the rendered
 * README HTML for `<id>` at `<version>`. Resolution order:
 *
 *   1. Fast path (summary.json present + summary.readme.path resolved):
 *      GitHub raw README (no presigned URL needed)
 *   2. Manifest README via presigned URL
 *   3. GitHub raw README (without summary)
 *   4. BIDS dataset_description fallback
 *
 * Each step only runs if the previous step yielded nothing, so a dataset
 * without a linked GitHub repo (or with a GitHub fetch failure) still
 * gets the manifest path. Edge-cached.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  const [summary, metadata] = await Promise.all([
    getSummary(id, version, { timeoutMs: 1_500 }),
    getMetadata(id, { timeoutMs: 4_000 }),
  ]);

  const githubUrl = metadata?.external_links.github_url ?? null;
  const readmePath = summary ? findReadmePathInSummary(summary) : null;

  let source: string | null = null;
  let kind: ReadmeSourceKind = null;

  // Step 1: fast path — summary confirms a README exists, try GitHub raw.
  if (summary && readmePath !== null && githubUrl) {
    source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
    if (source) kind = "github";
  }

  // Step 2: manifest README. Runs when:
  //   - no summary (slow path), OR
  //   - summary present but the GitHub fast path produced nothing (no
  //     githubUrl, GH unreachable, or summary reported a README the GH
  //     repo doesn't actually serve). Falling through to manifest avoids
  //     silently dropping the README for datasets without a GitHub URL.
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

  // Step 3: GitHub raw without summary signal (covers the case where summary
  // is absent and the manifest README path also failed).
  if (!source && githubUrl) {
    source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
    if (source) kind = "github";
  }

  // Step 4: BIDS description.
  if (!source && metadata?.description && metadata.description !== metadata.name) {
    source = metadata.description;
    kind = "description";
  }

  const html = renderReadme(source, kind, githubUrl);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
    },
  });
};
