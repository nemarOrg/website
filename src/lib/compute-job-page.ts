/**
 * The browser controller of `/compute/jobs/<id>` (website ADR 0030 phase E3, issue #496): live refresh,
 * the log, the result links and the cancel. Every word and rule comes from the pure modules
 * (`compute-job-view.ts`, `compute-logs.ts`, `compute-copy.ts`); this file only reads the page's
 * `data-*` hooks, calls the client (`compute-api.ts`) and writes the answer back as text nodes through
 * `compute-job-dom.ts`. Nothing here writes markup.
 *
 * Rules this file keeps (each has a source scan in `test/compute-job-ui.test.ts`):
 *  - A result link is minted only by a click on "Get download links" or "Renew links", lives only in the
 *    DOM of this page, and is never written to storage, the URL, a log, the clipboard or an attribute
 *    other than `href`. `pageshow` with a persisted page clears the list.
 *  - Log text is never logged or counted in the console.
 *  - Timing comes from `compute-job-live.ts`, the one module that reads a clock.
 */
import {
  ComputeApiError,
  type ComputeJobRead,
  type ComputeResults,
  cancelComputeJob,
  getComputeJob,
  getComputeLogs,
  getComputeMe,
  getComputeResults,
  renewComputeResults,
} from "./compute-api";
import { JOB_COPY } from "./compute-copy";
import { detailRows, el, failureNodes, resultRowElement, timelineItems } from "./compute-job-dom";
import { createPoller, nowMs } from "./compute-job-live";
import {
  RESULT_ROWS_STEP,
  type ResultRow,
  cancelOutcome,
  jobDetailView,
  linksExpired,
  linksOutliveFiles,
  logFailure,
  resultRow,
  resultsFailure,
  resultsPaging,
  resultsPanelView,
} from "./compute-job-view";
import { badgeElement } from "./compute-jobs-dom";
import { LOG_EARLIER_STEP, LOG_TAIL_DEFAULT, logWindow, prepareLog } from "./compute-logs";

const LOG_REFRESH_COOLDOWN_MS = 10_000;

function must<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`the job page is missing ${selector}`);
  return node;
}

function setText(node: Element, text: string): void {
  node.textContent = text;
}

/** Add "(your time: ...)" to a line that carries the instant it names in `data-until-iso`. */
function addLocalTime(node: HTMLElement): void {
  const iso = node.dataset.untilIso;
  const when = iso ? new Date(iso) : null;
  if (when && !Number.isNaN(when.getTime())) {
    node.textContent = `${node.textContent ?? ""} (${JOB_COPY.results.yourTime}: ${when.toLocaleString()})`;
  }
}

