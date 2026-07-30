#!/bin/bash
# Version bump script for nemar-website (website#214).
#
# Ported from nemar-cli's scripts/bump-version.sh so the two repos share one
# mental model. Two deliberate differences:
#
#   - Branch guard names `staging` (not `dev`), matching this repo's
#     branch/environment map in AGENTS.md.
#   - No `bun run build` verification step. nemar-cli runs one to prove the
#     bump took; here `bun run build` also renders every OG card, which costs
#     minutes for a one-field edit. We validate the rewritten package.json
#     parses and carries the expected version instead, which catches the same
#     class of failure (a botched write) at no cost.
#
# Usage:
#   ./scripts/bump-version.sh patch         # 1.0.0-dev3 -> 1.0.1, 1.0.0 -> 1.0.1
#   ./scripts/bump-version.sh minor         # 1.0.0 -> 1.1.0
#   ./scripts/bump-version.sh major         # 1.0.0 -> 2.0.0
#   ./scripts/bump-version.sh dev           # 1.0.0 -> 1.0.1-dev
#   ./scripts/bump-version.sh dev0          # 1.0.0 -> 1.0.1-dev0 (numbered)
#   ./scripts/bump-version.sh dev4          # 1.0.0-dev3 -> 1.0.0-dev4
#   ./scripts/bump-version.sh rc            # 1.0.0-beta -> 1.0.0-rc
#   ./scripts/bump-version.sh 1.2.0         # Set explicit version
#   ./scripts/bump-version.sh 1.2.0-dev0    # Set explicit version with suffix

set -euo pipefail

usage() {
  echo "Usage: $0 <patch|minor|major|dev|dev<N>|alpha|beta|rc|version>"
  echo ""
  echo "Semver bumps (strip any pre-release suffix):"
  echo "  $0 patch    # 1.0.0-dev3 -> 1.0.1"
  echo "  $0 minor    # 1.0.0 -> 1.1.0"
  echo "  $0 major    # 1.0.0 -> 2.0.0"
  echo ""
  echo "Pre-release bumps (add/change suffix; bump patch when leaving a clean version):"
  echo "  $0 dev      # 1.0.0 -> 1.0.1-dev"
  echo "  $0 dev0     # 1.0.0 -> 1.0.1-dev0   (numbered: dev0, dev1, ...)"
  echo "  $0 dev4     # 1.0.0-dev3 -> 1.0.0-dev4"
  echo "  $0 rc       # 1.0.0-beta -> 1.0.0-rc"
  echo ""
  echo "Explicit version:"
  echo "  $0 1.2.0"
  echo "  $0 1.2.0-dev0"
}

if [ -z "${1:-}" ]; then
  usage
  exit 1
fi

VERSION_TYPE="$1"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
PKG="$REPO_ROOT/package.json"

if [ ! -f "$PKG" ]; then
  echo "Error: $PKG not found" >&2
  exit 1
fi

# Branch guard: clean release versions land only on `staging` or `main`, so a
# feature branch can never quietly claim a released version number.
# Pre-release bumps are unrestricted — that is the point of a pre-release.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
is_release_on_wrong_branch() {
  [ "$CURRENT_BRANCH" != "staging" ] && [ "$CURRENT_BRANCH" != "main" ]
}

case "$VERSION_TYPE" in
  patch|minor|major)
    if is_release_on_wrong_branch; then
      echo "Error: Release bumps ($VERSION_TYPE) only allowed on staging or main." >&2
      echo "Current branch: $CURRENT_BRANCH" >&2
      echo "Use a pre-release bump (dev/alpha/beta/rc) on feature branches." >&2
      exit 1
    fi
    ;;
  dev|alpha|beta|rc)
    ;; # Pre-release keywords allowed anywhere.
  dev[0-9]*)
    # The case glob is permissive (it would also match `dev0a`), so anchor it.
    if [[ ! "$VERSION_TYPE" =~ ^dev[0-9]+$ ]]; then
      echo "Error: numbered dev pre-release must match dev<N> (got '$VERSION_TYPE')" >&2
      exit 1
    fi
    ;;
  *)
    if [[ "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && is_release_on_wrong_branch; then
      echo "Error: Release versions ($VERSION_TYPE) only allowed on staging or main." >&2
      echo "Current branch: $CURRENT_BRANCH" >&2
      exit 1
    fi
    if [[ ! "$VERSION_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
      echo "Error: unrecognised argument '$VERSION_TYPE'" >&2
      echo "" >&2
      usage >&2
      exit 1
    fi
    ;;
esac

CURRENT=$(node -p "require('$PKG').version")

if [[ ! "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z.]+))?$ ]]; then
  echo "Error: current version '$CURRENT' is not semver" >&2
  exit 1
fi
MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"
PRERELEASE="${BASH_REMATCH[5]:-}"

# Pre-release bumps keep the same base when one is already in flight, and
# bump patch when leaving a clean release. Without that, cutting a `-dev0`
# straight after 1.0.0 would reuse 1.0.0 and produce a pre-release that sorts
# *below* an already-published version.
next_prerelease() {
  local suffix="$1"
  if [ -n "$PRERELEASE" ]; then
    echo "$MAJOR.$MINOR.$PATCH-$suffix"
  else
    echo "$MAJOR.$MINOR.$((PATCH + 1))-$suffix"
  fi
}

case "$VERSION_TYPE" in
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  patch)
    # A pre-release already sits on the target patch number, so `patch` from
    # 1.0.1-dev3 releases 1.0.1 rather than skipping to 1.0.2.
    if [ -n "$PRERELEASE" ]; then
      NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    else
      NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    fi
    ;;
  dev|alpha|beta|rc|dev[0-9]*) NEW_VERSION="$(next_prerelease "$VERSION_TYPE")" ;;
  *) NEW_VERSION="$VERSION_TYPE" ;;
esac

if [ "$NEW_VERSION" = "$CURRENT" ]; then
  echo "Version already $CURRENT — nothing to do."
  exit 0
fi

echo "Bumping $CURRENT -> $NEW_VERSION"

# Rewrite through JSON.parse/stringify so key order and formatting survive,
# rather than a regex over the raw text that could match a dependency range.
node -e "
  const fs = require('fs');
  const path = '$PKG';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

# Verify the write landed and the file still parses. This is the cheap
# stand-in for nemar-cli's full build check.
WROTE=$(node -p "require('$PKG').version")
if [ "$WROTE" != "$NEW_VERSION" ]; then
  echo "Error: package.json still reads '$WROTE' after write" >&2
  exit 1
fi

git -C "$REPO_ROOT" add package.json
git -C "$REPO_ROOT" commit -m "chore: bump version to $NEW_VERSION"

echo "Committed: chore: bump version to $NEW_VERSION"
