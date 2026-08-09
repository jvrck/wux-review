#!/usr/bin/env bash
# Run reproducible seeded CLI review cases against a released or local wux-review
# binary and preserve stdout/stderr plus exit status for later comparison.
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux-review seeded cases: %s\n' "$*" >&2; exit 1; }

WUX_REVIEW_BIN="${WUX_REVIEW_BIN:-wux-review}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${WUX_SEEDED_CASES_ROOT:-$repo_root/.tmp/seeded-cli-cases}"

command -v git >/dev/null 2>&1 || die "git is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
# The default review path is headless: it drives `claude -p` and `codex exec`
# directly, so both must be on PATH and authenticated. (No codex trust wrapper is
# needed — non-interactive `codex exec -s read-only` does not prompt for trust.)
command -v claude >/dev/null 2>&1 || die "claude is required"
command -v codex >/dev/null 2>&1 || die "codex is required"

if [ -x "$WUX_REVIEW_BIN" ]; then
  REVIEW_BIN="$WUX_REVIEW_BIN"
else
  REVIEW_BIN="$(command -v "$WUX_REVIEW_BIN" 2>/dev/null || true)"
fi
[ -n "${REVIEW_BIN:-}" ] || die "could not resolve WUX_REVIEW_BIN: $WUX_REVIEW_BIN"
[ -x "$REVIEW_BIN" ] || die "wux-review binary is not executable: $REVIEW_BIN"

repos_dir="$ROOT/repos"
results_dir="$ROOT/results"
rm -rf "$repos_dir" "$results_dir"
mkdir -p "$repos_dir" "$results_dir"

summary_tsv="$results_dir/summary.tsv"
printf 'case\texpected_verdict\texpected_exit\tactual_verdict\tactual_exit\tstdout\tstderr\trepo\n' > "$summary_tsv"

repo_init() {
  local dir="$1"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q
    git config user.email seeded@example.com
    git config user.name seeded
  )
}

case_approve_clean() {
  local dir="$1"
  cat > "$dir/clamp.js" <<'EOF'
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
EOF
  cat > "$dir/clamp.test.js" <<'EOF'
import { strict as assert } from "node:assert";
import { clamp } from "./clamp.js";

assert.equal(clamp(-5, 0, 10), 0);
assert.equal(clamp(5, 0, 10), 5);
EOF
  (
    cd "$dir"
    git add clamp.js clamp.test.js
    git commit -q -m 'base approve-clean case'
  )
  cat >> "$dir/clamp.test.js" <<'EOF'
assert.equal(clamp(15, 0, 10), 10);
EOF
}

case_correctness_block() {
  local dir="$1"
  cat > "$dir/parity.js" <<'EOF'
export function isEven(value) {
  return value % 2 === 0;
}
EOF
  (
    cd "$dir"
    git add parity.js
    git commit -q -m 'base correctness case'
  )
  cat > "$dir/parity.js" <<'EOF'
export function isEven(value) {
  return value % 2 !== 0;
}
EOF
}

case_shell_security_block() {
  local dir="$1"
  cat > "$dir/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

artifact="$1"
install -m 0644 "$artifact" "./deploy.tar.gz"
EOF
  chmod 0755 "$dir/deploy.sh"
  (
    cd "$dir"
    git add deploy.sh
    git commit -q -m 'base shell-security case'
  )
  cat > "$dir/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

artifact="$1"
eval "$artifact"
install -m 0644 "./deploy.tar.gz" "./deploy.tar.gz"
EOF
  chmod 0755 "$dir/deploy.sh"
}

case_docs_only() {
  local dir="$1"
  cat > "$dir/README.md" <<'EOF'
# Sample

This tool installs a review helper and prints a JSON verdict.
EOF
  (
    cd "$dir"
    git add README.md
    git commit -q -m 'base docs-only case'
  )
  cat > "$dir/README.md" <<'EOF'
# Sample

This tool installs a review helper and prints a structured JSON verdict.
EOF
}

run_case() {
  local name="$1"
  local expected_verdict="$2"
  local expected_exit="$3"
  local repo_dir="$repos_dir/$name"
  local out_dir="$results_dir/$name"
  mkdir -p "$out_dir"
  repo_init "$repo_dir"
  "case_$name" "$repo_dir"

  local stdout_file="$out_dir/stdout.json"
  local stderr_file="$out_dir/stderr.txt"
  local status_file="$out_dir/exit-status.txt"
  local actual_exit actual_verdict

  note "wux-review seeded cases: running $name"
  set +e
  (
    cd "$repo_dir"
    "$REVIEW_BIN" --json
  ) >"$stdout_file" 2>"$stderr_file"
  actual_exit="$?"
  set -e
  printf '%s\n' "$actual_exit" > "$status_file"

  if [ ! -s "$stdout_file" ]; then
    die "$name produced no stdout JSON (exit $actual_exit, see $stderr_file)"
  fi

  actual_verdict="$(python3 - "$stdout_file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload.get("verdict", ""))
PY
)"

  if [ "$actual_verdict" != "$expected_verdict" ]; then
    die "$name verdict mismatch: expected $expected_verdict, got $actual_verdict (see $out_dir)"
  fi
  if [ "$actual_exit" != "$expected_exit" ]; then
    die "$name exit mismatch: expected $expected_exit, got $actual_exit (see $out_dir)"
  fi

  if [ "$expected_verdict" = "block" ]; then
    python3 - "$stdout_file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
must_fix = payload.get("must_fix", [])
if not must_fix:
    raise SystemExit("blocked case returned no must_fix findings")
PY
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$expected_verdict" "$expected_exit" "$actual_verdict" "$actual_exit" \
    "$stdout_file" "$stderr_file" "$repo_dir" >> "$summary_tsv"
}

run_case approve_clean approve 0
run_case correctness_block block 2
run_case shell_security_block block 2
run_case docs_only approve 0

note "wux-review seeded cases: summary written to $summary_tsv"
printf '%s\n' "$summary_tsv"
