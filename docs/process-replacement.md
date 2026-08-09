# Process Replacement Decision

Whether agents can use `wux-review` as the standard Claude+Codex review gate
instead of the manual Wux dual-review loop — without bespoke prompting or manual
babysitting.

Decision: the bounded headless review contract is proven suitable as the
standard automated review gate. On real pull requests it returned non-empty
`block`/`approve` verdicts unattended, with no no-verdict timeouts and no
manual-only must-fix misses in the comparison set. The worker still owns the
fix loop and a human retains final merge authority.

The unchanged bounded headless legs now run in observable Wux children by
default. `--direct` retains the direct transport as an explicit emergency
rollback with identical verdict semantics; `--inspect` remains a compatibility
alias for the observable default.

## What changed (root cause)

Through `2026.06.13.2`, each reviewer leg ran an interactive `wux run claude|codex`
session and `wux send` the instruction, then polled a sentinel file for ≤10 min.
That send-into-a-TUI chokepoint paste-swallowed / idle-stalled in an unattended
loop, so the four Epic 2 real-PR comparisons produced **no verdict** — exit `1`,
empty stdout, a 600 s timeout each. The tool was parked at advisory.

`2026.06.25` rebuilds both legs on the **headless** pattern: `claude -p
--output-format json` and `codex exec` are driven as bounded, one-shot
subprocesses that *exit* on completion, so there is no TUI, no `wux send`, no
sentinel polling, and a per-leg wall-clock bound guarantees the review can never
hang. This direct headless transport is retained behind `--direct`. The default
observable transport wraps the same argv in Wux and fails closed if its launch
or durable-result contract fails. Neither path returns to the interactive-TUI
send mechanism. This is the change that turned "no verdict" into "always a
bounded verdict."

## Evaluation evidence (proven on the headless legs)

| Area | Evidence | Result |
|------|----------|--------|
| Seeded CLI cases | `scripts/seeded-cli-cases.sh` | approve / correctness-block / shell-security-block / docs-nit all return their expected verdicts on the headless legs, unattended. |
| Fake-agent CI smoke | `scripts/smoke-fake-agent-wux.sh` | Green in CI with fake `claude`/`codex` (no model auth): approve, block (exit 2 + non-empty must_fix), both legs invoked + consolidated, temp-file cleanup. |
| Real pull-request verdict | Recorded evaluation run | A bounded `block` in 171 s, exit 2, non-empty findings, and no human nudging. |
| Real pull-request comparison | Three recorded evaluation runs | All returned actual verdicts in roughly three minutes; no timeouts; no manual-only must-fix misses. |
| Unattended re-review loop | Seeded evaluation | A blocked change drove block → apply fix → re-review → approve; the two per-agent comments updated **in place**, and the total comment count stayed exactly two. |

### Real-PR comparison detail

The recorded runs used the headless CLI (`--pr <n> --json`) against three
changes that had also received manual Claude+Codex review before merge.

| Change | wux-review | Manual | Time | Notes |
| --- | --- | --- | --- | --- |
| Per-agent PR comments | **block** (3 must-fix) | approve | 171 s | wux-review surfaced subtle issues the manual review did not, including per-reviewer severity when filtering consolidated buckets. |
| Configurable `check` | **approve** (0 must-fix) | approve | 173 s | Matches manual; nice-fix suggestions only. |
| Default transport change | **block** (2 must-fix) | approve | 177 s | Conservative on an intentional refactor reviewed diff-only; the worker adjudicates and proceeds. |

Every run returned a bounded, non-empty verdict unattended — the failure mode
that blocked replacement (no verdict) is gone. wux-review never missed a must-fix
the manual gate caught; where the verdicts differ it is wux-review being **more**
thorough or conservative on a diff reviewed in isolation, which the worker
adjudicates. Diff-only review has no surrounding-code context, so a block is the
reviewer's opinion for the worker to act on — it is not authorization to bypass
the human merge gate.

## Current Process

For every PR, `wux-review` is the standard automated review gate:

1. Run the deterministic check (`wux-review check`, or the repo's configured
   `check:` command) and the required GitHub checks.
2. Run `wux-review <target> --json` (optionally `--post-to-pr <n>`). It drives the
   headless Claude + Codex legs and returns the consolidated verdict; exit `0`
   approve, exit `2` block, exit `1` execution error.
3. Treat a `block` as the reviewer raising a must-fix: fix it and re-review, or
   record why it does not apply (e.g. a conservative diff-only finding on an
   intentional change). The worker owns this loop.
4. Merge only after `wux-review` approves (or its must-fixes are resolved/justified)
   and the required GitHub checks are green. The human owns the final merge gate;
   wux-review judges, it never merges.

The manual interactive Wux dual-review is no longer required for every PR.

## Supported Caller Paths

- **CLI:** `wux-review <target> --json` is the primary observable path. Exit `0`
  approve, `2` block, `1` execution error. Use `--direct` for the emergency
  direct-headless rollback.
- **Portable skill:** invokes the CLI; capture stdout before branching on status.
- **Claude MCP:** `wux-review mcp` exposes `review_diff`; a blocked review returns
  a successful tool result with `verdict: "block"` (no CLI-style exit `2`).
- **Codex MCP:** unsupported; Codex callers use the CLI or portable skill.
- **Default / `--inspect`:** observable execution runs each unchanged headless
  leg inside a fresh `wux run shell` session and requires its durable atomic
  result. `--inspect` is retained as a compatibility alias.
- **`--direct`:** bypasses Wux explicitly while preserving review and verdict
  semantics; observable failures never select it automatically.
- **`--post-to-pr <n>`:** posts one comment per reviewer, each marker-keyed
  (`<!-- dual-review:claude|codex -->`) so a re-review updates it in place —
  exactly one Claude and one Codex comment per PR, no duplicate pile.

## Replacement Bar — met

| Bar | Status |
|-----|--------|
| ≥2 real pull-request comparisons with a produced verdict vs the manual gate | ✅ three comparisons |
| No no-verdict timeouts | ✅ all bounded (171–177 s) |
| No manual-only must-fix misses | ✅ manual found 0 must-fix on all three; wux-review blocked 2 of 3 and missed none (caught ≥ manual) |
| Blocked reviews preserve stdout/JSON, handled as review-blocked not crashed | ✅ exit 2 + JSON envelope |
| Re-review converges (block → fix → approve) without stale findings | ✅ seeded evaluation |
| `--post-to-pr` updates in place without duplicate piles | ✅ seeded evaluation (count stayed 2) |
| Seeded + fake-agent smoke green on the headless legs | ✅ recorded evaluation and CI smoke |

## Earlier transport evaluation

An earlier interactive transport evaluation proved installation, seeded cases,
the portable skill, the Claude MCP surface, session looping, and PR-comment
deduplication, but all four real pull-request comparisons produced **no verdict**
after a 600-second reviewer timeout at the interactive `wux send` chokepoint.
The bounded headless legs fixed that failure; see "What changed" above.
