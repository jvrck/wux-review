#!/usr/bin/env bash
# Fail closed unless a staged Darwin release binary has a valid code signature.
set -euo pipefail

readonly ASSET_PATH="${1:-}"

if [ -z "$ASSET_PATH" ]; then
  echo "Darwin signature verification: expected an asset path" >&2
  exit 2
fi
if [ ! -f "$ASSET_PATH" ]; then
  echo "Darwin signature verification: asset not found: $ASSET_PATH" >&2
  exit 2
fi
if [ ! -x /usr/bin/codesign ]; then
  echo "Darwin signature verification: /usr/bin/codesign is unavailable" >&2
  exit 1
fi
if ! /usr/bin/codesign --verify --verbose=4 "$ASSET_PATH"; then
  echo "Darwin signature verification failed: $ASSET_PATH" >&2
  exit 1
fi

echo "Darwin signature verification passed: $ASSET_PATH"
