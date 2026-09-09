# NEMAR website content and visual Bible

This is the shared reference for public NEMAR language, terminology, claims,
support routing, and explanatory visuals. It is written for an early graduate
student: precise enough to be useful, plain enough to read without knowing the
architecture first.

## The public promise

NEMAR makes human neuroelectromagnetic data easier to find, understand, check,
cite, and reuse. It connects community standards and review with practical
interfaces for people, scripts, browsers, agents, and future compute services.

The short explanation is:

> NEMAR is an open data, tools, and compute resource for human EEG, MEG, iEEG,
> and EMG research. The website is the front door. The CLI, APIs, data plane,
> manifests, metadata, derived Zarr stores, and DOI records are the durable
> system behind it.

The website should make a reader understand that NEMAR is a connected system,
not just a search page and not just a file bucket.

## Mission and vision

### Mission

NEMAR makes human neuroelectromagnetic data findable, understandable, citable,
and reusable by combining community standards with trustworthy metadata,
quality checks, open interfaces, and practical paths to computation.

### Vision

We envision a future in which a researcher can discover a dataset, inspect its
provenance and quality, analyze the smallest useful piece, and cite the exact
version without treating data sharing as the end of the research.

These statements are compatible with NEMAR's NIH/NIMH-supported role and with
our commitment to open science: preserve and expose publicly useful research
data, make its context legible, support reproducible reuse, and improve the
resource in public. They do not imply that every future service is already
shipped or that NEMAR replaces the repositories and compute centers it connects.

## Audience and voice

- Write for a smart researcher who knows what a recording is but may not know
  BIDS, Zarr, Cloudflare Workers, DOI relations, or HPC operations.
- Start with the human reason. Follow with the system detail.
- Prefer “a file index” to “manifest” on first use; define “manifest” directly
  after it.
- Prefer “the browser reads only the chunks it needs” to “partial HTTP range
  access over a chunked object store.”
- Use “planned”, “in development”, or “roadmap” for Tapis, One Science Place,
  broad in-browser analysis, and future versioned derivatives.
- Say “where available” for derived Zarr stores and quality annotations.
- Never promise that a DOI makes data correct, that AI makes a publication
  decision, or that all data are equally reusable. Point readers to the dataset
  license and metadata.

Avoid marketing superlatives such as “best” in a universal sense. The accurate
claim is that NEMAR is **CLI-first**: a command-line client is the strongest
foundation for repeatable upload, validation, versioning, large transfers, and
HPC use. The website remains the best surface for discovery, sign-in,
visual inspection, and one-off exploration.

## Core mental model

NEMAR is a set of layers with one source of truth for each job:

| Layer | Plain-language job | Public name |
| --- | --- | --- |
| Human browser | Discover, inspect, visualize, sign in, and manage datasets | `nemar.org` |
| Terminal client | Script upload, validation, download, versioning, and publication workflows | `nemar-cli` |
| Control plane | Catalog search, accounts, permissions, and workflow state | `api.nemar.org` |
| Data plane | Canonical BIDS-shaped metadata, manifests, file listings, and byte access | `data.nemar.org` |
| Streaming plane | Derived chunked signal stores for responsive, partial reads | `zarr.nemar.org` |
| Documentation | Human and machine-readable contracts, guides, and policies | `docs.nemar.org` |
| Durable provenance | Repository history, object storage, immutable release manifests, and citation records | GitHub, S3, DOI/DataCite |

The web app is deliberately a shell around the system. It should not copy
catalog logic, invent metadata, or become a second upload implementation when
the backend already owns that contract. New backend fields belong in
`nemar-cli` first; the website should consume them.

## Why CLI-first

The CLI is not merely a smaller version of the website. A terminal workflow can
be placed in a shell script, repeated next month, resumed after an interrupted
transfer, run on a workstation or HPC login node, reviewed in a pull request,
and inspected without clicking through a browser. That makes it a durable
research instrument and a stable contract for future clients.

The website is still essential. A browser is the fastest way to search an
archive, see a dataset's context, preview files, explore quality information,
manage collaborators, or start a workflow without installing anything. The
two surfaces share accounts, permissions, and dataset state; they differ in
how a person reaches the same system.

## Zarr and edge computing

The canonical archive remains BIDS-shaped. During conversion, large signal
files can be copied into derived Zarr stores: chunked arrays that let a reader
ask for a small region instead of downloading a whole recording. A Worker at
`zarr.nemar.org` provides the browser-facing gateway, CORS handling, and edge
caching. The browser viewer can then request the chunks needed for the current
window.

Zarr is an access layer, not a replacement for the BIDS source. It can lag,
fail, or be unavailable for a particular recording. The original file and its
manifest remain authoritative, and the Zarr index should make conversion
coverage, pending work, and failures visible.

The near-term product direction is in-browser analysis: bring lightweight
inspection and analysis to the data without moving an entire multi-gigabyte
recording to a laptop. The long-term compute direction is to move larger jobs
to where the data and suitable compute already live.

## HPC roadmap language

NEMAR's compute direction is grounded in its partnership with the San Diego
Supercomputer Center (SDSC). The Neuroscience Gateway (NSG) is an established
resource for neuroscience tools and high-performance computing access; link to
`https://www.nsgportal.org/` when introducing it to readers. NEMAR's role is to
make open, structured, citable data easier to connect to that compute path.

Our roadmap is to use Tapis as a web-friendly API bridge to national HPC
infrastructure through OneSciencePlace. OneSciencePlace is a platform whose
teams include UCLA, SDSC, and TACC and which uses Tapis for job and data
lifecycle management. The intended user experience is: choose a dataset and a
reproducible workflow, submit a job near the data, monitor it, and bring back a
described result.

