# ADR 0010: Tiered access — base (auto) vs service (admin-gated)

**Status:** accepted
**Date:** 2026-07-24
**Owner:** Seyed Yahya Shirazi

## Context

ORCID sign-in (ADR 0008) authenticates a person, but ORCID iDs are free to create, so
"ORCID-verified" alone is not authorization to consume NEMAR's finite compute and storage —
without a gate, upload/compute could be abused as free cloud. Separately, NEMAR compute is
subject to export-control and local-jurisdiction restrictions, so granting service access
requires a human to review who the person is and where they are. ADR 0008 said "auto-approve"
and "GitHub only at publish"; in practice new ORCID signups landed `status='pending'` (locked
out of everything) and the admin-approve path could not even address them (username=NULL,
gated on a `verified` status ORCID users never reach — nemar-cli#1012). This ADR resolves both
the drift and the missing authorization tier.

## Decision

Split the single `approved` gate into two tiers:

- **Base access** — granted automatically the moment ORCID sign-in completes. Unlocks browse,
  view, dashboard, settings, and (future) co-author dataset surfacing. No admin action; ORCID
  is the only gate. Implemented by auto-approving the account to base on ORCID finalize.
- **Service access** — a separate per-user grant required to upload or use compute/services.
  Granted by an admin who reviews the person's GitHub handle (identity/accountability) and
  their location (city/country) + affiliation for export-control / local-restriction screening.
  Closed by default: a base user cannot upload until service access is granted. There is no
  self-service path (the prior self-service sandbox-training unlock does not satisfy this gate).

Publishing is unchanged: a per-dataset publication request → admin approval stays on top of
service access, so a dataset's life has two independent human checks (may this person upload;
may this dataset go public).

## Consequences

- Base access is effectively open to anyone with any ORCID iD — accepted, because base access
  grants nothing costly (mostly public data) and the real gatekeeping is at the service tier.
- Compute/storage abuse and export-control exposure are gated behind a deliberate admin review,
  not a sign-in step.
- Rolling the upload gate to production requires backfilling existing uploaders (grandfather
  anyone already `approved` + `sandbox_completed`, plus admins/owners) so they are not locked
  out.
- New obligation: an admin surface to review + grant service access (fits the admin-portal epic
  website#158), and `/auth/me` must expose the service-access flag so the frontend can gate the
  upload UI.
- Supersedes ADR 0008's "GitHub only at publish": GitHub is now required at the service-access
  grant (before upload), which is earlier than publish. Base auto-approve is retained.

## Alternatives considered

- **Single `approved` gate (status quo):** one flip unlocks both view and upload; no way to let
  people look without also letting them consume compute. Rejected — can't express the abuse /
  export-control gate.
- **Sandbox-training as the upload gate (interim option b):** self-service, so it does not gate
  compute behind a human review at all. Rejected by owner ("everything gated").
- **Role-based (add an "uploader" role):** conflates the owner>admin>member hierarchy with an
  orthogonal permission; a separate access axis is cleaner.

## Phasing

- **Now (Phase 1):** auto-approve ORCID base access; add the service-access axis and close the
  upload endpoint behind it; backfill/grandfather existing uploaders; expose the flag on
  `/auth/me`. No grant UI yet — service access is closed for new users until Phase 2.
- **Later (Phase 2):** admin grant flow with export-control review of location/affiliation +
  GitHub requirement (in the admin portal, website#158); user-facing "request upload access".
- **Later (Phase 3):** the compute/service features the grant unlocks.
- **Parked:** legacy account import (nemar-cli#833 / website#129), until the need arises.
- **Future idea:** co-author dataset surfacing — match the signed-in ORCID against dataset
  authors and let people see/pull datasets they co-authored.

## Receipts

- Supersedes part of ADR 0008 (auto-approve retained; "GitHub at publish" tightened to "GitHub
  at service-access grant").
- nemar-cli#1012 (admin cannot approve ORCID/web pending signups — the drift this fixes).
- Admin portal epic website#158 (home of the Phase 2 grant/review UI).
- Export-control intent already present: onboarding collects city/country "required for
  export-control screening".
