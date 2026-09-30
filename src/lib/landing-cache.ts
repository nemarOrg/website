/**
 * The landing page's Cache-Control, decided from what its data fetches did.
 *
 *  - Hero stats not live (the catalog download threw): never cache. Caching one
 *    transient failure is what pinned the stale snapshot at the edge for a full
 *    day; `no-store` makes every request retry the live fetch until it succeeds.
 *  - Live and every highlight present: edge-cache 10 min, then refresh at least
 *    every 12 h. A returning visitor sees an at-most-12 h-stale page while a
 *    background revalidate runs.
 *  - A highlight missing, or the "most cited" card ranked from the catalog's
 *    own counts because the dashboard could not be used: only a minute. A
 *    missing highlight is not worth `no-store` (a news backend that is not
 *    deployed yet would then cost every visit three API calls), but neither
 *    the gap nor a stale-count card may sit at the edge for half a day.
 */
export const LIVE_CACHE_CONTROL = "public, max-age=60, s-maxage=600, stale-while-revalidate=43200";
export const SHORT_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
export const NO_STORE = "no-store";

export interface LandingState {
  readonly statsAvailable: boolean;
  /** A highlight is `null` when its fetch failed and its column was dropped. */
  readonly news: unknown;
  readonly cited: unknown;
  readonly latest: unknown;
  /** The card fell back to the catalog's counts (the dashboard was unusable). */
  readonly citedFromCatalog: boolean;
}

export function landingCacheControl(state: LandingState): string {
  if (!state.statsAvailable) return NO_STORE;
  const complete =
    state.news !== null && state.cited !== null && state.latest !== null && !state.citedFromCatalog;
  return complete ? LIVE_CACHE_CONTROL : SHORT_CACHE_CONTROL;
}
