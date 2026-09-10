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

step "Checking which doors the executable opens"
DOOR_PORT=3193
LIVE_PORTS="7788 3001"
is_a_live_orbit() { case " $LIVE_PORTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
if is_a_live_orbit "$DOOR_PORT" || lsof -tiTCP:"$DOOR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    :$DOOR_PORT is not free — skipped" >&2
else
  LAN_ADDRESS="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  door_home="$WORK/doors"
  mkdir -p "$door_home"
  door_up() {
    (cd /tmp && env HOME="$door_home" ORBIT_HOME="$door_home" ORBIT_PORT="$DOOR_PORT" \
      ORBIT_TAILSCALE="$REPO/scripts/fake-tailscale.mjs" ${1:+ORBIT_LAN=1} \
      "$BIN" >"$door_home/log" 2>&1 &)
    for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$DOOR_PORT/healthz" >/dev/null 2>&1 && return 0; sleep 0.25; done
    return 1
  }
  door_down() { kill "$(lsof -tiTCP:"$DOOR_PORT" -sTCP:LISTEN 2>/dev/null)" 2>/dev/null || true; sleep 0.5; }
  code() { curl -s -o /dev/null -m 4 -w '%{http_code}' "$@" 2>/dev/null; }
  refuse() { echo "    $1" >&2; door_down; exit 1; }

  door_up || refuse "the executable did not come up on :$DOOR_PORT"
  [ "$(code http://127.0.0.1:$DOOR_PORT/api/sessions)" = 401 ] || refuse "it served the API with no credential"
  [ "$(code -H 'Tailscale-User-Login: smoke-owner@example.com' http://127.0.0.1:$DOOR_PORT/api/sessions)" = 200 ] \
    || refuse "it did not recognise the tailnet owner"
  [ "$(code -H 'Tailscale-User-Login: someone-else@example.com' http://127.0.0.1:$DOOR_PORT/api/sessions)" = 401 ] \
    || refuse "it let in a login that is not the owner's"
  if [ -n "$LAN_ADDRESS" ]; then
    [ "$(code http://$LAN_ADDRESS:$DOOR_PORT/healthz)" = 000 ] || refuse "it answered on the wi-fi address with the LAN shut"
  fi
  grep -q 'access token' "$door_home/log" && refuse "it printed the access token when nothing needs one"
  door_down
  proved "with the LAN shut it answers only on loopback, only to the tailnet owner, and prints no token"

  if [ -n "$LAN_ADDRESS" ]; then
    door_up lan || refuse "the executable did not come up with ORBIT_LAN=1"
    [ "$(code http://$LAN_ADDRESS:$DOOR_PORT/healthz)" = 200 ] || refuse "ORBIT_LAN=1 did not open the wi-fi address"
    [ "$(code -H 'Tailscale-User-Login: smoke-owner@example.com' http://$LAN_ADDRESS:$DOOR_PORT/api/sessions)" = 401 ] \
      || refuse "it trusted a Tailscale header while the wi-fi door was open"
    door_down
    proved "with ORBIT_LAN=1 the wi-fi address answers and the header counts for nothing"
  fi
fi

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
