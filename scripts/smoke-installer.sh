#!/usr/bin/env bash
# Validate install.sh against a release-shaped asset set built from the current
# checkout. This exercises checksum verification, plain install,
# `--with-skills`, and a clean failure path without needing a published release.
#
# Required:
#   WUX_REVIEW_SOURCE_BIN  compiled binary to package as the release asset
#   EXPECTED_VERSION       version `wux-review --version` must print after install
#
# Optional:
#   WUX_INSTALL_SMOKE_ROOT      temp root to reuse instead of mktemp
#   WUX_INSTALL_SMOKE_DIAG_DIR  failure diagnostics destination
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux-review install smoke: %s\n' "$*" >&2; exit 1; }

ROOT_INPUT="${WUX_INSTALL_SMOKE_ROOT:-}"
DIAG_DIR="${WUX_INSTALL_SMOKE_DIAG_DIR:-}"
SOURCE_BIN="${WUX_REVIEW_SOURCE_BIN:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"

[ -n "$SOURCE_BIN" ] || die "WUX_REVIEW_SOURCE_BIN is required"
[ -n "$EXPECTED_VERSION" ] || die "EXPECTED_VERSION is required"
[ -f "$SOURCE_BIN" ] || die "binary not found: $SOURCE_BIN"
[ -x "$SOURCE_BIN" ] || die "binary is not executable: $SOURCE_BIN"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_sh="$repo_root/install.sh"
[ -f "$install_sh" ] || die "install.sh not found: $install_sh"

asset_name() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
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

own_root=0
if [ -n "$ROOT_INPUT" ]; then
  root="$ROOT_INPUT"
  mkdir -p "$root"
else
  root="$(mktemp -d)"
  own_root=1
fi

release_dir="$root/release"
fake_bin="$root/fake-bin"
bin_plain="$root/bin-plain"
bin_skills="$root/bin-skills"
skills_dir="$root/skills"
bin_tag="$root/bin-tag"
bin_stage="$root/bin-stage"
bin_rollback="$root/bin-rollback"
mkdir -p "$release_dir" "$fake_bin" "$skills_dir"

collect_diagnostics() {
  local status="$1"
  local dest="$DIAG_DIR"
  if [ -z "$dest" ]; then
    dest="$root/diagnostics"
  fi
  mkdir -p "$dest"
  {
    printf 'status=%s\n' "$status"
    printf 'root=%s\n' "$root"
    printf 'source_bin=%s\n' "$SOURCE_BIN"
    date -u
    uname -a
  } > "$dest/environment.txt" 2>&1 || true
  for file in plain.out plain.err tag.out tag.err stage.out stage.err skills.out skills.err rollback.out rollback.err; do
    if [ -f "$root/$file" ]; then
      cp "$root/$file" "$dest/$file" 2>/dev/null || true
    fi
  done
  if [ -d "$skills_dir" ]; then
    cp -R "$skills_dir" "$dest/skills" 2>/dev/null || true
  fi
}

cleanup() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    collect_diagnostics "$status"
  fi
  if [ "$own_root" -eq 1 ] && [ "$status" -eq 0 ]; then
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT

asset="$(asset_name)"
cp "$SOURCE_BIN" "$release_dir/$asset"
chmod 0755 "$release_dir/$asset"
(
  cd "$release_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$asset" > SHA256SUMS
  else
    shasum -a 256 "$asset" > SHA256SUMS
  fi
)

curl_log="$root/curl.log"
cat > "$fake_bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
out=
url=
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o)
      out="\$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="\$1"
      shift
      ;;
  esac
done
[ -n "\$out" ] && [ -n "\$url" ] || { printf 'missing URL or output\n' >&2; exit 1; }
case "\$url" in
  https://github.com/jvrck/wux-review/releases/latest/download/*|https://github.com/jvrck/wux-review/releases/download/*)
    ;;
  *)
    printf 'unexpected curl URL: %s\n' "\$url" >&2
    exit 1
    ;;
esac
printf '%s\n' "\$url" >> "$curl_log"
cp "$release_dir/\${url##*/}" "\$out"
EOF
chmod 0755 "$fake_bin/curl"

stage_log="$root/stage.log"
move_log="$root/move.log"
cat > "$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  "$BIN_DIR"/.wux-review.new.*)
    printf '%s\t%s\n' "$1" "$2" >> "$STAGE_LOG"
    if [ "${WUX_REVIEW_FAIL_STAGE_COPY:-0}" = 1 ]; then
      printf 'injected staging copy failure\n' >&2
      exit 1
    fi
    ;;
esac
exec /bin/cp "$@"
EOF
chmod 0755 "$fake_bin/cp"

cat > "$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -f ]; then
  shift
fi
case "$2" in
  "$BIN_DIR/wux-review") printf '%s\t%s\n' "$1" "$2" >> "$MOVE_LOG" ;;
esac
exec /bin/mv -f "$@"
EOF
chmod 0755 "$fake_bin/mv"

