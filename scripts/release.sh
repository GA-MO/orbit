#!/usr/bin/env bash
# Cut a release: set the version in both package.json files, commit, tag,
# push. CI (.github/workflows/release.yml) does the rest — builds both Mac
# binaries, attaches them with checksums, and updates the Homebrew tap.
#
#   scripts/release.sh 0.2.0
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
version="${1:?version, e.g. 0.2.0}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "  not a version: $version" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "  commit or discard your changes first" >&2; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "  release from main" >&2; exit 1; }
git tag | grep -qx "v$version" && { echo "  v$version already exists" >&2; exit 1; }

for f in package.json server/package.json; do
  bun -e "const f=process.argv[1];const p=JSON.parse(await Bun.file(f).text());p.version=process.argv[2];await Bun.write(f,JSON.stringify(p,null,2)+'\n')" "$f" "$version"
done
bun install --silent   # the lockfile carries the workspace versions
git add package.json server/package.json bun.lock
# The first release of a version the files already carry has nothing to commit.
git diff --cached --quiet || git commit -q -m "Release $version"
git tag -a "v$version" -m "orbit $version"
git push -q origin main "v$version"
echo "  Pushed v$version — watch: gh run watch"
