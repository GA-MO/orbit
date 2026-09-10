#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

VERSIONED_FILES=(package.json server/package.json)

version="${1:?version, e.g. 0.2.0}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "  not a version: $version" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "  commit or discard your changes first" >&2; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "  release from main" >&2; exit 1; }
git tag | grep -qx "v$version" && { echo "  v$version already exists" >&2; exit 1; }

# The rehearsal writes two words: the tree it worked from, and the target
# group it built. The shape is unchanged now that Windows is one of the
# targets, because the question it answers is unchanged — was every asset
# this tag will publish built from exactly this tree? A rehearsal of `mac`
# builds two of the three, so its stamp does not say `all` and this refuses
# it, which is the whole point of the second word.
#
# What the stamp does not claim is that every asset ran. A Mac cannot start
# the Windows executable; .github/workflows/release.yml does that on a
# windows-latest runner, and publishes nothing if it fails.
REHEARSED_STAMP='.rehearsed'
EVERY_TARGET_A_RELEASE_PUBLISHES=all

rehearsal_that_covers_this_tree() {
  [ -f "$REHEARSED_STAMP" ] || return 1
  read -r tree targets < "$REHEARSED_STAMP" || return 1
  [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ] &&
    [ "$targets" = "$EVERY_TARGET_A_RELEASE_PUBLISHES" ]
}

rehearsal_that_covers_this_tree || {
  echo "  this exact tree has not been rehearsed" >&2
  echo "  run: scripts/rehearse-release.sh $EVERY_TARGET_A_RELEASE_PUBLISHES" >&2
  exit 1
}

set_version_in() {
  bun -e "const f=process.argv[1];const p=JSON.parse(await Bun.file(f).text());p.version=process.argv[2];await Bun.write(f,JSON.stringify(p,null,2)+'\n')" "$1" "$2"
}

refresh_lockfile_with_workspace_versions() {
  bun install --silent
}

commit_if_anything_changed() {
  git diff --cached --quiet || git commit -q -m "$1"
}

for f in "${VERSIONED_FILES[@]}"; do
  set_version_in "$f" "$version"
done
refresh_lockfile_with_workspace_versions
git add "${VERSIONED_FILES[@]}" bun.lock
commit_if_anything_changed "Release $version"
git tag -a "v$version" -m "orbit $version"
git push -q origin main "v$version"
echo "  Pushed v$version — watch: gh run watch"
