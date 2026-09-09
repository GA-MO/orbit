#!/usr/bin/env bash
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LIVE_PORT=3001
PORT_SEARCH_FIRST=3099
PORT_SEARCH_LAST=3148
HEALTH_POLLS=100
HEALTH_POLL_INTERVAL=0.2

port_is_free() { ! lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pick_port() {
  for candidate in $(seq "$PORT_SEARCH_FIRST" "$PORT_SEARCH_LAST"); do
    port_is_free "$candidate" && { echo "$candidate"; return; }
  done
  echo "  No free port in $PORT_SEARCH_FIRST-$PORT_SEARCH_LAST. Try: make test-clean" >&2
  exit 1
}

PORT="$(pick_port)" || exit 1

if [ "$PORT" = "$LIVE_PORT" ]; then
  echo "  Refusing to run against :$LIVE_PORT — that is the real server." >&2
  exit 1
fi

SCRATCH="/tmp/orbit-shots-$PORT"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "  Building …"
  (cd "$REPO" && bun run build >/dev/null) || { echo "  Build failed." >&2; exit 1; }
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/.orbit"
LOG="$SCRATCH/server.log"

export ORBIT_TAILSCALE="${ORBIT_TAILSCALE:-$REPO/scripts/fake-tailscale.mjs}"

claude_env_unset_flags() {
  local flags=""
  for var in $(env | sed -n 's/^\(CLAUDE[A-Z_0-9]*\)=.*/\1/p'); do
    flags="$flags -u $var"
  done
  echo "$flags"
}

UNSET="$(claude_env_unset_flags)"

env $UNSET ORBIT_HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_TAILSCALE="$ORBIT_TAILSCALE" \
  bun "$REPO/server/dist/index.js" >"$LOG" 2>&1 &
SERVER_PID=$!

PASSED=0
cleanup() {
  rm -rf "$HOME/.orbit-shots"
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  [ "$PASSED" = "1" ] && rm -rf "$SCRATCH"
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

echo "  Starting Orbit on :$PORT (ORBIT_HOME=$SCRATCH) …"
wait_for_server

ORBIT_HOME="$SCRATCH" ORBIT_PORT="$PORT" bun "$REPO/scripts/shots.mjs" "$@"
status=$?

if [ $status -eq 0 ]; then
  PASSED=1
else
  echo "  Server log: $LOG"
fi
exit $status
