#!/usr/bin/env bash
# Install wux-review from a GitHub Release.
#
# Fetch and run:
#   curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash -s -- --with-skills
#
# Detects the platform, downloads the matching wux-review-<os>-<arch> asset over
# anonymous HTTPS from the public GitHub Release, verifies its SHA256 checksum,
# and installs a `wux-review` binary on PATH. Re-running upgrades in place. No
# Bun and no GitHub authentication required on the target host. Mirrors wux's
# install.sh.
#
# Env overrides:
#   WUX_REVIEW_REPO        repo to install from        (default: jvrck/wux-review)
#   WUX_REVIEW_VERSION     CalVer tag or "latest"      (default: latest)
#   BIN_DIR                install directory           (default: $HOME/.local/bin)
#   WUX_REVIEW_SKILLS_DIR  skills destination root     (default: $HOME/.claude/skills)
set -euo pipefail

WUX_REVIEW_REPO="${WUX_REVIEW_REPO:-jvrck/wux-review}"
WUX_REVIEW_VERSION="${WUX_REVIEW_VERSION:-latest}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
WUX_REVIEW_SKILLS_DIR="${WUX_REVIEW_SKILLS_DIR:-$HOME/.claude/skills}"
WITH_SKILLS=0
TMP_DIR=""
NEW_BIN=""

note() { printf '%s\n' "$*" >&2; }
die()  { printf 'wux-review install: %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "${NEW_BIN:-}" ] && rm -f "$NEW_BIN"
  [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"
}

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      # Install the bundled skill alongside the binary (see install_skills).
      --with-skills) WITH_SKILLS=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
}

detect_asset() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  if [ "$os" = linux ] && [ "$arch" = x64 ]; then
    if { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; } || [ -f /etc/alpine-release ]; then
      arch=x64-musl
    fi
  fi
  case "$os-$arch" in
    linux-x64|linux-arm64|linux-x64-musl|darwin-arm64) printf 'wux-review-%s-%s\n' "$os" "$arch" ;;
    *) die "no published binary for $os-$arch" ;;
  esac
}

verify_checksum() {  # <dir> <asset>
  local dir="$1" asset="$2"
  ( cd "$dir"
    grep -E "[[:space:]]\*?${asset}\$" SHA256SUMS > SHA256SUMS.one || die "SHA256SUMS has no entry for $asset"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS.one
    elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 -c SHA256SUMS.one
    else die "need sha256sum or shasum to verify the download"; fi )
}

download() {  # <tag> <asset> <destdir>
  local tag="$1" asset="$2" dest="$3"
  command -v curl >/dev/null 2>&1 || die "curl is required to download wux-review releases"

  # Public release assets are served anonymously from the releases/download URL
  # (302 -> asset CDN). `latest` resolves to the newest full release. No API
  # call or credentials are needed; checksum verification happens below.
  local base
  if [ "$tag" = latest ]; then
    base="https://github.com/$WUX_REVIEW_REPO/releases/latest/download"
  else
    base="https://github.com/$WUX_REVIEW_REPO/releases/download/$tag"
  fi
  local name
  for name in "$asset" SHA256SUMS; do
    curl -fsSL "$base/$name" -o "$dest/$name" \
      || die "failed to download $name from $WUX_REVIEW_REPO release ($tag)"
  done
}

main() {
  parse_args "$@"
  local asset
  asset="$(detect_asset)"
  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT

  note "wux-review install: downloading $asset ($WUX_REVIEW_VERSION) from $WUX_REVIEW_REPO"
  download "$WUX_REVIEW_VERSION" "$asset" "$TMP_DIR"
  verify_checksum "$TMP_DIR" "$asset"

  mkdir -p "$BIN_DIR"
  NEW_BIN="$(mktemp "$BIN_DIR/.wux-review.new.XXXXXX")"
  cp "$TMP_DIR/$asset" "$NEW_BIN"
  chmod 0755 "$NEW_BIN"
  mv -f "$NEW_BIN" "$BIN_DIR/wux-review"
  NEW_BIN=""
  note "wux-review install: installed $BIN_DIR/wux-review ($("$BIN_DIR/wux-review" --version))"

  if [ "$WITH_SKILLS" = 1 ]; then
    install_skills
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) note "wux-review install: add $BIN_DIR to your PATH" ;;
  esac
}

# Extract the bundled skill from the installed binary (no repo checkout needed).
install_skills() {
  local dir="$WUX_REVIEW_SKILLS_DIR/wux-review"
  mkdir -p "$dir"
  # Write to a temp file and move on success, so a failed extract never leaves a
  # truncated SKILL.md behind (the script aborts under set -e before the mv).
  "$BIN_DIR/wux-review" skills show wux-review > "$dir/.SKILL.md.new"
  mv -f "$dir/.SKILL.md.new" "$dir/SKILL.md"
  note "wux-review install: installed skill $dir/SKILL.md"
}

main "$@"
