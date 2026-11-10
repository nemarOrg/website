/**
 * The short UI words of the `/compute` page and of the dataset page's Compute dialog: headings, column
 * headers, button text, empty and error states (website ADR 0030 phase E2 and E5 addenda). Sentences
 * that the command line also says are NOT here: they live in `./account-copy.ts` (mirrored from
 * nemar-cli, ADR 0015). What is here is a label or a description of this surface's own layout, which the
 * CLI does not print, or a paraphrase of one line of the CLI's help (`datasetDialog`, pinned to the
 * captured help by `test/compute-instructions-cli-parity.test.ts`).
 *
 * `test/compute-dashboard-ui.test.ts` fails if a page or component under /compute types a long
 * sentence outside this file and the copy table, which is how a sentence stays in one place;
 * `test/compute-dialog-ui.test.ts` does the same for the dialog.
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
  },
  access: {
    status: "Status",
    since: "since",
    forbidden: "This account cannot use compute yet.",
  },
  usage: {
    title: "Net charge per day in SU",
    empty: "No charges in this period.",
    showNumbers: "Show the numbers",
    numbersNote: "Only days with a charge are listed.",
    day: "Day",
    total: "Total",
    other: "Other partitions",
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
  /**
   * The dataset page's Compute dialog (phase E5). Access sentences (what access is, that an admin
   * reviews, the queue is not a promise) are NOT here; the dialog reads them from the copy table.
   * Each explanation paraphrases one line of `nemar compute <command> --help-all`; no number, limit,
   * price or allocation size appears, and no claim about where a job runs.
   */
  datasetDialog: {
    title: "Compute on this dataset",
    intro:
      "NEMAR compute runs a script, a folder of code or a pinned container image that reads this dataset, from the command line.",
    install: {
      heading: "Install the NEMAR CLI and sign in",
      link: "Install the NEMAR CLI",
      signIn: "Sign in",
    },
    access: {
      heading: "Ask for compute access, once",
      row: "Ask an admin",
      explain: "You ask once, and the request tells you what your account is still missing.",
    },
    check: {
      heading: "Check the job first",
      row: "Dry run",
      explain:
        "A dry run packs and checks your job and prints it. It sends nothing about the job and needs no sign-in.",
    },
    run: {
      heading: "Run it on this dataset",
      script: "A script",
      scriptExplain:
        "Name the dataset with its version so the job can be run again on the same data. With --wait the command follows the job; Ctrl-C stops waiting and does not cancel it.",
      folder: "A folder",
      folderExplain: "A folder needs the file to run.",
      limits: "Limits",
      limitsExplain:
        "What one job may ask for on each partition offered to you, and how many jobs you may have at once.",
      balance: "Balance",
      balanceExplain: "Your access and balance. It works in every access state.",
    },
    follow: {
      heading: "Follow it and collect the results",
      row: "Your jobs",
      explain:
        "<job> is the id submit prints. List your jobs, show one, read its log, download its files or cancel it.",
      queue: "Queue",
      queueLead: "Shows recent queue waits per partition.",
    },
    computePageLead: "Where your access stands is on your compute page.",
    closedPointer: "To work with this data now, use one of the routes in Download.",
    notAvailable: "NEMAR compute cannot read this dataset.",
  },
  /** The admin Compute tab: the group a decided card moves to when it leaves the filtered list. */
  adminDecided: { title: "Decided on this page" },
} as const;

/** The plural-aware word for a number of days in a queue window. */
export function daysText(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** The polite announcement after "Load more" appended rows. */
export function loadedText(count: number): string {
  return `Loaded ${count} more ${count === 1 ? "job" : "jobs"}.`;
}
