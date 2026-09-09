#!/usr/bin/env bash
#
# Retake every screenshot in docs/images against the current UI.
#
#   make shots
#
# Same rig as scripts/test.sh — a spare port, a scratch data directory, both
# taken down on the way out — with one difference that is the whole reason this
# is a separate script: `HOME` is *yours*. Only `ORBIT_HOME` moves, so the
# sessions these shots photograph inherit your real shell, your real PATH and
# your real agent credentials, which is what makes a picture of Claude Code
# answering a prompt something a script can take. Nothing is written to
# ~/.orbit: the token, the sessions and the captures all belong to the scratch
# directory and go with it.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

free() { ! lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

PORT=""
for p in $(seq 3099 3148); do
  free "$p" && { PORT="$p"; break; }
done
[ -n "$PORT" ] || { echo "  No free port in 3099-3148. Try: make test-clean" >&2; exit 1; }

if [ "$PORT" = "3001" ]; then
  echo "  Refusing to run against :3001 — that is the real server." >&2
  exit 1
fi

SCRATCH="/tmp/orbit-shots-$PORT"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "  Building …"
  npm run build --prefix "$REPO" >/dev/null || { echo "  Build failed." >&2; exit 1; }
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/.orbit"
LOG="$SCRATCH/server.log"

# A `tailscale` that publishes nothing, so the Preview tab can be photographed
# with a port shared without anything reaching the real tailnet.
export ORBIT_TAILSCALE="${ORBIT_TAILSCALE:-$REPO/scripts/fake-tailscale.mjs}"

# An agent started from this server inherits its environment, and if `make
# shots` was itself run from inside a Claude Code session, that environment
# carries that session's CLAUDE_* variables — which the new agent reports on
# screen ("transcript saving is off", "1 MCP server needs authentication").
# True, and nothing to do with Orbit, so they are dropped: the picture should
# show what a session started from a plain terminal looks like.
UNSET=""
for var in $(env | sed -n 's/^\(CLAUDE[A-Z_0-9]*\)=.*/\1/p'); do
  UNSET="$UNSET -u $var"
done

env $UNSET ORBIT_HOME="$SCRATCH" ORBIT_PORT="$PORT" ORBIT_TAILSCALE="$ORBIT_TAILSCALE" \
  node "$REPO/server/dist/index.js" >"$LOG" 2>&1 &
SERVER_PID=$!

PASSED=0
cleanup() {
  # The project the shots are taken in lives under the real home, because a
  # session cannot be started outside it. It is generated per run; nothing in
  # it is worth keeping.
  rm -rf "$HOME/.orbit-shots"
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  [ "$PASSED" = "1" ] && rm -rf "$SCRATCH"
  return 0
}
trap cleanup EXIT INT TERM

echo "  Starting Orbit on :$PORT (ORBIT_HOME=$SCRATCH) …"
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

ORBIT_HOME="$SCRATCH" ORBIT_PORT="$PORT" node "$REPO/scripts/shots.mjs" "$@"
status=$?

if [ $status -eq 0 ]; then
  PASSED=1
else
  echo "  Server log: $LOG"
fi
exit $status
