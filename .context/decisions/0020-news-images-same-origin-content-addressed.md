# ADR 0020: News images are site-relative, content-addressed, and served same-origin

**Status:** accepted
**Date:** 2026-09-29
**Owner:** Seyed Yahya Shirazi

## Context

News posts (website#371) carry a banner and inline images that admins upload from `/admin/news`.
The bytes live in the API Worker's R2 bucket (nemar-cli#1551, nemar-cli ADR 0076).
Every page here ships `img-src 'self' data:`, so an image served from another host would not load.
The admin editor runs on `app.nemar.org` while readers are on `nemar.org`, and staging (`test.nemar.org`) reads a different backend than production.

## Decision

A post stores image URLs as site-relative paths, `/news/media/<sha256>.<ext>`, never as absolute URLs.
This site serves that path itself by streaming the object from `${apiBase}/news/media/<file>`,
marks it immutable (the name is the content hash), and lists `/news/media` as a host-neutral route
so neither host redirects it to the other.
Only paths of that exact shape render: as a banner, and as a figure in a post body
(the Markdown renderer's `allowImage` is `isNewsMediaUrl`).

## Consequences

- The same stored post renders on production, staging, and a local dev server, each against its own backend, with no rewriting.
- The CSP stays `img-src 'self'`; no new image host is trusted.
- Every image passes through this Worker once per edge location; after that the edge cache serves it.
- A body cannot embed an image from anywhere else, including a legitimate external figure. Upload it instead.
- Moving images to another host later means rewriting stored post bodies and banners, since the path is in the data.

## Alternatives considered

- **Absolute URLs to a public R2 domain (for example `media.nemar.org`):** widens `img-src` on every page, and ties stored posts to one environment's host.
- **Absolute URLs to `api.nemar.org/news/media`:** the same CSP widening, and staging posts would point at production's API.
- **Images in this repository as Astro assets:** needs a deploy per post, which defeats an admin-published news section.

## Receipts

- website#371, nemar-cli#1551
- `src/pages/news/media/[file].ts`, `src/lib/news.ts` (`isNewsMediaUrl`), `src/lib/host.ts` (`HOST_NEUTRAL_ROUTE_PREFIXES`)
