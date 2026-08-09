# Commands

The current `wux-review` CLI surface.

```
wux-review [<ref>]            Review a diff: a git ref (HEAD~1), a range (main..HEAD),
                              or — when <ref> is omitted — the working tree.
wux-review --pr <n>           Review a pull request's diff.
wux-review check              Run the deterministic check (.wux-review.yml `check:`).
wux-review reconcile <id>     Finalize an interrupted observable round without
                              starting either reviewer again.
wux-review mcp                Start the MCP server (the review_diff tool).
wux-review --help | --version
```

## `check`
`wux-review check` runs the repo's deterministic build/test gate and exits with
its status (`0` pass, non-zero fail). The command(s) come from the `check:` key in
`.wux-review.yml` — a string or an ordered list run fail-fast — defaulting to
`bun run typecheck && bun test`. Point it at `pytest`, `cargo test`, etc. to keep
a non-Bun repo portable. It is a separate deterministic gate and does **not**
change the AI review verdict (which still blocks iff a reviewer raises a must-fix).

```yaml
# .wux-review.yml
check:
  - ruff check
  - pytest -q
```

## Options
| Flag | Meaning |
|------|---------|
| `--pr <n>` | Review PR `<n>` instead of a local ref (mutually exclusive with `<ref>`). |
| `--lenses <list>` | Comma-separated lens-set override (default: the v1 lens set). |
| `--post-to-pr <n>` | Also post the consolidated findings as a PR comment on PR `<n>`. |
| `--session <id>` | Use a stable id for the run (names each leg's temp files); re-review with the same id reviews the current diff fresh. |
| `--end-session` | With `--session <id>`, tear down any sessions for that id and exit (cleanup). |
| `--refutations <file>` | JSON file of findings the worker has refuted with evidence; see [Refuting a finding](#refuting-a-finding). |
| `--direct` | Emergency rollback: run the unchanged headless legs without Wux. Prompts, parsing, timeouts, retries, and verdict semantics are unchanged. |
| `--inspect` | Compatibility alias for the default observable execution. |
| `--json` / `--no-json` | Machine-readable (default for non-TTY) vs. human output. |

## Refuting a finding

`--refutations <file>` is session-scoped: pass it with `--session <id>` on a
re-review after you have falsified a finding. The file is a JSON array. Copy
`reviewer`, `file`, `line`, `lens`, and `finding` verbatim from the verdict so
the entry keys to the same finding, then add the counter-evidence:

```json
[
  {
    "reviewer": "codex",
    "file": "src/x.ts",
    "line": 42,
    "lens": "security",
    "finding": "regex $ matches before a trailing newline",
    "evidence": "node -e 'process.stdout.write(String(/x$/.test(\"x\\n\")))' prints false; CI green"
  }
]
```

Each entry is recorded in that reviewer's per-leg ledger and shown to that leg
on every re-review. Every must-fix or `[security]` finding should include a
runnable `repro`; wux-review never runs it, but it is concrete evidence that can
be checked or refuted.

If a reviewer re-raises a refuted must-fix **without a new repro**, wux-review
demotes it to advisory and marks it `persistent-unproven`. The finding is
demoted, never deleted; a genuinely new must-fix, or one with new runnable
proof, still blocks the verdict.

`--post-to-pr` is additive: it never changes the review verdict or edits code.
It posts **one comment per reviewer** — Claude and Codex — each keyed by a hidden
marker (`<!-- dual-review:claude -->` / `<!-- dual-review:codex -->`) so a
re-review updates that reviewer's comment in place: exactly one Claude and one
Codex comment per PR, never a duplicate pile. If posting fails, the CLI prints a
warning and still exits according to the review verdict. The reviewed target and
the destination PR can differ, so controlled proof runs can post to a dedicated
PR while reviewing the same PR diff.

**Detecting a fresh verdict (upsert semantics).** Because the comments are
updated in place, the PR's wux-review comment **count stays 2 across every round** —
so a new comment never appears to signal a completed re-review. Each comment
instead opens with a visible header line:

```
**Dual-review (codex) — round 2 · updated 2026-07-24T04:51:24Z · verdict: must-fix**
```

Detect a new verdict by the **round number** (or the comment `updatedAt` / the
header timestamp), never by the comment count. `round` comes from the
`--session` state (round 1 on the first review of a session or a one-shot;
incremented each re-review), and the header `verdict` is that leg's own
`clean`/`must-fix`. The HTML marker keys are unchanged, so marker-grep tooling is
unaffected.

On completion the CLI prints a positive posted-verdict signal to **stderr** (so it
never corrupts the machine-readable `--json` verdict on stdout):

```
wux-review: verdict posted (round 2) — claude <url> · codex <url>
```

so a driving session gets a definitive "verdict posted (round N)" with both
comment URLs without polling the PR.

## Observable execution (default)

The default mode wraps the existing `claude -p` / `codex exec` argv in fresh parallel
`wux run shell` children named
`<prefix>-<review-id>-r<round>-x<execution>-<reviewer>`. The fresh execution
nonce keeps a failed round or deliberately reused session id retryable without
attaching to an old durable child. The prefix defaults to `wuxr` and can be
changed with `WUX_REVIEW_OBSERVABLE_PREFIX` (a 1–32 character safe slug).

Each Wux run directory keeps `prompt.md`, append-only control `events.jsonl`,
append-only raw `machine-stream.jsonl`, atomic `status.json`, typed
`lifecycle.json`, and `result.json` published via `result.json.tmp` + rename.
Zero-call reconstruction additionally records its exact raw capture in
`recovery-stream.jsonl`. If an atomic temporary result is found after a crash,
it is quarantined as `result.rejected.json`; that file is incident evidence and
is never accepted as a verdict.
Lifecycle state is one of `pending`, `running`,
`completed`, `failed`, `timed_out`, `tainted`, `interrupted`, or `reconciled`.
Only the identity-validated `result.json` is returned to the existing findings
parser; pane/capture text is evidence only. A collision, disappearance, timeout,
or missing/malformed/mismatched/partial result is a typed, fail-closed error
naming the child and its evidence path—observable mode never silently falls back
to direct execution. The wrapper reconstructs the direct leg's environment from
a transient mode-0600 NUL file, so tmux server lifetime cannot discard PATH,
auth variables, or an isolated `CODEX_HOME`. Session-mode state records the
round's child names, evidence paths, result identities, and recovery bootstrap
identities additively.

Observation is safe: `wux read`, `wux view`, `wux status`, and `wux attach` do
not taint a review. External control after launch does. A released Wux `send`,
`interrupt`, `handoff`, or `stop` event records its action, actor, and timestamp
in `lifecycle.json`, changes the leg to `tainted`, and blocks acceptance even if
both reviewer payloads approve. Malformed, truncated, rewritten, or
identity-conflicting Wux event evidence also taints and fails closed. The one
exception is wux-review's own exact-child `stop`, which is recorded as owned
cleanup and cannot taint its result. There is no interactive send path in
observable execution.

The unchanged one-shot engines expose machine events in this mode: Claude runs
`-p --output-format stream-json --verbose`, and Codex keeps `exec -o` for its
last message while adding `--json`. Raw stdout bytes are appended losslessly to
`machine-stream.jsonl` as offset-ordered base64
`reviewer-machine-stream-chunk` records. Concatenating their decoded `data`
reconstructs the exact stream, including partial writes, malformed/unknown
events, and an unterminated final line. Live parsing is separately bounded; an
oversized or malformed event is retained raw and counted as a safe diagnostic.
The atomic result carries only Claude's final bounded `result` event or Codex's
`-o` last message; lifecycle volume stays in chunked evidence and cannot force a
whole-stream memory allocation on the verdict path. Safe activity parsing stays
bounded at 256 KiB per event; final Claude result events have a separate 16 MiB
limit. A larger result remains raw evidence but fails closed instead of falling
back to an earlier result event. Direct mode also drains machine stdout with
bounded memory: Claude retains only that final-event-sized tail, while Codex
discards event stdout because its `-o` last message remains authoritative.
Both transports retain at most the final 256 KiB of stderr. The Wux wrapper
keeps its pane follower alive through the parent's final snapshot, exits if that
parent dies, and uses result-generation-specific release/ack markers so a stale
cleanup cannot target a later leg. Cleanup is armed before marker publication;
after acknowledging, the parent removes the wrapper bootstrap so it can exit
without a fixed cleanup delay. The wrapper self-cleans its acknowledgement, and
the parent journals its observed normal exit before returning the leg. Every
terminal lifecycle path removes the exact generation's transient markers.

The Wux pane is a concise observational surface:

```text
review <id> · round <n> · leg <claude|codex> · attempt <n>
state <state> · elapsed <seconds>s · last activity <seconds>s ago
phase <phase> · latest <allowlisted lifecycle/tool category>
result <pending|final · exit n> · diagnostics <n>
```

Only fixed lifecycle labels and fixed tool categories are eligible for
`phase`/`latest`. Prompt/diff text, assistant text, reasoning, commands, paths,
tool inputs/results, ids, secrets, token usage, and arbitrary unknown fields are
never rendered. Schema-version-2 `status.json` carries the same safe activity
atomically for recovery/inspection. A renderer failure is diagnosed but cannot
change the validated atomic result or determine a verdict.

### Reconcile an interrupted observable round

If the parent receives `SIGINT` or `SIGTERM`, each launched leg records
`interrupted` and retains its exact Wux child and private bootstrap files. The
error names the review id to use:

```bash
wux-review reconcile <review-id> --json
```

Reconciliation starts **zero Claude or Codex calls**. It accepts only the
recorded review id, round, execution, reviewer, attempt, prompt hash, result id,
and evidence path. It refuses a still-running child, changed session state,
stale/cross-round evidence, cross-leg swaps, gaps or duplicates in Codex retry
attempts, external control, and incomplete or malformed output. Once both exact
legs have finished and both atomic results validate, it feeds those existing
results through the normal parser, sticky/refutation logic, verdict renderer,
and exit codes (`0` approve, `2` block). It marks the round and legs
`reconciled`, stops only the owned children, and removes their transient
bootstrap files. Re-running an already reconciled round fails closed rather
than replaying a verdict.

If terminal cleanup itself fails, the terminal journal retains
`cleanupPending` and blocks a replacement model launch. Re-run the same
`reconcile` command to retry only exact-child/transient cleanup with zero model
calls; once cleanup succeeds, the original failed/timed-out/tainted round stays
terminal and a later review may start safely. That cleanup-only success exits
`0`; `--json` returns a `kind: "terminal-cleanup-completed"` outcome so scripts
can distinguish it from a cleanup failure without matching diagnostic text.

For predictable ids, use `--session <id>`; a one-shot interrupted run
also prints its generated review id in the recovery error.

Use `--direct` only as an explicit emergency rollback when the Wux transport is
unavailable. It bypasses observable children and recovery while retaining the
same review inputs and verdict contract. `--inspect` remains a compatibility
alias for the default.

### Evidence retention and pruning

Terminal success, failure, timeout, taint, and reconciliation stop the exact Wux
children and remove transient files under `/tmp/wux-review`. Interrupted
bootstrap files remain only until reconciliation. Durable Wux run directories
retain prompts, machine-event evidence, lifecycle/status, and any atomic result
for diagnosis. Review recovery manifests live under
`/tmp/wux-review/observable-rounds`; valid records older than seven days are
pruned automatically before a later observable launch once they are terminal.
Interrupted/running and cleanup-pending records remain until explicit
reconciliation so their cleanup identity is never discarded. Override the terminal-record window with
`WUX_REVIEW_OBSERVABLE_RECOVERY_RETENTION_DAYS`.

Use released Wux's dry run before deleting retained stopped-run evidence:

```bash
wux prune --older-than 7d --dry-run
wux prune --older-than 7d
```

## Exit codes
- `0` — approve, plus non-review success paths such as `--help`, `--version`,
  and `--end-session`.
- `2` — block (at least one reviewer raised a must-fix).
- `1` — error (`WuxReviewError` or another failed execution path).