run_install() {
  local target_bin="$1"
  local target_skills="$2"
  local version="$3"
  shift 3
  PATH="$fake_bin:${PATH}" \
    BIN_DIR="$target_bin" \
    WUX_REVIEW_SKILLS_DIR="$target_skills" \
    WUX_REVIEW_REPO="jvrck/wux-review" \
    WUX_REVIEW_VERSION="$version" \
    STAGE_LOG="$stage_log" \
    MOVE_LOG="$move_log" \
    WUX_REVIEW_FAIL_STAGE_COPY="${WUX_REVIEW_FAIL_STAGE_COPY:-0}" \
    bash "$install_sh" "$@"
}

expected_version="${EXPECTED_VERSION#v}"
latest_base="https://github.com/jvrck/wux-review/releases/latest/download"
tag="2026.08.09"
tagged_base="https://github.com/jvrck/wux-review/releases/download/$tag"

note "wux-review install smoke: plain install"
run_install "$bin_plain" "$skills_dir/plain" latest > "$root/plain.out" 2> "$root/plain.err"
[ -x "$bin_plain/wux-review" ] || die "plain install did not create $bin_plain/wux-review"
test "$("$bin_plain/wux-review" --version)" = "$expected_version" || die "plain install produced the wrong version"
WUX_REVIEW_BIN="$bin_plain/wux-review" EXPECTED_VERSION="$EXPECTED_VERSION" "$repo_root/scripts/smoke-release-asset.sh"
grep -Fx "$latest_base/$asset" "$curl_log" >/dev/null || die "latest asset URL was not used"
grep -Fx "$latest_base/SHA256SUMS" "$curl_log" >/dev/null || die "latest checksum URL was not used"
grep -F "$bin_plain/.wux-review.new." "$stage_log" >/dev/null || die "binary was not staged beside its target"
grep -F "$bin_plain/wux-review" "$move_log" >/dev/null || die "staged binary was not atomically moved into place"

note "wux-review install smoke: tagged install"
run_install "$bin_tag" "$skills_dir/tag" "$tag" > "$root/tag.out" 2> "$root/tag.err"
[ -x "$bin_tag/wux-review" ] || die "tagged install did not create $bin_tag/wux-review"
test "$("$bin_tag/wux-review" --version)" = "$expected_version" || die "tagged install produced the wrong version"
grep -Fx "$tagged_base/$asset" "$curl_log" >/dev/null || die "tagged asset URL was not used"
grep -Fx "$tagged_base/SHA256SUMS" "$curl_log" >/dev/null || die "tagged checksum URL was not used"

note "wux-review install smoke: staging failure preserves installed binary"
: > "$stage_log"
: > "$move_log"
mkdir -p "$bin_stage"
printf '%s\n' '#!/usr/bin/env bash' "printf 'prior binary\\n'" > "$bin_stage/wux-review"
chmod 0755 "$bin_stage/wux-review"
if WUX_REVIEW_FAIL_STAGE_COPY=1 run_install "$bin_stage" "$skills_dir/stage" latest > "$root/stage.out" 2> "$root/stage.err"; then
  die "expected staging-copy install to fail"
fi
test "$("$bin_stage/wux-review" --version)" = 'prior binary' || die "staging failure replaced the working binary"
grep -F "$bin_stage/.wux-review.new." "$stage_log" >/dev/null || die "staging failure did not use a sibling candidate"
[ ! -s "$move_log" ] || die "staging failure moved a candidate into place"
grep -q 'injected staging copy failure' "$root/stage.err" || die "staging failure was not observed"

note "wux-review install smoke: install with skills"
run_install "$bin_skills" "$skills_dir" latest --with-skills > "$root/skills.out" 2> "$root/skills.err"
[ -x "$bin_skills/wux-review" ] || die "skills install did not create $bin_skills/wux-review"
test "$("$bin_skills/wux-review" --version)" = "$expected_version" || die "skills install produced the wrong version"
WUX_REVIEW_BIN="$bin_skills/wux-review" EXPECTED_VERSION="$EXPECTED_VERSION" "$repo_root/scripts/smoke-release-asset.sh"
cmp -s "$repo_root/skills/wux-review/SKILL.md" "$skills_dir/wux-review/SKILL.md" \
  || die "installed SKILL.md did not match the bundled skill"

note "wux-review install smoke: checksum mismatch preserves installed binary"
mkdir -p "$bin_rollback"
cp "$SOURCE_BIN" "$bin_rollback/wux-review"
printf 'corrupted\n' >> "$release_dir/$asset"
if run_install "$bin_rollback" "$skills_dir/rollback" latest > "$root/rollback.out" 2> "$root/rollback.err"; then
  die "expected checksum-mismatch install to fail"
fi
if command -v sha256sum >/dev/null 2>&1; then
  test "$(sha256sum < "$SOURCE_BIN")" = "$(sha256sum < "$bin_rollback/wux-review")"
else
  test "$(shasum -a 256 < "$SOURCE_BIN")" = "$(shasum -a 256 < "$bin_rollback/wux-review")"
fi || die "checksum failure replaced the working binary"
grep -Eq 'FAILED|NOT match|mismatch|checksum|no properly formatted SHA checksum lines found' "$root/rollback.err" \
  || die "checksum failure did not report an actionable error"

note "wux-review install smoke: ok"
