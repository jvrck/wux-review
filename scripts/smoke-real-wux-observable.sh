#!/usr/bin/env bash
# Exercise the compiled candidate observable path through released Wux + tmux
# with deterministic fake Claude/Codex processes. No model auth or credits.
set -euo pipefail

note() { printf '%s\n' "$*" >&2; }
die() { printf 'wux-review real-Wux observable smoke: %s\n' "$*" >&2; exit 1; }

WUX_REVIEW_BIN="${WUX_REVIEW_BIN:-}"
WUX_REAL_SMOKE_WUX_BIN="${WUX_REAL_SMOKE_WUX_BIN:-wux}"
WUX_REAL_SMOKE_WUX_VERSION="${WUX_REAL_SMOKE_WUX_VERSION:-2026.06.21.1}"
ROOT_INPUT="${WUX_REAL_SMOKE_ROOT:-}"
DIAG_DIR="${WUX_REAL_SMOKE_DIAG_DIR:-}"
TMP_REVIEW_DIR="/tmp/wux-review"
SESSION_STATE_DIR="$TMP_REVIEW_DIR/sessions"
ROUND_STATE_DIR="$TMP_REVIEW_DIR/observable-rounds"

[ -n "$WUX_REVIEW_BIN" ] || die "WUX_REVIEW_BIN is required"
[ -x "$WUX_REVIEW_BIN" ] || die "binary is not executable: $WUX_REVIEW_BIN"
resolved_wux_bin="$(command -v "$WUX_REAL_SMOKE_WUX_BIN" 2>/dev/null || true)"
[ -n "$resolved_wux_bin" ] || die "released Wux binary not found: $WUX_REAL_SMOKE_WUX_BIN"
case "$resolved_wux_bin" in
  /*) ;;
  *)
    resolved_wux_dir="$(cd "$(dirname "$resolved_wux_bin")" && pwd -P)" || \
      die "cannot resolve released Wux binary: $resolved_wux_bin"
    resolved_wux_bin="$resolved_wux_dir/$(basename "$resolved_wux_bin")"
    ;;
esac
[ -x "$resolved_wux_bin" ] || die "released Wux binary is not executable: $resolved_wux_bin"
WUX_REAL_SMOKE_WUX_BIN="$resolved_wux_bin"
for required_command in git jq tmux; do
  command -v "$required_command" >/dev/null 2>&1 || die "$required_command is required"
done

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
state_home="$root/state"
call_dir="$root/calls"
run_prefix="wuxr-rwsmoke$$"
approve_session="rwsmoke$$-a"
block_session="rwsmoke$$-b"
interrupt_session="rwsmoke$$-i"
rm -rf "$fake_bin" "$repo_dir" "$output_dir" "$state_home" "$call_dir"
mkdir -p "$fake_bin" "$repo_dir" "$output_dir" "$state_home" "$call_dir"

export XDG_STATE_HOME="$state_home"
export WUX_REVIEW_OBSERVABLE_PREFIX="$run_prefix"
export WUXR_REAL_SMOKE_CALL_DIR="$call_dir"

wux() {
  XDG_STATE_HOME="$state_home" "$WUX_REAL_SMOKE_WUX_BIN" "$@"
}

run_names() {
  local dir
  for dir in "$state_home"/wux/runs/"$run_prefix"-*; do
    [ -d "$dir" ] || continue
    basename "$dir"
  done
}

collect_diagnostics() {
  local status="$1"
  local dest="${DIAG_DIR:-$root/diagnostics}"
  mkdir -p "$dest"
  {
    printf 'status=%s\n' "$status"
    printf 'root=%s\n' "$root"
    printf 'wux_review_bin=%s\n' "$WUX_REVIEW_BIN"
    printf 'wux_bin=%s\n' "$WUX_REAL_SMOKE_WUX_BIN"
    date -u
    "$WUX_REVIEW_BIN" --version || true
    wux --version || true
  } > "$dest/environment.txt" 2>&1 || true
  cp -R "$output_dir" "$dest/output" 2>/dev/null || true
  wux --local status --json > "$dest/wux-status.json" 2>&1 || true
  find "$state_home/wux/runs" -maxdepth 2 -type f -print > "$dest/evidence-files.txt" 2>&1 || true
  for session in "$approve_session" "$block_session" "$interrupt_session"; do
    if [ -f "$SESSION_STATE_DIR/$session.json" ]; then
      cp "$SESSION_STATE_DIR/$session.json" "$dest/session-$session.json" 2>/dev/null || true
    fi
    if [ -f "$ROUND_STATE_DIR/$session.json" ]; then
      cp "$ROUND_STATE_DIR/$session.json" "$dest/round-$session.json" 2>/dev/null || true
    fi
  done
  return 0
}

cleanup() {
  local status="$?"
  if [ "$status" -ne 0 ]; then collect_diagnostics "$status" || true; fi
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    wux --local stop "$name" --yes >/dev/null 2>&1 || true
    tmux kill-session -t "=wux_$name" >/dev/null 2>&1 || true
  done < <(run_names)
  rm -f \
    "$SESSION_STATE_DIR/$approve_session.json" \
    "$SESSION_STATE_DIR/$block_session.json" \
    "$SESSION_STATE_DIR/$interrupt_session.json" \
    "$ROUND_STATE_DIR/$approve_session.json" \
    "$ROUND_STATE_DIR/$block_session.json" \
    "$ROUND_STATE_DIR/$interrupt_session.json"
  if [ "$own_root" -eq 1 ] && [ "$status" -eq 0 ]; then rm -rf "$root"; fi
  exit "$status"
}
trap cleanup EXIT

actual_wux_version="$(wux --version)"
[ "$actual_wux_version" = "$WUX_REAL_SMOKE_WUX_VERSION" ] || \
  { note "wux-review real-Wux observable smoke: SKIP: expected Wux $WUX_REAL_SMOKE_WUX_VERSION, got $actual_wux_version"; exit 0; }

# wux-review invokes `wux` by name. Keep the actual released binary explicit
# while putting deterministic reviewer fakes ahead of the ambient PATH.
cat > "$fake_bin/wux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${WUX_REAL_SMOKE_WUX_BIN:?}" "$@"
EOF

cat > "$fake_bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
mkdir -p "${WUXR_REAL_SMOKE_CALL_DIR:?}"
: > "$WUXR_REAL_SMOKE_CALL_DIR/claude-$PPID-$$"
if printf '%s' "$input" | grep -q 'BLOCK_CASE'; then
  findings='[{"lens":"correctness","file":"sample.txt","line":1,"severity":"must-fix","finding":"BLOCK_CASE must block the review"}]'
else
  findings='[]'
fi
result="$(printf '```json\n{"findings":%s}\n```' "$findings")"
jq -nc '{type:"system",subtype:"init",session_id:"REAL_WUX_SMOKE"}'
jq -nc '{type:"assistant",message:{content:[{type:"tool_use",name:"Read",input:{file_path:"/safe/fake"}}]}}'
sleep "${WUXR_REAL_SMOKE_DELAY_SECONDS:-5}"
jq -nc --arg r "$result" '{type:"result",subtype:"success",is_error:false,result:$r}'
EOF

cat > "$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""; prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    exec) shift ;;
    --json|--ephemeral|--skip-git-repo-check) shift ;;
    -o) out="$2"; shift 2 ;;
    -s|-C|-m) shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done
[ -n "$out" ] || { printf 'fake codex: no -o output path\n' >&2; exit 1; }
mkdir -p "${WUXR_REAL_SMOKE_CALL_DIR:?}"
: > "$WUXR_REAL_SMOKE_CALL_DIR/codex-$PPID-$$"
brief="$(printf '%s' "$prompt" | grep -oE '/[^ ]*-prompt\.md' | head -1 || true)"
[ -n "$brief" ] && [ -f "$brief" ] || { printf 'fake codex: unreadable brief\n' >&2; exit 1; }
input="$(cat "$brief")"
if printf '%s' "$input" | grep -q 'BLOCK_CASE'; then
  findings='[{"lens":"correctness","file":"sample.txt","line":1,"severity":"must-fix","finding":"BLOCK_CASE must block the review"}]'
else
  findings='[]'
fi
jq -nc '{type:"thread.started",thread_id:"REAL_WUX_SMOKE"}'
jq -nc '{type:"turn.started"}'
sleep "${WUXR_REAL_SMOKE_DELAY_SECONDS:-5}"
jq -nc '{type:"turn.completed"}'
printf '```json\n{"findings":%s}\n```\n' "$findings" > "$out"
EOF
chmod 0755 "$fake_bin/wux" "$fake_bin/claude" "$fake_bin/codex"

export WUX_REAL_SMOKE_WUX_BIN
smoke_path="$fake_bin:$PATH"

(
  cd "$repo_dir"
  git init -q
  git config user.email smoke@example.com
  git config user.name smoke
  printf 'base\n' > sample.txt
  git add sample.txt
  git commit -q -m base
)

call_count() {
  find "$call_dir" -type f | wc -l | tr -d ' '
}

wait_visible() {
  local session="$1" deadline=$((SECONDS + 5))
  while [ "$SECONDS" -le "$deadline" ]; do
    local status
    if ! status="$(PATH="$smoke_path" wux --local status --json)"; then
      sleep 0.1
      continue
    fi
    if jq -e --arg prefix "$run_prefix-$session-r1-x" '
      [.[] | select(.status == "running" and (.name | startswith($prefix))) | .name] as $names
      | ($names | map(select(endswith("-claude"))) | length) == 1
        and ($names | map(select(endswith("-codex"))) | length) == 1
    ' <<< "$status" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  die "$session did not expose both reviewer sessions within five seconds"
}

wait_review() {
  local pid="$1" expected="$2"
  set +e
  wait "$pid"
  local code="$?"
  set -e
  [ "$code" -eq "$expected" ] || die "review exited $code instead of $expected"
}

start_review() {
  local session="$1" marker="$2" out="$3" delay="${4:-5}"
  printf '%s\n' "$marker" > "$repo_dir/sample.txt"
  (
    cd "$repo_dir"
    exec env \
      PATH="$smoke_path" \
      XDG_STATE_HOME="$state_home" \
      WUX_REVIEW_OBSERVABLE_PREFIX="$run_prefix" \
      WUXR_REAL_SMOKE_CALL_DIR="$call_dir" \
      WUXR_REAL_SMOKE_DELAY_SECONDS="$delay" \
      "$WUX_REVIEW_BIN" --session "$session" --inspect --json
  ) > "$output_dir/$out.out" 2> "$output_dir/$out.err" &
  REVIEW_PID="$!"
}

session_children() {
  local session="$1"
  jq -r '.children[] | .claude[].childName, .codex[].childName' \
    "$SESSION_STATE_DIR/$session.json"
}

assert_terminal_evidence() {
  local session="$1" expected_state="$2"
  local child dir read_code
  local count=0
  while IFS= read -r child; do
    [ -n "$child" ] || continue
    count=$((count + 1))
    dir="$state_home/wux/runs/$child"
    for file in prompt.md events.jsonl status.json lifecycle.json result.json pane.log; do
      [ -f "$dir/$file" ] || die "missing durable evidence: $dir/$file"
    done
    [ -f "$dir/machine-stream.jsonl" ] || [ -f "$dir/recovery-stream.jsonl" ] || \
      die "missing durable machine or recovery stream: $dir"
    jq -e --arg child "$child" --arg state "$expected_state" \
      '.identity.childName == $child and .state == $state' "$dir/lifecycle.json" >/dev/null || \
      die "invalid lifecycle for $child"
    jq -e --arg child "$child" '.identity.childName == $child' "$dir/result.json" >/dev/null || \
      die "invalid result identity for $child"
    set +e
    PATH="$smoke_path" wux --local read "$child" --json >/dev/null 2>&1
    read_code="$?"
    set -e
    [ "$read_code" -ne 0 ] || die "child still live after terminal result: $child"
    if compgen -G "$TMP_REVIEW_DIR/$child-observable*" >/dev/null; then
      die "observable transient leaked for $child"
    fi
    [ ! -e "$TMP_REVIEW_DIR/$child-prompt.md" ] || die "prompt transient leaked for $child"
    [ ! -e "$TMP_REVIEW_DIR/$child-last.txt" ] || die "last-message transient leaked for $child"
  done < <(session_children "$session")
  [ "$count" -eq 2 ] || die "expected two durable children for $session, got $count"
}

note "real-Wux observable smoke: approve + visibility"
before="$(call_count)"
start_review "$approve_session" APPROVE_CASE approve
approve_pid="$REVIEW_PID"
wait_visible "$approve_session"
wait_review "$approve_pid" 0
jq -e '.verdict == "approve"' "$output_dir/approve.out" >/dev/null || die "approve verdict missing"
[ "$(( $(call_count) - before ))" -eq 2 ] || die "approve did not invoke exactly two reviewers"
assert_terminal_evidence "$approve_session" completed

note "real-Wux observable smoke: block + visibility"
before="$(call_count)"
start_review "$block_session" BLOCK_CASE block
block_pid="$REVIEW_PID"
wait_visible "$block_session"
wait_review "$block_pid" 2
jq -e '.verdict == "block" and (.must_fix | length) > 0' "$output_dir/block.out" >/dev/null || \
  die "block verdict or must-fix missing"
[ "$(( $(call_count) - before ))" -eq 2 ] || die "block did not invoke exactly two reviewers"
assert_terminal_evidence "$block_session" completed

note "real-Wux observable smoke: interrupted parent + zero-call reconcile"
before="$(call_count)"
start_review "$interrupt_session" APPROVE_CASE interrupted 8
interrupt_pid="$REVIEW_PID"
wait_visible "$interrupt_session"
kill -TERM "$interrupt_pid"
wait_review "$interrupt_pid" 1
grep -q 'reconcile' "$output_dir/interrupted.err" || die "interruption did not name reconciliation"

# The detached reviewer wrappers finish their deterministic calls after the
# parent has retained the exact recovery identity. Reconcile then consumes only
# those durable/transient bytes; it must not launch either fake again.
deadline=$((SECONDS + 15))
while [ "$SECONDS" -le "$deadline" ]; do
  if [ "$(call_count)" -eq "$((before + 2))" ] && \
    ! PATH="$smoke_path" wux --local status --json | jq -e --arg prefix "$run_prefix-$interrupt_session-r1-x" \
      '.[] | select(.status == "running" and (.name | startswith($prefix)))' >/dev/null; then
    break
  fi
  sleep 0.2
done
[ "$(call_count)" -eq "$((before + 2))" ] || die "interrupted review did not complete both original fake calls"
before_reconcile="$(call_count)"
(
  cd "$repo_dir"
  PATH="$smoke_path" XDG_STATE_HOME="$state_home" \
    "$WUX_REVIEW_BIN" reconcile "$interrupt_session" --json
) > "$output_dir/reconcile.out" 2> "$output_dir/reconcile.err"
jq -e '.verdict == "approve"' "$output_dir/reconcile.out" >/dev/null || die "reconcile verdict missing"
[ "$(call_count)" -eq "$before_reconcile" ] || die "reconcile launched an extra reviewer call"
assert_terminal_evidence "$interrupt_session" reconciled

note "wux-review real-Wux observable smoke: ok"
