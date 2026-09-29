/**
 * News posts: the shapes `api.nemar.org` serves and the pure helpers every
 * news surface shares (the landing column, `/news`, the article page, the
 * feed, and the admin editor).
 *
 * The contract lives in nemar-cli (`backend/src/services/news.ts`,
 * nemarOrg/nemar-cli#1551). The wire client is `news-api.ts`; nothing in
 * this file fetches, so all of it is unit-testable.
 */

/**
 * What a post is about. Constrained by a `CHECK` on `news_posts.category`.
 * Rendered as a colored marker (never as colored text), so the color only
 * has to clear the 3:1 non-text contrast bar.
 */
export type NewsCategory = "feature" | "data" | "event" | "update";

/** `published` posts are public once `published_at` has passed. */
export type NewsStatus = "draft" | "published";

export const NEWS_CATEGORIES: readonly NewsCategory[] = ["feature", "data", "event", "update"];

export const NEWS_CATEGORY_LABELS: Readonly<Record<NewsCategory, string>> = {
  feature: "New feature",
  data: "Data",
  event: "Event",
  update: "Update",
};

/** A post as listed: everything but the Markdown body. */
export interface NewsPostSummary {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: NewsCategory;
  /** Site-relative `/news/media/<sha256>.<ext>`, or null for a post without a banner. */
  readonly banner_url: string | null;
  readonly banner_alt: string;
  readonly status: NewsStatus;
  /** RFC3339 UTC. The date readers see; admins may backdate or schedule it. */
  readonly published_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface NewsPost extends NewsPostSummary {
  /** Markdown, rendered with {@link renderMarkdown}'s news options. */
  readonly body: string;
}

/** The body `POST /admin/news` and `PUT /admin/news/:id` accept. */
export interface NewsInput {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly category: NewsCategory;
  readonly banner_url: string | null;
  readonly banner_alt: string;
  readonly status: NewsStatus;
  /** RFC3339 with offset. */
  readonly published_at: string;
}

/** Field limits, mirrored from the backend's zod schema so the editor can say so before a round trip. */
export const NEWS_LIMITS = {
  slugMin: 3,
  slugMax: 80,
  title: 140,
  summary: 300,
  body: 50_000,
  bannerAlt: 300,
  /** Upload cap for one image, in bytes (5 MiB). */
  mediaBytes: 5 * 1024 * 1024,
} as const;

/** Image types the media upload accepts, keyed by the extension the stored file gets. */
export const NEWS_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `media` is reserved: `/news/media/<file>` is where post images are served,
 * so a post with that slug could never be reached.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["media"]);

export function isValidSlug(slug: string): boolean {
  return (
    slug.length >= NEWS_LIMITS.slugMin &&
    slug.length <= NEWS_LIMITS.slugMax &&
    SLUG_RE.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  );
}

/**
 * A URL slug from a title: lowercase ASCII words joined by hyphens, cut at a
 * word boundary so it stays under the backend's 80-character cap.
 *
 * Diacritics are folded (`é` to `e`) rather than dropped, so "EEG précis"
 * becomes `eeg-precis`, not `eeg-pr-cis`. Anything else that is not a letter
 * or digit separates words.
 */
export function slugify(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > NEWS_LIMITS.slugMax) break;
    slug = next;
  }
  // A single word longer than the cap still yields something usable.
  if (!slug && words.length > 0) slug = words[0].slice(0, NEWS_LIMITS.slugMax);
  return slug;
}

/**
 * Where post images live on this site. Content-addressed by the backend
 * (sha256 of the bytes), so a URL never changes meaning.
 *
 * Only these URLs may appear as a banner or as an image in a post body: the
 * Content-Security-Policy allows images from this origin only, and the
 * `/news/media/[file]` route is what serves them.
 */
const NEWS_MEDIA_URL_RE = /^\/news\/media\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/;
const NEWS_MEDIA_FILE_RE = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

export function isNewsMediaUrl(url: string): boolean {
  return NEWS_MEDIA_URL_RE.test(url);
}

/** Content type for a stored media file name, or null when the name is not one the backend mints. */
export function newsMediaContentType(file: string): string | null {
  const match = NEWS_MEDIA_FILE_RE.exec(file);
  return match ? (NEWS_MEDIA_TYPES[match[1]] ?? null) : null;
}

export function newsPath(slug: string): string {
  return `/news/${encodeURIComponent(slug)}`;
}

/**
 * Category for display. The website and the API deploy independently, so a
 * category this build does not know yet reads as `update`, the most neutral
 * treatment, instead of rendering an unstyled marker.
 */
export function presentationCategory(category: string): NewsCategory {
  return (NEWS_CATEGORIES as readonly string[]).includes(category)
    ? (category as NewsCategory)
    : "update";
}

export function categoryLabel(category: string): string {
  return NEWS_CATEGORY_LABELS[presentationCategory(category)];
}

/** Where a post stands for readers right now. */
export type NewsPostState = "draft" | "scheduled" | "published";

