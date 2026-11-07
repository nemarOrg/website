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
import {
  cancelOutcome,
  isLoopbackHost,
  jobDetailView,
  linksOutliveFiles,
  logFailure,
  resultRow,
  resultsFailure,
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

const pendingText = new WeakMap<HTMLElement, string>();

/**
 * Show or hide a `role="status"` region. A live region announces what CHANGES inside it, so one that is
 * un-hidden with its text already in place can be missed: the text is put in one tick after the region
 * appears. `target` is the element that holds the text when that is not the region itself.
 */
function showStatus(region: HTMLElement, text: string | null, target: HTMLElement = region): void {
  if (text === null || text === "") {
    region.hidden = true;
    target.textContent = "";
    pendingText.delete(target);
    return;
  }
  if (region.hidden) {
    region.hidden = false;
    target.textContent = "";
    pendingText.set(target, text);
    setTimeout(() => {
      const later = pendingText.get(target);
      if (later !== undefined) target.textContent = later;
      pendingText.delete(target);
    }, 0);
  } else {
    pendingText.delete(target);
    target.textContent = text;
  }
}

/** Add "(your time: ...)" to a line that carries the instant it names in `data-until-iso`. */
function addLocalTime(node: HTMLElement): void {
  const iso = node.dataset.untilIso;
  const when = iso ? new Date(iso) : null;
  if (when && !Number.isNaN(when.getTime())) {
    node.textContent = `${node.textContent ?? ""} ${JOB_COPY.results.localTime(when.toLocaleString())}`;
  }
}

export function initJobPage(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const jobId = root.dataset.jobId ?? "";
  const source = root.dataset.source ?? "";
  let resultsDays: number | null = root.dataset.resultsDays
    ? Number(root.dataset.resultsDays)
    : null;
  let lastCharged = Number(root.dataset.charged ?? "");
  let lastStale = root.dataset.stale === "true";
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
      (!Number.isNaN(lastCharged) && lastCharged !== read.job.charged_milli) ||
      lastStale !== read.stale;
    const stateChanged = view.state !== lastState;
    lastCharged = read.job.charged_milli;
    lastStale = read.stale;
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
    // The local time is only added where the line names the date (not for a derived "expired").
    if (panel.window.untilIso && panel.window.state !== "expired") {
      headline.dataset.untilIso = panel.window.untilIso;
    } else delete headline.dataset.untilIso;
    if (panel.window.untilMs !== null) root.dataset.untilMs = String(panel.window.untilMs);
    else delete root.dataset.untilMs;
    addLocalTime(headline);
    // Derived from the job, never from what the panel showed last: a restored page needs it back.
    canGetLinks = panel.canGetLinks;
    renderResults();
  }

  // --- the poller ----------------------------------------------------------------------------------

  let lastStop: string | null = null;
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
      lastStop = reason;
      if (reason === "terminal" || reason === "unknown_state") {
        showStatus(paused, null, pausedText);
        return;
      }
      pausedSignIn.hidden = reason !== "session";
      pausedButton.hidden = reason === "session" || reason === "not_found";
      pausedButton.textContent =
        reason === "hard_stop" ? JOB_COPY.live.resume : JOB_COPY.live.refresh;
      showStatus(
        paused,
        reason === "session"
          ? JOB_COPY.live.sessionEnded
          : reason === "not_found"
            ? JOB_COPY.notFoundBody
            : JOB_COPY.live.paused,
        pausedText,
      );
    },
  });
  pausedButton.addEventListener("click", () => {
    if (pausedButton.disabled) return;
    pausedButton.disabled = true;
    lastStop = null;
    showStatus(paused, JOB_COPY.live.refreshing, pausedText);
    // One read now (through the poller's one-in-flight rule), then the schedule from the start.
    void poller.restartNow().then((ok) => {
      pausedButton.disabled = false;
      if (ok) {
        if (lastStop === null) showStatus(paused, null, pausedText);
      } else if (lastStop === null) {
        // The read failed and nothing ended the poller: stop it here, say so, and let the person retry.
        poller.stop();
        pausedButton.hidden = false;
        showStatus(paused, JOB_COPY.live.refreshFailed, pausedText);
      }
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
    showStatus(logsStatus, JOB_COPY.logs.loading);
    try {
      const log = await getComputeLogs(jobId, { signal: mine.signal });
      const prepared = prepareLog(log.text);
      logLines = prepared.lines;
      logShown = LOG_TAIL_DEFAULT;
      logTruncatedFlag = log.truncated;
      logsShow.textContent = JOB_COPY.logs.refresh;
      must<HTMLElement>(root, "[data-logs-ended-note]").hidden = true;
      if (prepared.lines.length === 0) {
        showStatus(logsStatus, JOB_COPY.logs.empty);
        logsTruncated.hidden = !log.truncated;
      } else {
        showStatus(logsStatus, null);
      }
      renderLog();
    } catch (err) {
      if (mine.signal.aborted) return;
      logLines = [];
      renderLog();
      const failure = logFailure(err, source);
      showStatus(logsStatus, failure.sentence);
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
  // Plain http result links are accepted only when this page is itself on a loopback host.
  const loopbackPage = isLoopbackHost(window.location.hostname);
  let hold: ResultsHold = EMPTY_HOLD;
  let canGetLinks = !resultsGet.hidden;
  let resultsBusy = false;

  /** The one place the results panel is written: from the hold and from what the JOB allows. */
  function renderResults(): void {
    const ui = resultsUi(hold, canGetLinks);
    resultsGet.hidden = ui.getHidden;
    resultsPanel.hidden = ui.panelHidden;
    const words = {
      download: JOB_COPY.results.download,
      unavailable: JOB_COPY.results.unavailableLink,
      sha: JOB_COPY.results.sha,
    };
    resultsList.replaceChildren(...ui.visibleRows.map((r) => resultRowElement(doc, r, words)));
    showStatus(resultsStatus, ui.status);
    const held = hold.held;
    if (held === null) return;
    const from = hold.offset + 1;
    const to = hold.offset + held.rows.length;
    setText(
      resultsSummary,
      held.response.truncated || hold.offset > 0
        ? JOB_COPY.results.showingRange(from, to, held.response.total)
        : JOB_COPY.results.filesCount(held.response.total),
    );
    setText(resultsNotice, held.response.notice);
    const until = new Date(held.response.expires_at);
    const when = Number.isNaN(until.getTime())
      ? held.response.expires_at
      : `${until.toISOString().slice(0, 16).replace("T", " ")} UTC (${JOB_COPY.results.yourTime}: ${until.toLocaleString()})`;
    setText(resultsExpiry, JOB_COPY.results.linksExpire(when));
    const untilMs = Number(root.dataset.untilMs ?? "");
    resultsOutlive.hidden = !linksOutliveFiles(
      held.response.expires_at,
      Number.isNaN(untilMs) ? null : untilMs,
    );
    resultsMore.hidden = ui.moreCount === 0;
    setText(resultsMore, JOB_COPY.results.showMore(ui.moreCount));
    resultsNext.hidden = ui.nextRemaining === null;
    if (ui.nextRemaining !== null)
      setText(resultsNext, JOB_COPY.results.nextPage(ui.nextRemaining));
    resultsFirst.hidden = ui.firstHidden;
  }

  async function fetchResults(after: string | null, renew: boolean, offset: number): Promise<void> {
    if (resultsBusy) return;
    resultsBusy = true;
    for (const b of [resultsGet, resultsRenew, resultsNext, resultsFirst, resultsMore]) {
      b.disabled = true;
    }
    hold = setStatus(hold, JOB_COPY.results.loading);
    renderResults();
    try {
      const response = renew
        ? await renewComputeResults(jobId, after)
        : await getComputeResults(jobId, after);
      hold = holdPage(
        hold,
        { rows: response.files.map((f) => resultRow(f, loopbackPage)), response },
        after,
        offset,
      );
    } catch (err) {
      const failure = resultsFailure(err, resultsDays, source);
      hold = setStatus(hold, failure.sentence);
      if (failure.kind === "expired") hold = markGone(hold, failure.sentence);
      if (failure.kind === "not_ready") canGetLinks = false;
      if (failure.kind === "not_found") onNotFound();
    } finally {
      resultsBusy = false;
      for (const b of [resultsGet, resultsRenew, resultsNext, resultsFirst, resultsMore]) {
        b.disabled = false;
      }
    }
    renderResults();
  }
  resultsGet.addEventListener("click", () => void fetchResults(null, false, 0));
  resultsRenew.addEventListener("click", () => {
    hold = expireIfDue(hold, nowMs());
    renderResults();
    void fetchResults(hold.after, true, hold.offset);
  });
  resultsMore.addEventListener("click", () => {
    hold = showMore(hold);
    renderResults();
  });
  resultsNext.addEventListener("click", () => {
    const held = hold.held;
    if (held === null || held.response.next_after === null) return;
    void fetchResults(held.response.next_after, false, hold.offset + held.rows.length);
  });
  resultsFirst.addEventListener("click", () => void fetchResults(null, false, 0));
  doc.addEventListener("visibilitychange", () => {
    if (doc.hidden) return;
    hold = expireIfDue(hold, nowMs());
    renderResults();
  });
  // A page restored from the back-forward cache must not bring bearer links back.
  window.addEventListener("pageshow", (event) => {
    hold = handlePageshow(hold, event.persisted);
    renderResults();
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
    showStatus(cancelStatus, JOB_COPY.cancel.working);
    try {
      const answer = await cancelComputeJob(jobId);
      const outcome = cancelOutcome(answer);
      showStatus(cancelStatus, outcome.sentence);
      await reread();
      if (outcome.poll) poller.refreshNow();
    } catch (err) {
      if (err instanceof ComputeApiError && err.code === "job_not_found") {
        onNotFound();
      } else if (err instanceof ComputeApiError && err.kind === "session") {
        showStatus(cancelStatus, JOB_COPY.live.sessionEnded);
      } else if (err instanceof ComputeApiError && err.kind === "account") {
        showStatus(cancelStatus, err.sentence ?? JOB_COPY.cancel.notRecorded);
      } else {
        // The answer may have been lost after the cancel went through: the job record says which.
        showStatus(cancelStatus, JOB_COPY.cancel.unclear);
        const read = await reread();
        if (read?.job.cancel_requested) showStatus(cancelStatus, JOB_COPY.cancel.recorded);
        else if (read) showStatus(cancelStatus, JOB_COPY.cancel.notRecorded);
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
