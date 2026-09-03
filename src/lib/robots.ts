import { MARKETING_BASE_URL, isProductionHost } from "./host";

/**
 * ROBOTS.TXT GROUPS ARE MOST-SPECIFIC-WINS, NOT ADDITIVE (RFC 9309 §2.2.1). A
 * crawler picks the ONE group whose `User-agent` line matches it best and
 * obeys only that group's directives; it never inherits anything from
 * `User-agent: *`. So a named group is not "extra permission on top of the
 * wildcard" -- it is a complete, separate policy, and every named crawler
 * below silently escapes any `Disallow` a future change adds to the wildcard
 * group.
 *
 * The named groups stay anyway, because they are the readable statement of
 * intent this site wants to make (OSCAR-parity: no hidden directives). The
 * safety net is a test instead: `robots.test.ts` asserts every group's
 * directive set is identical to the wildcard's, so the moment the two diverge
 * it fails loudly rather than shipping a policy that applies to some crawlers
 * and not others.
 *
 * Two groups of named tokens, kept apart on purpose -- see
 * `SEARCH_CRAWLER_TOKENS`.
 */

/**
 * AI crawler user-agent tokens allowed to browse the marketing catalog
 * (website#284 phase 1, issue #285): OpenAI's three, Anthropic's three,
 * Perplexity's two, Google's AI-training-only agent, Apple's AI-training-only
 * agent, Meta's two, then Common Crawl.
 *
 * These share ONE `Allow: /` rule group (stacked `User-agent:` lines under a
 * single set of directives is valid robots.txt syntax) rather than one group
 * per token, so adding a token here is enough -- no second block to update.
 *
 * `Perplexity-User` and `meta-externalfetcher` are the user-initiated
 * fetchers that sit beside each vendor's bulk crawler: they retrieve a page
 * because someone asked about it, and they are separate tokens, so omitting
 * them left "a person asked an assistant about this dataset" governed by a
 * different rule than the crawl.
 */
export const AI_CRAWLER_TOKENS: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "meta-externalagent",
  "meta-externalfetcher",
  "CCBot",
];

/**
 * Named crawlers that are NOT AI agents and must not be swept up by an
 * AI-motivated directive.
 *
 * `Applebot` is Apple's ordinary search crawler -- it feeds Siri, Spotlight
 * and Safari suggestions. The AI-training opt-out token for Apple is
 * `Applebot-Extended`, which lives in `AI_CRAWLER_TOKENS` above. Applebot sat
 * in that list too, so the day someone decides to `Disallow` the AI group,
 * nemar.org would also drop out of Apple's search index -- an outcome nobody
 * asked for, arrived at by editing a list that looked homogeneous. It gets
 * its own group so that edit stays local.
 */
export const SEARCH_CRAWLER_TOKENS: readonly string[] = ["Applebot"];

/**
 * Non-production body, byte-identical to the policy this route has always
 * served for staging/preview hosts. Never touch this string without
 * confirming `isNoindexHost` in `host.ts` still agrees with it -- the two
 * are two faces of the same "don't index this deploy" policy.
 */
const NON_PRODUCTION_BODY = "User-agent: *\nDisallow: /\n";

/** The directive set every group carries. One array, referenced by all three
 *  groups, so a divergence has to be a deliberate edit rather than a missed
 *  copy (and `robots.test.ts` asserts the emitted groups still agree). */
const ALLOW_ALL: readonly string[] = ["Allow: /"];

function ruleGroup(tokens: readonly string[], comment?: readonly string[]): string {
  return [...(comment ?? []), ...tokens.map((token) => `User-agent: ${token}`), ...ALLOW_ALL].join(
    "\n",
  );
}

/**
 * Builds the robots.txt body for a given request hostname.
 *
 * Production hosts (`isProductionHost`) get a short honest comment header
 * naming where the data and tooling actually live, an explicit allow-list
 * for named crawlers (OSCAR-parity requirement -- readable, no hidden
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

  const searchCrawlerGroup = ruleGroup(SEARCH_CRAWLER_TOKENS, [
    "# Apple's search crawler (Siri, Spotlight, Safari suggestions), not an",
    "# AI-training token -- that one is Applebot-Extended below. Kept in its",
    "# own group so an AI-motivated directive cannot deindex this site from",
    "# Apple search by accident.",
  ]);

  const aiCrawlerGroup = ruleGroup(AI_CRAWLER_TOKENS, ["# AI crawlers and assistant fetchers."]);

  const wildcardGroup = ruleGroup(["*"]);

  return `${[header, searchCrawlerGroup, aiCrawlerGroup, wildcardGroup].join("\n\n")}\n\nSitemap: ${MARKETING_BASE_URL}/sitemap.xml\n`;
}
