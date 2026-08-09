#!/usr/bin/env bash
# Exercise the compiled wux-review across the real headless reviewer legs using
# fake `claude` / `codex` binaries — no live model auth. The explicit `--direct`
# path needs no Wux; the default proof below uses a strict fake of the released
# `run shell` / `status --json` / `read --json` interfaces.
#
# The direct rollback path is headless: `claude -p --output-format stream-json`
# (prompt on stdin) and `codex exec --json ... -o <file>` (prompt points at a
# brief file, the verdict is read back from -o). The fakes below implement
# exactly those protocols and decide approve vs block from a marker in the diff,
# so the smoke proves the binary drives both legs, consolidates a verdict, exits
# correctly, and cleans up its temp files — all unattended.
#
# Required:
#   WUX_REVIEW_BIN  compiled wux-review binary to test
# Optional:
#   WUX_FAKE_SMOKE_ROOT     temp root to reuse instead of mktemp
#   WUX_FAKE_SMOKE_DIAG_DIR failure diagnostics destination
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux-review fake-agent smoke: %s\n' "$*" >&2; exit 1; }

WUX_REVIEW_BIN="${WUX_REVIEW_BIN:-}"
ROOT_INPUT="${WUX_FAKE_SMOKE_ROOT:-}"
DIAG_DIR="${WUX_FAKE_SMOKE_DIAG_DIR:-}"
# The headless legs write their temp files here (src/backends/headless.ts tmpDir).
TMP_REVIEW_DIR="/tmp/wux-review"
SESSION_STATE_DIR="$TMP_REVIEW_DIR/sessions"

[ -n "$WUX_REVIEW_BIN" ] || die "WUX_REVIEW_BIN is required"
[ -f "$WUX_REVIEW_BIN" ] || die "binary not found: $WUX_REVIEW_BIN"
[ -x "$WUX_REVIEW_BIN" ] || die "binary is not executable: $WUX_REVIEW_BIN"
command -v git >/dev/null 2>&1 || die "git is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

own_root=0
if [ -n "$ROOT_INPUT" ]; then
  root="$ROOT_INPUT"
  mkdir -p "$root"
else
  root="$(mktemp -d)"
  own_root=1
fi

fake_bin="$root/fake-bin"
repo_dir="$root/repo"
output_dir="$root/output"
rm -rf "$fake_bin" "$repo_dir" "$output_dir"
mkdir -p "$fake_bin" "$repo_dir" "$output_dir"

session_id="fakesmoke"
claude_prompt="$TMP_REVIEW_DIR/wuxr-${session_id}-claude-prompt.md"
codex_prompt="$TMP_REVIEW_DIR/wuxr-${session_id}-codex-prompt.md"
codex_last="$TMP_REVIEW_DIR/wuxr-${session_id}-codex-last.txt"
rm -f "$SESSION_STATE_DIR/$session_id.json" "$SESSION_STATE_DIR/fakesmoke-obs.json"

collect_diagnostics() {
  local status="$1"
  local dest="${DIAG_DIR:-$root/diagnostics}"
  mkdir -p "$dest"
  {
    printf 'status=%s\n' "$status"
    printf 'root=%s\n' "$root"
    printf 'wux_review_bin=%s\n' "$WUX_REVIEW_BIN"
    date -u
    "$WUX_REVIEW_BIN" --version || true
  } > "$dest/environment.txt" 2>&1 || true
  for f in approve.out approve.err block.out block.err observable-approve.out observable-approve.err observable-block.out observable-block.err; do
    if [ -f "$output_dir/$f" ]; then
      cp "$output_dir/$f" "$dest/$f" 2>/dev/null || true
    fi
  done
  ls -la "$TMP_REVIEW_DIR" > "$dest/tmp-review-listing.txt" 2>&1 || true
}

cleanup() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    collect_diagnostics "$status"
  fi
  rm -f "$SESSION_STATE_DIR/fakesmoke.json" "$SESSION_STATE_DIR/fakesmoke-obs.json"
  if [ "$own_root" -eq 1 ] && [ "$status" -eq 0 ]; then
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT

