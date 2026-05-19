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
 * Fast path (summary.json present + readme path known):
 *   1. GitHub raw README (no presigned URL needed)
 *   2. description fallback
 *
 * Slow path (no summary.json):
 *   1. manifest README via presigned URL
 *   2. GitHub raw README
 *   3. description fallback
 *
 * Edge-cached so repeat visitors get instant content.
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

  let source: string | null = null;
  let kind: ReadmeSourceKind = null;

  const readmePath = summary ? findReadmePathInSummary(summary) : null;

  if (summary && readmePath !== null) {
    // Fast path: summary confirms a README exists; fetch it from GitHub.
    if (githubUrl) {
      source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
      if (source) kind = "github";
    }
  } else {
    // Slow path: no summary — fall back to manifest-based lookup unchanged.
    const manifest = await getManifest(id, version, { timeoutMs: 4_000 });
    if (manifest) {
      const entry = findReadmeEntry(manifest);
      if (entry?.url) {
        source = await fetchManifestEntryText(entry.url, { timeoutMs: 2_500 });
        if (source) kind = "manifest";
      }
    }
    if (!source && githubUrl) {
      source = await fetchGithubReadme(githubUrl, { timeoutMs: 1_500 });
      if (source) kind = "github";
    }
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
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
    },
  });
};
