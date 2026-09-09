#!/usr/bin/env bash
#
# Run the whole suite against a throwaway Orbit, then take it down again.
#
#   make test            # both suites
#   make test-smoke      # API / MCP / hooks only  (no browser)
#   make test-touch      # touch behaviour only    (needs system Chrome)
#   make test-changes    # the Changes tab only    (needs system Chrome)
#   make test-preview-url # how an agent's path becomes a URL (no server needed)
#   make test-idle       # noticing a session went quiet    (no server needed)
#   make test-ask        # answering from a notification    (no server needed)
#
# Everything the suites touch — sessions, captures, uploads, the access token —
# lives under a scratch HOME that is deleted first, so a run cannot be coloured
# by the last one and cannot reach into the real ~/.orbit. The port is likewise
# a spare: the running Orbit is on 3001, and these tests kill sessions.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ORBIT_TEST_PORT:-3099}"
SCRATCH="${ORBIT_TEST_HOME:-/tmp/orbit-smoke}"
SUITE="${1:-all}"

if [ "$PORT" = "3001" ]; then
  echo "  Refusing to test against :3001 — that is the real server, and this kills sessions." >&2
  exit 1
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  Port $PORT is already in use. Free it, or set ORBIT_TEST_PORT to another." >&2
  exit 1
fi

# ── a server of its own ────────────────────────────────────────────────────
if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "  Building …"
  npm run build --prefix "$REPO" >/dev/null || { echo "  Build failed." >&2; exit 1; }
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/server.log"

# The scratch HOME has no shell rc files, so a login shell started under it
# rebuilds PATH without whatever the real one adds — `~/.local/bin`, a version
# manager's shims. Provider detection runs `zsh -lic 'command -v claude'`, so
# every agent check then skipped with "not installed" on a machine that has it
# installed: a false negative, which is the kind of skip nobody investigates.
# A login shell keeps what it inherits, so hand it the real PATH.
REAL_PATH="$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null)"
[ -n "$REAL_PATH" ] && export PATH="$REAL_PATH"

# A `tailscale` that publishes nothing (scripts/fake-tailscale.mjs). Without it
# the preview tests either skip — on any machine without Tailscale logged in —
# or publish real mappings on the real tailnet, which is how `:8443 → :3099`
# once outlived the throwaway server it pointed at. Set ORBIT_TAILSCALE
# yourself before running this to aim at the real CLI instead.
export ORBIT_TAILSCALE="${ORBIT_TAILSCALE:-$REPO/scripts/fake-tailscale.mjs}"

HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_TAILSCALE="$ORBIT_TAILSCALE" \
  node "$REPO/server/dist/index.js" >"$LOG" 2>&1 &
SERVER_PID=$!

# Kill it however we leave — a failed suite, a Ctrl-C, or the end of the script.
cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "  Starting Orbit on :$PORT (HOME=$SCRATCH) …"
for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "  Server exited during startup:"; sed 's/^/    /' "$LOG"; exit 1; }
  sleep 0.2
done
if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "  Server never answered /healthz. Log:" >&2
  sed 's/^/    /' "$LOG" >&2
  exit 1
fi

# ── the suites ─────────────────────────────────────────────────────────────
export HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_HOME="$SCRATCH"
failed=()

run() {
  echo ""
  echo "── $1 ────────────────────────────────────────────"
  node "$REPO/scripts/$2" || failed+=("$1")
}

case "$SUITE" in
  smoke)   run smoke smoke.mjs ;;
  touch)   run touch touch-smoke.mjs ;;
  changes) run changes changes-smoke.mjs ;;
  # Wants nothing but the build, and is run under the same throwaway server as
  # the rest only so that `make test` stays one command rather than two.
  preview-url) run preview-url preview-url-smoke.mjs ;;
  # Same: a stand-in session and a clock, no HTTP anywhere near it.
  idle)    run idle idle-smoke.mjs ;;
  ask)     run ask ask-smoke.mjs ;;
  all)     run smoke smoke.mjs; run touch touch-smoke.mjs; run changes changes-smoke.mjs; run preview-url preview-url-smoke.mjs; run idle idle-smoke.mjs; run ask ask-smoke.mjs ;;
  *)       echo "  Unknown suite: $SUITE (expected smoke, touch, changes, preview-url, idle, ask, or all)" >&2; exit 1 ;;
esac

echo ""
if [ ${#failed[@]} -eq 0 ]; then
  echo "  All suites passed."
  exit 0
fi
echo "  FAILED: ${failed[*]}"
echo "  Server log: $LOG"
exit 1
