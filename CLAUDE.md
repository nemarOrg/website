@AGENTS.md

## Claude Code Specific Instructions

The shared project instructions live in `AGENTS.md`; this file imports them for Claude Code with `@AGENTS.md`.

### First action when resuming this project

Read `.context/handoff.md` before anything else — it has the most recent session's state including open PRs, deploy URLs, blocking issues, and known gotchas.

### Active worktrees

```
/Users/yahya/Documents/git/nemar/website    main — the production branch (CF GitHub integration deploys it)
```

`main` is the production branch on Cloudflare Pages, serving `nemar.org`, `www`, `ww2`, and `app.nemar.org` since the apex cutover (website#190). The redesign epic branch `feature/issue-1-epic-nemar-redesign` is retired.

**Open PRs against `staging`, not `main`.** `staging` leads: work lands there, deploys to test.nemar.org against the nemar-cli `dev` backends for QA, and then promotes to `main` (`git push origin origin/staging:main`). This inverted on 2026-07-29 — staging used to be a fast-forward mirror refreshed *after* each production merge, which meant it could never catch anything. See AGENTS.md "Branch ↔ environment map".

Caveat worth knowing before you rely on a staging soak: `test.nemar.org` resolves to single-host mode, so cross-host redirects, the signed-in redirect suppression, and app-vs-marketing canonical origins are all inert there. Those need checking on production after promotion (website#212).

### Project-specific skill triggers

| When you would... | Use this skill |
|---|---|
| Move to the next phase of the redesign epic | `/project:epic-dev` (current state in `.claude/epic.local.md`) |
| Visual polish or design QA on a deployed preview | `/design-review` against the latest `*.nemar-website.pages.dev` URL |
| Snapshot the dataset detail or Discover page | `/browse` — Playwright Chromium under `~/.claude/skills/gstack/browse/dist/browse` |
| Build a new component from a brief | `/frontend-design:frontend-design` |
| Open a PR | `/ship` (atomic commits, no AI attribution per AGENTS.md) |

### Backend issues to keep in mind

Open `nemarOrg/nemar-cli` issues block parts of this repo (rendering still degrades gracefully without them):

- `#511` — `/qa/*` route for Phase 3 charts + Vis modal
- `#512` — OpenNeuro import doesn't backfill modalities/tasks
- `#513` — File downloads return SHA-named instead of BIDS-shaped
- `#653` — `license` field on catalog rows → Discover license tier filter (color works today; filtering is inactive until this lands)

Don't reimplement these in the frontend — the website already has fallbacks; the upstream fix is the right path.

### Deploy authentication

`cfman wrangler --account sccn` for everything. The token doesn't have memberships scope so always pass `CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"` explicitly (export the SCCN account id from your shell rc or pull it from a password manager). Don't write the account id or the token anywhere in this repo.
