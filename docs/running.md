# Running

## Install

Fetch and run the public installer anonymously:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash
```

To install the bundled skill too:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash -s -- --with-skills
```

Installs `wux-review` to `~/.local/bin` (override with `BIN_DIR`). `install.sh`
downloads and checksum-verifies the release asset over public HTTPS, atomically
replacing an existing binary only after verification succeeds. Set
`WUX_REVIEW_VERSION` to an explicit CalVer tag to install that release. See
[releasing.md](./releasing.md) for the asset layout.

## Requirements at run time
The default observable reviewer path needs authenticated `claude` and `codex`
CLIs plus released [`wux`](https://github.com/jvrck/wux) `2026.06.21.1` or newer,
including `run shell`, `status --json`, `read --json` (whose response includes
`runDir`), actor-stamped mutation events, and exact-child `stop`. Observable
Wux/result failures fail closed and do not fall back to direct execution.
The explicit `--direct` emergency rollback needs only the two reviewer CLIs and
preserves the normal prompt, parsing, timeout, retry, and verdict contracts.
Owned cleanup uses the released Wux CLI-owner contract (`USER`, then `LOGNAME`)
to stamp an unpredictable per-stop actor; both variables are set to the same
value and the resulting event is authenticated before the verdict is accepted.

## Usage
See [commands.md](./commands.md). Output is JSON by default for agents/CI; pass
`--no-json` for the human view. The tool **judges only** — it never edits code;
the worker owns applying fixes and the merge gate.

## Concurrency & codex-leg reliability
`wux-review` is **safe to fan out** — run many reviews at once on one host (an
eval sweep, a batch of PRs) without a concurrency cap. The Codex leg is
hardened for transient load failures:

- **Contained reviewer processes.** Each leg runs in its own freshly created
  mode-0700 working directory, never the reviewed repository or a shared,
  attacker-plantable temp path; the complete diff is already in the supplied
  prompt. Claude uses safe mode, an empty built-in tool set, strict empty MCP
  configuration, disabled skills, and no session persistence while retaining
  OAuth/keychain or API-key auth. Codex keeps `-s read-only`, `--ephemeral`, and
  `--ignore-rules`.
- **Sanitized per-leg `CODEX_HOME`.** Each Codex leg runs with its own throwaway
  mode-0700 home. `auth.json` is copied and locked to mode 0600; built-in API auth
  variables and a preserved custom provider's declared `env_key` remain inherited.
  `config.toml` and separate `<name>.config.toml` profile layers—including
  symlink-managed layers whose resolved targets are bounded regular files—are
  parsed and reduced to the Codex 0.147.0 scalar model/provider routing surface,
  including `openai_base_url`, reasoning, verbosity, context/compaction, and
  service-tier choices. Non-regular or oversized layers are skipped with a
  diagnostic. Provider tables and legacy profile tables declared in `config.toml`
  are preserved. Notify
  commands, MCP servers, hooks, plugins, skills,
  feature/tool settings, instructions, project trust, and mutable caches are not
  copied.
  Every Codex write lands in the throwaway home, so concurrent legs share no
  mutable state. A TOML syntax feature unsupported by Bun produces a minimal
  generated allowlisted config (with a one-line diagnostic), never a verbatim
  fallback or an outage. Genuine filesystem, copy, or sanitization failures
  retain their specific cause and block safely instead of loading the shared
  home. An undetected auth route is advisory: the leg warns and proceeds so
  unauthenticated local/OSS providers remain supported, while Codex reports any
  actual credential failure. See the
  [reviewer threat model](./reviewer-threat-model.md).
- **Bounded retry with backoff.** A transient codex `exit-1` or empty verdict is
  retried (default 2 retries, exponential backoff) so a flake never loses a
  verdict; a persistent failure surfaces as a typed error with the attempt count.
  A *timeout* is never retried (that only doubles the wait) — it surfaces at once.
- **Size-aware timeout (both legs).** Each leg's wall-clock bound scales with the
  diff size (base + per-KB, capped), so a large diff earns proportional time; a
  genuine overrun is a typed timeout — naming the prompt size and the env var that
  actually raises the ceiling (that leg's base while the bound is below the cap,
  or its `*_MAX_TIMEOUT_MS` once the bound is clamped to the cap) — never a
  silent hang. Both legs use the **same** size-aware
  helper but have independent base, per-KB, and cap knobs. The bound is only a
  *patience* ceiling — a leg that finishes early returns the instant its process
  exits — so a generous bound never slows a successful review. The Claude leg was
  originally given a **flat** bound and the Codex leg a size-aware one, so on a
  large diff the Claude leg could time out at the default while Codex completed.
  Both legs now use the size-aware treatment and per-leg knobs.
  The Claude leg's per-KB default is more generous (`claude -p` is slower to first
  output on a large diff).

