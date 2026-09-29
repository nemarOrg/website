import { describe, expect, it } from "vitest";
import {
  type NewsInput,
  type NewsPostSummary,
  buildNewsArticleJsonLd,
  categoryLabel,
  formatNewsDate,
  formatNewsShortDate,
  groupNewsByMonth,
  isNewsMediaUrl,
  isValidSlug,
  newsDateParts,
  newsMediaContentType,
  newsPostState,
  parseNewsList,
  parseNewsPost,
  parseNewsSummary,
  presentationCategory,
  readingMinutes,
  slugify,
  toDatetimeLocalValue,
  validateNewsInput,
} from "./news";
import { toRfc3339 } from "./notices-api";

const HASH = "a".repeat(64);
const MEDIA = `/news/media/${HASH}.png`;

const ROW: NewsPostSummary = {
  id: 7,
  slug: "nemar-assistant",
  title: "Ask the NEMAR Assistant",
  summary: "A chat assistant that reads the dataset you are looking at.",
  category: "feature",
  banner_url: MEDIA,
  banner_alt: "The assistant plotting an ERP image",
  status: "published",
  published_at: "2026-09-24T19:00:00Z",
  created_at: "2026-09-29T16:00:00Z",
  updated_at: "2026-09-29T16:00:00Z",
};

describe("isValidSlug", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(isValidSlug("sign-in-with-orcid")).toBe(true);
    expect(isValidSlug("v0-2-5")).toBe(true);
  });

  it("rejects case, doubled or edge hyphens, and other characters", () => {
    for (const bad of ["Sign-in", "sign--in", "-sign", "sign-", "sign_in", "sign in", "a.b"]) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
  });

  it("enforces the length bounds", () => {
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("abc")).toBe(true);
    expect(isValidSlug("a".repeat(80))).toBe(true);
    expect(isValidSlug("a".repeat(81))).toBe(false);
  });

  it("reserves media, the image path", () => {
    expect(isValidSlug("media")).toBe(false);
    expect(isValidSlug("media-kit")).toBe(true);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates a title", () => {
    expect(slugify("Sign in with ORCID")).toBe("sign-in-with-orcid");
  });

  it("folds diacritics instead of splitting words on them", () => {
    expect(slugify("EEG précis: café")).toBe("eeg-precis-cafe");
  });

  it("treats punctuation and symbols as separators", () => {
    expect(slugify("HED & SCORE annotation, in the viewer!")).toBe(
      "hed-score-annotation-in-the-viewer",
    );
  });

  it("stops at a word boundary under 80 characters", () => {
    const slug = slugify(`${"word ".repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("truncates a single overlong word rather than returning nothing", () => {
    expect(slugify("x".repeat(100))).toBe("x".repeat(80));
  });

  it("returns an empty string when nothing is sluggable", () => {
    expect(slugify("!!! ???")).toBe("");
  });
});

describe("isNewsMediaUrl and newsMediaContentType", () => {
  it("accepts only the content-addressed media path", () => {
    expect(isNewsMediaUrl(MEDIA)).toBe(true);
    expect(isNewsMediaUrl(`/news/media/${HASH}.jpg`)).toBe(true);
    expect(isNewsMediaUrl(`https://nemar.org/news/media/${HASH}.png`)).toBe(false);
    expect(isNewsMediaUrl(`/news/media/${HASH}.svg`)).toBe(false);
    expect(isNewsMediaUrl(`/news/media/${"A".repeat(64)}.png`)).toBe(false);
    expect(isNewsMediaUrl(`/news/media/../${HASH}.png`)).toBe(false);
    expect(isNewsMediaUrl("javascript:alert(1)")).toBe(false);
  });

  it("maps the file extension to its content type", () => {
    expect(newsMediaContentType(`${HASH}.png`)).toBe("image/png");
    expect(newsMediaContentType(`${HASH}.jpg`)).toBe("image/jpeg");
    expect(newsMediaContentType(`${HASH}.webp`)).toBe("image/webp");
    expect(newsMediaContentType(`${HASH}.gif`)).toBe("image/gif");
    expect(newsMediaContentType(`${HASH}.svg`)).toBeNull();
    expect(newsMediaContentType("../etc/passwd")).toBeNull();
  });
});

