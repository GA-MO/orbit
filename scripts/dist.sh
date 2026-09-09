#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

MAC_TARGETS=(bun-darwin-arm64 bun-darwin-x64)
ENTRY_POINT=server/dist/main.js
ASSETS_THE_SERVER_READS_FROM_DISK=(--asset=web/dist --asset=server/package.json)
FIREFOX_ONLY_PLAYWRIGHT_REQUIRE=chromium-bidi

targets=("${@:-host}")
[ "${targets[0]}" = "all" ] && targets=("${MAC_TARGETS[@]}")

output_for() {
  if [ "$1" = "host" ]; then echo "dist/orbit"; else echo "dist/orbit-${1#bun-}"; fi
}

compile() {
  local target="$1" out="$2"
  local flag=()
  [ "$target" = "host" ] || flag=("--target=$target")
  bun build --compile ${flag:+"${flag[@]}"} \
    --external "$FIREFOX_ONLY_PLAYWRIGHT_REQUIRE" \
    "${ASSETS_THE_SERVER_READS_FROM_DISK[@]}" \
    "$ENTRY_POINT" --outfile "$out" >/dev/null
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
