#!/usr/bin/env bash
# Render the Homebrew formula for a released version and put it in the tap.
#
#   scripts/tap.sh v0.1.0                 # render only → dist/orbit.rb
#   scripts/tap.sh v0.1.0 ../homebrew-tap # render and commit into that checkout
#
# The checksums come from the release's own *.sha256 assets, so what the
# formula promises is what CI built, not what this machine has lying around.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
tag="${1:?tag, e.g. v0.1.0}"
tap="${2:-}"
version="${tag#v}"
slug="${ORBIT_REPO:-$(cd "$REPO" && gh repo view --json nameWithOwner -q .nameWithOwner)}"
license="${ORBIT_LICENSE:-MIT}"

sha() {
  gh release download "$tag" --repo "$slug" --pattern "$1.sha256" --output - 2>/dev/null | awk '{print $1}'
}
arm="$(sha orbit-darwin-arm64)"
x64="$(sha orbit-darwin-x64)"
[ -n "$arm" ] && [ -n "$x64" ] || { echo "  release $tag has no orbit-darwin-*.sha256 assets" >&2; exit 1; }

mkdir -p "$REPO/dist"
sed -e "s|@@REPO@@|$slug|g" -e "s|@@VERSION@@|$version|g" -e "s|@@LICENSE@@|$license|g" \
    -e "s|@@SHA_ARM64@@|$arm|g" -e "s|@@SHA_X64@@|$x64|g" \
    "$REPO/packaging/homebrew/orbit.rb.tmpl" > "$REPO/dist/orbit.rb"
echo "  Rendered dist/orbit.rb for $tag"

if [ -n "$tap" ]; then
  mkdir -p "$tap/Formula"
  cp "$REPO/dist/orbit.rb" "$tap/Formula/orbit.rb"
  git -C "$tap" add Formula/orbit.rb
  git -C "$tap" commit -q -m "orbit $version" || echo "  (formula unchanged)"
  echo "  Committed Formula/orbit.rb in $tap — push it and \`brew install $slug/orbit\` follows"
fi