describe("categories", () => {
  it("labels known categories", () => {
    expect(categoryLabel("feature")).toBe("New feature");
    expect(categoryLabel("event")).toBe("Event");
  });

  it("reads an unknown category as update", () => {
    expect(presentationCategory("webinar")).toBe("update");
    expect(categoryLabel("")).toBe("Update");
  });
});

describe("newsPostState", () => {
  const now = new Date("2026-09-29T12:00:00Z");

  it("calls a draft a draft whatever its date", () => {
    expect(newsPostState({ status: "draft", published_at: "2020-01-01T00:00:00Z" }, now)).toBe(
      "draft",
    );
  });

  it("calls a future-dated published post scheduled", () => {
    expect(newsPostState({ status: "published", published_at: "2026-10-01T00:00:00Z" }, now)).toBe(
      "scheduled",
    );
  });

  it("calls a past-dated published post published", () => {
    expect(newsPostState({ status: "published", published_at: "2026-07-29T17:00:00Z" }, now)).toBe(
      "published",
    );
  });

  it("treats an unreadable date as published", () => {
    expect(newsPostState({ status: "published", published_at: "soon" }, now)).toBe("published");
  });
});

describe("dates in NEMAR's time zone", () => {
  it("keeps a San Diego evening post on its local date", () => {
    // 03:00 UTC on the 25th is 20:00 on the 24th in San Diego.
    expect(formatNewsDate("2026-09-25T03:00:00Z")).toBe("September 24, 2026");
    expect(newsDateParts("2026-09-25T03:00:00Z")).toEqual({
      monthKey: "2026-09",
      monthLabel: "September 2026",
      day: "24",
    });
  });

  it("drops the year from a short date only within the current year", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(formatNewsShortDate("2026-09-16T19:00:00Z", now)).toBe("Sep 16");
    expect(formatNewsShortDate("2025-12-31T19:00:00Z", now)).toBe("Dec 31, 2025");
    expect(formatNewsShortDate("", now)).toBe("");
  });

  it("returns nothing for a missing or unreadable date", () => {
    expect(formatNewsDate(null)).toBe("");
    expect(formatNewsDate("not a date")).toBe("");
    expect(newsDateParts("not a date")).toBeNull();
  });
});