None of this changes the verdict semantics (block iff any reviewer raises a
must-fix) or the `--json` envelope. Tuning knobs (env, all optional):

| Env var | Default | Effect |
|---|---|---|
| `WUX_REVIEW_CODEX_RETRIES` | `2` | Retry attempts for a transient codex `exit-1`/empty verdict. |
| `WUX_REVIEW_CODEX_RETRY_BASE_MS` | `1000` | Base backoff; attempt _n_ waits `base · 2ⁿ` ms. |
| `WUX_REVIEW_TIMEOUT_MS` | _(per-leg default)_ | Backward-compatible base bound override for **both** legs; either per-leg base var below takes precedence. |
| `WUX_REVIEW_TIMEOUT_PER_KB_MS` | _(per-leg default)_ | Extra wall-clock per KB, for **both** legs — a leg-agnostic fallback overridden by either per-leg var below. |
| `WUX_REVIEW_MAX_TIMEOUT_MS` | _(per-leg default)_ | Cap on the size-aware bound, for **both** legs — a leg-agnostic fallback overridden by either per-leg var below. |
| `WUX_REVIEW_CLAUDE_TIMEOUT_MS` | `900000` | Claude base wall-clock bound (15 minutes). |
| `WUX_REVIEW_CLAUDE_TIMEOUT_PER_KB_MS` | `1000` | Extra claude wall-clock per KB of prompt. |
| `WUX_REVIEW_CLAUDE_MAX_TIMEOUT_MS` | `1500000` | Cap on the size-aware Claude timeout (25 minutes). |
| `WUX_REVIEW_CODEX_TIMEOUT_MS` | `240000` | Codex base wall-clock bound (4 minutes). |
| `WUX_REVIEW_CODEX_TIMEOUT_PER_KB_MS` | `250` | Extra codex wall-clock per KB of prompt. |
| `WUX_REVIEW_CODEX_MAX_TIMEOUT_MS` | `600000` | Cap on the size-aware codex timeout. |

Per-leg knob precedence: the leg-specific var (`WUX_REVIEW_CLAUDE_*` /
`WUX_REVIEW_CODEX_*`) wins; else the matching leg-agnostic var
(`WUX_REVIEW_TIMEOUT_MS`, `WUX_REVIEW_TIMEOUT_PER_KB_MS`, or
`WUX_REVIEW_MAX_TIMEOUT_MS`), which overrides both legs at once and can raise or
lower their individual defaults; else the per-leg default. The existing shared
and `WUX_REVIEW_CODEX_*` knobs keep working exactly as before. On startup, each
leg reports its prompt size and effective timeout budget to stderr so a patient
bounded review is distinguishable from a hang; Codex labels this as a per-attempt
budget because its existing bounded retry policy can launch more than one attempt.

Observable execution preserves the same Codex isolation and bounded retry policy. A retry
uses a fresh child/evidence identity (`-a2`, etc.) so it never overwrites the
failed attempt or adds a model invocation beyond the existing retry policy. Its
cleanup metadata is durably published and exact child identity is journaled
before Wux launch, so a parent crash before evidence discovery remains
reclaimable. Recovery accepts only exact Wux already-gone diagnostics and verifies
the child is inactive before deleting those attempt-specific files. Owned cleanup
markers authenticate the timestamp and one-call actor of the exact Wux stop they
neutralize. A missing release acknowledgement plus an unauthenticated
already-gone response fails closed. An acknowledged and observed normal wrapper
exit is journaled for crash recovery; an external stop racing cleanup remains
tainted.

