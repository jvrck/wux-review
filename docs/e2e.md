# End-to-end

`.github/workflows/e2e.yml` runs the required PR smoke under the
`Compiled binary smoke` job.

The workflow builds a local `dist/wux-review`, stages a release-shaped asset set
for the runner's platform, and runs `scripts/smoke-installer.sh` against the
real `install.sh` contract. That smoke proves:

- plain install into a temp `BIN_DIR`
- `install.sh --with-skills` installs the bundled `SKILL.md`
- `SHA256SUMS` verification is enforced
- a checksum failure exits non-zero and leaves no partial install behind
- the installed binary still passes the shared `scripts/smoke-release-asset.sh`
  checks (`--version`, `--help`, clean unknown-option error)

Diagnostics are uploaded only on failure and are not part of the pass/fail
contract. That keeps artifact-quota noise out of the merge gate.

The same job also runs `scripts/smoke-fake-agent-wux.sh`. It puts fake `claude`
/ `codex` binaries on `PATH` and drives the compiled `wux-review` binary through
both the explicit direct rollback and the default observable transport using a
strict fake of the released Wux
`run shell` / `status --json` / `read --json` interfaces:

- an `approve` verdict
- a `block` verdict
- direct-path prompt/report cleanup
- default observable approve/block rounds with fresh per-round child names
- durable `prompt.md`, append-only control `events.jsonl`, append-only raw
  `machine-stream.jsonl`, atomic `status.json` and `lifecycle.json`, and
  identity-valid `result.json` (with no leaked `.tmp`)
- typed lifecycle completion, exact-child Wux stop, and removal of every
  observable bootstrap/output transient after both approve and block

The fake-agent smoke therefore proves the compiled CLI's direct rollback
compatibility and default durable-result boundary without real model auth or interactive
Wux backends.

The job then runs `scripts/smoke-real-wux-observable.sh` against the same
checksum-verified released Wux binary and real tmux, while retaining the
deterministic fake Claude/Codex processes. This thin integration smoke makes no
model calls and proves:

- both reviewer children are visible through real `wux status --json` within
  five seconds
- approve and must-fix block verdicts survive the full real-Wux wrapper path
- each stopped child retains prompt, control log, raw machine stream, pane,
  status, lifecycle, and identity-bound atomic result evidence
- a SIGTERM-interrupted parent can be reconciled from its existing two reviewer
  executions with no additional Claude or Codex invocation
- terminal paths leave no live tmux child or observable bootstrap/output
  transient

The job also installs the checksum-verified minimum supported Wux release
(`2026.06.21.1`) and runs `scripts/smoke-released-wux-owner.sh` against that real
binary. The smoke starts and stops isolated shell runs and asserts the durable
create baseline and stop actor follow Wux's released event contract for both
live and naturally exited shells, including the `USER`-then-`LOGNAME` actor used
by owned-cleanup authentication. It also proves an idempotent repeated stop adds
no second event and a post-stop `read --json` fails with the exact already-gone
diagnostic accepted by the liveness probe.

Focused Bun coverage supplies the adversarial cases that should not be encoded
as interactive fake-Wux shell behavior: harmless reads/attaches, external
send/interrupt/handoff/stop taint with actor/time/action, mutation after result
publication, malformed/replayed events, disappearance, timeout, parent
interruption, zero-model-call reconciliation, and stale/cross-leg recovery
rejection.

## Seeded CLI cases

Epic 2 adds a local seeded runner, `scripts/seeded-cli-cases.sh`, for real-agent
dogfood of the released CLI path. It synthesizes four tiny git repos, reviews
each working-tree diff via `wux-review --json`, and preserves stdout, stderr,
and exit status under a temp root:

- `approve_clean` -> expected `approve`, exit `0`
- `correctness_block` -> expected `block`, exit `2`
- `shell_security_block` -> expected `block`, exit `2`
- `docs_only` -> expected `approve`, exit `0`

Usage:

```bash
WUX_REVIEW_BIN=/path/to/wux-review scripts/seeded-cli-cases.sh
```

The script prints the path to `summary.tsv`, which points at the preserved JSON
and stderr artifacts for every case. By default it writes under
`.tmp/seeded-cli-cases/` in the repo so the real Claude/Codex callers stay
inside a trusted workspace tree. This is not a CI gate; it is repeatable Epic 2
evidence for comparing the released tool against the manual review loop.
