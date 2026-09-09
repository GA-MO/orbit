#!/usr/bin/env bash
# One executable with everything in it: the server, the MCP server (`orbit mcp`),
# the built web app and bun-pty's library. `bun build --compile` bundles the
# JavaScript; the web app and the version go in as assets, since the server
# reads them from disk (see WEB_DIST in server/src/index.ts).
#
#   scripts/dist.sh                       # this Mac's architecture → dist/orbit
#   scripts/dist.sh bun-darwin-x64        # a named target → dist/orbit-darwin-x64
#   scripts/dist.sh all                   # both Mac architectures
#
# Chrome, Tailscale and Claude Code are still the machine's own — this is the
# thing that talks to them, not them.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

targets=("${@:-host}")
[ "${targets[0]}" = "all" ] && targets=(bun-darwin-arm64 bun-darwin-x64)

echo "  Building server and web …"
bun run build >/dev/null
mkdir -p dist

for target in "${targets[@]}"; do
  if [ "$target" = "host" ]; then
    out="dist/orbit"; flag=()
  else
    out="dist/orbit-${target#bun-}"; flag=("--target=$target")
  fi
  echo "  Compiling $out …"
  # chromium-bidi is an optional require inside playwright-core that the
  # bundler cannot resolve and the binary never needs (it is for Firefox).
  bun build --compile ${flag:+"${flag[@]}"} \
    --external chromium-bidi \
    --asset=web/dist \
    --asset=server/package.json \
    server/dist/main.js --outfile "$out" >/dev/null
  ls -la "$out" | awk '{printf "  %s  %.0f MB\n", $9, $5/1048576}'
done
