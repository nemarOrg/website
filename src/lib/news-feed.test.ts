import { describe, expect, it } from "vitest";
import type { NewsPostSummary } from "./news";
import { renderNewsRss } from "./news-feed";

const POST: NewsPostSummary = {
  id: 1,
  slug: "hed-score-annotation",
  title: "Annotate recordings with HED & SCORE <tags>",
  summary: "Mark events and artifacts in the viewer.",
  category: "feature",
  banner_url: null,
  banner_alt: "",
  status: "published",
  published_at: "2026-09-02T19:00:00Z",
  created_at: "2026-09-29T16:00:00Z",
  updated_at: "2026-09-29T16:00:00Z",
};

describe("renderNewsRss", () => {
  it("renders one item per post with absolute links and RFC 822 dates", () => {
    const xml = renderNewsRss([POST], "https://nemar.org");
    expect(xml).toContain("<link>https://nemar.org/news/hed-score-annotation</link>");
    expect(xml).toContain(
      '<guid isPermaLink="true">https://nemar.org/news/hed-score-annotation</guid>',
    );
    expect(xml).toContain("<pubDate>Wed, 02 Sep 2026 19:00:00 GMT</pubDate>");
    expect(xml).toContain("<lastBuildDate>Wed, 02 Sep 2026 19:00:00 GMT</lastBuildDate>");
    expect(xml).toContain("<category>New feature</category>");
  });

  it("escapes titles and summaries", () => {
    const xml = renderNewsRss([POST], "https://nemar.org");
    expect(xml).toContain("<title>Annotate recordings with HED &amp; SCORE &lt;tags&gt;</title>");
    expect(xml).not.toContain("<tags>");
  });

  it("skips a date it cannot read instead of printing Invalid Date", () => {
    const xml = renderNewsRss([{ ...POST, published_at: "" }], "https://nemar.org");
    expect(xml).not.toContain("pubDate");
    expect(xml).not.toContain("lastBuildDate");
    expect(xml).not.toContain("Invalid");
  });

  it("is a valid empty channel with no posts", () => {
    const xml = renderNewsRss([], "https://nemar.org");
    expect(xml).toContain("<channel>");
    expect(xml).not.toContain("<item>");
  });
});
