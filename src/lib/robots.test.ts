import { describe, expect, it } from "vitest";
import { APP_HOST, MARKETING_BASE_URL, MARKETING_HOST } from "./host";
import { AI_CRAWLER_TOKENS, SEARCH_CRAWLER_TOKENS, robotsBody } from "./robots";

const PRODUCTION_HOSTS = [APP_HOST, MARKETING_HOST, "ww2.nemar.org"];
const NON_PRODUCTION_HOSTS = ["test.nemar.org", "fa9dbfa0.nemar-website.pages.dev", "localhost"];

/** Every named token the body is expected to carry, in emission order. */
const NAMED_TOKENS = [...SEARCH_CRAWLER_TOKENS, ...AI_CRAWLER_TOKENS];

interface RobotsGroup {
  agents: string[];
  directives: string[];
}

/**
 * Parse a robots.txt body into RFC 9309 groups: consecutive `User-agent`
 * lines, then the directives that apply to all of them. A `User-agent` line
 * following a directive starts a new group. `Sitemap` is a non-group record
 * and is skipped; comment-only lines carry nothing.
 *
 * Written out rather than asserted with substring matches because the thing
 * being checked IS the grouping -- `body.includes("Allow: /")` cannot tell
 * which group the directive landed in, and that is the whole question.
 */
function parseGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") continue;
    if (field === "user-agent") {
      if (!current || current.directives.length > 0) {
        current = { agents: [], directives: [] };
        groups.push(current);
      }
      current.agents.push(value);
      continue;
    }
    if (current) current.directives.push(line);
  }
  return groups;
}

