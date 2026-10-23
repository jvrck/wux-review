# Security

Dependency security scanning mirrors `wux` (`.github/workflows/security.yml`).

The reviewer execution boundary, auth-preserving containment decisions, and
adversarial verification are documented in the
[reviewer threat model](./reviewer-threat-model.md).

## Codex reviewer state

Each Codex review leg gets a fresh mode-`0700` `CODEX_HOME` under
`${XDG_STATE_HOME:-~/.local/state}/wux-review/codex-homes/`; relative XDG state
paths are ignored. The root is verified as a real, current-user-owned directory
and is mode `0700`; homes are removed at normal completion. A parent-owned
last-use marker sits beside each home under the `codex-homes` root, rather than
inside the child-writable home. A best-effort prune at the next Codex-leg start
removes only an abandoned real own-prefix home: its last-use marker (or, for a
pre-marker home, directory mtime) must be older than
the larger of 24 hours and twice the configured Codex maximum timeout, and no
in-flight or cleanup-pending observable round may name it. This location is
outside the system temporary directory so Codex 0.162+ can create its read-only
sandbox helpers.

Claude receives a separately created, empty mode-`0700` cwd under
`${XDG_STATE_HOME:-~/.local/state}/wux-review/reviewer-cwds/`. It is removed by
its owning leg after normal completion, or by durable observable reconciliation
after an interrupted parent; it is never created under the system temp directory.

Codex evidence is fail-closed in both direct and observable execution. An
`error` or `turn.failed` machine event, a sandbox-start failure, an unclassified
oversized event, or no completed `command_execution` item is a reviewer error
rather than an approval, even if the final findings file is empty. Sandbox
diagnostics are observed across the full stderr stream rather than only its
retained tail. Sandbox-unavailable failures are deterministic and do not consume
retry attempts; other stream failures use the normal bounded retry policy.

## Interrupted-round upgrade note

Before upgrading, reconcile interrupted observable rounds with the binary that
created them. The upgraded binary intentionally rejects a pre-upgrade temporary
cleanup directory rather than weakening its cleanup guard; remove that old
directory manually if it cannot be reconciled first. Run reconciliation with
the same `XDG_STATE_HOME` that the round used, because recovery resolves its
state-home location from the current environment.

## What runs
- **Reporting scan** (`dependency-scan`): verifies the text `bun.lock` (not
  `bun.lockb`), installs OSV-Scanner + Trivy, then scans the declared dependency
  graph in `bun.lock` with OSV-Scanner and the checkout filesystem with Trivy.
  Both scans are `continue-on-error` and their SARIF reports are uploaded for
  reporting; this job does not install dependencies.
- **Gate** (`security-gate`): installs Bun 1.3.9, verifies the lockfile form,
  and runs `bun install --frozen-lockfile` before scanning. The frozen graph
  materializes `node_modules`; the pre-existing Trivy filesystem vulnerability
  gate therefore walks installed package metadata as well as repository files,
  rather than `bun.lock` alone. It fails on **fixable HIGH/CRITICAL**
  vulnerabilities (`trivy ... --severity HIGH,CRITICAL --ignore-unfixed
  --exit-code 1`) and on any non-permissive or unknown production or development
  dependency license (`bun run security:license`).
- Triggers: PRs and pushes to `main`/`epic/**`, a weekly schedule, and
  `workflow_dispatch`.

## Config
- `osv-scanner.toml` — OSV suppressions (none active).
- `.trivyignore.yaml` — Trivy suppressions (none active).
Every suppression must carry an advisory id, owner, tracking note, and expiry.

## Dependabot remediation

Dependabot complements these detection and merge gates with a repair path.
Vulnerability alerts create security update PRs as soon as GitHub identifies an
eligible vulnerable dependency; automated security fixes are enabled for those
alerts. These security PRs are not deferred to the routine weekly schedule.

Routine dependency maintenance is configured in
`.github/dependabot.yml`. Dependabot groups Bun and GitHub Actions patch/minor
updates into one PR per ecosystem each Monday in `Australia/Sydney`. Routine
major upgrades are ignored so they remain deliberate human work. The routine
major filter does not prevent eligible security updates from being proposed.

Dependabot PRs receive the same review and CI/security gates as other changes.
Dependabot does not automatically merge PRs.

## License compatibility

`wux-review` is MIT licensed. The `security-gate` job and local
`security:license` script run:

```bash
bun run security:license
```

This invokes Trivy with
`--scanners license --include-dev-deps --severity UNKNOWN,MEDIUM,HIGH,CRITICAL
--exit-code 1`, after `bun install --frozen-lockfile` has materialized the
resolved dependency packages. The CI job runs this script directly, so the
local command and merge gate use the same flags.
Permissive/notice/unencumbered licenses (including MIT, BSD, ISC, and
Apache-2.0) are classified as `LOW` and pass. Reciprocal licenses are
`MEDIUM`, restricted/copyleft licenses are `HIGH`, forbidden/proprietary
licenses are `CRITICAL`, and unidentified licenses are `UNKNOWN`; each blocks
the gate.

Do not add a suppression for an unknown or incompatible license. Stop and
escalate it for Jim's explicit decision (for example, replacement, an approved
exception, or relicensing); the gate must remain blocking until then.

## Required-checks note
The exact required merge-check contexts stay:
- `check`
- `Compiled binary smoke`
- `HIGH/CRITICAL fixable gate`

The reporting path is intentionally non-required:
- `Dependency scan (reporting)` is not a required status check.
- The SARIF/report upload steps inside that job are reporting-only and do not
  change the required-check set.

That keeps the fixable HIGH/CRITICAL gate blocking, without letting
`continue-on-error` reporting or upload noise wedge the merge gate.