/**
 * `scheduled` is a published post whose date is still in the future: the
 * backend withholds it from the public endpoints until then, and the admin
 * list needs to say so rather than call it live.
 *
 * An unparseable date counts as published, matching what the backend will do
 * with a row it can compare.
 */
export function newsPostState(
  post: Pick<NewsPostSummary, "status" | "published_at">,
  now: Date,
): NewsPostState {
  if (post.status !== "published") return "draft";
  const at = Date.parse(post.published_at);
  if (!Number.isNaN(at) && at > now.getTime()) return "scheduled";
  return "published";
}

/**
 * NEMAR's home time zone. Post dates are displayed here rather than in UTC
 * (which is what a Worker's locale defaults to) so an evening post in San
 * Diego does not show tomorrow's date, and so server and browser renders agree.
 */
export const NEWS_TIME_ZONE = "America/Los_Angeles";

/** "September 24, 2026", or "" for a missing or unparseable date. */
export function formatNewsDate(value: string | null | undefined): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString("en-US", {
    timeZone: NEWS_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * "Sep 16" for a post dated in `now`'s year, "Sep 16, 2025" otherwise, for
 * the compact rows where a full date would crowd the title.
 */
export function formatNewsShortDate(value: string | null | undefined, now: Date): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const year = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: NEWS_TIME_ZONE, year: "numeric" });
  return at.toLocaleDateString("en-US", {
    timeZone: NEWS_TIME_ZONE,
    month: "short",
    day: "numeric",
    ...(year(at) === year(now) ? {} : { year: "numeric" }),
  });
}

/** The date parts the news index's timeline prints, in {@link NEWS_TIME_ZONE}. */
export interface NewsDateParts {
  /** `2026-09`, a sortable grouping key. */
  readonly monthKey: string;
  /** "September 2026". */
  readonly monthLabel: string;
  /** "24". */
  readonly day: string;
}

export function newsDateParts(value: string): NewsDateParts | null {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEWS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "numeric",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const monthLabel = at.toLocaleDateString("en-US", {
    timeZone: NEWS_TIME_ZONE,
    year: "numeric",
    month: "long",
  });
  return { monthKey: `${year}-${month}`, monthLabel, day: get("day") };
}

export interface NewsMonthGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly posts: readonly { readonly post: T; readonly day: string }[];
}

/**
 * Consecutive posts grouped by the month they are dated in, in the order
 * given (the API already sorts newest first). A post with an unreadable date
 * joins an "Undated" group at the end instead of being dropped.
 */
export function groupNewsByMonth<T extends Pick<NewsPostSummary, "published_at">>(
  posts: readonly T[],
): NewsMonthGroup<T>[] {
  const groups: { key: string; label: string; posts: { post: T; day: string }[] }[] = [];
  const undated: { post: T; day: string }[] = [];
  for (const post of posts) {
    const parts = newsDateParts(post.published_at);
    if (!parts) {
      undated.push({ post, day: "" });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.key === parts.monthKey) {
      last.posts.push({ post, day: parts.day });
    } else {
      groups.push({
        key: parts.monthKey,
        label: parts.monthLabel,
        posts: [{ post, day: parts.day }],
      });
    }
  }
  if (undated.length > 0) groups.push({ key: "undated", label: "Undated", posts: undated });
  return groups;
}

