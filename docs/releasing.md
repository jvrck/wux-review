# Releasing

Releases are **CalVer** (`YYYY.MM.DD`, with a `.N` micro suffix for multiple
releases on the same day) and are cut by pushing a matching tag.

## Process

1. Curate `CHANGELOG.md` through the normal protected-main process: rename the
   top `## Unreleased` section to the release's CalVer heading (for example,
   `## 2026.06.12`) and open a fresh empty `## Unreleased`. A `.N` micro uses
   its own `## YYYY.MM.DD.N` heading — never duplicate a `## YYYY.MM.DD`
   heading.
2. Create and push the release tag from a commit reachable from `main`:
   `git tag 2026.06.12 && git push origin 2026.06.12`. An annotated tag is
   allowed. The workflow itself creates no branch, commit, version-bump commit,
   changelog commit, or `release/*` branch.

## What the release workflow does (`.github/workflows/release.yml`)

- Serializes same-tag runs with a tag-keyed concurrency group and never cancels
  an in-progress run that may be publishing.
- Validates the CalVer tag and confirms its target commit is reachable from
  `main` before creating or reusing a draft GitHub Release.
- Builds four stamped binaries — `wux-review-linux-x64`,
  `wux-review-linux-arm64`, `wux-review-darwin-arm64`, and
  `wux-review-linux-x64-musl` — and attaches them to the draft release. Linux
  targets remain cross-compiled on Ubuntu; Darwin ARM64 is built on macOS,
  explicitly ad-hoc signed, and verified before upload. Draft release assets,
  not Actions artifacts, carry binaries between workflow jobs.
- Validates every binary from that draft on its native target: Linux x64, Linux
  ARM64, Darwin ARM64, and Alpine for musl. Each validation checks `--version`,
  `--help`, and `scripts/smoke-release-asset.sh`; Darwin validation also fails
  closed unless `/usr/bin/codesign --verify --verbose=4` succeeds.
- Installs Bun 1.3.9 and the frozen dependency graph, generates a CycloneDX
  SBOM, and requires at least 80 SBOM components before its HIGH/CRITICAL
  fixable-vulnerability scan can pass. This floor keeps the release security
  gate non-vacuous.
- Creates `SHA256SUMS` from the final binaries after Darwin signing and verifies
  the draft contains exactly six assets: the four binaries, `sbom.cdx.json`,
  and `SHA256SUMS`. Only after all native validation, SBOM scanning, and
  exact-asset checks pass does it publish the draft as the latest release.
- Refuses any selected rerun that would operate on an already published release:
  the create/reuse, binary-build/upload, and publish jobs each fail closed
  rather than overwriting public assets. A published release must be deleted to
  re-cut its tag.

[`validate-release.yml`](./release-validation.md) is a distinct manual,
post-publication re-validation path for an already released tag; it is not part
of the tag workflow's publication gate.

## Public installation

Users install the latest release with:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash
```

The installer downloads `wux-review-<os>-<arch>` and `SHA256SUMS` anonymously
from `https://github.com/jvrck/wux-review/releases/latest/download/`. Setting
`WUX_REVIEW_VERSION=YYYY.MM.DD[.N]` instead uses
`https://github.com/jvrck/wux-review/releases/download/<tag>/`. It verifies the
checksum before atomically replacing the installed binary.

## Merge-check policy

For PRs, the required merge-check contexts are recorded exactly as:

- `check`
- `Compiled binary smoke`
- `HIGH/CRITICAL fixable gate`

The following contexts are explicitly non-required:

- `Build preview artifacts`, while Actions artifact quota behavior remains noisy
- `Dependency scan (reporting)`; its SARIF/report upload steps are reporting-only

> Pushing the release tag / cutting the GitHub release is a human gate — it is
> never done autonomously. The workflow itself creates no branches or commits.
