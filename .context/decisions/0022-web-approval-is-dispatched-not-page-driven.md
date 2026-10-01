# ADR 0022: Web approval is started by the backend and run by an executor, never driven by the page

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

## Context

Approving a publication request is not one HTTP call.
The orchestrator runs sixteen steps, and S3 Object Lock, which comes after the irreversible `publish_doi` step, works in batches of 100 objects.
Each batch answers `hasMore` with a continuation token that the caller must send back, so the caller has to loop.
The CLI loops, with retries and `resume`.
The admin page sent one request and reloaded, so any dataset over 100 files would stop at `approving` with its repository public and its DOI published but no S3 lock, no catalog sync and no owner email, and an `approving` row had no button to continue from.
The loop sits in the caller on purpose: running it inside a Cloudflare Worker would cost too much.
The page could not even reach the button until website#407, because the list crashed on the backend's real row shape.

## Decision

The backend route is the contract and executors are pluggable.
The page asks the backend to start an approval (`POST /admin/publish/:id/approve-dispatch`), the backend asks an executor to run it, and the page then reads what the backend reports about the request: `status`, `current_step`, `last_error`, and `approval_in_flight`, which the backend computes so the page holds no timing constant.
For now the executor for a web click is a GitHub Action in `nemarDatasets/.github`; a terminal running `nemar admin publish approve` stays a first-class executor.
The page's code does not call or depend on any executor, though its copy currently names GitHub Actions, and nothing is run on nemaring.
Who approved forks by origin: a CLI approval records the CLI user, a web click records the admin who clicked, with the executing key kept in the audit row.

## Consequences

Closing the page no longer matters, and the page can say so.
The page needs no timing constant: the backend computes `approval_in_flight`, and a backend that does not send it is treated as one that cannot dispatch, so the site degrades to the CLI hint instead of a button that answers 404.
A stalled run (no progress for the backend's lease) shows Resume, a request that never started shows Retry behind the same typed PUBLISH confirmation as the first approval (nothing has run, so it is not a continuation), and the CLI command stays as a fallback for an Actions outage.
A failed run keeps the backend's lease until it lapses, so for up to fifteen minutes it is still "in flight"; the row shows the error and the CLI command during that time instead of claiming the run is progressing.
An anonymous release gets its own confirmation words, because the data goes public while the repository stays private and no DOI is published.
The page now depends on the backend deploying first, then the central workflow, then the site; `WEB_PUBLISH_APPROVE_ENABLED` is the kill switch.
A run's progress is only as fresh as the page's 20 second refresh.

## Alternatives considered

- **Loop in the browser, as the CLI does:** it would work, but only while the tab stays open, and a closed tab would strand the dataset mid-lock again. It needs a keep-the-page-open warning and a resume path anyway.
- **Run everything in the Worker:** the cost is the reason the loop moved to the caller.
- **Make GitHub the only executor:** one more single dependency on one route; the contract keeps the terminal path and leaves room for another executor.
- **Leave the button off and use the CLI only:** this is the interim guard in website#407, safe but not what an admin team that approves from the web needs.

## Receipts

- website#200 (the original non-blocking request) and the finding recorded there on 2026-10-01.
- website#407 (list fix and interim guard) and website#408 (this change).
- nemar-cli `src/lib/api/publish.ts` (`approvePublication`, the loop) and `backend/src/services/publication-orchestrator.ts` (step 14, `hasMore`).
- `nemarDatasets/.github` `onboard-openneuro.yml` (the existing Actions-runs-the-CLI pattern).
