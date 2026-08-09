#!/usr/bin/env bash
# Executable contract test for the released Wux mutation actor used to
# authenticate wux-review's exact-child cleanup.
set -euo pipefail

WUX_OWNER_CONTRACT_BIN="${WUX_OWNER_CONTRACT_BIN:-wux}"
WUX_OWNER_CONTRACT_VERSION="${WUX_OWNER_CONTRACT_VERSION:-2026.06.21.1}"
WUX_OWNER_CONTRACT_ROOT="${WUX_OWNER_CONTRACT_ROOT:-}"

own_root=0
if [ -z "$WUX_OWNER_CONTRACT_ROOT" ]; then
  WUX_OWNER_CONTRACT_ROOT="$(mktemp -d)"
  own_root=1
fi
state_home="$WUX_OWNER_CONTRACT_ROOT/state"
work_dir="$WUX_OWNER_CONTRACT_ROOT/work"
run_prefix="wuxr-owner-contract-$$"
mkdir -p "$state_home" "$work_dir"

wux() {
  XDG_STATE_HOME="$state_home" "$WUX_OWNER_CONTRACT_BIN" "$@"
}

cleanup() {
  local status="$?"
  wux stop "${run_prefix}-user" --yes >/dev/null 2>&1 || true
  wux stop "${run_prefix}-logname" --yes >/dev/null 2>&1 || true
  wux stop "${run_prefix}-exited" --yes >/dev/null 2>&1 || true
  tmux kill-session -t "=wux_${run_prefix}-user" >/dev/null 2>&1 || true
  tmux kill-session -t "=wux_${run_prefix}-logname" >/dev/null 2>&1 || true
  tmux kill-session -t "=wux_${run_prefix}-exited" >/dev/null 2>&1 || true
  if [ "$own_root" -eq 1 ]; then
    rm -rf "$WUX_OWNER_CONTRACT_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

actual_version="$(wux --version)"
if [ "$actual_version" != "$WUX_OWNER_CONTRACT_VERSION" ]; then
  printf 'released Wux owner contract: expected %s, got %s\n' \
    "$WUX_OWNER_CONTRACT_VERSION" "$actual_version" >&2
  exit 1
fi

assert_stop_actor() {
  local run_name="$1"
  local expected_actor="$2"
  local user_actor="$3"
  local logname_actor="$4"
  local lifecycle="${5:-live}"
  local events_path="$state_home/wux/runs/$run_name/events.jsonl"

  if [ "$lifecycle" = "exited" ]; then
    wux run shell --name "$run_name" --cwd "$work_dir" --json -- \
      -c 'sleep 1' >/dev/null
    local observed_exit=0
    for ((poll = 0; poll < 100; poll++)); do
      if ! tmux has-session -t "=wux_$run_name" 2>/dev/null; then
        observed_exit=1
        break
      fi
      sleep 0.05
    done
    if [ "$observed_exit" -ne 1 ]; then
      printf 'released Wux owner contract: shell did not exit before stop (%s)\n' \
        "$run_name" >&2
      exit 1
    fi
  else
    wux run shell --name "$run_name" --cwd "$work_dir" --json >/dev/null
  fi
  env XDG_STATE_HOME="$state_home" USER="$user_actor" LOGNAME="$logname_actor" \
    "$WUX_OWNER_CONTRACT_BIN" --local stop "$run_name" --yes >/dev/null
  local read_output
  local read_status
  set +e
  read_output="$(wux --local read "$run_name" --json 2>&1)"
  read_status="$?"
  set -e
  if [ "$read_status" -eq 0 ]; then
    printf 'released Wux owner contract: read unexpectedly succeeded after stop (%s)\n' \
      "$run_name" >&2
    exit 1
  fi
  local read_detail="$read_output"
  local json_detail
  if json_detail="$(printf '%s' "$read_output" | jq -er '.error.message | select(type == "string")' 2>/dev/null)"; then
    read_detail="$json_detail"
  fi
  read_detail="${read_detail#wux: }"
  case "$read_detail" in
    "run not found:"* \
      |"run is not running"|"run is not running "* \
      |"run is stopped"|"run is stopped:"* \
      |"run is already stopped"|"run is already stopped:"* \
      |"tmux session is not running"|"tmux session is not running "* \
      |"no such session"|"no such session "* \
      |"unknown session"|"unknown session "*) ;;
    *)
      printf 'released Wux owner contract: unrecognized read-after-stop error: %s\n' \
        "$read_detail" >&2
      exit 1
      ;;
  esac
  jq -se --arg run "$run_name" --arg actor "$expected_actor" '
    [.[] | select(.type == "create" and .run == $run)] as $creates
    | [.[] | select(.type == "stop" and .run == $run)] as $stops
    | ($creates | length) == 1
      and ($stops | length) == 1
      and ($stops[0].by | startswith($actor + "@"))
  ' "$events_path" >/dev/null
}

assert_idempotent_stop() {
  local run_name="$1"
  local actor="$2"
  local events_path="$state_home/wux/runs/$run_name/events.jsonl"
  env XDG_STATE_HOME="$state_home" USER="$actor" LOGNAME="$actor" \
    "$WUX_OWNER_CONTRACT_BIN" --local stop "$run_name" --yes >/dev/null
  jq -se --arg run "$run_name" '
    [.[] | select(.type == "stop" and .run == $run)] | length == 1
  ' "$events_path" >/dev/null
}

assert_stop_actor "${run_prefix}-user" "wux-review-contract-user" \
  "wux-review-contract-user" "wux-review-contract-wrong"
assert_stop_actor "${run_prefix}-logname" "wux-review-contract-logname" \
  "" "wux-review-contract-logname"
assert_stop_actor "${run_prefix}-exited" "wux-review-contract-exited" \
  "wux-review-contract-exited" "wux-review-contract-wrong" exited
assert_idempotent_stop "${run_prefix}-user" "wux-review-contract-repeat"

printf 'released Wux owner contract: pass (%s; live/exited actors + idempotent stop + read-after-stop)\n' \
  "$actual_version"
