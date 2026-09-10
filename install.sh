#!/usr/bin/env bash
set -euo pipefail

repo="${ORBIT_REPO:-GA-MO/orbit}"
install_dir="${ORBIT_INSTALL_DIR:-$HOME/.orbit/bin}"
wanted_version="${ORBIT_VERSION:-}"
local_dir="${ORBIT_LOCAL_DIR:-}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  case "${COLORTERM:-}" in
    *truecolor*|*24bit*)
      accent=$'\033[38;2;56;214;238m'; violet=$'\033[38;2;178;132;252m'
      good=$'\033[38;2;74;222;128m';   bad=$'\033[38;2;248;113;113m' ;;
    *)
      accent=$'\033[36m'; violet=$'\033[35m'; good=$'\033[32m'; bad=$'\033[31m' ;;
  esac
  faint=$'\033[2m'; strong=$'\033[1m'; off=$'\033[0m'; erase=$'\033[K'
else
  accent=''; violet=''; good=''; bad=''; faint=''; strong=''; off=''; erase=''
fi

orb='◍'
steps=4
bar_rule='══════════════════════════════════════════════'

say() { printf '  %s\n' "$*"; }
rule() { printf '  %s%s%s\n' "$accent" "$bar_rule" "$off"; }

pixels=(
  "1111011100111001110111"
  "1001010010100100100010"
  "1001011100111000100010"
  "1001010100100100100010"
  "1111010010111001110010"
)

column_colour() {
  local at=$1 width=$2
  printf '\033[38;2;%d;%d;%dm' \
    $(( 56 + (178 - 56) * at / (width - 1) )) \
    $(( 214 + (132 - 214) * at / (width - 1) )) \
    $(( 238 + (252 - 238) * at / (width - 1) ))
}

pixel_wordmark() {
  local width=${#pixels[0]} band top bottom at lit under glyph line
  for band in 0 1 2; do
    top="${pixels[$((band * 2))]}"
    bottom="${pixels[$((band * 2 + 1))]:-}"
    line=''
    for (( at = 0; at < width; at++ )); do
      lit="${top:$at:1}"
      under="${bottom:$at:1}"
      if [ "$lit" = 1 ] && [ "$under" = 1 ]; then glyph='██'
      elif [ "$lit" = 1 ]; then glyph='▀▀'
      elif [ "$under" = 1 ]; then glyph='▄▄'
      else glyph='  '
      fi
      if [ -n "$accent" ]; then line+="$(column_colour "$at" "$width")$glyph$off"
      else line+="$glyph"
      fi
    done
    printf '  %s\n' "$line"
  done
}

heading() {
  printf '\n'
  if [ "$(tput cols 2>/dev/null || echo 80)" -ge 48 ]; then
    pixel_wordmark
    printf '\n  %s%s%s %sinstall%s\n' "$accent" "$orb" "$off" "$violet" "$off"
  else
    printf '  %s%s%s  %s%sO R B I T%s   %s▸ install%s\n' \
      "$accent" "$orb" "$off" "$strong" "$accent" "$off" "$violet" "$off"
  fi
  rule
  printf '\n'
}

step() {
  printf '%s  %s[%s/%s]%s  %s  %-9s  %s%s%s\n' \
    "$erase" "$faint" "$1" "$steps" "$off" "$2" "$3" "$faint" "$4" "$off"
}

note() { printf '         %s└→ %s%s\n' "$faint" "$*" "$off"; }

working() {
  [ -t 1 ] || return 0
  printf '  %s[%s/%s]%s  %s·%s  %-9s  %s%s%s\r' \
    "$faint" "$1" "$steps" "$off" "$accent" "$off" "$2" "$faint" "$3" "$off"
}

done_step() { step "$1" "${good}✔${off}" "$2" "$3"; }

fail() {
  printf '\n  %s✘%s %s\n\n' "$bad" "$off" "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Orbit runs on macOS — this is $(uname -s)."
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
asset="orbit-darwin-$arch"

has_gh=0
if [ -z "$local_dir" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then has_gh=1; fi

github_api() {
  curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "https://api.github.com/repos/$repo/$1"
}

latest_tag() {
  if [ -n "$local_dir" ]; then cat "$local_dir/VERSION"
  elif [ "$has_gh" = 1 ]; then gh release view --repo "$repo" --json tagName -q .tagName
  else github_api "releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p'
  fi
}

asset_id_by_api() {
  github_api "releases/tags/$tag" \
    | tr ',' '\n' | grep -B3 "\"name\": *\"$1\"" | sed -n 's/.*"id": *\([0-9]*\).*/\1/p' | head -1
}

fetch_asset() {
  local name="$1" dest="$2" id
  if [ -n "$local_dir" ]; then cp "$local_dir/$name" "$dest"
  elif [ "$has_gh" = 1 ]; then gh release download "$tag" --repo "$repo" --pattern "$name" --output "$dest" --clobber
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    id="$(asset_id_by_api "$name")"
    [ -n "$id" ] || fail "release $tag has no asset named $name"
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/$repo/releases/assets/$id" -o "$dest"
  else
    curl -fsSL "https://github.com/$repo/releases/download/$tag/$name" -o "$dest"
  fi
}

heading

working 1 release "asking $repo …"
tag="${wanted_version:-$(latest_tag || true)}"
[ -n "$tag" ] || fail "could not find a release of $repo — is it private? Log in with \`gh auth login\`, or set GITHUB_TOKEN."
done_step 1 release "$tag  ·  $repo"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

working 2 download "$asset"
fetch_asset "$asset" "$work/$asset" || fail "could not download $asset from $repo $tag"
fetch_asset "$asset.sha256" "$work/$asset.sha256" || fail "release $tag carries no checksum for $asset — not installing it"
done_step 2 download "$asset  ·  $arch"

working 3 checksum "sha256 …"
(cd "$work" && shasum -a 256 -c "$asset.sha256" >/dev/null) \
  || fail "checksum of $asset does not match the one the release published — not installing it"
done_step 3 checksum "matches what $tag published"

working 4 install "$install_dir"
mkdir -p "$install_dir"
install -m 755 "$work/$asset" "$install_dir/orbit"
xattr -d com.apple.quarantine "$install_dir/orbit" 2>/dev/null || true

installed_version="$("$install_dir/orbit" version 2>/dev/null || true)"
[ -n "$installed_version" ] || fail "$install_dir/orbit did not start"
done_step 4 install "Installed orbit $installed_version → $install_dir/orbit"

add_to_path() {
  local rc="$HOME/.zshrc"
  local line="export PATH=\"$install_dir:\$PATH\""
  if [ -z "${ORBIT_NO_MODIFY_PATH:-}" ] && ! grep -qsF "$install_dir" "$rc"; then
    printf '\n# orbit\n%s\n' "$line" >> "$rc"
    note "Added $install_dir to PATH in $rc — open a new terminal, or run:  $line"
  else
    note "Add it to your PATH:  $line"
  fi
}

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) add_to_path ;;
esac

printf '\n'
rule
printf '  %s%s%s Next:\n' "$accent" "$orb" "$off"
say "  ${accent}orbit doctor${off}    ${faint}what this Mac has and is missing${off}"
say "  ${accent}orbit setup${off}     ${faint}wire the hooks and MCP server into Claude Code${off}"
say "  ${accent}orbit start${off}     ${faint}run it, published over your tailnet as https${off}"
printf '\n'
