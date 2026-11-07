/**
 * What the job page holds of the result links, and when it must let go (phase E3, website#496). The
 * links are the real ones the backend minted (`test/fixtures/compute/results.json`). These are the rules
 * a security review asked to be tested rather than read: nothing stale stays after the links expire,
 * nothing comes back from the back-forward cache, and the button returns after a restore.
 */
import { describe, expect, it } from "vitest";
import results from "../../test/fixtures/compute/results.json";
import { parseComputeResults } from "./compute-api";
import {
  EMPTY_HOLD,
  type ResultsHold,
  expireIfDue,
  handlePageshow,
  holdPage,
  markGone,
  resultsUi,
  setStatus,
  showMore,
} from "./compute-job-results-state";
import { RESULT_ROWS_STEP, resultRow } from "./compute-job-view";

const response = parseComputeResults(results.get.body);
const expiresMs = Date.parse(response.expires_at);
const held = { rows: response.files.map(resultRow), response };
const withLinks = (): ResultsHold => holdPage(EMPTY_HOLD, held, null, 0);

describe("holding a page", () => {
  it("shows the panel and the rows, and hides the get button", () => {
    const ui = resultsUi(withLinks(), true);
    expect(ui.panelHidden).toBe(false);
    expect(ui.getHidden).toBe(true);
    expect(ui.visibleRows.length).toBe(3);
    expect(ui.visibleRows.every((r) => r.href !== null)).toBe(true);
  });

  it("shows the get button and no panel when nothing is held", () => {
    const ui = resultsUi(EMPTY_HOLD, true);
    expect([ui.panelHidden, ui.getHidden, ui.visibleRows.length]).toEqual([true, false, 0]);
  });

  it("never offers the get button for a job that cannot have results", () => {
    expect(resultsUi(EMPTY_HOLD, false).getHidden).toBe(true);
  });

  it("shows 100 rows at first and adds 100 a press", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ ...held.rows[0], path: `f${i}` }));
    let hold = holdPage(EMPTY_HOLD, { rows, response: { ...response, total: 250 } }, null, 0);
    expect(resultsUi(hold, true).visibleRows.length).toBe(RESULT_ROWS_STEP);
    expect(resultsUi(hold, true).moreCount).toBe(100);
    hold = showMore(showMore(hold));
    const ui = resultsUi(hold, true);
    expect([ui.visibleRows.length, ui.moreCount]).toEqual([250, 0]);
  });
});

describe("expiry of the links", () => {
  it("keeps the links while they are alive, up to and including the instant", () => {
    const hold = withLinks();
    expect(expireIfDue(hold, expiresMs - 1)).toBe(hold);
    // `linksExpired` counts the instant itself as expired: a link is not kept to its last moment.
    expect(expireIfDue(hold, expiresMs).held?.rows.length).toBe(0);
  });

  it("drops every row after expires_at, says so, and keeps Renew's place", () => {
    const hold = holdPage(EMPTY_HOLD, held, "out/x", 1000);
    const after = expireIfDue(hold, expiresMs + 1);
    const ui = resultsUi(after, true);
    expect(ui.visibleRows).toEqual([]);
    expect(ui.status).toBe("These links have expired. Renew them.");
    // The panel stays (its Renew button is in it) and the position is kept.
    expect(ui.panelHidden).toBe(false);
    expect([after.after, after.offset]).toEqual(["out/x", 1000]);
    // No link survives in memory either.
    expect(JSON.stringify(after)).not.toContain("X-Amz");
    expect(after.held?.response.files).toEqual([]);
  });

  it("does nothing when nothing is held, or the rows are already gone", () => {
    expect(expireIfDue(EMPTY_HOLD, expiresMs + 1)).toBe(EMPTY_HOLD);
    const gone = expireIfDue(withLinks(), expiresMs + 1);
    expect(expireIfDue(gone, expiresMs + 99)).toBe(gone);
  });

  it("treats a links date it cannot read as expired", () => {
    const bad = holdPage(
      EMPTY_HOLD,
      { rows: held.rows, response: { ...response, expires_at: "garbage" } },
      null,
      0,
    );
    expect(expireIfDue(bad, 0).held?.rows.length).toBe(0);
  });
});

describe("a page restored from the back-forward cache", () => {
  it("drops every held link, the status and the position, and brings the button back", () => {
    const shown = setStatus(holdPage(EMPTY_HOLD, held, "cursor", 1000), "Getting the links");
    expect(resultsUi(shown, true).getHidden).toBe(true);
    const restored = handlePageshow(shown, true);
    const ui = resultsUi(restored, true);
    expect(ui.visibleRows).toEqual([]);
    expect(ui.panelHidden).toBe(true);
    expect(ui.status).toBeNull();
    // The regression: the button must come back for a finished job, derived from the job's own state.
    expect(ui.getHidden).toBe(false);
    expect([restored.held, restored.after, restored.offset]).toEqual([null, null, 0]);
    expect(JSON.stringify(restored)).not.toContain("X-Amz");
  });

  it("leaves an ordinary pageshow alone", () => {
    const hold = withLinks();
    expect(handlePageshow(hold, false)).toBe(hold);
  });

  it("does not bring the button back after the backend said 410", () => {
    const gone = markGone(withLinks(), "The results of this job were deleted.");
    const restored = handlePageshow(gone, true);
    expect(resultsUi(restored, true).getHidden).toBe(true);
  });

  it("does not bring the button back for a job that cannot have results", () => {
    expect(resultsUi(handlePageshow(withLinks(), true), false).getHidden).toBe(true);
  });
});

describe("410", () => {
  it("drops the links, keeps the sentence and removes the button for good", () => {
    const gone = markGone(withLinks(), "deleted");
    const ui = resultsUi(gone, true);
    expect([ui.panelHidden, ui.getHidden, ui.status, ui.visibleRows.length]).toEqual([
      true,
      true,
      "deleted",
      0,
    ]);
  });
});