This integration is planned, not shipped. Public copy must not describe a
one-click Tapis launch as a current feature. When it arrives, outputs should
be represented as versioned, citable BIDS derivatives with their own provenance
and DOI rather than as anonymous job artifacts.

## DOI and versioning language

NEMAR mints identifiers in its own `10.82901/NEMAR` namespace through EZID and
publishes DataCite metadata. “Our own DOI” means that NEMAR controls the
dataset's identifier pattern and landing experience; it does not mean that
NEMAR operates the global DOI registry.

Explain the two related identifiers this way:

- A **concept DOI** identifies the dataset as a continuing scholarly object.
- A **version DOI** identifies one released state: its version number,
  landing page, and immutable file manifest.

The NEMAR record is intentionally fuller than a bare repository pointer. It
can connect authors, ORCIDs, and affiliations; an abstract and acknowledgement
text; MeSH-validated keywords; funding; related identifiers; license; issued
and collection dates; formats, sizes, version, and relations between concept
and release. A DOI is the stable handle; the landing page and structured
metadata can be corrected or enriched as curation improves.

After publication, changes go through a reviewed pull request and become a new
version. This gives the archive a useful balance: stable citations for work
already used, and a public path for continuous improvement. Never say that a
DOI makes the underlying bytes mutable or that metadata changes silently rewrite
an old release.

## AI- and agent-friendly research

NEMAR's commitment to agentic research means making the whole resource legible
to software, not only making a repository's code public. Code repositories,
dataset pages, metadata, manifests, docs, and stable URLs should be usable by
scripts and LLM-based research agents.

Public surfaces should provide:

- stable dataset and version URLs;
- JSON metadata and manifests with explicit field names;
- BIDS paths and checksums where the contract provides them;
- schema.org Dataset metadata and a markdown mirror for dataset pages;
- `/llms.txt` and a dedicated agent guide;
- licensing and citation guidance close to the data;
- documentation that explains the difference between the catalog, data, and
  derived streaming layers.

AI-assisted curation is bounded and reviewable. Models may read README files
and structural metadata to propose descriptions, methods, keywords, related
identifiers, or validation findings. They do not make final publication
decisions, replace controlled vocabularies, or inspect participant-level
recordings as part of this workflow. Human and administrative review remains
authoritative, and corrections should be made through the dataset or code
repository issue paths.

## Support routing

The rule is “report the problem where it lives.”

- Dataset content, metadata, quality, citation, or a specific file: use the
  dataset's `nemarDatasets` repository, linked from its detail page. A pull
  request is welcome when you can propose a concrete, reviewable fix.
- CLI, API, upload, authentication, DOI, versioning, conversion, or systematic
  backend behavior: use `nemarOrg/nemar-cli`.
- Browser, layout, routing, sign-in surface, or website behavior: use
  `nemarOrg/website`.
- Documentation wording, broken links, or missing guidance: use
  `nemarOrg/docs`.
- Unsure, sensitive, private, or security-related: contact the published
  support/security route rather than putting credentials or participant data in
  a public issue.

An issue explains a problem or idea. A pull request proposes the change itself.
Useful reports include the dataset ID and version, URL or file path, expected
and observed behavior, a minimal reproduction, and relevant environment
details. Never include participant data, access tokens, private URLs, or
secrets.

## Visual system

Use the website tokens as the source of truth for interface styling. Standalone
figures use the same visual vocabulary, with a light paper variant as the
default for the website and presentations and a matched dark variant for dark
contexts:

- deep navy for canonical/source or primary structure;
- teal for data movement, conversion, and streaming;
- indigo-violet for people-facing exploration and reuse;
- warm gold for review, citation, and future/roadmap callouts;
- soft ivory backgrounds and pale tinted surfaces on website pages and light
  presentation slides;
- restrained rules, generous whitespace, 2–3 px visual strokes where they carry
  meaning, and short labels in sentence case. Avoid repeated rounded cards or
  decorative gradients; use a framed panel only when it clarifies a system
  boundary or a call to action.

Diagrams are deterministic SVG masters with high-resolution PNG exports. Do not
use Mermaid. Keep labels as real text, provide meaningful alt text and a
caption, avoid decorative arrows that imply unsupported dependencies, and make
the current/planned boundary visible in the figure itself. The selected visual
language is a modern technical atlas: quiet grid, aligned rounded panels,
precise connectors, restrained depth, and an exact NEMAR lockup at lower right.
Light and dark variants keep the same geometry and semantics; only the surface
and contrast palette changes. Image generation was used only to compare visual
substrates; the final figures use exact SVG geometry and typography because a
strict science resource cannot delegate labels or relationships to a
generative image.

Current shared assets:

- `public/figures/nemar-system-map-light.svg` and `.png` — light layers and
  clients;
- `public/figures/nemar-dataset-lifecycle-light.svg` and `.png` — light review,
  DOI, and version loop;
- `public/figures/nemar-edge-compute-light.svg` and `.png` — light Zarr/edge
  flow and planned HPC direction;
- the matching `-dark.svg` and `-dark.png` files — dark-theme variants with the
  same geometry and labels; the unsuffixed SVG/PNG names remain light defaults
  for existing links.

## Source discipline

Before adding a claim, check the live backend contract or the corresponding
`nemar-cli`/docs implementation. Public counts, conversion coverage, endpoint
fields, and roadmap dates are changeable; avoid hardcoding them in evergreen
copy. Link the deeper contract instead of hiding implementation detail, and
label inferences as inferences.
