# ADR 0008: ORCID-primary authentication

**Status:** accepted
**Date:** 2026-05-20
**Owner:** Seyed Yahya Shirazi

## Context

Dataset uploaders and researchers need accounts. Roughly 90%+ of neuroscience/biomedical
researchers hold an ORCID iD, and OpenNeuro (NEMAR's closest peer) migrated to ORCID-only in
2025. An ORCID iD on an account is also a provenance signal. Backfilled 2026-07-07 from
`.context/research.md`.

## Decision

ORCID-primary sign-in. Reuse the backend's opaque session cookie via `issueSession` (no JWT).
Do not store the ORCID access token (its ~20-year expiry makes it a worst-case exfil item);
read `orcid` + `name` from the token body and discard the rest. Collect email via a form on
first login; require GitHub username only at publish time; auto-approve new accounts.

## Consequences

- The ORCID iD doubles as a provenance signal, shown on the profile and dataset rail.
- Minimal token-exfil surface (no long-lived token stored).
- Sign-in requires an ORCID iD; users without one are excluded until an alternative is added.

## Alternatives considered

- **Email/password:** no provenance signal; more credential-handling surface. Rejected.
- **GitHub-primary:** weaker provenance for a research audience and diverges from the peer
  (OpenNeuro). GitHub is still collected, but at publish time, not sign-in.

## Receipts

- `.context/research.md` (ORCID onboarding section); memories `project_legacy_orcid_onboarding`,
  `project_auth_backend_pending`; upstream nemar-cli#832/#833.