/** Whole minutes to read a Markdown body at 230 words a minute, never less than one. */
export function readingMinutes(markdown: string): number {
  const words = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return Math.max(1, Math.round(words / 230));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * One post summary from an unvalidated response row, or null when the row
 * cannot be rendered.
 *
 * The response is a `res.json()` cast, so nothing guarantees the shape. A
 * card whose render throws is silently dropped by Astro, and a missing slug
 * would produce a link to `/news/undefined`; both are worse than skipping
 * the row. A slug and a title are the minimum a card needs. A banner URL that
 * is not one of ours is dropped (the page would fail the CSP anyway), and an
 * unknown category or status is normalized rather than rejected.
 */
export function parseNewsSummary(raw: unknown): NewsPostSummary | null {
  if (!isRecord(raw)) return null;
  const slug = str(raw.slug);
  const title = str(raw.title).trim();
  if (!slug || !title) return null;
  const banner = str(raw.banner_url);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    slug,
    title,
    summary: str(raw.summary),
    category: presentationCategory(str(raw.category)),
    banner_url: banner && isNewsMediaUrl(banner) ? banner : null,
    banner_alt: str(raw.banner_alt),
    status: raw.status === "draft" ? "draft" : "published",
    published_at: str(raw.published_at),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
}

/** {@link parseNewsSummary} plus the body; a post without a string body is not renderable. */
export function parseNewsPost(raw: unknown): NewsPost | null {
  const summary = parseNewsSummary(raw);
  if (!summary || !isRecord(raw) || typeof raw.body !== "string") return null;
  return { ...summary, body: raw.body };
}

/** Rows from a list response, unrenderable ones dropped. */
export function parseNewsList(raw: unknown): NewsPostSummary[] {
  if (!isRecord(raw) || !Array.isArray(raw.posts)) return [];
  const out: NewsPostSummary[] = [];
  for (const row of raw.posts) {
    const post = parseNewsSummary(row);
    if (post) out.push(post);
  }
  return out;
}

/** Full posts from the admin list, unrenderable ones dropped. */
export function parseAdminNewsList(raw: unknown): NewsPost[] {
  if (!isRecord(raw) || !Array.isArray(raw.posts)) return [];
  const out: NewsPost[] = [];
  for (const row of raw.posts) {
    const post = parseNewsPost(row);
    if (post) out.push(post);
  }
  return out;
}

/** A problem the editor can name before sending the post. */
export interface NewsInputProblem {
  readonly field: keyof NewsInput;
  readonly message: string;
}

/**
 * The checks the backend will make, run in the editor first so an admin hears
 * about a bad slug or a missing alt text beside the field, not as a 400.
 * The backend stays the authority; this only saves a round trip.
 */
export function validateNewsInput(input: NewsInput): NewsInputProblem[] {
  const problems: NewsInputProblem[] = [];
  if (!isValidSlug(input.slug)) {
    problems.push({
      field: "slug",
      message: RESERVED_SLUGS.has(input.slug)
        ? `"${input.slug}" is reserved. Choose another URL.`
        : `Use ${NEWS_LIMITS.slugMin} to ${NEWS_LIMITS.slugMax} lowercase letters, digits, and single hyphens.`,
    });
  }
  const title = input.title.trim();
  if (!title) problems.push({ field: "title", message: "Add a title." });
  else if (title.length > NEWS_LIMITS.title)
    problems.push({
      field: "title",
      message: `Keep the title under ${NEWS_LIMITS.title} characters.`,
    });
  const summary = input.summary.trim();
  if (!summary) problems.push({ field: "summary", message: "Add a one or two sentence summary." });
  else if (summary.length > NEWS_LIMITS.summary)
    problems.push({
      field: "summary",
      message: `Keep the summary under ${NEWS_LIMITS.summary} characters.`,
    });
  if (!input.body.trim()) problems.push({ field: "body", message: "Write the post." });
  else if (input.body.length > NEWS_LIMITS.body)
    problems.push({
      field: "body",
      message: `Keep the post under ${NEWS_LIMITS.body} characters.`,
    });
  if (input.banner_url !== null && !isNewsMediaUrl(input.banner_url))
    problems.push({ field: "banner_url", message: "Upload the banner again." });
  if (input.banner_url !== null && !input.banner_alt.trim())
    problems.push({
      field: "banner_alt",
      message: "Describe the banner image for people who cannot see it.",
    });
  if (input.banner_alt.length > NEWS_LIMITS.bannerAlt)
    problems.push({
      field: "banner_alt",
      message: `Keep the description under ${NEWS_LIMITS.bannerAlt} characters.`,
    });
  if (Number.isNaN(Date.parse(input.published_at)))
    problems.push({ field: "published_at", message: "Pick a publication date." });
  return problems;
}

/**
 * schema.org `NewsArticle` for a post page, so search engines and agents
 * read the headline, dates, and image without scraping. Serialize with
 * `escapeJsonLdForScript` from `jsonld.ts` before it reaches a `<script>`.
 *
 * `origin` is the canonical marketing origin: every URL here must be
 * absolute, and a post belongs on nemar.org whichever host rendered it.
 */
export function buildNewsArticleJsonLd(
  post: Pick<
    NewsPost,
    "slug" | "title" | "summary" | "banner_url" | "published_at" | "updated_at" | "category"
  >,
  origin: string,
): Record<string, unknown> {
  const url = `${origin}${newsPath(post.slug)}`;
  const jsonld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: post.title,
    description: post.summary,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    articleSection: categoryLabel(post.category),
    author: { "@type": "Organization", name: "NEMAR", url: origin },
    publisher: {
      "@type": "Organization",
      name: "NEMAR",
      url: origin,
      logo: { "@type": "ImageObject", url: `${origin}/android-chrome-512x512.png` },
    },
  };
  if (post.banner_url) jsonld.image = [`${origin}${post.banner_url}`];
  if (!Number.isNaN(Date.parse(post.published_at))) jsonld.datePublished = post.published_at;
  if (!Number.isNaN(Date.parse(post.updated_at))) jsonld.dateModified = post.updated_at;
  return jsonld;
}

/**
 * An instant as an `<input type="datetime-local">` value in the browser's
 * own time zone (`2026-09-24T12:00`), the inverse of `toRfc3339` in
 * `notices-api.ts`. Minutes only, which is all that input shows. Empty for
 * an unreadable value, so the input shows blank rather than garbage.
 */
export function toDatetimeLocalValue(value: string | Date): string {
  const at = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
