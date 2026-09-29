/**
 * The RSS 2.0 feed at `/news/feed.xml` (website#371). Pure: the route
 * fetches, this renders.
 *
 * RSS rather than Atom because it is what every reader, Slack's RSS app, and
 * most lab mailing-list bridges accept without configuration.
 */
import { type NewsPostSummary, categoryLabel, newsPath } from "./news";
import { escapeXml } from "./xml";

/** RFC 822 dates, as RSS requires; null when the value is unreadable. */
function rfc822(value: string): string | null {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toUTCString();
}

export function renderNewsRss(posts: readonly NewsPostSummary[], origin: string): string {
  const newest = posts.map((p) => rfc822(p.published_at)).find(Boolean);
  const items = posts
    .map((post) => {
      const link = `${origin}${newsPath(post.slug)}`;
      const date = rfc822(post.published_at);
      const lines = [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        date ? `      <pubDate>${date}</pubDate>` : "",
        `      <category>${escapeXml(categoryLabel(post.category))}</category>`,
        post.summary ? `      <description>${escapeXml(post.summary)}</description>` : "",
        "    </item>",
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>NEMAR news</title>
    <link>${escapeXml(`${origin}/news`)}</link>
    <atom:link href="${escapeXml(`${origin}/news/feed.xml`)}" rel="self" type="application/rss+xml"/>
    <description>New features, data, and events on NEMAR, the open archive for human EEG, MEG, iEEG, and EMG data.</description>
    <language>en-us</language>${newest ? `\n    <lastBuildDate>${newest}</lastBuildDate>` : ""}
${items}
  </channel>
</rss>
`;
}