# Fake `claude`: reads the prompt (with the diff) on stdin and emits a real-shaped
# stream-json lifecycle. Observable runs deliberately pause after a safe Read
# tool event so the pane must show useful activity before the final result.
cat > "$fake_bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
# Record the invocation so the smoke can prove BOTH legs ran (not just one).
[ -n "${WUXR_SMOKE_INVOKED:-}" ] && { mkdir -p "$WUXR_SMOKE_INVOKED"; : > "$WUXR_SMOKE_INVOKED/claude"; }
if printf '%s' "$input" | grep -q 'BLOCK_CASE'; then
  findings='[{"lens":"correctness","file":"sample.txt","line":1,"severity":"must-fix","finding":"BLOCK_CASE must block the review"}]'
else
  findings='[]'
fi
result="$(printf '```json\n{"findings":%s}\n```' "$findings")"
jq -nc '{type:"system",subtype:"init",session_id:"SESSION_SECRET"}'
if [ "${WUXR_SMOKE_SLOW:-0}" = 1 ]; then sleep 2.5; fi
jq -nc '{type:"assistant",message:{content:[
  {type:"thinking",thinking:"REASONING_CONTENT_DO_NOT_RENDER"},
  {type:"text",text:"PROMPT_DIFF_TOKEN_SECRET_DO_NOT_RENDER"},
  {type:"tool_use",name:"Read",input:{file_path:"/TOKEN_SECRET/path"}}
]}}'
if [ "${WUXR_SMOKE_SLOW:-0}" = 1 ]; then sleep 2.5; fi
jq -nc --arg r "$result" '{type:"result",subtype:"success",is_error:false,result:$r,usage:{input_tokens:123}}'
EOF

# Fake `codex`: parses `-o <file>` and the prompt (which points at a brief file),
# reads the brief, and writes the findings block to the -o last-message file —
# exactly what `codex exec` does for the headless leg.
cat > "$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    exec) shift;;
    --json|--ephemeral|--skip-git-repo-check|--ignore-rules|--ignore-user-config) shift;;
    -o) out="$2"; shift 2;;
    -s|-C|-m) shift 2;;
    *) prompt="$1"; shift;;
  esac
done
[ -n "$out" ] || { echo "fake codex: no -o output path" >&2; exit 1; }
[ -n "${WUXR_SMOKE_INVOKED:-}" ] && { mkdir -p "$WUXR_SMOKE_INVOKED"; : > "$WUXR_SMOKE_INVOKED/codex"; }
brief="$(printf '%s' "$prompt" | grep -oE '/[^ ]*-prompt\.md' | head -1)"
# Fail loudly on broken prompt plumbing rather than silently reviewing nothing
# (an unreadable brief must turn the smoke red, not pass as an empty approve).
[ -n "$brief" ] && [ -f "$brief" ] || { echo "fake codex: cannot read brief from prompt: '$prompt'" >&2; exit 1; }
input="$(cat "$brief")"
if printf '%s' "$input" | grep -q 'BLOCK_CASE'; then
  findings='[{"lens":"correctness","file":"sample.txt","line":1,"severity":"must-fix","finding":"BLOCK_CASE must block the review"}]'
else
  findings='[]'
fi
jq -nc '{type:"thread.started",thread_id:"THREAD_SECRET"}'
jq -nc '{type:"turn.started"}'
jq -nc '{type:"item.started",item:{id:"item_1",type:"command_execution",command:"cat PROMPT_DIFF_TOKEN_SECRET"}}'
jq -nc '{type:"item.completed",item:{id:"item_1",type:"command_execution",command:"cat PROMPT_DIFF_TOKEN_SECRET",aggregated_output:"TOOL_OUTPUT_SECRET",exit_code:0,status:"completed"}}'
jq -nc '{type:"turn.completed",usage:{input_tokens:999}}'
printf '```json\n{"findings":%s}\n```\n' "$findings" > "$out"
EOF
chmod 0755 "$fake_bin/claude" "$fake_bin/codex"

