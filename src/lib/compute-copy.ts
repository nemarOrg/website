/**
 * The sentences of the job page (website ADR 0030 phase E3, issue #496). WEBSITE-OWNED: nemar-cli's
 * `account-copy.ts` has none of these (the CLI prints its own strings for cancel, logs and results, and
 * its status command prints the raw failure code), so there is no key parity to keep and no `cli.` key
 * is needed. Backend-owned text is NOT here: every refusal `error` sentence, the results `notice`, the
 * unreported note and the units note are shown as the backend (or the shared copy) served them.
 *
 * `test/compute-dashboard-ui.test.ts` allows a long sentence in `compute-labels.ts`, this file and
 * `compute-failure.ts` only, which is how a sentence stays in one place.
 */

export const JOB_COPY = {
  pageTitle: "Compute job",
  pageDescription: "The state, log and results of one compute job.",
  jobHeading: "Job",
  back: "Back to Compute",
  notFoundTitle: "Job not found",
  notFoundBody: "There is no job with this id.",
  notAvailableTitle: "Compute is not available on this server yet",
  notAvailableBody: "The page cannot show this job until the server supports compute.",
  loadFailedTitle: "Could not load this job",
  tryAgain: "Try again",
  signIn: "Sign in",
  stale: "This may be out of date: the cluster could not be asked just now.",
  app: "App",
  frontDoor: "Front door",
  sections: {
    status: "Status",
    resources: "Resources and charge",
    failure: "What went wrong",
    logs: "Log",
    results: "Results",
    actions: "Actions",
  },
  timeline: {
    ended: "Ended",
    started: "Started",
    unknown: "Not known",
    stepWord: { passed: "done", current: "current", pending: "not yet", unknown: "not known" },
    stateLine: "State",
  },
  rows: {
    partition: "Partition",
    nodes: "Nodes",
    cores: "Cores per node",
    gpus: "GPUs",
    memory: "Memory",
    runTime: "Maximum run time",
    created: "Created",
    started: "Started",
    ended: "Ended",
    charged: "Charged",
    upTo: "up to",
  },
  live: {
    paused: "Updates paused.",
    refresh: "Refresh",
    resume: "Resume",
    sessionEnded: "Your session expired. Sign in again.",
    announce: (label: string) => `Job is now ${label}.`,
  },
  logs: {
    show: "Show log",
    refresh: "Refresh log",
    loading: "Loading the log",
    empty: "The job wrote no output.",
    none: "No log yet.",
    nonePartner: "No log yet. A partner job's log appears once NEMAR has checked the job.",
    unavailable: "The log could not be read just now. Try again.",
    ended: "The job ended. Refresh the log for the final output.",
    earlier: "Show earlier lines",
    region: "Job log",
    count: (shown: number, total: number, truncated: boolean) =>
      truncated
        ? `Showing the last ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} lines of the first 1 MiB`
        : `Showing the last ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} lines`,
    countAll: (total: number, truncated: boolean) =>
      truncated
        ? `Showing all ${total.toLocaleString("en-US")} lines of the first 1 MiB`
        : `Showing all ${total.toLocaleString("en-US")} lines`,
    truncatedLead:
      "The log was cut at 1 MiB: this is its beginning. The end of a longer log cannot be read here yet; run ",
    truncatedTail: " for the same part from a terminal.",
  },
  results: {
    notReady: "Results appear here when the job finishes.",
    none: "This job has no results to download.",
    get: "Get download links",
    renew: "Renew links",
    download: "Download",
    unavailableLink: "link unavailable",
    keptLimited: "Results are kept for a limited time.",
    kept: (days: number, until: string) =>
      `Results are kept for ${days} ${days === 1 ? "day" : "days"} after the job ends, until ${until}.`,
    expiring: (days: number, until: string) =>
      `These results will be deleted soon, on ${until} (${days} ${days === 1 ? "day" : "days"} left).`,
    expiredDerived: (days: number) =>
      `Results are kept for ${days} ${days === 1 ? "day" : "days"} after the job ends. That time has passed, so the files may already be deleted.`,
    expired410: (days: number | null) =>
      `The results of this job were deleted${days === null ? "" : ` after ${days} ${days === 1 ? "day" : "days"}`}. This page keeps the job's record (state, resources and charge) and its log.`,
    badState: "NEMAR has no result files for this job.",
    loading: "Getting the links",
    yourTime: "your time",
    localTime: (when: string) => `In your time zone: ${when}.`,
    linksExpire: (until: string) => `Links expire ${until}.`,
    filesCount: (total: number) =>
      `${total.toLocaleString("en-US")} ${total === 1 ? "file" : "files"}`,
    showingRange: (from: number, to: number, total: number) =>
      `Files ${from.toLocaleString("en-US")} to ${to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`,
    mayOutlive: "The files may be deleted before these links expire.",
    linksExpired: "These links have expired. Renew them.",
    showMore: (n: number) => `Show ${n} more`,
    nextPage: (remaining: number) =>
      `${remaining.toLocaleString("en-US")} more ${remaining === 1 ? "file" : "files"}. Get the next links`,
    firstPage: "Back to the first links",
    allLead: "To download everything, run ",
    allTail: ": it checks each file's size and checksum.",
    region: "Result files",
    sha: "SHA-256",
  },
  cancel: {
    button: "Cancel job",
    dialogTitle: "Cancel this job?",
    dialogBody:
      "This stops the job. A job that has not started costs nothing. A job that is running is charged for the time it used. This cannot be undone.",
    confirm: "Cancel job",
    keep: "Keep job",
    working: "Canceling",
    requested: "Cancel requested",
    recorded: "Cancel recorded. NEMAR stops the job shortly, and this page updates.",
    canceled: "The job was canceled.",
    alreadyRecorded: "A cancel was already recorded for this job.",
    ended: (state: string) => `The job had already ended (${state}); nothing was canceled.`,
    unknown: "The cancel request was answered in a way this page does not know. Checking the job.",
    unclear: "Could not tell whether the cancel went through. Checking the job.",
    notRecorded: "The cancel was not recorded. You can try again.",
  },
} as const;
