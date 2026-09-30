import { describe, expect, it } from "vitest";
import {
  LIVE_CACHE_CONTROL,
  type LandingState,
  NO_STORE,
  SHORT_CACHE_CONTROL,
  landingCacheControl,
} from "./landing-cache";

const whole: LandingState = {
  statsAvailable: true,
  news: [],
  cited: [],
  latest: [],
  citedFromCatalog: false,
};

describe("landingCacheControl", () => {
  it("caches a whole, live page at the edge for ten minutes and revalidates for twelve hours", () => {
    expect(landingCacheControl(whole)).toBe(LIVE_CACHE_CONTROL);
    expect(LIVE_CACHE_CONTROL).toContain("s-maxage=600");
    expect(LIVE_CACHE_CONTROL).toContain("stale-while-revalidate=43200");
  });

  it("counts an empty highlight as present: it loaded, there was just nothing to show", () => {
    expect(landingCacheControl({ ...whole, cited: [], latest: [], news: [] })).toBe(
      LIVE_CACHE_CONTROL,
    );
  });

  it("never stores a page whose hero stats are the fallback snapshot", () => {
    expect(landingCacheControl({ ...whole, statsAvailable: false })).toBe(NO_STORE);
    // Whatever else is going on: a dropped highlight does not soften no-store.
    expect(landingCacheControl({ ...whole, statsAvailable: false, news: null })).toBe(NO_STORE);
  });

  it.each(["news", "cited", "latest"] as const)(
    "keeps a page missing its %s highlight for a minute",
    (name) => {
      expect(landingCacheControl({ ...whole, [name]: null })).toBe(SHORT_CACHE_CONTROL);
      expect(SHORT_CACHE_CONTROL).toContain("s-maxage=60");
      expect(SHORT_CACHE_CONTROL).not.toContain("stale-while-revalidate");
    },
  );

  it("keeps a card ranked from the catalog's own counts for a minute, not half a day", () => {
    expect(landingCacheControl({ ...whole, citedFromCatalog: true })).toBe(SHORT_CACHE_CONTROL);
  });
});