describe("groupNewsByMonth", () => {
  it("groups consecutive posts by month, keeping the given order", () => {
    const groups = groupNewsByMonth([
      { id: 1, published_at: "2026-09-24T19:00:00Z" },
      { id: 2, published_at: "2026-09-02T19:00:00Z" },
      { id: 3, published_at: "2026-07-29T19:00:00Z" },
      { id: 4, published_at: "2026-07-29T18:00:00Z" },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["September 2026", "July 2026"]);
    expect(groups[0].posts.map((p) => [p.post.id, p.day])).toEqual([
      [1, "24"],
      [2, "2"],
    ]);
    expect(groups[1].posts.map((p) => p.post.id)).toEqual([3, 4]);
  });

  it("puts undated posts last instead of dropping them", () => {
    const groups = groupNewsByMonth([
      { id: 1, published_at: "" },
      { id: 2, published_at: "2026-09-24T19:00:00Z" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09", "undated"]);
    expect(groups[1].posts[0].post.id).toBe(1);
  });

  it("returns no groups for no posts", () => {
    expect(groupNewsByMonth([])).toEqual([]);
  });
});

describe("readingMinutes", () => {
  it("counts words, not code or image markup", () => {
    const body = `${"word ".repeat(460)}\n\n\`\`\`\n${"code ".repeat(1000)}\n\`\`\`\n\n![alt](${MEDIA})`;
    expect(readingMinutes(body)).toBe(2);
  });

  it("never says zero", () => {
    expect(readingMinutes("")).toBe(1);
  });
});

describe("parsing responses", () => {
  it("keeps a well-formed row as is", () => {
    expect(parseNewsSummary(ROW)).toEqual(ROW);
  });

  it("drops a row without a slug or a title", () => {
    expect(parseNewsSummary({ ...ROW, slug: "" })).toBeNull();
    expect(parseNewsSummary({ ...ROW, title: "   " })).toBeNull();
    expect(parseNewsSummary(null)).toBeNull();
    expect(parseNewsSummary("post")).toBeNull();
  });

  it("drops a banner that is not one of ours rather than the post", () => {
    const parsed = parseNewsSummary({ ...ROW, banner_url: "https://example.org/x.png" });
    expect(parsed?.banner_url).toBeNull();
    expect(parsed?.title).toBe(ROW.title);
  });

  it("normalizes an unknown category and status", () => {
    const parsed = parseNewsSummary({ ...ROW, category: "webinar", status: "archived" });
    expect(parsed?.category).toBe("update");
    expect(parsed?.status).toBe("published");
  });

  it("requires a string body for a full post", () => {
    expect(parseNewsPost({ ...ROW, body: "Hello" })?.body).toBe("Hello");
    expect(parseNewsPost(ROW)).toBeNull();
  });

  it("parses a list, skipping unrenderable rows", () => {
    expect(parseNewsList({ posts: [ROW, { title: "no slug" }, 3] })).toEqual([ROW]);
    expect(parseNewsList({})).toEqual([]);
    expect(parseNewsList(null)).toEqual([]);
  });
});

describe("validateNewsInput", () => {
  const good: NewsInput = {
    slug: "nemar-assistant",
    title: "Ask the NEMAR Assistant",
    summary: "A chat assistant.",
    body: "Body text.",
    category: "feature",
    banner_url: MEDIA,
    banner_alt: "A screenshot",
    status: "published",
    published_at: "2026-09-24T19:00:00Z",
  };

  it("passes a complete post", () => {
    expect(validateNewsInput(good)).toEqual([]);
  });

  it("names each missing field", () => {
    const problems = validateNewsInput({
      ...good,
      slug: "Bad Slug",
      title: " ",
      summary: "",
      body: "",
      published_at: "",
    });
    expect(problems.map((p) => p.field)).toEqual([
      "slug",
      "title",
      "summary",
      "body",
      "published_at",
    ]);
  });

  it("says the reserved slug is reserved", () => {
    expect(validateNewsInput({ ...good, slug: "media" })[0].message).toMatch(/reserved/);
  });

  it("requires alt text only when there is a banner", () => {
    expect(validateNewsInput({ ...good, banner_alt: "" }).map((p) => p.field)).toEqual([
      "banner_alt",
    ]);
    expect(validateNewsInput({ ...good, banner_url: null, banner_alt: "" })).toEqual([]);
  });

  it("rejects a banner from anywhere else", () => {
    expect(
      validateNewsInput({ ...good, banner_url: "https://example.org/x.png" }).map((p) => p.field),
    ).toEqual(["banner_url"]);
  });

  it("enforces the length caps", () => {
    const problems = validateNewsInput({
      ...good,
      title: "t".repeat(141),
      summary: "s".repeat(301),
      body: "b".repeat(50_001),
      banner_alt: "a".repeat(301),
    });
    expect(problems.map((p) => p.field)).toEqual(["title", "summary", "body", "banner_alt"]);
  });
});

describe("buildNewsArticleJsonLd", () => {
  it("describes the post with absolute URLs on the given origin", () => {
    const jsonld = buildNewsArticleJsonLd(ROW, "https://nemar.org");
    expect(jsonld).toMatchObject({
      "@type": "NewsArticle",
      headline: ROW.title,
      description: ROW.summary,
      url: "https://nemar.org/news/nemar-assistant",
      image: [`https://nemar.org${MEDIA}`],
      datePublished: ROW.published_at,
      dateModified: ROW.updated_at,
      articleSection: "New feature",
    });
  });

  it("omits the image and dates it cannot state", () => {
    const jsonld = buildNewsArticleJsonLd(
      { ...ROW, banner_url: null, published_at: "", updated_at: "" },
      "https://nemar.org",
    );
    expect(jsonld).not.toHaveProperty("image");
    expect(jsonld).not.toHaveProperty("datePublished");
    expect(jsonld).not.toHaveProperty("dateModified");
  });
});

describe("toDatetimeLocalValue", () => {
  it("round-trips through toRfc3339 at minute precision, in any time zone", () => {
    const iso = "2026-09-24T19:05:00.000Z";
    expect(toRfc3339(toDatetimeLocalValue(iso))).toBe(iso);
    expect(toDatetimeLocalValue(iso)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("returns an empty value for an unreadable date", () => {
    expect(toDatetimeLocalValue("never")).toBe("");
  });
});
