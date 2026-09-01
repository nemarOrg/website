# ADR 0012: Recording navigation detaches the viewer from its inline row

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

The signal viewer opens inline, under the BIDS tree row for the recording it shows, and moves into the page dialog when the user asks to enlarge it (website#217).
Website#253 adds subject/task dropdowns and prev/next controls to that dialog, so the recording on screen can change while the viewer stays mounted.
The inline row and the dialog then disagree: the row still names the file the user clicked, the dialog shows a different one.
The recording list comes from the Zarr `index.json`, not from the DOM, and the tree loads directories lazily, so the recording navigated to frequently has no row rendered at all.

## Decision

The first navigation inside the dialog collapses the originating inline row and hands ownership of the viewer to the dialog.
A viewer in that state is not returned inline when the dialog closes; it is destroyed.

## Consequences

The row and the dialog can never describe different recordings.
Closing the dialog after navigating loses the viewer's state, where closing it without navigating still returns the user to exactly the montage and time window they left with — a small asymmetry, and the same one the user created by navigating away from the row they opened.
`releaseEegViewer` and the dialog `close` handler both branch on the detached flag; anything added to that state machine has to respect it.
The inline panel stays a one-recording surface, which is what keeps it cheap: no controls, no list, no ownership question.

## Alternatives considered

- **Re-anchor the viewer under the new recording's row.** The honest version of "keep the inline panel truthful", and it is what a reader expects at first glance. It cannot be done reliably: the target recording usually sits in a directory the user never expanded, so there is no row to anchor to, and synthesizing one means the page starts inventing tree structure that the lazy dir-listing owns.
- **Leave the row expanded and untouched.** Cheapest, and wrong: a panel captioned `sub-01_task-rest_eeg.set` sitting under a viewer showing `sub-04_task-oddball_run-02_eeg.set` reads as a bug, and the Enlarge/close round trip would then restore a viewer to a row that never described it.
- **Put the navigation controls inline as well.** Rejected in the issue itself: the inline panel is a glance at one file, and re-anchoring on every step is exactly the confusion above, once per click.

## Receipts

- Issue nemarOrg/website#253 (part of epic #256), which specifies enlarge-mode-first navigation and leaves the inline behaviour to implementation.
- `navigateEegViewer` in `src/pages/dataset/[id].astro` and the `detached` flag on `eegLive`.
- ADR-adjacent prior art: website#217 (inline-first viewer with an enlarge handoff) and website#208 (mount supersession, which the swap reuses).
