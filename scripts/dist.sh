#!/usr/bin/env bash
# One executable with everything in it: the server, the MCP server, the hooks,
# the installer, the built web app and bun-pty's library.
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

MAC_TARGETS=(bun-darwin-arm64 bun-darwin-x64)

targets=("${@:-host}")
[ "${targets[0]}" = "all" ] && targets=("${MAC_TARGETS[@]}")

output_for() {
  if [ "$1" = "host" ]; then echo "dist/orbit"; else echo "dist/orbit-${1#bun-}"; fi
}

# Through Bun's API rather than `bun build --compile`: one dependency needs a
# bundle-time patch or the executable only starts on the machine that built
# it. The why, and the assets, are in scripts/dist-compile.ts.
compile() {
  bun scripts/dist-compile.ts "$1" "$2"
}

write_checksum_beside() {
  (cd dist && shasum -a 256 "$(basename "$1")" > "$(basename "$1").sha256")
}

report_size() {
  ls -la "$1" | awk '{printf "  %s  %.0f MB\n", $9, $5/1048576}'
}

echo "  Building server and web …"
bun run build >/dev/null
mkdir -p dist

for target in "${targets[@]}"; do
  out="$(output_for "$target")"
  echo "  Compiling $out …"
  compile "$target" "$out"
  write_checksum_beside "$out"
  report_size "$out"
done
