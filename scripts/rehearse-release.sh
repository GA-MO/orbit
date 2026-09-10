#!/usr/bin/env bash
# What a release does, done here first, with the one thing that makes a bad
# build show up locally: the tree it was built from is deleted before the
# executable is asked to run. A bundler bakes absolute paths in, and on the
# machine that built it those paths exist — which is how 0.2.0 was published
# from CI and died on the first Mac that ran it.
#
#   scripts/rehearse-release.sh          # this Mac's architecture only (faster)
#   scripts/rehearse-release.sh all      # both Mac architectures, as a release builds
#
# Prints what it proved, and exits non-zero at the first thing it could not.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TARGETS="${1:-host}"
ARCH="$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 )"
WORK="$(mktemp -d /tmp/orbit-rehearse-XXXXXX)"
BUILD_FROM="$WORK/somewhere-else/orbit"
ARTIFACTS="$WORK/release"
INSTALL_DIR="$WORK/bin"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n  %s\n' "$*"; }
proved() { printf '    ✔ %s\n' "$*"; }

step "Building from $BUILD_FROM"
mkdir -p "$BUILD_FROM" "$ARTIFACTS"
rsync -a --exclude node_modules --exclude dist --exclude .git --exclude web/dist ./ "$BUILD_FROM/"
(cd "$BUILD_FROM" && bun install --silent && bash scripts/dist.sh "$TARGETS") >"$WORK/build.log" 2>&1 || {
  cat "$WORK/build.log" >&2
  echo "    the build failed — nothing to rehearse" >&2
  exit 1
}

if [ "$TARGETS" = host ]; then
  cp "$BUILD_FROM/dist/orbit" "$ARTIFACTS/orbit-darwin-$ARCH"
  (cd "$ARTIFACTS" && shasum -a 256 "orbit-darwin-$ARCH" > "orbit-darwin-$ARCH.sha256")
else
  cp "$BUILD_FROM"/dist/orbit-darwin-* "$ARTIFACTS/"
fi
printf 'v%s\n' "$(bun -e "console.log(JSON.parse(await Bun.file('server/package.json').text()).version)")" > "$ARTIFACTS/VERSION"

step "Deleting the tree it was built from"
chmod -R u+w "$WORK/somewhere-else" && rm -rf "$WORK/somewhere-else"
[ ! -d "$BUILD_FROM" ] || { echo "    could not delete $BUILD_FROM" >&2; exit 1; }
proved "the path baked into the executable no longer exists"

step "Verifying the checksums a release would publish"
(cd "$ARTIFACTS" && for f in *.sha256; do shasum -a 256 -c "$f" >/dev/null; done)
proved "every asset matches its .sha256"

step "Installing it the way a stranger does"
env -i HOME="$WORK/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  ORBIT_LOCAL_DIR="$ARTIFACTS" ORBIT_INSTALL_DIR="$INSTALL_DIR" ORBIT_NO_MODIFY_PATH=1 \
  bash install.sh >/dev/null
BIN="$INSTALL_DIR/orbit"
[ -x "$BIN" ] || { echo "    install.sh left no executable at $BIN" >&2; exit 1; }
proved "install.sh verified the checksum and installed $("$BIN" version)"

step "Running the smoke suite against the installed executable"
ORBIT_BIN="$BIN" bash scripts/test.sh smoke >"$WORK/smoke.log" 2>&1 || {
  tail -30 "$WORK/smoke.log" >&2
  echo "    smoke failed — do not release this" >&2
  exit 1
}
proved "$(grep -cE '^  ok ' "$WORK/smoke.log") checks passed against the installed executable"

step "Checking the subcommands a fresh machine reaches for"
"$BIN" help >/dev/null && proved "orbit help"
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}' | "$BIN" hook approve >/dev/null && proved "orbit hook approve"
echo '{"hook_event_name":"Stop"}' | "$BIN" hook notify >/dev/null && proved "orbit hook notify"
HOME="$WORK/home" "$BIN" setup >/dev/null 2>&1 && HOME="$WORK/home" "$BIN" setup --uninstall >/dev/null 2>&1 \
  && proved "orbit setup, then --uninstall"

if [ "$TARGETS" != host ] && [ -f "$ARTIFACTS/orbit-darwin-x64" ]; then
  step "Checking the other architecture starts"
  chmod +x "$ARTIFACTS/orbit-darwin-x64"
  if arch -x86_64 "$ARTIFACTS/orbit-darwin-x64" version >/dev/null 2>&1; then
    proved "orbit-darwin-x64 runs under Rosetta"
  else
    printf '    – x64 not checked (no Rosetta on this Mac)\n'
  fi
fi

printf '\n  Rehearsed clean. scripts/release.sh <version> is safe to run.\n\n'
