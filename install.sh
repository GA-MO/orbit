#!/usr/bin/env bash
# Install Orbit on a Mac: one executable, from the newest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/GA-MO/orbit/main/install.sh | bash
#
#   ORBIT_VERSION=v0.2.0 …      a particular release rather than the newest
#   ORBIT_INSTALL_DIR=/usr/local/bin …   somewhere other than ~/.orbit/bin
#   ORBIT_REPO=you/orbit …      a fork
#
# While the repository is private, the release can only be fetched with
# credentials: the `gh` CLI, logged in, is used when it is there, and a
# GITHUB_TOKEN in the environment is used otherwise. A public repository
# needs neither.
#
# What it does, in order: pick the binary for this Mac's architecture, fetch
# it and its checksum, refuse to install anything whose checksum does not
# match, put it on the PATH, and hand over to `orbit doctor`.
set -euo pipefail

repo="${ORBIT_REPO:-GA-MO/orbit}"
dir="${ORBIT_INSTALL_DIR:-$HOME/.orbit/bin}"
want="${ORBIT_VERSION:-}"

say() { printf '  %s\n' "$*"; }
fail() { printf '  %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Orbit runs on macOS — this is $(uname -s)."
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
asset="orbit-darwin-$arch"

# ── where the release comes from ──────────────────────────────────────────
# ORBIT_LOCAL_DIR is for the test: a directory laid out like a release's
# assets, so the rest of this file runs unchanged with no network at all.
local_dir="${ORBIT_LOCAL_DIR:-}"
has_gh=0
if [ -z "$local_dir" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then has_gh=1; fi

latest() {
  if [ -n "$local_dir" ]; then cat "$local_dir/VERSION"
  elif [ "$has_gh" = 1 ]; then gh release view --repo "$repo" --json tagName -q .tagName
  else
    curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
      "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p'
  fi
}

# fetch <asset name> <destination>
fetch() {
  if [ -n "$local_dir" ]; then cp "$local_dir/$1" "$2"
  elif [ "$has_gh" = 1 ]; then gh release download "$tag" --repo "$repo" --pattern "$1" --output "$2" --clobber
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    # A private repository's assets are only reachable through the API, by id.
    id="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$repo/releases/tags/$tag" \
      | tr ',' '\n' | grep -B3 "\"name\": *\"$1\"" | sed -n 's/.*"id": *\([0-9]*\).*/\1/p' | head -1)"
    [ -n "$id" ] || fail "release $tag has no asset named $1"
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/$repo/releases/assets/$id" -o "$2"
  else
    curl -fsSL "https://github.com/$repo/releases/download/$tag/$1" -o "$2"
  fi
}

echo
tag="${want:-$(latest || true)}"
[ -n "$tag" ] || fail "could not find a release of $repo — is it private? Log in with \`gh auth login\`, or set GITHUB_TOKEN."
say "Installing orbit $tag for $arch → $dir"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fetch "$asset" "$work/$asset" || fail "could not download $asset from $repo $tag"
fetch "$asset.sha256" "$work/$asset.sha256" || fail "release $tag carries no checksum for $asset — not installing it"

# ── the one check that matters ────────────────────────────────────────────
(cd "$work" && shasum -a 256 -c "$asset.sha256" >/dev/null) \
  || fail "checksum of $asset does not match the one the release published — not installing it"

mkdir -p "$dir"
install -m 755 "$work/$asset" "$dir/orbit"
# Nothing here goes through a browser, so there should be no quarantine to
# clear; harmless when there is none.
xattr -d com.apple.quarantine "$dir/orbit" 2>/dev/null || true

got="$("$dir/orbit" version 2>/dev/null || true)"
[ -n "$got" ] || fail "$dir/orbit did not start"
say "Installed orbit $got"

# ── on the PATH ───────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    rc="$HOME/.zshrc"
    line="export PATH=\"$dir:\$PATH\""
    if [ -z "${ORBIT_NO_MODIFY_PATH:-}" ] && ! grep -qsF "$dir" "$rc"; then
      printf '\n# orbit\n%s\n' "$line" >> "$rc"
      say "Added $dir to PATH in $rc — open a new terminal, or run:  $line"
    else
      say "Add it to your PATH:  $line"
    fi
    ;;
esac

echo
say "Next:"
say "  orbit doctor    what this Mac has and is missing"
say "  orbit setup     wire the hooks and MCP server into Claude Code"
say "  orbit phone     run it, published over your tailnet as https"
echo
