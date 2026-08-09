---
name: wux-review
description: Run the Claude+Codex dual review of a code change via the wux-review CLI and report the consolidated verdict. Explicit-only; judges only (never edits code); stops at the human merge gate.
disable-model-invocation: true
---

Run a **dual review** of the change under review with `wux-review` and drive the result. This skill is explicit-only (`/wux-review`); it only **invokes the CLI** — it never re-implements reviewing. All the substance (two independent reviewers, the lens set, consolidation) lives in `wux-review`.

## 1. Resolve the target
- A pull request: `--pr <n>`.
- A ref, a range, or the working tree: pass `<ref>` (e.g. `HEAD~1`, `main..HEAD`), or omit it to review the uncommitted working tree.

## 2. Run the review
```bash
wux-review <target> --json                  # e.g. wux-review --pr 42 --json
# optionally also post the findings to the PR:
wux-review <target> --json --post-to-pr <n>
```
For a review → fix → re-review loop, pick a stable `--session <id>` up front and pass it on **every** run, including the first — that is what makes each re-review context-aware (see step 3). Use an id **unique to this review** (e.g. `<repo>-pr<n>`): ids share a per-host namespace, so a bare `<n>` could collide with another repo's loop and cross-feed its prior findings. A one-off review with no loop can omit it.

`wux-review` spawns two equal, independent reviewers (Claude + Codex), feeds each the same diff and lens set, and returns one consolidated verdict:
`{ verdict, must_fix, nice_fix, nits, reviewers, session }`. Exit code: `0` approve, `2` block, `1` error.

When the caller is a shell script or an agent running with `set -e`, capture the
status after preserving stdout. Exit `2` means **review blocked**, not a crashed
tool, and the JSON payload is still the source of truth:

```bash
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
set +e
wux-review <target> --json >"$stdout_file" 2>"$stderr_file"
status="$?"
set -e

case "$status" in
  0) outcome="review-approved" ;;
  2) outcome="review-blocked" ;;
  *) printf 'wux-review failed with exit %s\n' "$status" >&2; cat "$stderr_file" >&2; exit "$status" ;;
esac

python3 - "$stdout_file" "$outcome" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(json.dumps({"outcome": sys.argv[2], "verdict": payload["verdict"]}))
PY
```

## 3. Act on the verdict
- **`block`** (either reviewer raised a must-fix): apply the must-fix items — *you* own the fix; `wux-review` never edits code — then re-review with the **same** stable `--session <id>` you used on the first run: `wux-review <target> --session <id>`. Each re-review is context-aware — the leg is fed its own prior-round findings (persisted from the previous run *under that id*) and reports only issues still visible in the current diff, so a resolved finding is not re-raised and an approving leg does not flip on a subjective point. (State is persisted only for runs that pass `--session`, so the first run must already carry the id for the first re-review to be incremental.) Repeat until `approve`. End the session with `wux-review --session <id> --end-session` (this also clears the persisted prior-round state).
- **A persistent false-positive blocker** — a leg that re-raises the *same* wrong must-fix across rounds despite being wrong — is not a reason to give up or merge unreviewed. Falsify it with a runnable counter-repro (a `node -e` one-liner, a passing CI note), write those into a `--refutations <file>` (a JSON array of `{ reviewer, file, line, lens, finding, evidence }` matching the finding), and pass `--refutations <file>` on the next `--session` re-review. The finding is recorded in the session's refutation ledger and shown to the leg each round; if the leg re-raises it **without a new repro**, it is demoted to advisory and tagged `persistent-unproven` (demoted, never deleted — it stays visible), and the verdict unblocks. A blocker that *does* carry a valid repro is never demoted. This never auto-approves: a genuinely new must-fix still blocks.
- **`approve`**: report it.

## 4. Stop at the human merge gate
Report the final verdict (clean, ready for human merge approval). **Do NOT merge** unless a human explicitly authorizes the merge in this session. "Run the review" is not merge authorization.
