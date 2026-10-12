import { applyClientFilters, filterStateToSearchFilters, hasClientOnlyFilters } from "./filters";
import type { FilterState } from "./filters";
import type { DatasetSearchResponse, SearchFilters, SearchResult } from "./types";

/**
 * The most hits `GET /datasets/search` returns per call (it clamps `limit` to
 * this). The candidate window when a filter that only the page can apply must
 * prune the ranked list before it is paged locally.
 */
export const SEARCH_WINDOW = 100;

export type SearchPlan =
  | { mode: "window"; params: { limit: number; filters: SearchFilters } }
  | { mode: "server"; params: { limit: number; offset: number; filters: SearchFilters } };

/**
 * Which of the two ways to read a search: one best-100 window that the page
 * filters and pages itself, or the endpoint's own paging (and counting).
 *
 * A participant range or 2+ modalities prune after the server has counted and
 * paged, so they need the window. Channel, density, and electrode-system filters
 * do not count while searching: search rows carry no channel facts, so they
 * cannot be evaluated, and the sidebar disables them.
 */
export function planSearch(state: FilterState): SearchPlan {
  const filters = filterStateToSearchFilters(state);
  if (hasClientOnlyFilters(state, { searching: true })) {
    return { mode: "window", params: { limit: SEARCH_WINDOW, filters } };
  }
  return {
    mode: "server",
    params: { limit: state.pageSize, offset: (state.page - 1) * state.pageSize, filters },
  };
}

export interface SearchPage {
  slice: SearchResult[];
  /** The count to show. */
  totalReturned: number;
  /** How far the pager reaches. */
  pageableTotal: number;
  /** Said after the count when the list is a window onto more matches; empty otherwise. */
  countNote: string;
}

/**
 * Turn the endpoint's answer into what the page shows: the rows, the real
 * count, how far the pager reaches, and the note.
 *
 * Over the window the filtering is the page's, and the whole window is in hand,
 * so the modality check can be exact: the API's `modality` is a substring match
 * that lets an iEEG-only dataset through for EEG. When the endpoint pages, the
 * numbers are its own, and past `candidate_ceiling` it returns empty pages though
 * `count` is truthful, so the pager stops there.
 */
export function pageSearch(
  plan: SearchPlan,
  res: DatasetSearchResponse,
  state: FilterState,
): SearchPage {
  if (plan.mode === "window") {
    const ranked = applyClientFilters(res.results, state, { allModalitiesClientSide: true });
    return {
      slice: ranked.slice((state.page - 1) * state.pageSize, state.page * state.pageSize),
      totalReturned: ranked.length,
      pageableTotal: ranked.length,
      countNote:
        res.count > res.results.length
          ? `filtered from the ${res.results.length} best matches`
          : "",
    };
  }
  const pageableTotal = Math.min(res.count, res.candidate_ceiling ?? res.count);
  return {
    slice: res.results,
    totalReturned: res.count,
    pageableTotal,
    countNote: pageableTotal < res.count ? `showing the best ${pageableTotal}` : "",
  };
}
