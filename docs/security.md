# Security

Dependency security scanning mirrors `wux` (`.github/workflows/security.yml`).

The reviewer execution boundary, auth-preserving containment decisions, and
adversarial verification are documented in the
[reviewer threat model](./reviewer-threat-model.md).

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
