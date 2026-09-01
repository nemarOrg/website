# ADR 0013: Viewer annotations are two BIDS kinds, stored locally only

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

The signal viewer gained HED annotation authoring (website#255, epic #256 Phase 4):
a clinician can mark what they see on the trace using the SCORE clinical EEG vocabulary
and base HED's artifact terms. Two questions had to be settled before any of it could be
written, and both are expensive to revisit once people have annotations on disk.

First, what an annotation *is*. BIDS already has two separate answers for two separate
statements, with different files, different columns and different semantics: `events.tsv`
for something that happened at a time, `channels.tsv` for a standing property of an
electrode. A single "annotation" type spanning both would have to invent a meaning for a
channel mark's onset, or for an event's channel scope.

Second, where annotations live. NEMAR has a Cloudflare backend that could store them, and
the issue explicitly left the choice open. Annotations are tiny text, but they are also
somebody's unpublished clinical reading of a public dataset.

## Decision

Model annotations as two disjoint kinds — `TimeAnnotation` (an `events.tsv` row, duration
0 for a point marker) and `ChannelAnnotation` (a `channels.tsv` row with `status` /
`status_description`) — kept separate through the model, persistence and export, with a
separate download per kind.

Store them only in the annotator's own browser (IndexedDB, keyed by dataset id + dataset
version + recording path), with `events.tsv` / `channels.tsv` export always available and
no server component in v1.

## Consequences

Easier: each export is a real BIDS file that can be dropped into a dataset unmodified,
because neither kind had to be bent to fit the other. The channel kind reuses the viewer's
existing bad-channel marking as its selection gesture, so there is one way to pick channels
rather than two competing ones. Nothing to authenticate, rate-limit, or moderate, so the
feature ships whole for anonymous readers — which is most of NEMAR's traffic.

Harder: annotating *a time range on one channel* is the intersection of the two kinds and
is deliberately not expressible. That is the common case in some clinical workflows, and
answering it later means deciding what such a row means on export (an `events.tsv` row with
a `channel` column is the likely shape — the model leaves room, but v1 carries no such
field, so no reader can mistake an unscoped annotation for a scoped one that lost its
scope).

Also harder: annotations do not follow the user. A different browser, a cleared profile or
a private window starts empty, and there is no sharing, no review, and no contribution path
back to the dataset. The viewer is therefore obliged to say so — an in-panel notice and a
`beforeunload` confirm whenever there is unsaved-anywhere work — and that obligation is
permanent for as long as storage stays local.

## Alternatives considered

- **One `Annotation` type with optional `onset` and optional `channel`.** Fewer types, but
  every consumer then branches on which fields are set, and the exporter has to decide at
  write time which BIDS file a given row belongs in. The branch does not disappear; it just
  moves somewhere less obvious than the type.
- **Server-side storage from day one (D1 or KV behind `api.nemar.org`).** The prerequisite
  for cross-device access and any future shared annotation layer. Rejected for v1 because it
  buys a single user nothing — the data is tiny and local — while adding an auth boundary,
  a moderation question, and a nemar-cli dependency to a feature that is otherwise entirely
  frontend. Revisit when *sharing* is the goal rather than storage.
- **Keying persistence by user id.** Rejected: the issue requires persistence regardless of
  sign-in, and a user-keyed store would silently orphan everything an anonymous annotator
  had done the moment they signed in.
- **Fetching the HED schemas at runtime from the schema server.** Rejected for the same
  reason the rest of the viewer is offline-capable: it puts a third-party host in the
  critical path of a UI interaction, and the schemas change far more slowly than a page
  load. The vocabulary ships as a generated, committed JSON bundle instead
  (`scripts/extract-hed-vocab.mjs`), loaded as a lazy chunk on first use.

## Receipts

- website#255 (the issue, including its own local-only-plus-export recommendation)
- website#256 (viewer workbench epic), ADR 0012 (recording navigation)
- BIDS spec: task events (`events.tsv`) and channels description (`channels.tsv`)
- HED-SCORE library schema 2.1.0, base HED 8.4.0 (`hed-standard/hed-schemas`)

## Update — 2026-09-01

The vocabulary that ships with the bundle is no longer curated. Search now reaches the
full non-deprecated tag set of both schemas (1525 entries, ~341 KB; website#269) after an
earlier curated subset was found to hide most of base HED — asking for "Building", "Left"
or "Sleep" returned nothing. Curation survives only in the quick picks, which decide what
the popover *offers* before anyone types, not what the search can *find*.

The decision above is unchanged: the alternative it rejected was fetching the schemas at
runtime, and the bundle is still a generated, committed, lazily loaded chunk. Only its
contents grew.
