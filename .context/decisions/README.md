# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant decisions that shape the project: choice of stack, structural patterns, trade-offs accepted, alternatives rejected. Tuck them all in here so they are easy to find later.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, zero-padded to four digits.
- `0000-template.md` is the template; copy it to start a new ADR. Do not edit `0000-template.md` itself.
- Number sequentially. The next ADR after `0007-...` is `0008-...`.
- Status flows `proposed` -> `accepted` -> (later) `superseded by ADR-NNNN`. Never delete an ADR; supersede it.
- Keep each ADR short. If it grows past two screens, you are probably writing a design doc, not a decision.

## When to write an ADR

Write one when a decision:
- Will be hard or expensive to reverse.
- Cuts off other reasonable paths a future contributor might wonder about.
- Has been argued about more than once.
- Embeds a constraint (legal, performance, schedule) that is not obvious from the code.

Do not write one for routine choices that are obvious from reading the code.

## Index

Add new entries here as you create ADRs:

- ADR 0000 - template (do not edit)
- ADR 0001 - [Astro (server output + islands) as the frontend framework](0001-astro-ssr-islands-frontend.md) (accepted)
- ADR 0002 - [Cloudflare Pages as the deploy target](0002-cloudflare-pages-deploy-target.md) (accepted)
- ADR 0003 - [Bun as the package manager and runtime](0003-bun-package-manager-runtime.md) (accepted)
- ADR 0004 - [Vanilla CSS with design tokens (no Tailwind, no CSS-in-JS)](0004-vanilla-css-design-tokens.md) (accepted)
- ADR 0005 - [Reuse the api/data.nemar.org backends; never reimplement them](0005-reuse-backend-never-reimplement.md) (accepted)
- ADR 0006 - [Two-host model (marketing + authenticated) on one build with edge middleware](0006-two-host-marketing-app-model.md) (accepted)
- ADR 0007 - [Hand-rolled SVG charts (no chart library)](0007-hand-rolled-svg-charts.md) (accepted)
- ADR 0008 - [ORCID-primary authentication](0008-orcid-primary-authentication.md) (accepted)
- ADR 0009 - [Route-scoped CSP `'unsafe-eval'` for the zarr signal-viewer codecs](0009-route-scoped-csp-unsafe-eval-zarr-viewer.md) (accepted)
- ADR 0010 - [Tiered access: base (auto) vs service (admin-gated)](0010-tiered-access-base-service.md) (accepted)
- ADR 0011 - [Soften the upload profile gate for existing service-access users](0011-soften-upload-profile-gate.md) (accepted)
- ADR 0012 - [Recording navigation detaches the viewer from its inline row](0012-viewer-navigation-detaches-inline-row.md) (accepted)
