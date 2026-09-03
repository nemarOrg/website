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

  it.each(PRODUCTION_HOSTS)("emits exactly two rule groups on %s", (host) => {
    const body = robotsBody(host);
    // One `Allow: /` for the named crawlers, one for the wildcard. A third
    // would mean the named block fragmented; see the contiguity test above
    // for why that is not self-evident from the tokens alone.
    expect(body.match(/^Allow: \/$/gm) ?? []).toHaveLength(2);
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