describe("robotsBody on production hosts", () => {
  it.each(PRODUCTION_HOSTS)("lists every named crawler token exactly once on %s", (host) => {
    const body = robotsBody(host);
    const agentLines = body.match(/^User-agent: .+$/gm) ?? [];
    for (const token of NAMED_TOKENS) {
      const matches = agentLines.filter((line) => line === `User-agent: ${token}`);
      expect(matches, token).toHaveLength(1);
    }
  });

  it.each(PRODUCTION_HOSTS)("keeps the crawler tokens in the prescribed order on %s", (host) => {
    const body = robotsBody(host);
    const agentLines = (body.match(/^User-agent: .+$/gm) ?? []).map((line) =>
      line.replace("User-agent: ", ""),
    );
    // Only the named tokens, in order, excluding the trailing wildcard group.
    const namedTokens = agentLines.filter((token) => token !== "*");
    expect(namedTokens).toEqual(NAMED_TOKENS);
  });

  it.each(PRODUCTION_HOSTS)("shares a single Allow: / for the AI crawler block on %s", (host) => {
    const body = robotsBody(host);
    // Assert the WHOLE block is contiguous, not just that the last token is
    // followed by `Allow: /`. Checking only the tail passes even when the
    // group has been split in two, because both halves would carry the same
    // `Allow: /` today -- so the split is invisible until some crawler is
    // given a directive of its own, at which point the tokens above the
    // split would silently be governed by the wrong group.
    const contiguousBlock = [
      ...AI_CRAWLER_TOKENS.map((token) => `User-agent: ${token}`),
      "Allow: /",
    ].join("\n");
    expect(body).toContain(contiguousBlock);
  });

  it.each(PRODUCTION_HOSTS)("emits exactly three rule groups on %s", (host) => {
    const body = robotsBody(host);
    // One `Allow: /` for Applebot, one for the AI crawlers, one for the
    // wildcard. A fourth would mean a block fragmented; see the contiguity
    // test above for why that is not self-evident from the tokens alone.
    expect(body.match(/^Allow: \/$/gm) ?? []).toHaveLength(3);
    expect(parseGroups(body)).toHaveLength(3);
  });

  it.each(PRODUCTION_HOSTS)(
    "gives every named group the wildcard group's exact directive set on %s",
    (host) => {
      // RFC 9309 §2.2.1: a crawler obeys ONLY its most specific matching
      // group and inherits nothing from `User-agent: *`. So every named token
      // here silently escapes any future `Disallow` added to the wildcard
      // group. The named blocks are kept as a readable statement of intent;
      // this is the guard that makes the divergence fail loudly instead
      // (website#294 fix 9).
      const groups = parseGroups(robotsBody(host));
      const wildcard = groups.find((g) => g.agents.includes("*"));
      expect(wildcard).toBeDefined();
      expect(wildcard?.directives.length).toBeGreaterThan(0);
      const named = groups.filter((g) => !g.agents.includes("*"));
      expect(named.length).toBeGreaterThan(0);
      for (const group of named) {
        expect(new Set(group.directives), group.agents.join(", ")).toEqual(
          new Set(wildcard?.directives),
        );
      }
    },
  );

  it.each(PRODUCTION_HOSTS)("keeps Applebot in a group of its own on %s", (host) => {
    // Applebot is Apple's SEARCH crawler; Applebot-Extended is the
    // AI-training token. Sharing a group with the AI tokens means an
    // AI-motivated `Disallow` would deindex the site from Apple search
    // (website#294 fix 9).
    const groups = parseGroups(robotsBody(host));
    const appleGroup = groups.find((g) => g.agents.includes("Applebot"));
    expect(appleGroup?.agents).toEqual(["Applebot"]);
    const aiGroup = groups.find((g) => g.agents.includes("Applebot-Extended"));
    expect(aiGroup?.agents).not.toContain("Applebot");
    expect(AI_CRAWLER_TOKENS).not.toContain("Applebot");
  });

  it.each(PRODUCTION_HOSTS)("allows the user-initiated assistant fetchers on %s", (host) => {
    // A person asking an assistant about a dataset is a separate token from
    // the vendor's bulk crawl, so it needs listing separately or it falls to
    // a different rule (website#294 fix 9).
    const groups = parseGroups(robotsBody(host));
    const aiGroup = groups.find((g) => g.agents.includes("GPTBot"));
    expect(aiGroup?.agents).toContain("Perplexity-User");
    expect(aiGroup?.agents).toContain("meta-externalfetcher");
  });

  it.each(PRODUCTION_HOSTS)("still allows everything under the wildcard on %s", (host) => {
    const body = robotsBody(host);
    expect(body).toContain("User-agent: *\nAllow: /");
  });

  it.each(PRODUCTION_HOSTS)(
    "points the Sitemap directive at the marketing base URL on %s",
    (host) => {
      const body = robotsBody(host);
      expect(body).toContain(`Sitemap: ${MARKETING_BASE_URL}/sitemap.xml`);
    },
  );

  it.each(PRODUCTION_HOSTS)(
    "opens with a readable comment header naming data.nemar.org and the CLI on %s",
    (host) => {
      const body = robotsBody(host);
      const commentLines = body.split("\n").filter((line) => line.startsWith("#"));
      expect(commentLines.length).toBeGreaterThan(0);
      expect(commentLines.join("\n")).toContain("data.nemar.org");
      expect(commentLines.join("\n")).toContain("nemar-cli");
    },
  );

  it("never emits a Disallow directive on a production host", () => {
    expect(robotsBody(APP_HOST)).not.toContain("Disallow");
  });
});

describe("robotsBody on non-production hosts", () => {
  it.each(NON_PRODUCTION_HOSTS)("returns the exact legacy disallow-all body for %s", (host) => {
    expect(robotsBody(host)).toBe("User-agent: *\nDisallow: /\n");
  });

  it.each(NON_PRODUCTION_HOSTS)("never mentions a named crawler token on %s", (host) => {
    const body = robotsBody(host);
    for (const token of NAMED_TOKENS) {
      expect(body, token).not.toContain(token);
    }
  });

  it.each(NON_PRODUCTION_HOSTS)("never emits a Sitemap directive on %s", (host) => {
    expect(robotsBody(host)).not.toContain("Sitemap:");
  });
});
