#!/usr/bin/env bash
# Minimal release-asset smoke for wux-review.
#
# Unlike wux, wux-review owns no tmux/session lifecycle of its own — it is a
# judge-only CLI that shells out to `wux run claude` / `wux run codex` at review
# time. So the smoke verifies the things a released binary must always get right:
# the stamped version, a working `--help`, and a clean non-zero error path.
#
# Inputs (env):
#   WUX_REVIEW_BIN  (or WUX_BIN)  path to the binary under test (required)
#   EXPECTED_VERSION              if set, `--version` must equal it (a leading `v` is stripped)
set -euo pipefail

BIN="${WUX_REVIEW_BIN:-${WUX_BIN:-}}"
[ -n "$BIN" ] || { echo "smoke: set WUX_REVIEW_BIN to the binary path" >&2; exit 2; }
[ -f "$BIN" ] || { echo "smoke: binary not found: $BIN" >&2; exit 2; }
chmod 0755 "$BIN" 2>/dev/null || true

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

ver="$("$BIN" --version)"
if [ -n "${EXPECTED_VERSION:-}" ]; then
  if [ "$ver" != "${EXPECTED_VERSION#v}" ]; then
    echo "smoke: --version is '$ver', expected '${EXPECTED_VERSION#v}'" >&2
    exit 1
  fi
fi

"$BIN" --help | grep -q 'wux-review' || { echo "smoke: --help did not mention wux-review" >&2; exit 1; }

if "$BIN" --definitely-not-a-flag >/dev/null 2>"$work_dir/err.log"; then
  echo "smoke: expected a non-zero exit for an unknown option" >&2
  exit 1
fi
grep -q 'unknown option' "$work_dir/err.log" || {
  echo "smoke: unknown-option error message missing" >&2
  exit 1
}

echo "wux-review smoke OK ($ver)"