Observable child naming can be configured with
`WUX_REVIEW_OBSERVABLE_PREFIX` (default `wuxr`; 1–32 safe-slug characters).
Terminal recovery records default to seven days of retention; active or
interrupted records remain recoverable. Set
`WUX_REVIEW_OBSERVABLE_RECOVERY_RETENTION_DAYS` to a non-negative whole number
to change it.

### Watching observable activity safely

Observable legs keep the same one-call engines and auth/model path while enabling
their machine-event modes: Claude `-p --output-format stream-json --verbose`;
Codex `exec --json`, with `-o` still supplying its final message. Ordinary
`wux read <child>` / `wux attach <child>` surfaces show a concise pane with the
review id, round, leg, attempt, state, elapsed time, last-activity age, a fixed
safe phase/activity label, and pending/final result metadata.

Reading, viewing, checking status, and attaching are observation only. Do not
send, interrupt, hand off, or stop an observable child: released Wux records those
controls with actor and time, and wux-review deliberately taints and rejects the
leg even if its reviewer result says approve. Its own final exact-child stop is
distinguished as owned cleanup.

The pane is intentionally not a transcript. Its renderer uses an explicit
allowlist of lifecycle states and fixed tool categories. It never shows
prompts/diffs, assistant or reasoning text, commands, paths, tool payloads,
tokens, secrets, arbitrary event fields, or chain-of-thought. Unknown,
malformed, and oversized events increment only a generic diagnostic count and
cannot crash or approve a leg. Renderer/status failures are observational and
cannot replace or influence `result.json`.

For forensic evidence, each stdout read is appended to `machine-stream.jsonl` as a
`reviewer-machine-stream-chunk` record with byte offset, byte length, and base64
data. Decode and concatenate those records in offset order to reconstruct the
exact raw stream, including partial writes and an unterminated final line.
When zero-call reconciliation must reconstruct a missing result, the same chunk
shape is retained separately in `recovery-stream.jsonl`. A partial atomic result
is moved to `result.rejected.json` for diagnosis and can never become verdict
input.
Parsing is bounded independently, so raw evidence is retained even when an event
is too large or malformed, while repeated Wux control-log scans do not reparse
bulk reviewer output. Schema-version-2 `status.json` is atomically replaced
as activity changes and contains only the same safe pane metadata. `result.json`
keeps only the bounded final Claude result event or Codex `-o` message needed by
the findings parser; it does not duplicate the full lifecycle stream in memory.
Claude result events have a separate 16 MiB cap above the 256 KiB safe-activity
parse cap. Exceeding it retains raw evidence but invalidates any earlier result
and fails closed. The explicit direct transport likewise drains stdout through a
bounded tail: Claude keeps only a final-event-sized window, and Codex keeps no
machine stdout because `-o` is authoritative. Direct and observable transports
also retain only a 256 KiB stderr tail. During final collection, the observable
wrapper follows the pane even if its file appears late, waits until the parent
signals release, checks that parent is still alive, and acknowledges the
run-specific result identity so a delayed marker cannot satisfy a later leg's
bounded acknowledgement wait.

### Recovering after parent interruption

For an observable run that you may need to resume, prefer a stable id:

```bash
wux-review --session review-123 --json
```

On `SIGINT` or `SIGTERM`, the CLI marks the exact round `interrupted` and tells
you which review id to reconcile. Wait for any bounded reviewer child to finish,
then run:

```bash
wux-review reconcile review-123 --json
```

This does not attach to the children or call either model again. It validates
the saved round and both exact leg identities, reconstructs an atomic result
only from their retained completion/output files when necessary, and runs the
normal verdict pipeline. A live child, taint, timeout, missing completion,
partial result, changed session state, or stale/cross-leg evidence remains a
clean fail-closed error. Successful reconciliation removes the private
bootstrap files and stops only the owned base children plus any journaled retry
children; the durable Wux evidence remains available. Unreadable or corrupt
session state cannot be treated as an absent state during observable launch,
finalization, or recovery, and a leftover partial atomic result invalidates
reconciliation even when a final result also exists.

Every non-interrupted terminal path performs the same exact-child stop and
transient cleanup. If that cleanup fails, the journal blocks a replacement
model launch until `wux-review reconcile <id>` retries cleanup without calling a
model. Retained stopped-run evidence is operator-owned; inspect the selection
before pruning it:

```bash
wux prune --older-than 7d --dry-run
wux prune --older-than 7d
```
