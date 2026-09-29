import type { APIRoute } from "astro";
import { MARKETING_BASE_URL } from "../../lib/host";
import { listNews } from "../../lib/news-api";
import { renderNewsRss } from "../../lib/news-feed";

/**
 * `/news/feed.xml`: the 20 newest public posts as RSS 2.0. Links point at
 * nemar.org whichever host served the feed, like the sitemap.
 */
export const GET: APIRoute = async () => {
  try {
    const page = await listNews({ limit: 20 });
    return new Response(renderNewsRss(page.posts, MARKETING_BASE_URL), {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    // A reader treats an error as "try later"; an empty feed would read as
    // "every post was deleted".
    console.error(`[news/feed] list failed: ${err instanceof Error ? err.message : String(err)}`);
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
