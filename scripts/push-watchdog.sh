#!/usr/bin/env bash
# Replays pushes that GitHub never delivered (website#374). Run every ten
# minutes by .github/workflows/push-watchdog.yml.
#
# For each branch: when its tip is older than GRACE_MINUTES and no workflow
# has run for that commit on that branch, dispatch the workflows its push
# would have started, and say so on the tracking issue. A delivered push
# starts its runs within seconds; the late deliveries seen so far took about
# four minutes. The age is the commit date, since GitHub does not expose when
# a push landed.
#
#   GH_REPO=nemarOrg/website DRY_RUN=1 scripts/push-watchdog.sh
#   GH_REPO=nemarOrg/website DRY_RUN=1 scripts/push-watchdog.sh staging=<sha>
#
# `branch=sha` arguments check those commits instead of the tips, which is how
# to try it against a commit that never had runs; they require DRY_RUN=1.
# Needs GH_REPO, and GH_TOKEN or a signed-in gh. DRY_RUN=1 changes nothing.
#
# No `set -e`: each branch is checked on its own, so a failed call on one is
# reported and counted rather than silently skipping the other. Any failure
# makes the run exit non-zero.
set -uo pipefail

: "${GH_REPO:?set GH_REPO to owner/name}"
GRACE_MINUTES="${GRACE_MINUTES:-10}"
DRY_RUN="${DRY_RUN:-0}"
ISSUE="${WATCHDOG_ISSUE:-}"
RUN_URL=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

# What a push to each branch starts, most important first: a later dispatch
# that fails leaves the earlier runs in place, and the next pass then counts
# the branch as delivered. Release is path-filtered to package.json on push,
# but it skips a tag that already exists, so replaying it is harmless; on a
# main that still carries a -devN version it fails loudly, which is the right
# signal.
workflows_for() {
  case "$1" in
    staging) echo "deploy-test.yml auto-bump-staging.yml ci.yml" ;;
    main) echo "release.yml ci.yml" ;;
    *)
      echo "::error::no workflows known for branch '$1'"
      return 1
      ;;
  esac
}

# The tip's sha, its age in minutes, and whether its message tells GitHub to
# skip push workflows (in which case no runs is expected, not a lost push).
# shellcheck disable=SC2016 # the jq program is single-quoted on purpose
TIP_QUERY='[
  .sha,
  ((now - (.commit.committer.date | fromdateiso8601)) / 60 | floor),
  (.commit.message | test("\\[(skip ci|ci skip|no ci|skip actions|actions skip)\\]|(^|\\n)skip-checks: ?true"))
] | @tsv'

check() {
  local branch="$1" ref="$2" workflows info sha age skip runs short
  workflows=$(workflows_for "$branch") || return 1

  if ! info=$(gh api "repos/$GH_REPO/commits/$ref" -q "$TIP_QUERY"); then
    echo "::error::$branch: could not read the commit $ref"
    return 1
  fi
  IFS=$'\t' read -r sha age skip <<<"$info"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ || ! "$age" =~ ^-?[0-9]+$ ]]; then
    echo "::error::$branch: unexpected commit data '$info'"
    return 1
  fi
  short="${sha:0:8}"

  if ((age < GRACE_MINUTES)); then
    echo "$branch $short: $age min old, inside the grace period"
    return 0
  fi
  if [ "$skip" = true ]; then
    echo "$branch $short: its message skips push workflows, nothing to replay"
    return 0
  fi

  # Runs for this commit on this branch, except the watchdog's own (a
  # scheduled run is recorded against main's tip). Counting other branches
  # would let, say, a staging run hide a dropped fast-forward push to main.
  if ! runs=$(gh api "repos/$GH_REPO/actions/runs?head_sha=$sha&per_page=100" \
    -q "[.workflow_runs[] | select(.head_branch == \"$branch\") | select(.path | endswith(\"push-watchdog.yml\") | not)] | length"); then
    echo "::error::$branch $short: could not list its workflow runs"
    return 1
  fi
  if ((runs > 0)); then
    echo "$branch $short: $runs run(s), nothing to replay"
    return 0
  fi

  echo "::warning::$branch $short is $age min old and nothing ran for it; replaying its push"
  local dispatched="" failed="" workflow
  for workflow in $workflows; do
    if [ "$DRY_RUN" = 1 ]; then
      echo "  would dispatch $workflow on $branch"
      dispatched="$dispatched $workflow"
    elif gh workflow run "$workflow" --repo "$GH_REPO" --ref "$branch"; then
      echo "  dispatched $workflow on $branch"
      dispatched="$dispatched $workflow"
    else
      echo "::error::could not dispatch $workflow on $branch"
      failed="$failed $workflow"
    fi
  done

  local body="Push watchdog: the \`$branch\` tip $sha was $age min old and no workflow had run for it on \`$branch\`, so its push looks undelivered."
  if [ -n "$dispatched" ]; then
    body="$body Dispatched:$dispatched."
  fi
  if [ -n "$failed" ]; then
    body="$body Could not dispatch:$failed; start these by hand."
  fi

  # Cloudflare builds production from its own GitHub App, which an
  # undelivered push also misses, and nothing here can start that build.
  # Its build has also arrived late rather than never, so this is a prompt
  # to look, not a verdict.
  if [ "$branch" = main ]; then
    local built
    if ! built=$(gh api "repos/$GH_REPO/commits/$sha/check-suites" \
      -q '[.check_suites[] | select(.app.slug == "cloudflare-workers-and-pages")] | length'); then
      body="$body Could not check whether Cloudflare built it; confirm that https://nemar.org/version.json reports it."
      failed="$failed check-suites"
    elif [ "$built" = 0 ]; then
      body="$body Cloudflare has not started a build for it yet: if https://nemar.org/version.json does not report it soon, retry the production deployment in the Cloudflare dashboard."
    fi
  fi

  if [ -n "$RUN_URL" ]; then
    body="$body Run: $RUN_URL"
  fi
  if [ "$DRY_RUN" = 1 ] || [ -z "$ISSUE" ]; then
    echo "  comment: $body"
  elif ! gh issue comment "$ISSUE" --repo "$GH_REPO" --body "$body"; then
    echo "::error::could not comment on #$ISSUE: $body"
    failed="$failed comment"
  fi

  [ -z "$failed" ]
}

if [ $# -eq 0 ]; then
  set -- staging main
fi

failures=0
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
  check "$branch" "$ref" || failures=$((failures + 1))
done

if ((failures > 0)); then
  echo "::error::$failures branch check(s) failed; see above"
  exit 1
fi
