import type { APIRoute } from "astro";
import { isValidSlug } from "../../../lib/news";
import { getNewsPost } from "../../../lib/news-api";

/**
 * `/og/news/<slug>.png`: the social card URL a post page advertises.
 *
 * Redirects to the branded card rendered at build time
 * (`/og/news-card/<slug>.png`, from `scripts/generate-news-og-images.mjs`).
 * A post published since the last build has no card yet (the rebuild cron
 * runs every four hours), and a preview must not break in that window, so
 * it redirects to the post's banner instead, and to the site card when the
 * post has no banner. Crawlers follow the redirect; the short cache lets
 * the card take over once it exists.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const slug = params.slug ?? "";
  if (!isValidSlug(slug)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const card = new URL(`/og/news-card/${slug}.png`, request.url);
  if (await isPng(card)) return redirect(`${card.pathname}${new URL(request.url).search}`);

  let fallback = "/og-image.png";
  try {
    const post = await getNewsPost(slug, { timeoutMs: 2500 });
    if (!post) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (post.banner_url) fallback = post.banner_url;
  } catch (err) {
    console.warn(
      `[og/news/${slug}] post lookup failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  return redirect(fallback);
};

async function isPng(url: URL): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2500) });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/png");
  } catch {
    return false;
  }
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "public, max-age=300" },
  });
}
