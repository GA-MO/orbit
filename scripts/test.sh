#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="${1:-all}"

LIVE_PORT=3001
PORT_SEARCH_FIRST=3099
PORT_SEARCH_LAST=3148
HEALTH_POLLS=100
HEALTH_POLL_INTERVAL=0.2
SCRATCH_RM_TRIES=5
SCRATCH_RM_INTERVAL=0.3

port_is_free() { ! lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pick_port() {
  if [ -n "${ORBIT_TEST_PORT:-}" ]; then
    port_is_free "$ORBIT_TEST_PORT" || { echo "  Port $ORBIT_TEST_PORT is already in use. Free it, or unset ORBIT_TEST_PORT to be given a spare." >&2; exit 1; }
    echo "$ORBIT_TEST_PORT"
    return
  fi
  for candidate in $(seq "$PORT_SEARCH_FIRST" "$PORT_SEARCH_LAST"); do
    port_is_free "$candidate" && { echo "$candidate"; return; }
  done
  echo "  No free port in $PORT_SEARCH_FIRST-$PORT_SEARCH_LAST. Is something looping? Try: make test-clean" >&2
  exit 1
}

PORT="$(pick_port)" || exit 1
SCRATCH="${ORBIT_TEST_HOME:-/tmp/orbit-smoke-$PORT}"

if [ "$PORT" = "$LIVE_PORT" ]; then
  echo "  Refusing to test against :$LIVE_PORT — that is the real server, and this kills sessions." >&2
  exit 1
fi

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "  Building …"
  (cd "$REPO" && bun run build >/dev/null) || { echo "  Build failed." >&2; exit 1; }
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/server.log"

inherit_login_shell_path() {
  local real_path
  real_path="$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null)"
  [ -n "$real_path" ] && export PATH="$real_path"
}
inherit_login_shell_path

export ORBIT_TAILSCALE="${ORBIT_TAILSCALE:-$REPO/scripts/fake-tailscale.mjs}"

start_server() {
  if [ -n "${ORBIT_BIN:-}" ]; then
    HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_TAILSCALE="$ORBIT_TAILSCALE" \
      "$REPO/$ORBIT_BIN" >"$LOG" 2>&1 &
  else
    HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_TAILSCALE="$ORBIT_TAILSCALE" \
      bun "$REPO/server/dist/index.js" >"$LOG" 2>&1 &
  fi
  SERVER_PID=$!
}
start_server

PASSED=0
remove_scratch() {
  for _ in $(seq 1 "$SCRATCH_RM_TRIES"); do
    rm -rf "$SCRATCH" 2>/dev/null && break
    sleep "$SCRATCH_RM_INTERVAL"
  done
}
cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  [ "$PASSED" = "1" ] && remove_scratch
  return 0
}
trap cleanup EXIT INT TERM

healthy() { curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }
print_log() { sed 's/^/    /' "$LOG"; }

wait_for_server() {
  for _ in $(seq 1 "$HEALTH_POLLS"); do
    healthy && break
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "  Server exited during startup:"; print_log; exit 1; }
    sleep "$HEALTH_POLL_INTERVAL"
  done
  if ! healthy; then
    echo "  Server never answered /healthz. Log:" >&2
    print_log >&2
    exit 1
  fi
}

echo "  Starting Orbit on :$PORT (HOME=$SCRATCH) …"
wait_for_server

export HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_HOME="$SCRATCH"
failed=()

run() {
  local name="$1" script="$2"
  echo ""
  echo "── $name ────────────────────────────────────────────"
  bun "$REPO/scripts/$script" || failed+=("$name")
}

run_all() {
  run smoke smoke.mjs
  run touch touch-smoke.mjs
  run changes changes-smoke.mjs
  run preview-url preview-url-smoke.mjs
  run idle idle-smoke.mjs
  run ask ask-smoke.mjs
  run setup setup-smoke.mjs
  run install install-smoke.mjs
}

case "$SUITE" in
  smoke)       run smoke smoke.mjs ;;
  touch)       run touch touch-smoke.mjs ;;
  changes)     run changes changes-smoke.mjs ;;
  preview-url) run preview-url preview-url-smoke.mjs ;;
  idle)        run idle idle-smoke.mjs ;;
  ask)         run ask ask-smoke.mjs ;;
  setup)       run setup setup-smoke.mjs ;;
  install)     run install install-smoke.mjs ;;
  all)         run_all ;;
  *)           echo "  Unknown suite: $SUITE (expected smoke, touch, changes, preview-url, idle, ask, setup, install, or all)" >&2; exit 1 ;;
esac

echo ""
if [ ${#failed[@]} -eq 0 ]; then
  echo "  All suites passed."
  PASSED=1
  exit 0
fi
echo "  FAILED: ${failed[*]}"
echo "  Server log: $LOG"
exit 1
