import type { APIRoute } from "astro";
import {
  fetchGithubReadme,
  fetchManifestEntryText,
  findReadmeEntry,
  getManifest,
  getMetadata,
} from "../../../../lib/data-api";
import { renderReadme, type ReadmeSourceKind } from "../../../../lib/render-readme";

/**
 * `GET /api/dataset/<id>/readme?v=<version>` — returns the rendered
 * README HTML for `<id>` at `<version>`. Resolution order matches the
 * legacy SSR path: manifest README -> GitHub raw README -> BIDS
 * description. Edge-cached so repeat visitors get instant content.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", { status: 400 });
  }

  // Manifest README + metadata fetched in parallel. metadata only used for
  // the GitHub URL + description fallback, so we don't block on it before
  // attempting the manifest README.
  const [manifest, metadata] = await Promise.all([
    getManifest(id, version, { timeoutMs: 4_000 }),
    getMetadata(id, { timeoutMs: 4_000 }),
  ]);

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
      "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
    },
  });
};
