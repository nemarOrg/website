/**
 * The short UI words of the `/compute` page: headings, column headers, button text, empty and error
 * states (website ADR 0030 phase E2 addendum). Sentences that the command line also says are NOT here:
 * they live in `./account-copy.ts` (mirrored from nemar-cli, ADR 0015). What is here is a label or a
 * description of this page's own state, which the CLI does not print.
 *
 * `test/compute-dashboard-ui.test.ts` fails if a page or component under /compute types a long
 * sentence outside this file and the copy table, which is how a sentence stays in one place.
 */

export const COMPUTE_LABELS = {
  pageTitle: "Compute",
  pageDescription: "Your compute access, balances, usage and jobs.",
  panels: {
    access: "Access",
    balances: "Balances",
    usage: "Usage",
    jobs: "Jobs",
    queue: "Recent queue waits",
  },
  pools: { cpu: "CPU", gpu: "GPU" },
  balance: {
    granted: "Granted",
    held: "Held",
    charged: "Charged",
    available: "Available",
    nothingGranted: "Nothing granted",
    unit: "SU",
  },
  access: {
    status: "Status",
    since: "since",
    unverified: "Verify your email address to use compute.",
    forbidden: "This account cannot use compute yet.",
    unavailable: "Compute is not available on this server yet.",
  },
  usage: {
    title: "Net charge per day",
    empty: "No charges in this period.",
    showNumbers: "Show the numbers",
    numbersNote: "Only days with a charge are listed.",
    day: "Day",
    total: "Total",
    other: "Other partitions",
    adjustments: "Adjustments and other partitions",
    adjustmentsLine: "Adjustments and other partitions",
    noJob: "No job",
    partition: "Partition",
    amount: "Amount",
    negativeNote:
      "A day with a net refund or correction in a partition is not drawn as a bar; it is in the table.",
    window: "UTC days",
  },
  jobs: {
    job: "Job",
    state: "State",
    app: "App",
    partition: "Partition",
    frontDoor: "Front door",
    created: "Created",
    charged: "Charged",
    empty: "No jobs yet.",
    loadMore: "Load more",
    loading: "Loading",
    retry: "Retry",
    loadFailed: "Could not load more jobs.",
    refresh: "Refresh",
    notChargedYet: "Not charged yet",
    chargeUnknown: "Not known",
    cancelRequested: "Cancel requested",
    firstPage: "Back to the first page",
  },
  queue: {
    intro:
      "Waits between the scheduler receiving a job and starting it, for recent jobs on the whole platform.",
    partition: "Partition",
    median: "Median",
    p90: "90th percentile",
    counted: "Jobs counted",
    notEnough: "Not enough data",
    none: "No partitions are offered right now.",
  },
  notice: {
    title: "Could not load",
    missing: "The figures are missing, not zero.",
    retry: "Try again",
    session: "Your session expired. Sign in again.",
    account: "This account cannot use compute yet.",
    unavailable: "The server could not answer just now.",
    timeout: "The server did not answer in time.",
    network: "The server could not be reached.",
    shape: "The server's answer was not in the expected form.",
    rejected: "The server refused the request.",
    notAvailableTitle: "Compute is not available on this server yet",
    notAvailableBody: "The page cannot show your compute account until the server supports it.",
  },
} as const;

/** The plural-aware word for a number of days in a queue window. */
export function daysText(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** The polite announcement after "Load more" appended rows. */
export function loadedText(count: number): string {
  return `Loaded ${count} more ${count === 1 ? "job" : "jobs"}.`;
}