export function initJobPage(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const jobId = root.dataset.jobId ?? "";
  const source = root.dataset.source ?? "";
  let resultsDays: number | null = root.dataset.resultsDays
    ? Number(root.dataset.resultsDays)
    : null;
  let current: ComputeJobRead | null = null;
  let lastState = root.dataset.state ?? "";
  let lastCancel = root.dataset.cancelRequested === "true";
  let ended = false;
  let readResultsDays = resultsDays !== null;

  const announce = must<HTMLElement>(root, "[data-job-announce]");
  const paused = must<HTMLElement>(root, "[data-job-paused]");
  const pausedText = must<HTMLElement>(root, "[data-job-paused-text]");
  const pausedSignIn = must<HTMLAnchorElement>(root, "[data-job-signin]");
  const pausedButton = must<HTMLButtonElement>(root, "[data-job-resume]");

  // --- applying a job ------------------------------------------------------------------------------

  function applyJob(read: ComputeJobRead): { changed: boolean } {
    const view = jobDetailView(read);
    const changed =
      view.state !== lastState ||
      view.cancelRequested !== lastCancel ||
      current === null ||
      current.job.charged_milli !== read.job.charged_milli ||
      current.stale !== read.stale;
    const stateChanged = view.state !== lastState;
    current = read;
    root.dataset.state = view.state;
    must<HTMLElement>(root, "[data-job-badge]").replaceChildren(badgeElement(doc, view.badge));
    must<HTMLElement>(root, "[data-job-cancel-note]").hidden = !view.cancelRequested;
    must<HTMLElement>(root, "[data-job-stale]").hidden = !view.stale;
    const unreported = must<HTMLElement>(root, "[data-job-unreported]");
    unreported.hidden = view.unreportedNote === null;
    if (view.unreportedNote !== null) setText(unreported, view.unreportedNote);
    must<HTMLElement>(root, "[data-job-timeline]").replaceChildren(
      ...timelineItems(doc, view.timeline),
    );
    const unknown = must<HTMLElement>(root, "[data-job-unknown-state]");
    unknown.hidden = view.timeline.unknownState === null;
    if (view.timeline.unknownState !== null) {
      setText(unknown, `${JOB_COPY.timeline.stateLine}: ${view.timeline.unknownState}`);
    }
    must<HTMLElement>(root, "[data-job-rows]").replaceChildren(
      ...detailRows(doc, view.rows, {
        label: JOB_COPY.rows.charged,
        text: view.charge.text,
        kind: view.charge.kind,
      }),
    );
    const failure = must<HTMLElement>(root, "[data-job-failure]");
    failure.hidden = view.failure === null;
    failure
      .querySelector("[data-job-failure-body]")
      ?.replaceChildren(...(view.failure ? failureNodes(doc, view.failure) : []));
    must<HTMLElement>(root, "[data-cancel-block]").hidden = !view.canCancel;
    if (stateChanged || view.cancelRequested !== lastCancel) {
      setText(
        announce,
        `${JOB_COPY.live.announce(view.badge.label)}${view.cancelRequested ? ` ${JOB_COPY.cancel.requested}.` : ""}`,
      );
    }
    if (view.terminal && !ended) {
      ended = true;
      if (!must<HTMLElement>(root, "[data-logs-region]").hidden) {
        const note = must<HTMLElement>(root, "[data-logs-ended-note]");
        note.hidden = false;
      }
    }
    lastState = view.state;
    lastCancel = view.cancelRequested;
    void renderResultsPanel(read);
    return { changed };
  }

  // --- results panel -------------------------------------------------------------------------------

  async function renderResultsPanel(read: ComputeJobRead): Promise<void> {
    if (read.job.state === "finished" && !readResultsDays) {
      readResultsDays = true;
      try {
        resultsDays = (await getComputeMe()).resultsDays;
      } catch {
        resultsDays = null; // the line then reads "kept for a limited time"; never blocks the page
      }
    }
    const panel = resultsPanelView({
      state: read.job.state,
      endedAt: read.job.ended_at,
      resultsDays,
      nowMs: nowMs(),
    });
    const headline = must<HTMLElement>(root, "[data-results-headline]");
    setText(headline, panel.headline);
    if (panel.window.untilIso) headline.dataset.untilIso = panel.window.untilIso;
    else delete headline.dataset.untilIso;
    if (panel.window.untilMs !== null) root.dataset.untilMs = String(panel.window.untilMs);
    else delete root.dataset.untilMs;
    addLocalTime(headline);
    // Do not offer the button again once a 410 settled it.
    must<HTMLButtonElement>(root, "[data-results-get]").hidden =
      !panel.canGetLinks || resultsGone || heldResults !== null;
  }

  // --- the poller ----------------------------------------------------------------------------------

  const poller = createPoller({
    async read(signal) {
      const read = await getComputeJob(jobId, { signal });
      return { state: read.job.state, ...applyJob(read) };
    },
    fatal(err) {
      if (err instanceof ComputeApiError) {
        if (err.code === "job_not_found") return "not_found";
        if (err.kind === "session") return "session";
      }
      return undefined;
    },
    onStop(reason) {
      if (reason === "terminal" || reason === "unknown_state") {
        paused.hidden = true;
        return;
      }
      paused.hidden = false;
      pausedSignIn.hidden = reason !== "session";
      pausedButton.hidden = reason === "session" || reason === "not_found";
      pausedButton.textContent =
        reason === "hard_stop" ? JOB_COPY.live.resume : JOB_COPY.live.refresh;
      setText(
        pausedText,
        reason === "session"
          ? JOB_COPY.live.sessionEnded
          : reason === "not_found"
            ? JOB_COPY.notFoundBody
            : JOB_COPY.live.paused,
      );
    },
  });
  pausedButton.addEventListener("click", () => {
    paused.hidden = true;
    // One read now, then the schedule from the start.
    void getComputeJob(jobId)
      .then((read) => {
        applyJob(read);
        if (jobDetailView(read).live) poller.start();
      })
      .catch(() => {
        paused.hidden = false;
      });
  });

  // --- logs ----------------------------------------------------------------------------------------

  const logsShow = must<HTMLButtonElement>(root, "[data-logs-show]");
  const logsStatus = must<HTMLElement>(root, "[data-logs-status]");
  const logsRegion = must<HTMLElement>(root, "[data-logs-region]");
  const logsPre = must<HTMLElement>(root, "[data-logs-pre]");
  const logsCount = must<HTMLElement>(root, "[data-logs-count]");
  const logsEarlier = must<HTMLButtonElement>(root, "[data-logs-earlier]");
  const logsTruncated = must<HTMLElement>(root, "[data-logs-truncated]");
  let logLines: readonly string[] = [];
  let logShown = LOG_TAIL_DEFAULT;
  let logTruncatedFlag = false;
  let logController: AbortController | undefined;
  let logBusy = false;

  function renderLog(): void {
    if (logLines.length === 0) {
      logsRegion.hidden = true;
      logsCount.hidden = true;
      logsEarlier.hidden = true;
      return;
    }
    const w = logWindow(logLines, logShown);
    logsPre.textContent = w.text;
    logsRegion.hidden = false;
    logsCount.hidden = false;
    setText(
      logsCount,
      w.hidden === 0
        ? JOB_COPY.logs.countAll(w.total, logTruncatedFlag)
        : JOB_COPY.logs.count(w.shown, w.total, logTruncatedFlag),
    );
    logsEarlier.hidden = w.hidden === 0;
    logsTruncated.hidden = !logTruncatedFlag;
  }

  async function loadLog(): Promise<void> {
    if (logBusy) return;
    logBusy = true;
    logController?.abort();
    const mine = new AbortController();
    logController = mine;
    logsShow.disabled = true;
    logsStatus.hidden = false;
    setText(logsStatus, JOB_COPY.logs.loading);
    try {
      const log = await getComputeLogs(jobId, { signal: mine.signal });
      const prepared = prepareLog(log.text);
      logLines = prepared.lines;
      logShown = LOG_TAIL_DEFAULT;
      logTruncatedFlag = log.truncated;
      logsShow.textContent = JOB_COPY.logs.refresh;
      must<HTMLElement>(root, "[data-logs-ended-note]").hidden = true;
      if (prepared.lines.length === 0) {
        setText(logsStatus, JOB_COPY.logs.empty);
        logsTruncated.hidden = !log.truncated;
      } else {
        logsStatus.hidden = true;
        setText(logsStatus, "");
      }
      renderLog();
    } catch (err) {
      if (mine.signal.aborted) return;
      logLines = [];
      renderLog();
      const failure = logFailure(err, source);
      setText(logsStatus, failure.sentence);
      if (failure.kind === "none") logsShow.textContent = JOB_COPY.logs.refresh;
      if (failure.kind === "not_found") onNotFound();
    } finally {
      logBusy = false;
      // Each press may be a cluster read of up to 1 MiB: a short pause before the next.
      setTimeout(() => {
        logsShow.disabled = false;
      }, LOG_REFRESH_COOLDOWN_MS);
    }
  }
  logsShow.addEventListener("click", () => void loadLog());
  logsEarlier.addEventListener("click", () => {
    logShown += LOG_EARLIER_STEP;
    renderLog();
  });

  // --- results -------------------------------------------------------------------------------------

  const resultsGet = must<HTMLButtonElement>(root, "[data-results-get]");
  const resultsStatus = must<HTMLElement>(root, "[data-results-status]");
  const resultsPanel = must<HTMLElement>(root, "[data-results-panel]");
  const resultsList = must<HTMLElement>(root, "[data-results-list]");
  const resultsSummary = must<HTMLElement>(root, "[data-results-summary]");
  const resultsExpiry = must<HTMLElement>(root, "[data-results-expiry]");
  const resultsOutlive = must<HTMLElement>(root, "[data-results-outlive]");
  const resultsNotice = must<HTMLElement>(root, "[data-results-notice]");
  const resultsMore = must<HTMLButtonElement>(root, "[data-results-more]");
  const resultsNext = must<HTMLButtonElement>(root, "[data-results-next]");
  const resultsFirst = must<HTMLButtonElement>(root, "[data-results-first]");
  const resultsRenew = must<HTMLButtonElement>(root, "[data-results-renew]");
  let heldResults: { rows: ResultRow[]; response: ComputeResults } | null = null;
  let resultsShown = RESULT_ROWS_STEP;
  let resultsOffset = 0;
  let resultsAfter: string | null = null;
  let resultsGone = false;
  let resultsBusy = false;

  function clearResults(): void {
    heldResults = null;
    resultsList.replaceChildren();
    resultsPanel.hidden = true;
    if (current) void renderResultsPanel(current);
  }

  function renderResults(): void {
    if (heldResults === null) return;
    const { rows, response } = heldResults;
    resultsPanel.hidden = false;
    resultsGet.hidden = true;
    const words = {
      download: JOB_COPY.results.download,
      unavailable: JOB_COPY.results.unavailableLink,
      sha: JOB_COPY.results.sha,
    };
    resultsList.replaceChildren(
      ...rows.slice(0, resultsShown).map((r) => resultRowElement(doc, r, words)),
    );
    const from = resultsOffset + 1;
    const to = resultsOffset + rows.length;
    setText(
      resultsSummary,
      response.truncated || resultsOffset > 0
        ? JOB_COPY.results.showingRange(from, to, response.total)
        : JOB_COPY.results.filesCount(response.total),
    );
    setText(resultsNotice, response.notice);
    const until = new Date(response.expires_at);
    const when = Number.isNaN(until.getTime())
      ? response.expires_at
      : `${until.toISOString().slice(0, 16).replace("T", " ")} UTC (${JOB_COPY.results.yourTime}: ${until.toLocaleString()})`;
    setText(resultsExpiry, JOB_COPY.results.linksExpire(when));
    const untilMs = Number(root.dataset.untilMs ?? "");
    resultsOutlive.hidden = !linksOutliveFiles(
      response.expires_at,
      Number.isNaN(untilMs) ? null : untilMs,
    );
    const paging = resultsPaging({
      held: rows.length,
      shown: Math.min(resultsShown, rows.length),
      offset: resultsOffset,
      total: response.total,
      nextAfter: response.next_after,
    });
    resultsMore.hidden = paging.showMore === 0;
    setText(resultsMore, JOB_COPY.results.showMore(paging.showMore));
    resultsNext.hidden = paging.nextPageRemaining === null;
    if (paging.nextPageRemaining !== null) {
      setText(resultsNext, JOB_COPY.results.nextPage(paging.nextPageRemaining));
    }
    resultsFirst.hidden = resultsOffset === 0;
  }

  /** Replace the rows with a notice when the links' own expiry has passed: no stale link stays in the DOM. */
  function expireLinksIfDue(): void {
    if (heldResults === null) return;
    if (!linksExpired(heldResults.response.expires_at, nowMs())) return;
    heldResults = null;
    resultsList.replaceChildren();
    resultsMore.hidden = true;
    resultsNext.hidden = true;
    resultsFirst.hidden = true;
    setText(resultsStatus, JOB_COPY.results.linksExpired);
    resultsStatus.hidden = false;
  }

  async function fetchResults(after: string | null, renew: boolean, offset: number): Promise<void> {
    if (resultsBusy) return;
    resultsBusy = true;
    for (const b of [resultsGet, resultsRenew, resultsNext, resultsFirst, resultsMore]) {
      b.disabled = true;
    }
    resultsStatus.hidden = false;
    setText(resultsStatus, JOB_COPY.results.loading);
    try {
      const response = renew
        ? await renewComputeResults(jobId, after)
        : await getComputeResults(jobId, after);
      heldResults = { rows: response.files.map(resultRow), response };
      resultsAfter = after;
      resultsOffset = offset;
      resultsShown = RESULT_ROWS_STEP;
      resultsStatus.hidden = true;
      setText(resultsStatus, "");
      renderResults();
    } catch (err) {
      const failure = resultsFailure(err, resultsDays);
      setText(resultsStatus, failure.sentence);
      if (failure.kind === "expired") {
        resultsGone = true;
        heldResults = null;
        resultsPanel.hidden = true;
        resultsGet.hidden = true;
      }
      if (failure.kind === "not_ready") resultsGet.hidden = true;
      if (failure.kind === "not_found") onNotFound();
    } finally {
      resultsBusy = false;
      for (const b of [resultsGet, resultsRenew, resultsNext, resultsFirst, resultsMore]) {
        b.disabled = false;
      }
    }
  }
  resultsGet.addEventListener("click", () => void fetchResults(null, false, 0));
  resultsRenew.addEventListener("click", () => {
    expireLinksIfDue();
    void fetchResults(resultsAfter, true, resultsOffset);
  });
  resultsMore.addEventListener("click", () => {
    resultsShown += RESULT_ROWS_STEP;
    renderResults();
  });
  resultsNext.addEventListener("click", () => {
    const next = heldResults?.response.next_after ?? null;
    if (next === null || heldResults === null) return;
    void fetchResults(next, false, resultsOffset + heldResults.rows.length);
  });
  resultsFirst.addEventListener("click", () => void fetchResults(null, false, 0));
  doc.addEventListener("visibilitychange", () => {
    if (!doc.hidden) expireLinksIfDue();
  });
  // A page restored from the back-forward cache must not bring bearer links back.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      resultsStatus.hidden = true;
      clearResults();
    }
  });

  // --- cancel --------------------------------------------------------------------------------------

  const cancelOpen = must<HTMLButtonElement>(root, "[data-cancel-open]");
  const cancelStatus = must<HTMLElement>(root, "[data-cancel-status]");
  let cancelBusy = false;

  cancelOpen.addEventListener("click", () => {
    if (cancelBusy) return;
    doc.dispatchEvent(
      new CustomEvent<{ dialogId: string }>("nemar:open-confirm-dialog", {
        detail: { dialogId: "compute-cancel" },
      }),
    );
  });

  doc.addEventListener("nemar:confirm-dialog-confirm", (event) => {
    if ((event as CustomEvent<{ dialogId: string }>).detail?.dialogId !== "compute-cancel") return;
    void doCancel();
  });

  async function reread(): Promise<ComputeJobRead | null> {
    try {
      const read = await getComputeJob(jobId);
      applyJob(read);
      return read;
    } catch {
      return null;
    }
  }

  async function doCancel(): Promise<void> {
    if (cancelBusy) return;
    cancelBusy = true;
    cancelOpen.disabled = true;
    cancelOpen.setAttribute("aria-busy", "true");
    cancelStatus.hidden = false;
    setText(cancelStatus, JOB_COPY.cancel.working);
    try {
      const answer = await cancelComputeJob(jobId);
      const outcome = cancelOutcome(answer);
      setText(cancelStatus, outcome.sentence);
      await reread();
      if (outcome.poll) poller.refreshNow();
    } catch (err) {
      if (err instanceof ComputeApiError && err.code === "job_not_found") {
        onNotFound();
      } else if (err instanceof ComputeApiError && err.kind === "session") {
        setText(cancelStatus, JOB_COPY.live.sessionEnded);
      } else if (err instanceof ComputeApiError && err.kind === "account") {
        setText(cancelStatus, err.sentence ?? JOB_COPY.cancel.notRecorded);
      } else {
        // The answer may have been lost after the cancel went through: the job record says which.
        setText(cancelStatus, JOB_COPY.cancel.unclear);
        const read = await reread();
        if (read?.job.cancel_requested) setText(cancelStatus, JOB_COPY.cancel.recorded);
        else if (read) setText(cancelStatus, JOB_COPY.cancel.notRecorded);
      }
    } finally {
      cancelBusy = false;
      cancelOpen.disabled = false;
      cancelOpen.removeAttribute("aria-busy");
      // The button may be gone now; the status is where focus belongs.
      cancelStatus.focus();
    }
  }

  // --- a job that is not there ---------------------------------------------------------------------

  function onNotFound(): void {
    poller.stop();
    root.replaceChildren(
      el(doc, "h1", "compute-job__title", JOB_COPY.notFoundTitle),
      el(doc, "p", undefined, JOB_COPY.notFoundBody),
    );
  }

  // --- start ---------------------------------------------------------------------------------------

  const headline = must<HTMLElement>(root, "[data-results-headline]");
  if (headline.dataset.untilIso && root.dataset.untilMs === undefined) {
    root.dataset.untilMs = String(Date.parse(headline.dataset.untilIso));
  }
  addLocalTime(headline);
  if (root.dataset.live === "true") poller.start();
}
