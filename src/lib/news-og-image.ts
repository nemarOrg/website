/**
 * The social card for a news post: 1200x630, the size every major preview
 * consumer (Slack, LinkedIn, Bluesky, X, Mastodon) crops least.
 *
 * Same dark chrome as the dataset and site cards (`og-chrome.ts`). The title
 * carries the card; the banner, when the post has one, sits framed on the
 * right, and the category is the colored marker bar the site uses for news.
 *
 * Pure string output, rasterized by `scripts/generate-news-og-images.mjs`
 * with resvg at build time. The banner arrives as a data URI because resvg
 * does not fetch.
 */
import { categoryLabel, formatNewsDate, presentationCategory } from "./news";
import { BRAND_CYAN, ELECTRODE_GOLD, INK, OG_DEFS } from "./og-chrome";
import { tspans, wrapText } from "./og-image";
import { escapeXml } from "./xml";

export const NEWS_CARD_W = 1200;
export const NEWS_CARD_H = 630;

/** Marker colors on the dark card: the dark-theme values of the `--news-*` tokens. */
const MARKER: Readonly<Record<string, string>> = {
  feature: BRAND_CYAN,
  data: "#a78bfa",
  event: ELECTRODE_GOLD,
  update: "#94a3b8",
};

export interface NewsOgModel {
  readonly title: string;
  readonly category: string;
  readonly publishedAt: string;
  /** `data:image/...;base64,...`, or null for a card without a picture. */
  readonly bannerDataUri: string | null;
}

export function renderNewsOgSvg(model: NewsOgModel, logoSvg: string): string {
  const withBanner = Boolean(model.bannerDataUri);
  // Measured against Inter Bold at these sizes: about 0.56em per character.
  const titleSize = withBanner ? 54 : 64;
  const titleLines = wrapText(model.title, withBanner ? 18 : 30, withBanner ? 4 : 3);
  const lineHeight = Math.round(titleSize * 1.14);
  const category = presentationCategory(model.category);
  const marker = MARKER[category] ?? MARKER.update;
  const date = formatNewsDate(model.publishedAt);
  const logo = logoSvg
    .replace(
      /^<svg\b/,
      `<svg x="72" y="52" width="288" height="60" color="${INK}" style="color:${INK}"`,
    )
    .replaceAll("var(--brand-accent, currentColor)", BRAND_CYAN)
    .replaceAll("var(--brand-electrode, currentColor)", ELECTRODE_GOLD);

  const picture = withBanner
    ? `<defs><clipPath id="banner"><rect x="660" y="52" width="488" height="526" rx="28"/></clipPath></defs>
  <rect x="660" y="52" width="488" height="526" rx="28" fill="#111d36"/>
  <image href="${escapeXml(model.bannerDataUri as string)}" x="660" y="52" width="488" height="526" preserveAspectRatio="xMidYMin slice" clip-path="url(#banner)"/>
  <rect x="660" y="52" width="488" height="526" rx="28" fill="none" stroke="#334155" stroke-width="2"/>`
    : `<circle cx="1030" cy="150" r="260" fill="${BRAND_CYAN}" opacity="0.10"/>
  <circle cx="1110" cy="560" r="220" fill="#603cba" opacity="0.14"/>
  <path d="M700 110 C880 40 1060 100 1180 240" fill="none" stroke="${BRAND_CYAN}" stroke-width="4" opacity="0.28"/>`;

  const titleTop = withBanner ? 262 : 250;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${NEWS_CARD_W}" height="${NEWS_CARD_H}" viewBox="0 0 ${NEWS_CARD_W} ${NEWS_CARD_H}" role="img" aria-label="${escapeXml(model.title)}, NEMAR news">
  ${OG_DEFS}
  <rect width="${NEWS_CARD_W}" height="${NEWS_CARD_H}" fill="url(#bg)"/>
  ${picture}
  ${logo}
  <rect x="72" y="166" width="6" height="40" rx="3" fill="${marker}"/>
  <text x="96" y="195" font-family="Inter" font-size="28" font-weight="700" fill="${INK}">${escapeXml(categoryLabel(category))}</text>
  ${date ? `<text x="96" y="228" font-family="Inter" font-size="22" fill="#94a3b8">${escapeXml(date)}</text>` : ""}
  <text x="72" y="${titleTop + titleSize}" font-family="Inter" font-size="${titleSize}" font-weight="700" fill="${INK}">${tspans(titleLines, 72, 0, lineHeight)}</text>
  <text x="72" y="584" font-family="Inter" font-size="24" font-weight="700" fill="${BRAND_CYAN}">nemar.org/news</text>
  <rect x="72" y="600" width="${withBanner ? 540 : 1056}" height="6" rx="3" fill="url(#accent)"/>
</svg>`;
}
