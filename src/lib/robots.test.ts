import { describe, expect, it } from "vitest";
import { APP_HOST, MARKETING_BASE_URL, MARKETING_HOST } from "./host";
import { AI_CRAWLER_TOKENS, robotsBody } from "./robots";

const PRODUCTION_HOSTS = [APP_HOST, MARKETING_HOST, "ww2.nemar.org"];
const NON_PRODUCTION_HOSTS = ["test.nemar.org", "fa9dbfa0.nemar-website.pages.dev", "localhost"];

describe("robotsBody on production hosts", () => {
  it.each(PRODUCTION_HOSTS)("lists every AI crawler token exactly once on %s", (host) => {
    const body = robotsBody(host);
    const agentLines = body.match(/^User-agent: .+$/gm) ?? [];
    for (const token of AI_CRAWLER_TOKENS) {
      const matches = agentLines.filter((line) => line === `User-agent: ${token}`);
      expect(matches).toHaveLength(1);
    }
  });

  it.each(PRODUCTION_HOSTS)("keeps the crawler tokens in the prescribed order on %s", (host) => {
    const body = robotsBody(host);
    const agentLines = (body.match(/^User-agent: .+$/gm) ?? []).map((line) =>
      line.replace("User-agent: ", ""),
    );
    // Only the named tokens, in order, excluding the trailing wildcard group.
    const namedTokens = agentLines.filter((token) => token !== "*");
    expect(namedTokens).toEqual(AI_CRAWLER_TOKENS);
  });

  it.each(PRODUCTION_HOSTS)("shares a single Allow: / for the AI crawler block on %s", (host) => {
    const body = robotsBody(host);
    const lastToken = AI_CRAWLER_TOKENS[AI_CRAWLER_TOKENS.length - 1];
    expect(body).toContain(`User-agent: ${lastToken}\nAllow: /`);
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

  it.each(NON_PRODUCTION_HOSTS)("never mentions AI crawler tokens on %s", (host) => {
    const body = robotsBody(host);
    for (const token of AI_CRAWLER_TOKENS) {
      expect(body).not.toContain(token);
    }
  });

  it.each(NON_PRODUCTION_HOSTS)("never emits a Sitemap directive on %s", (host) => {
    expect(robotsBody(host)).not.toContain("Sitemap:");
  });
});
