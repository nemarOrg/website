import type { APIRoute } from "astro";
import { buildTree, buildTreeFromPaths } from "../../../../lib/bids-tree";
import type { TreeNode } from "../../../../lib/bids-tree";
import {
  getLandingOutcome,
  getManifest,
  getSummary,
  isUnpublished,
  outcomeValue,
} from "../../../../lib/data-api";
import {
  isSubjectDir,
  renderBidsSubtree,
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
// A well-formed `?subject=` whose label genuinely doesn't exist in this
// version's tree (typo'd URL, race against a newer version) is a real
// not-found, not a transient. Short cache absorbs repeated misses on the
// same bad URL without pinning the answer for long if the dataset
// gains the subject in a future version.
const NOT_FOUND_SUBJECT_CACHE = "public, max-age=60, s-maxage=60";

/**
 * `GET /api/dataset/<id>/tree?v=<version>` — returns the rendered BIDS
 * file tree HTML for `<id>` at `<version>`. Two response modes:
 *
 *   skeleton (no `subject=` param):
 *     Top-level non-subject entries rendered inline; each `sub-XYZ`
 *     directory becomes a *collapsed* row with a lazy-load slot so a
 *     dataset like on005505 (5,409 paths / 136 subjects) ships < 50 KB
 *     of HTML instead of 3.3 MB.
 *   subtree (`subject=sub-XYZ`):
 *     Returns just the inner `<ul>` markup for that subject's subtree —
 *     the client drops it into the matching `[data-subject-target]`
 *     slot on first <details> toggle.
 *
 * Resolution order (both modes):
 *   0. If landing says unpublished → render "not yet published" placeholder.
 *   1. Fast path: summary.json's flat path list builds the tree.
 *   2. Slow path: full manifest builds the tree.
 *   3. No-manifest empty state (skeleton only; subtree returns 404).
 *
 * Landing + summary fetched in parallel so unpublished detection and the
 * fast path don't add serial RTT. Manifest only fires when summary is
 * absent or malformed.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const url = new URL(request.url);
  const version = url.searchParams.get("v");
  const subjectParam = url.searchParams.get("subject");

  if (!id || !version) {
    return new Response("Missing id or v= query parameter", {
      status: 400,
      headers: { "Cache-Control": FALLBACK_CACHE },
    });
  }

  // Validate the subject param at the boundary: anything that doesn't match
  // the BIDS sub-XYZ shape (path traversal, empty string, embedded slash) is
  // rejected before any tree is built. The same predicate gates the
  // skeleton render — if `isSubjectDir` is ever widened (e.g., to support
  // BIDS 2.0 hyphenated labels), this validation must change to match so
  // the two stay symmetric.
  if (subjectParam !== null && !isSubjectDir(subjectParam)) {
    return new Response("Invalid subject parameter", {
      status: 400,
      headers: { "Cache-Control": FALLBACK_CACHE },
    });
  }

  // Summary timeout raised from 1.5s to 4s: HBN-sized datasets ship a
  // 400-750 KB summary.json, and on a cold CF isolate the 1.5s ceiling
  // was triggering the manifest/no-manifest fallback chain on first
  // visit (user-visible "Manifest unavailable" + 2-3 refresh cycles).
  // Landing stays at 1.5s — it's a tiny payload and timing out usually
  // means the dataset doesn't exist, where a fast 404 is the right move.
  // Issue #74.
  const [landingOut, summary] = await Promise.all([
    getLandingOutcome(id, { timeoutMs: 1_500 }),
    getSummary(id, version, { timeoutMs: 4_000 }),
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

  // Build the shared TreeNode root for both response modes. Skeleton uses
  // the root directly; subtree picks the matching subject child off it.
  let root: TreeNode | null = null;
  let fellBackToEmpty = false;
  if (summaryUsable && summary) {
    // Overlay summary.totals.bytes so the rendered panel header reads
    // a real number ("X GB total") instead of the 0 B that the
    // zero-size synthetic entries would otherwise propagate. Per-file
    // sizes still need schema 1.2 (nemar-cli#635). Issue #74.
    root = buildTreeFromPaths(summary.paths, summary.totals?.bytes);
  } else {
    if (summary === null) {
      console.warn(`[tree/${id}] summary null; falling back to manifest path`);
    } else {
      console.warn(`[tree/${id}] summary present but paths empty; falling back to manifest`);
    }
    const manifest = await getManifest(id, version, { timeoutMs: 5_000 });
    if (manifest) {
      root = buildTree(manifest);
    } else {
      fellBackToEmpty = true;
    }
  }

  // Subtree branch: locate the subject child or 404. The 503 branch matches
  // the skeleton path's no-manifest treatment — both summary and manifest
  // failed, which is a transient upstream symptom and must not be pinned
  // at the edge. The 404 is genuine (typo'd URL or race against a newer
  // version) so a short cache absorbs repeated misses on the same bad URL.
  if (subjectParam !== null) {
    if (!root) {
      return new Response("Manifest unavailable", {
        status: 503,
        headers: { "Cache-Control": FALLBACK_CACHE },
      });
    }
    const subjectNode = root.children.find((c) => c.name === subjectParam);
    if (!subjectNode) {
      return new Response("Subject not found in this version", {
        status: 404,
        headers: { "Cache-Control": NOT_FOUND_SUBJECT_CACHE },
      });
    }
    return new Response(renderBidsSubtree(subjectNode, basePath), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": PUBLISHED_CACHE,
      },
    });
  }

  // Skeleton branch (no subject param).
  const html = root ? renderBidsTree(root, basePath) : renderNoManifest(version);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": fellBackToEmpty ? FALLBACK_CACHE : PUBLISHED_CACHE,
    },
  });
};
