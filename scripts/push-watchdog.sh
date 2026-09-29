#!/usr/bin/env bash
# Replays pushes that GitHub never delivered (website#374). Run every ten
# minutes by .github/workflows/push-watchdog.yml.
#
# For each branch: when its tip is older than GRACE_MINUTES and not one
# workflow run exists for that commit, dispatch the workflows its push would
# have started, and say so on the tracking issue. A delivered push starts its
# runs within seconds; the late deliveries seen so far took about four minutes.
#
#   GH_REPO=nemarOrg/website DRY_RUN=1 scripts/push-watchdog.sh
#   GH_REPO=nemarOrg/website DRY_RUN=1 scripts/push-watchdog.sh staging=<sha>
#
# `branch=sha` arguments check those commits instead of the tips, which is how
# to try it against a commit that never had runs; they require DRY_RUN=1.
# Needs GH_REPO, and GH_TOKEN or a signed-in gh. DRY_RUN=1 changes nothing.
set -euo pipefail

: "${GH_REPO:?set GH_REPO to owner/name}"
GRACE_MINUTES="${GRACE_MINUTES:-5}"
DRY_RUN="${DRY_RUN:-0}"
ISSUE="${WATCHDOG_ISSUE:-}"
RUN_URL=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

# What a push to each branch starts. Release is path-filtered to package.json
# on push, but it is idempotent (it skips a tag that already exists), so
# replaying it for any tip of main is safe.
workflows_for() {
  case "$1" in
    staging) echo "auto-bump-staging.yml ci.yml deploy-test.yml" ;;
    main) echo "ci.yml release.yml" ;;
    *)
      echo "no workflows known for branch '$1'" >&2
      return 1
      ;;
  esac
}

if [ $# -eq 0 ]; then
  set -- staging main
fi

for target in "$@"; do
  branch="${target%%=*}"
  ref="$branch"
  if [[ "$target" == *=* ]]; then
    ref="${target#*=}"
    if [ "$DRY_RUN" != 1 ]; then
      echo "checking a specific commit ($target) requires DRY_RUN=1" >&2
      exit 2
    fi
  fi
  workflows=$(workflows_for "$branch")

  read -r sha age < <(gh api "repos/$GH_REPO/commits/$ref" \
    -q '[.sha, ((now - (.commit.committer.date | fromdateiso8601)) / 60 | floor)] | @tsv')
  short="${sha:0:8}"

  if ((age < GRACE_MINUTES)); then
    echo "$branch $short: $age min old, inside the grace period"
    continue
  fi

  # Every run for this commit except the watchdog's own: a scheduled run is
  # recorded against the default branch's tip, which would otherwise make a
  # dropped push to main look delivered.
  runs=$(gh api "repos/$GH_REPO/actions/runs?head_sha=$sha&per_page=100" \
    -q '[.workflow_runs[] | select(.path | endswith("push-watchdog.yml") | not)] | length')
  if ((runs > 0)); then
    echo "$branch $short: $runs run(s), nothing to replay"
    continue
  fi

  echo "::warning::$branch $short is $age min old and nothing ran for it; replaying its push"
  for workflow in $workflows; do
    if [ "$DRY_RUN" = 1 ]; then
      echo "  would dispatch $workflow on $branch"
    else
      gh workflow run "$workflow" --repo "$GH_REPO" --ref "$branch"
      echo "  dispatched $workflow on $branch"
    fi
  done

  # Cloudflare builds production from its own GitHub App, which a dropped
  # push also never reaches, and nothing here can start that build.
  cloudflare=""
  if [ "$branch" = main ]; then
    built=$(gh api "repos/$GH_REPO/commits/$sha/check-suites" \
      -q '[.check_suites[] | select(.app.slug == "cloudflare-workers-and-pages")] | length')
    if [ "$built" = 0 ]; then
      cloudflare=" Cloudflare has not built it either: retry the production deployment for this commit in the Cloudflare dashboard, then check that https://nemar.org/version.json reports it."
    fi
  fi

  body="Push watchdog: the \`$branch\` tip $sha was $age min old and no workflow had run for it, so its push was not delivered. Dispatched ${workflows// /, } on \`$branch\`.$cloudflare"
  if [ -n "$RUN_URL" ]; then
    body="$body Run: $RUN_URL"
  fi
  if [ "$DRY_RUN" = 1 ] || [ -z "$ISSUE" ]; then
    echo "  comment: $body"
  else
    gh issue comment "$ISSUE" --repo "$GH_REPO" --body "$body"
  fi
done
