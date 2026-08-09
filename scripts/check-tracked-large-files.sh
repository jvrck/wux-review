#!/usr/bin/env bash
# Reject oversized tracked files so the source repository remains lightweight.
set -euo pipefail

readonly MAX_BYTES=1048576

die() {
  printf 'tracked large-file guard: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || \
  die "must run inside a Git worktree"
cd "$repo_root" || die "cannot enter repository root: $repo_root"

readonly ALLOWLIST_PATH="scripts/tracked-large-files.allowlist"

is_allowlisted() {
  local candidate="$1"
  local allowed
  while IFS= read -r allowed || [ -n "$allowed" ]; do
    case "$allowed" in
      ""|\#*) continue ;;
    esac
    [ "$allowed" = "$candidate" ] && return 0
  done < "$allowlist"
  return 1
}

listing="$(mktemp "${TMPDIR:-/tmp}/wux-review-tracked-files.XXXXXX")" || \
  die "cannot create temporary listing"
allowlist="$(mktemp "${TMPDIR:-/tmp}/wux-review-large-file-allowlist.XXXXXX")" || {
  rm -f "$listing"
  die "cannot create temporary allowlist"
}
cleanup() {
  rm -f "$listing" "$allowlist"
}
trap cleanup EXIT

if ! git ls-files --stage -z > "$listing"; then
  die "cannot enumerate tracked files"
fi
[ -s "$listing" ] || die "refusing to pass with zero tracked files"
if ! git show ":$ALLOWLIST_PATH" > "$allowlist"; then
  die "allowlist is missing from the index: $ALLOWLIST_PATH"
fi
if ! invalid_entry="$(LC_ALL=C od -An -v -tu1 "$allowlist" | awk '
  BEGIN { line = 1; invalid = "" }
  {
    for (i = 1; i <= NF; i++) {
      byte = $i
      if (byte == 10) {
        line++
      } else if (invalid == "" && byte == 0) {
        invalid = line ":NUL"
      } else if (invalid == "" && (byte < 32 || byte == 127)) {
        invalid = line ":control"
      }
    }
  }
  END { print invalid }
')"; then
  die "cannot validate indexed allowlist: $ALLOWLIST_PATH"
fi
case "$invalid_entry" in
  *:NUL) die "allowlist contains a NUL byte on line ${invalid_entry%%:*}" ;;
  *:control) die "allowlist contains a control character on line ${invalid_entry%%:*}" ;;
esac

status=0
examined=0
while IFS= read -r -d '' entry; do
  header="${entry%%$'\t'*}"
  path="${entry#*$'\t'}"
  IFS=' ' read -r mode object _stage <<< "$header"
  # Gitlinks point to submodule commits, not blobs in this object database.
  [ "$mode" = "160000" ] && continue
  [ -n "${object:-}" ] || die "cannot read index entry: $path"
  bytes="$(git cat-file -s "$object")" || die "cannot size tracked blob: $path"
  case "$bytes" in
    *[!0-9]*|"") die "invalid tracked blob size for: $path" ;;
  esac
  examined=$((examined + 1))
  if [ "$bytes" -gt "$MAX_BYTES" ] && ! is_allowlisted "$path"; then
    printf 'tracked file exceeds %d-byte limit: %s (%d bytes)\n' \
      "$MAX_BYTES" "$path" "$bytes" >&2
    status=1
  fi
done < "$listing"

[ "$examined" -gt 0 ] || die "refusing to pass with zero tracked files"

if [ "$status" -ne 0 ]; then
  printf 'Add an intentional exception to %s only after review.\n' "$ALLOWLIST_PATH" >&2
  exit "$status"
fi

printf 'tracked large-file guard: pass (all tracked files are at most %d bytes or allowlisted)\n' \
  "$MAX_BYTES"
