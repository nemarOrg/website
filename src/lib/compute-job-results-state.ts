/**
 * The result links a job page holds, as a pure state machine (website ADR 0030 phase E3, issue #496).
 *
 * The links are seven-day BEARER links, so what the page may hold, and when it must let go, is the
 * security-relevant part of the results panel. It lives here, not in the DOM controller, so that it is
 * tested: the controller (`compute-job-page.ts`) only calls these functions and renders what
 * `resultsUi` says. Nothing here reads a clock (`nowMs` is an argument) or touches the DOM.
 *
 *  - `holdPage`: a minted page is held, from the first row, at an offset in the whole list.
 *  - `expireIfDue`: once the links' own `expires_at` has passed the rows are DROPPED (no stale link
 *    stays in memory or in the page) and the panel says so; the cursor and offset stay, so Renew still
 *    renews the page that was shown.
 *  - `handlePageshow`: a page restored from the back-forward cache drops every held link and every
 *    status, and the "Get download links" button comes back (it is derived from the job, not from
 *    whatever the page last showed).
 *  - `markGone`: the backend said 410; the button never returns.
 */
import type { ComputeResults } from "./compute-api";
import { JOB_COPY } from "./compute-copy";
import { RESULT_ROWS_STEP, type ResultRow, linksExpired, resultsPaging } from "./compute-job-view";

export interface HeldResults {
  readonly rows: readonly ResultRow[];
  readonly response: ComputeResults;
}

export interface ResultsHold {
  readonly held: HeldResults | null;
  /** Rows of the held page that are visible. */
  readonly shown: number;
  /** Where the held page starts in the whole list (0 for the first page). */
  readonly offset: number;
  /** The cursor the held page was fetched with (null for the first page). */
  readonly after: string | null;
  /** The backend answered 410: the results are gone and no button comes back. */
  readonly gone: boolean;
  /** The one status line of the panel; null for none. */
  readonly status: string | null;
}

export const EMPTY_HOLD: ResultsHold = {
  held: null,
  shown: RESULT_ROWS_STEP,
  offset: 0,
  after: null,
  gone: false,
  status: null,
};

export function holdPage(
  hold: ResultsHold,
  held: HeldResults,
  after: string | null,
  offset: number,
): ResultsHold {
  return { ...hold, held, after, offset, shown: RESULT_ROWS_STEP, status: null };
}

export function setStatus(hold: ResultsHold, status: string | null): ResultsHold {
  return { ...hold, status };
}

export function showMore(hold: ResultsHold): ResultsHold {
  return { ...hold, shown: hold.shown + RESULT_ROWS_STEP };
}

/** The backend said the results are gone: drop everything held and never offer the button again. */
export function markGone(hold: ResultsHold, status: string): ResultsHold {
  return { ...hold, held: null, gone: true, status };
}

/**
 * Drop the rows once the links have expired, keeping the page's position so Renew still works. A hold
 * with nothing held, or links still alive, is returned unchanged.
 */
export function expireIfDue(hold: ResultsHold, nowMs: number): ResultsHold {
  if (hold.held === null || hold.held.rows.length === 0) return hold;
  if (!linksExpired(hold.held.response.expires_at, nowMs)) return hold;
  return {
    ...hold,
    held: { rows: [], response: { ...hold.held.response, files: [] } },
    status: JOB_COPY.results.linksExpired,
  };
}

/** A page restored from the back-forward cache must not bring bearer links, or a stale status, back. */
export function handlePageshow(hold: ResultsHold, persisted: boolean): ResultsHold {
  if (!persisted) return hold;
  return { ...hold, held: null, status: null, shown: RESULT_ROWS_STEP, offset: 0, after: null };
}

export interface ResultsUi {
  readonly panelHidden: boolean;
  /** "Get download links": back whenever the job can have results, nothing is held and 410 did not say gone. */
  readonly getHidden: boolean;
  readonly visibleRows: readonly ResultRow[];
  readonly status: string | null;
  readonly moreCount: number;
  readonly nextRemaining: number | null;
  readonly firstHidden: boolean;
}

/** What the results panel shows for a hold. `canGetLinks` comes from the JOB, never from what was shown last. */
export function resultsUi(hold: ResultsHold, canGetLinks: boolean): ResultsUi {
  const held = hold.held;
  const paging =
    held === null
      ? { showMore: 0, nextPageRemaining: null }
      : resultsPaging({
          held: held.rows.length,
          shown: Math.min(hold.shown, held.rows.length),
          offset: hold.offset,
          total: held.response.total,
          nextAfter: held.response.next_after,
        });
  return {
    panelHidden: held === null,
    getHidden: !canGetLinks || hold.gone || held !== null,
    visibleRows: held === null ? [] : held.rows.slice(0, hold.shown),
    status: hold.status,
    moreCount: paging.showMore,
    nextRemaining: paging.nextPageRemaining,
    firstHidden: hold.offset === 0,
  };
}
