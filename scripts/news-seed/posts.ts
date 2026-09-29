/**
 * The first five news posts (website#371), dated by the release that first
 * carried each feature to nemar.org:
 *
 * - ORCID sign-in and the streaming viewer: website v0.2.0, 2026-07-29, the
 *   day the new site took over nemar.org (website#190).
 * - HED and SCORE annotation: website v0.2.5, 2026-09-02 (#263).
 * - Anonymous deposits: nemar-cli 0.10.4 and website v0.2.14, 2026-09-16
 *   (nemar-cli epic #1406, website#334).
 * - The NEMAR Assistant: website v0.2.18, 2026-09-24 (#350, #351).
 *
 * Times are mid-morning in San Diego so the date reads the same in every
 * time zone a reader is likely to be in. `banner` is a file name looked up
 * in the directory passed to `seed-news.ts --images`.
 */

export interface SeedPost {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly category: "feature" | "data" | "event" | "update";
  readonly published_at: string;
  readonly banner: string;
  readonly banner_alt: string;
  readonly body: string;
}

export const SEED_POSTS: readonly SeedPost[] = [
  {
    slug: "sign-in-with-orcid",
    title: "Sign in to NEMAR with your ORCID iD",
    summary:
      "Researchers can now sign in with ORCID, the identifier most of them already publish under. Browsing and downloading still need no account.",
    category: "feature",
    published_at: "2026-07-29T16:00:00Z",
    banner: "nemar-orcid-login.png",
    banner_alt:
      "The NEMAR sign-in page, with a Sign in with ORCID button and a note that an account is only needed to upload data.",
    body: `NEMAR now signs researchers in with [ORCID](https://orcid.org), the persistent identifier most researchers already carry on their papers and grant applications. There is no NEMAR password to create or forget.

## Who needs an account

Only people who upload data, and soon, people who run compute on NEMAR. Browsing, searching, and downloading every public dataset stays open to everyone, with no sign-in.

## Signing in for the first time

Use the same **Sign in with ORCID** button. If your iD is new to NEMAR, it creates your account, then asks for an email address (ORCID does not share one) and your location. That is the whole sign-up.

Already have a NEMAR account from signing in by email? Link your ORCID iD to it from **Settings**.

## Why ORCID

An ORCID iD ties a dataset to the person who deposited it without anyone retyping a name. It is also how dataset pages show authors: an author with an iD gets the green iD mark and a link to their record.

[Sign in to NEMAR](https://app.nemar.org/login)`,
  },
  {
    slug: "view-recordings-in-the-browser",
    title: "Look through any recording in your browser, before you download it",
    summary:
      "Open a signal file on a dataset page and the viewer streams only the stretch you are looking at, with the dataset's own events marked.",
    category: "feature",
    published_at: "2026-07-29T17:00:00Z",
    banner: "nemar-viewer-zarr.png",
    banner_alt:
      "The NEMAR signal viewer showing 32 EEG channels of a Flanker task recording, with colored event markers and an overview strip below.",
    body: `Deciding whether a dataset suits your analysis used to mean downloading it first. Now you can look first. Click a signal file in a dataset's file tree (EEG, MEG, iEEG, or EMG, as \`.set\`, \`.edf\`, \`.bdf\`, \`.vhdr\`, or \`.fif\`) and the recording opens in a full-screen viewer.

## Only the part on screen

NEMAR keeps a streaming copy of each recording in [Zarr](https://zarr.dev), a chunked format built for reading over the web. The viewer fetches only the window you are looking at, around 130 KB for ten seconds of data however long the recording is, so an hour-long session opens as quickly as a short one.

## What you can do

- Page through time, change the window length, and scale the traces
- Filter with high-pass, low-pass, and notch filters
- Zoom into part of a large montage
- Read the dataset's own events as colored markers, named in a legend, with an overview strip of the whole recording
- Show a topographic map of the scalp at any moment

**Update, September 1:** the viewer now moves between runs, tasks, and subjects without closing, from the Subject and Task menus at the top.`,
  },
  {
    slug: "hed-score-annotation",
    title: "Annotate recordings with HED and SCORE, right in the viewer",
    summary:
      "Mark events and artifacts on any recording with standard HED and SCORE terms, then download them as BIDS events and channels files.",
    category: "feature",
    published_at: "2026-09-02T17:00:00Z",
    banner: "nemar-annotation-hed.png",
    banner_alt:
      "Annotating a chewing artifact in the NEMAR signal viewer: a highlighted span, and a search box offering HED and SCORE terms with their definitions.",
    body: `Reviewing a recording usually ends in notes that live nowhere near the data. The signal viewer now lets you annotate as you read, in the vocabularies the field already shares: [HED](https://www.hedtags.org) (Hierarchical Event Descriptors) and HED-SCORE, the HED library for SCORE (Standardized Computer-based Organized Reporting of EEG), the clinical EEG reporting standard.

## How it works

Turn on **Annotate** (the pencil beside the topographic map), then:

- **Click** a trace to mark a moment, or **drag** across it to mark a span.
- Search the vocabulary as you type. *chew* finds Chewing-artifact in HED and oroalimentary semiology in SCORE, each with its definition.
- Add a comment when the tags do not say everything.
- **Click channel labels** to mark bad channels, then annotate them as a set.

Enter saves and Esc cancels. Click an annotation to edit or delete it.

## Take them with you

Annotations download as Brain Imaging Data Structure (BIDS) files: \`<recording>_events.tsv\` for moments and spans, and \`<recording>_channels.tsv\` for channel status. Your browser keeps them between visits, per dataset, version, and recording, so a long review can pick up where it stopped.

The vocabulary holds 488 terms: the whole HED-SCORE 2.1.0 library, plus the artifact, event, and state terms of HED 8.4.0. It loads only when you first turn annotation on.`,
  },
  {
    slug: "anonymous-deposits-for-double-blind-review",
    title: "Deposit a dataset anonymously for double-blind review",
    summary:
      "Submitting to a double-blind venue? Reviewers can download your data from NEMAR while nothing NEMAR publishes names you, until you say so.",
    category: "data",
    published_at: "2026-09-16T17:00:00Z",
    banner: "nemar-anonymous-dataset.png",
    banner_alt:
      "A dataset page tagged Anonymous deposit, explaining that authorship is temporarily withheld while the data stays public and downloadable.",
    body: `Double-blind review asks authors to hide who they are, and a link to the data usually gives it away. NEMAR now accepts anonymous deposits. The dataset is public, browsable, and downloadable at its ordinary address, so reviewers can use it, while NEMAR withholds everything it publishes about the depositor.

## What stays hidden

- The dataset's GitHub repository stays private.
- The author list shows a blinded label instead of names, and the catalog shows no owner.
- The published metadata leaves out authors, contributors, funding, locations, and related identifiers.
- The DOI is reserved but not registered, so nothing harvests or indexes it yet.

The dataset page says all this plainly, so a reviewer who finds no authors knows why.

## How to deposit anonymously

Upload as usual, then request publication with the \`--anonymous\` flag:

\`\`\`
nemar dataset publish request <dataset-id> --anonymous
\`\`\`

When the paper is accepted, restore the real authors in \`dataset_description.json\` and request publication again without the flag. That publishes the full record and makes the DOI citable.

## Two things to know first

- **Blind your own files.** NEMAR withholds what it publishes, but it cannot rewrite what you wrote: the README, \`dataset_description.json\`, and the participants files are served as written. A daily check reports anything in them that still names you, so you can fix it.
- **Anonymity only comes before the first publication.** A dataset already published under your name cannot be made anonymous; an attribution that is already public cannot be taken back.`,
  },
  {
    slug: "nemar-assistant",
    title: "Ask the NEMAR Assistant about any dataset",
    summary:
      "An experimental assistant on every page answers questions about NEMAR data, and can read a recording and plot it for you, showing the code it ran.",
    category: "feature",
    published_at: "2026-09-24T17:00:00Z",
    banner: "nemar-assistant-erp.png",
    banner_alt:
      "The NEMAR Assistant answering a request to plot an event-related potential (ERP) image of a Flanker recording: the Python steps it ran, then the figure with one panel per condition.",
    body: `Every page on NEMAR now has an assistant, behind the chat button at the bottom right. It is built on the [Open Science Assistant](https://github.com/OpenScience-Collective/osa), and it can look datasets up in NEMAR's catalog and read their recordings.

## From a question to a figure

Ask in plain language. *Plot an ERP image of sub-1001's Flanker recording from on007139, one panel per condition* becomes a short analysis: the assistant reads the recording from NEMAR's streaming copy, re-references, filters, and epochs it, and returns the figure. Every step it ran is shown as Python you can read.

- **Edit and run** the code yourself; the result is labeled as yours.
- **Download** any figure it makes.
- On a dataset with a streaming copy, the notebook button opens the data in a JupyterLite notebook, to carry on there.

It asks before it runs code, and the code runs in your browser.

## Experimental, and says so

The assistant can be wrong. Check what it tells you against the dataset page and the [documentation](https://docs.nemar.org), and treat its analyses as a starting point to inspect, which is why it shows its code.`,
  },
];
