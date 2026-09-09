#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
tag="${1:?tag, e.g. v0.1.0}"
tap="${2:-}"
version="${tag#v}"
repo_slug="${ORBIT_REPO:-$(cd "$REPO" && gh repo view --json nameWithOwner -q .nameWithOwner)}"
license="${ORBIT_LICENSE:-MIT}"

TEMPLATE="$REPO/packaging/homebrew/orbit.rb.tmpl"
RENDERED="$REPO/dist/orbit.rb"

checksum_the_release_published_for() {
  gh release download "$tag" --repo "$repo_slug" --pattern "$1.sha256" --output - 2>/dev/null | awk '{print $1}'
}

render_formula() {
  sed -e "s|@@REPO@@|$repo_slug|g" -e "s|@@VERSION@@|$version|g" -e "s|@@LICENSE@@|$license|g" \
      -e "s|@@SHA_ARM64@@|$arm|g" -e "s|@@SHA_X64@@|$x64|g" \
      "$TEMPLATE" > "$RENDERED"
}

commit_into_tap() {
  mkdir -p "$1/Formula"
  cp "$RENDERED" "$1/Formula/orbit.rb"
  git -C "$1" add Formula/orbit.rb
  git -C "$1" commit -q -m "orbit $version" || echo "  (formula unchanged)"
  echo "  Committed Formula/orbit.rb in $1 — push it and \`brew install $repo_slug/orbit\` follows"
}

arm="$(checksum_the_release_published_for orbit-darwin-arm64)"
x64="$(checksum_the_release_published_for orbit-darwin-x64)"
[ -n "$arm" ] && [ -n "$x64" ] || { echo "  release $tag has no orbit-darwin-*.sha256 assets" >&2; exit 1; }

mkdir -p "$REPO/dist"
render_formula
echo "  Rendered dist/orbit.rb for $tag"

if [ -n "$tap" ]; then
  commit_into_tap "$tap"
fi