# Fake released Wux interface for default observable execution. `run shell`
# creates a durable runDir, launches the forwarded shell args asynchronously,
# and returns; `read --json` exposes that runDir only while the exact child is
# live; `status --json` makes name collisions visible; `stop` reaps/finalizes
# only the named child so lifecycle cleanup is exercised without an interactive
# send surface.
fake_wux_root="$root/fake-wux"
export WUXR_FAKE_WUX_ROOT="$fake_wux_root"
cat > "$fake_bin/wux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${WUXR_FAKE_WUX_ROOT:?}"
mkdir -p "$root"
[ "${1:-}" = "--local" ] && shift
case "${1:-}" in
  status)
    [ "${2:-}" = "--json" ] || exit 2
    if compgen -G "$root/*/meta.json" >/dev/null; then
      jq -s '.' "$root"/*/meta.json
    else
      printf '[]\n'
    fi
    ;;
  run)
    [ "${2:-}" = shell ] || exit 2
    shift 2
    name=""; cwd=""; backend=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --cwd) cwd="$2"; shift 2 ;;
        --json) shift ;;
        --) shift; backend=("$@"); break ;;
        *) printf 'fake wux: unexpected run arg %s\n' "$1" >&2; exit 2 ;;
      esac
    done
    [ -n "$name" ] && [ -n "$cwd" ] && [ "${#backend[@]}" -gt 0 ] || exit 2
    dir="$root/$name"
    if [ -e "$dir" ]; then
      printf '{"error":{"message":"run already exists"}}\n' >&2
      exit 1
    fi
    mkdir -p "$dir"
    created_at_epoch="$(date +%s)"
    printf '{"name":"%s","backend":"shell","status":"running","createdAtEpoch":%s}\n' \
      "$name" "$created_at_epoch" > "$dir/meta.json"
    created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '{"type":"create","at":"%s","run":"%s","backend":"shell"}\n' \
      "$created_at" "$name" > "$dir/events.jsonl"
    : > "$dir/pane.log"
    (
      cd "$cwd"
      exec "${SHELL:-/bin/sh}" "${backend[@]}"
    ) </dev/null >> "$dir/pane.log" 2>&1 &
    printf '%s\n' "$!" > "$dir/pid"
    printf '{"name":"%s","tmuxSession":"fake_%s","backend":"shell"}\n' "$name" "$name"
    ;;
  read)
    name="${2:-}"
    [ "${3:-}" = "--json" ] || exit 2
    dir="$root/$name"
    [ -f "$dir/meta.json" ] || { printf 'run not found: %s\n' "$name" >&2; exit 1; }
    pid="$(cat "$dir/pid" 2>/dev/null || true)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || {
      printf 'tmux session is not running for %s\n' "$name" >&2
      exit 1
    }
    jq -n --arg name "$name" --arg dir "$dir" \
      '{name:$name,capturedAt:"2026-07-28T00:00:00Z",lines:[],paneLogPath:($dir+"/pane.log"),runDir:$dir}'
    ;;
  stop)
    name="${2:-}"
    [ "${3:-}" = "--yes" ] || exit 2
    dir="$root/$name"
    [ -f "$dir/meta.json" ] || { printf 'run not found: %s\n' "$name" >&2; exit 1; }
    pid="$(cat "$dir/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    stopped_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    jq --arg at "$stopped_at" '.status="stopped" | .stoppedAt=$at' \
      "$dir/meta.json" > "$dir/meta.json.tmp"
    mv "$dir/meta.json.tmp" "$dir/meta.json"
    printf '{"type":"stop","at":"%s","run":"%s","by":"%s@local"}\n' \
      "$stopped_at" "$name" "${USER:-${LOGNAME:-fake-smoke}}" >> "$dir/events.jsonl"
    ;;
  *)
    printf 'fake wux: unsupported command %s\n' "${1:-}" >&2
    exit 2
    ;;
esac
EOF
chmod 0755 "$fake_bin/wux"

(
  cd "$repo_dir"
  git init -q
  git config user.email smoke@example.com
  git config user.name smoke
  printf 'base\n' > sample.txt
  git add sample.txt
  git commit -q -m base
)

smoke_path="$fake_bin:$PATH"
# Each fake records its invocation here so the smoke can prove BOTH headless legs
# ran on every review (the fakes return identical payloads, so without this a
# regression that ran only one leg would still pass).
invoked_dir="$output_dir/invoked"
export WUXR_SMOKE_INVOKED="$invoked_dir"

run_review() {
  local base="$1"; shift
  rm -rf "$invoked_dir"
  ( cd "$repo_dir" && PATH="$smoke_path" "$WUX_REVIEW_BIN" --session "$session_id" "$@" ) \
    > "$output_dir/${base}.out" 2> "$output_dir/${base}.err"
}

assert_clean_tmp() {
  local p
  for p in "$claude_prompt" "$codex_prompt" "$codex_last"; do
    [ ! -e "$p" ] || die "temp file lingered: $p"
  done
}

assert_both_invoked() {
  [ -e "$invoked_dir/claude" ] || die "claude leg was not invoked (only one reviewer ran)"
  [ -e "$invoked_dir/codex" ] || die "codex leg was not invoked (only one reviewer ran)"
}

note "wux-review fake-agent smoke: approve path (explicit direct rollback)"
printf 'APPROVE_CASE\n' > "$repo_dir/sample.txt"
run_review approve --direct --json
grep -q '"verdict": "approve"' "$output_dir/approve.out" || die "approve run did not approve (see $output_dir/approve.err)"
grep -q '"session": "'"$session_id"'"' "$output_dir/approve.out" || die "approve run did not report the session id"
assert_both_invoked
assert_clean_tmp

note "wux-review fake-agent smoke: block path (explicit direct rollback)"
printf 'BLOCK_CASE\n' > "$repo_dir/sample.txt"
if run_review block --direct --json; then
  die "block run should have exited 2"
else
  code=$?
fi
[ "$code" -eq 2 ] || die "block run exited $code instead of 2"
grep -q '"verdict": "block"' "$output_dir/block.out" || die "block run did not block"
jq -e '.must_fix | length > 0' "$output_dir/block.out" >/dev/null || die "block run returned no must_fix findings"
# Both legs raised the must-fix and were consolidated into one finding — proves
# the verdict came from BOTH reviewers, not a single leg.
jq -e '[.must_fix[].raised_by[]] | (index("claude") != null) and (index("codex") != null)' \
  "$output_dir/block.out" >/dev/null || die "block must_fix was not raised by both claude and codex"
assert_both_invoked
assert_clean_tmp

observable_session="fakesmoke-obs"
assert_observable_evidence() {
  local round="$1" reviewer="$2" started_at="$3"
  local state="$SESSION_STATE_DIR/$observable_session.json"
  local child
  child="$(jq -r --argjson round "$round" --arg reviewer "$reviewer" \
    '.children[] | select(.round == $round) | .[$reviewer][0].childName' "$state")"
  case "$child" in
    "wuxr-${observable_session}-r${round}-x"*"-${reviewer}") ;;
    *) die "observable child name has wrong identity: $child" ;;
  esac
  local dir="$fake_wux_root/$child"
  [ -f "$dir/prompt.md" ] || die "observable prompt missing: $dir/prompt.md"
  [ -f "$dir/events.jsonl" ] || die "observable events missing: $dir/events.jsonl"
  [ -f "$dir/status.json" ] || die "observable status missing: $dir/status.json"
  [ -f "$dir/lifecycle.json" ] || die "observable lifecycle missing: $dir/lifecycle.json"
  [ -f "$dir/result.json" ] || die "observable atomic result missing: $dir/result.json"
  [ -f "$dir/pane.log" ] || die "observable pane log missing: $dir/pane.log"
  [ ! -e "$dir/result.json.tmp" ] || die "observable result tmp leaked: $dir/result.json.tmp"
  jq -e --argjson started "$started_at" \
    '.createdAtEpoch >= $started and .createdAtEpoch <= ($started + 5)' \
    "$dir/meta.json" >/dev/null || die "observable $reviewer leg was not visible within 5s"
  jq -e --arg child "$child" --arg reviewer "$reviewer" \
    '.version == 1 and .identity.childName == $child and .identity.reviewer == $reviewer' \
    "$dir/result.json" >/dev/null || die "observable result identity invalid: $dir/result.json"
  jq -e --arg child "$child" --arg reviewer "$reviewer" \
    '.version == 1
      and .identity.childName == $child
      and .identity.reviewer == $reviewer
      and .state == "completed"' \
    "$dir/lifecycle.json" >/dev/null || die "observable lifecycle invalid: $dir/lifecycle.json"
  jq -e --arg reviewer "$reviewer" \
    '.version == 2
      and .reviewer == $reviewer
      and .status == "completed"
      and .result.state == "final"
      and .result.code == 0
      and (.lastActivityAt | type == "string")
      and (.phase | type == "string")
      and (.latestActivity | type == "string")' \
    "$dir/status.json" >/dev/null || die "observable safe status invalid: $dir/status.json"
  grep -q '"type":"reviewer-machine-stream-chunk"' "$dir/machine-stream.jsonl" || \
    die "raw machine stream chunks missing: $dir/machine-stream.jsonl"
  if grep -q '"type":"reviewer-machine-stream-chunk"' "$dir/events.jsonl"; then
    die "raw machine stream chunks polluted the Wux control log: $dir/events.jsonl"
  fi
  grep -q '"type":"review-leg-owned-cleanup"' "$dir/events.jsonl" || \
    die "observable exact-child cleanup event missing: $dir/events.jsonl"
  jq -e '.status == "stopped"' "$dir/meta.json" >/dev/null || \
    die "observable Wux child was not finalized: $dir/meta.json"
  if PATH="$smoke_path" wux --local read "$child" --json >/dev/null 2>&1; then
    die "observable Wux child is still live after terminal result: $child"
  fi
  if compgen -G "$TMP_REVIEW_DIR/$child-observable*" >/dev/null; then
    die "observable transient files leaked for $child"
  fi
  [ ! -e "$TMP_REVIEW_DIR/$child-prompt.md" ] || \
    die "observable headless prompt leaked for $child"
  [ ! -e "$TMP_REVIEW_DIR/$child-last.txt" ] || \
    die "observable Codex last-message file leaked for $child"
  grep -q 'result final · exit 0' "$dir/pane.log" || \
    die "final result metadata missing from pane: $dir/pane.log"
  if grep -Eq \
    'SESSION_SECRET|THREAD_SECRET|REASONING_CONTENT|PROMPT_DIFF_TOKEN_SECRET|TOKEN_SECRET|TOOL_OUTPUT_SECRET|input_tokens' \
    "$dir/pane.log"; then
    die "unsafe event payload leaked into pane: $dir/pane.log"
  fi
  if [ "$reviewer" = claude ]; then
    grep -q 'latest file read' "$dir/pane.log" || \
      die "slow Claude pane never showed useful pre-completion activity"
  fi
}

note "wux-review fake-agent smoke: default observable approve path (released Wux interface)"
printf 'APPROVE_CASE\n' > "$repo_dir/sample.txt"
rm -rf "$invoked_dir"
observable_started="$(date +%s)"
( cd "$repo_dir" && PATH="$smoke_path" WUXR_SMOKE_SLOW=1 \
  "$WUX_REVIEW_BIN" --session "$observable_session" --json ) \
  > "$output_dir/observable-approve.out" 2> "$output_dir/observable-approve.err"
grep -q '"verdict": "approve"' "$output_dir/observable-approve.out" || \
  die "observable approve run did not approve (see $output_dir/observable-approve.err)"
assert_both_invoked
assert_observable_evidence 1 claude "$observable_started"
assert_observable_evidence 1 codex "$observable_started"

note "wux-review fake-agent smoke: observable block path + fresh round names"
printf 'BLOCK_CASE\n' > "$repo_dir/sample.txt"
rm -rf "$invoked_dir"
observable_started="$(date +%s)"
if ( cd "$repo_dir" && PATH="$smoke_path" WUXR_SMOKE_SLOW=1 \
  "$WUX_REVIEW_BIN" --session "$observable_session" --json ) \
  > "$output_dir/observable-block.out" 2> "$output_dir/observable-block.err"; then
  die "observable block run should have exited 2"
else
  code=$?
fi
[ "$code" -eq 2 ] || die "observable block run exited $code instead of 2"
grep -q '"verdict": "block"' "$output_dir/observable-block.out" || die "observable block run did not block"
assert_both_invoked
assert_observable_evidence 2 claude "$observable_started"
assert_observable_evidence 2 codex "$observable_started"
jq -e '
  .round == 2
  and (.children | length == 2)
  and .children[0].round == 1
  and .children[1].round == 2
  and ([.children[].claude[], .children[].codex[]] | length == 4)
' "$SESSION_STATE_DIR/$observable_session.json" >/dev/null || \
  die "observable child identities were not persisted by round"

note "wux-review fake-agent smoke: ok"
