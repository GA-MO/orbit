#!/usr/bin/env bash
set -euo pipefail

repo="${ORBIT_REPO:-GA-MO/orbit}"
install_dir="${ORBIT_INSTALL_DIR:-$HOME/.orbit/bin}"
wanted_version="${ORBIT_VERSION:-}"
local_dir="${ORBIT_LOCAL_DIR:-}"

say() { printf '  %s\n' "$*"; }
fail() { printf '  %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) ;;
  MINGW*|MSYS*|CYGWIN*) fail "On Windows, install with PowerShell:  irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex" ;;
  *) fail "Orbit runs on macOS and Windows — this is $(uname -s)." ;;
esac
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

echo
tag="${wanted_version:-$(latest_tag || true)}"
[ -n "$tag" ] || fail "could not find a release of $repo — is it private? Log in with \`gh auth login\`, or set GITHUB_TOKEN."
say "Installing orbit $tag for $arch → $install_dir"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fetch_asset "$asset" "$work/$asset" || fail "could not download $asset from $repo $tag"
fetch_asset "$asset.sha256" "$work/$asset.sha256" || fail "release $tag carries no checksum for $asset — not installing it"

(cd "$work" && shasum -a 256 -c "$asset.sha256" >/dev/null) \
  || fail "checksum of $asset does not match the one the release published — not installing it"

mkdir -p "$install_dir"
install -m 755 "$work/$asset" "$install_dir/orbit"
xattr -d com.apple.quarantine "$install_dir/orbit" 2>/dev/null || true

installed_version="$("$install_dir/orbit" version 2>/dev/null || true)"
[ -n "$installed_version" ] || fail "$install_dir/orbit did not start"
say "Installed orbit $installed_version"

add_to_path() {
  local rc="$HOME/.zshrc"
  local line="export PATH=\"$install_dir:\$PATH\""
  if [ -z "${ORBIT_NO_MODIFY_PATH:-}" ] && ! grep -qsF "$install_dir" "$rc"; then
    printf '\n# orbit\n%s\n' "$line" >> "$rc"
    say "Added $install_dir to PATH in $rc — open a new terminal, or run:  $line"
  else
    say "Add it to your PATH:  $line"
  fi
}

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) add_to_path ;;
esac

echo
say "Next:"
say "  orbit doctor    what this Mac has and is missing"
say "  orbit setup     wire the hooks and MCP server into Claude Code"
say "  orbit start     run it, published over your tailnet as https"
echo
