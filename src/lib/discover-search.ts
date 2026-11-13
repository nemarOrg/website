import {
  applyClientFilters,
  filterStateToSearchFilters,
  filterStateToURL,
  hasClientOnlyFilters,
} from "./filters";
import type { FilterState } from "./filters";
import type { DatasetSearchResponse, SearchFilters, SearchResult } from "./types";

/**
 * The most hits `GET /datasets/search` returns per call (it clamps `limit` to
 * this). The candidate window when a filter that only the page can apply must
 * prune the ranked list before it is paged locally.
 */
export const SEARCH_WINDOW = 100;

export type SearchPlan =
  | { mode: "window"; params: { limit: number; filters: SearchFilters }; overviewRows: number }
  | {
      mode: "server";
      params: { limit: number; offset: number; filters: SearchFilters };
      overviewRows: number;
    };

export interface SearchPlanOptions {
  /**
   * How many of the best matches the AI overview reads (website#531). On page 1
   * the endpoint is asked for at least this many, though the page still shows
   * `pageSize` cards. 0, the default, when the page has no overview.
   */
  overviewRows?: number;
}

/**
 * Which of the two ways to read a search: one best-100 window that the page
 * filters and pages itself, or the endpoint's own paging (and counting).
 *
 * A participant range or 2+ modalities prune after the server has counted and
 * paged, so they need the window. Channel, density, and electrode-system filters
 * do not count while searching: search rows carry no channel facts, so they
 * cannot be evaluated, and the sidebar disables them.
 *
 * The overview reads page 1 only, so `overviewRows` is 0 on any other page. The
 * window already holds the best 100, so only the endpoint's own paging asks for
 * more rows than the page shows.
 */
export function planSearch(state: FilterState, options: SearchPlanOptions = {}): SearchPlan {
  const filters = filterStateToSearchFilters(state);
  const asked = options.overviewRows ?? 0;
  const wanted = Number.isFinite(asked)
    ? Math.min(SEARCH_WINDOW, Math.max(0, Math.floor(asked)))
    : 0;
  const overviewRows = state.page === 1 ? wanted : 0;
  if (hasClientOnlyFilters(state, { searching: true })) {
    return { mode: "window", params: { limit: SEARCH_WINDOW, filters }, overviewRows };
  }
  return {
    mode: "server",
    params: {
      limit: Math.max(state.pageSize, overviewRows),
      offset: (state.page - 1) * state.pageSize,
      filters,
    },
    overviewRows,
  };
}

export interface SearchPage {
  /** The rows the page shows. */
  slice: SearchResult[];
  /** The best `plan.overviewRows` matches in ranking order, for the AI overview; empty when the
   *  plan asked for none. On page 1 they begin with the page's own rows. */
  overviewHits: SearchResult[];
  /** The count to show. */
  totalReturned: number;
  /** How far the pager reaches. */
  pageableTotal: number;
  /** Said after the count when the list is a window onto more matches; empty otherwise. */
  countNote: string;
  /** The words the API searched instead of the reader's, or null. */
  correction: CorrectionNotice | null;
}

/** What the "Showing results for ..." line needs. */
export interface CorrectionNotice {
  /** The words that were searched. */
  corrected: string;
  /** A /discover link that searches the reader's own words, or null when no such
   *  link can work: an `exact` search whose answer was still corrected, because
   *  the API predates `correct=0` (nemar-cli#2132). The page then says what was
   *  searched without offering a link that would reload the same results. */
  originalHref: string | null;
}

/**
 * The words as the API compares them: spaces collapsed, case and accents folded.
 * The API folds accents before it corrects, so a query that differs from its own
 * `corrected_query` only by accents ("café" -> "cafe") was not corrected at all.
 */
function normalizeWords(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}

/**
 * Whether to say "Showing results for ..." and how to get back to the reader's
 * own words. Null when the answer carries no `corrected_query`, when it is not a
 * string or is blank, or when it says nothing the query did not (the same words
 * after trimming, collapsing spaces and folding case and accents).
 *
 * The link is /discover with the current filters (not the page: the reader's
 * words are a different result list), `q` set to the words as typed, and
 * `exact=1`, which the API reads as `correct=0`. Without it the API would correct
 * the same words again and the link would reload the same results. In an `exact`
 * search the reader has already chosen their words; a correction that still comes
 * back means the API ignored the parameter, so the line is kept (the page must not
 * claim words it did not search) but with no link.
 */
export function correctionNotice(
  state: FilterState,
  res: Pick<DatasetSearchResponse, "corrected_query">,
): CorrectionNotice | null {
  const corrected = res.corrected_query;
  if (typeof corrected !== "string" || corrected.trim() === "") return null;
  if (normalizeWords(corrected) === normalizeWords(state.q)) return null;
  if (state.exact) return { corrected: corrected.trim(), originalHref: null };
  const params = filterStateToURL({ ...state, page: 1, exact: true });
  return { corrected: corrected.trim(), originalHref: `/discover?${params.toString()}` };
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
  const correction = correctionNotice(state, res);
  if (plan.mode === "window") {
    const ranked = applyClientFilters(res.results, state, { allModalitiesClientSide: true });
    return {
      slice: ranked.slice((state.page - 1) * state.pageSize, state.page * state.pageSize),
      overviewHits: ranked.slice(0, plan.overviewRows),
      totalReturned: ranked.length,
      pageableTotal: ranked.length,
      countNote:
        res.count > res.results.length
          ? `filtered from the ${res.results.length} best matches`
          : "",
      correction,
    };
  }
  const pageableTotal = Math.min(res.count, res.candidate_ceiling ?? res.count);
  return {
    // The endpoint may have been asked for more rows than the page shows (`overviewRows`).
    slice: res.results.slice(0, state.pageSize),
    overviewHits: res.results.slice(0, plan.overviewRows),
    totalReturned: res.count,
    pageableTotal,
    countNote: pageableTotal < res.count ? `showing the best ${pageableTotal}` : "",
    correction,
  };
}
