import { MARKETING_BASE_URL, isProductionHost } from "./host";

/**
 * AI crawler user-agent tokens allowed to browse the marketing catalog
 * (website#284 phase 1, issue #285). Order matches the research memo:
 * OpenAI's two crawlers, Anthropic's three, Perplexity, Google's
 * AI-training-only agent, Apple's two, Meta's, then Common Crawl.
 *
 * These share ONE `Allow: /` rule group (stacked `User-agent:` lines under a
 * single set of directives is valid robots.txt syntax) rather than one group
 * per token, so adding a token here is enough -- no second block to update.
 */
export const AI_CRAWLER_TOKENS: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "meta-externalagent",
  "CCBot",
];

/**
 * Non-production body, byte-identical to the policy this route has always
 * served for staging/preview hosts. Never touch this string without
 * confirming `isNoindexHost` in `host.ts` still agrees with it -- the two
 * are two faces of the same "don't index this deploy" policy.
 */
const NON_PRODUCTION_BODY = "User-agent: *\nDisallow: /\n";

/**
 * Builds the robots.txt body for a given request hostname.
 *
 * Production hosts (`isProductionHost`) get a short honest comment header
 * naming where the data and tooling actually live, an explicit allow-list
 * for named AI crawlers (OSCAR-parity requirement -- readable, no hidden
 * directives), a general `User-agent: *` allow, and a Sitemap pointer.
 * Every other host keeps today's blanket disallow so staging and preview
 * deploys stay out of search entirely.
 */
export function robotsBody(hostname: string): string {
  if (!isProductionHost(hostname)) return NON_PRODUCTION_BODY;

  const header = [
    "# NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
    "# Dataset files and metadata are also served at data.nemar.org, and",
    "# datasets can be fetched programmatically with the nemar CLI:",
    "# https://github.com/nemarOrg/nemar-cli",
  ].join("\n");

  const aiCrawlerGroup = [
    ...AI_CRAWLER_TOKENS.map((token) => `User-agent: ${token}`),
    "Allow: /",
  ].join("\n");

  const wildcardGroup = ["User-agent: *", "Allow: /"].join("\n");

  return `${[header, aiCrawlerGroup, wildcardGroup].join("\n\n")}\n\nSitemap: ${MARKETING_BASE_URL}/sitemap.xml\n`;
}
