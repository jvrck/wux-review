# Release validation

Two layers validate a release.

## In-pipeline (automatic)

The tag workflow creates or reuses a draft release, uploads the four compiled
binaries to that draft, and validates them before publication on Linux x64,
Linux ARM64, Darwin ARM64, and Alpine for the musl build. Each path checks the
version, help output, and `scripts/smoke-release-asset.sh`.

After native validation, the workflow installs Bun 1.3.9 and the frozen
dependency graph, generates a CycloneDX SBOM, requires at least 80 components,
and runs the HIGH/CRITICAL fixable-vulnerability scan. It then writes
`SHA256SUMS` and checks that the draft has exactly the four binaries plus
`sbom.cdx.json` and `SHA256SUMS` before publishing it as latest. The assets move
between jobs on the draft release, not through Actions artifacts. A failure
leaves the release as a draft.

The workflow serializes same-tag retries. It can reuse only a draft release;
its create/reuse, build/upload, and publish jobs each refuse to run against an
already published release, so a selected rerun cannot clobber public assets.

## After the fact (manual)

`.github/workflows/validate-release.yml` is `workflow_dispatch` with a `tag`
input. It downloads the published assets and `SHA256SUMS`, verifies the checksum,
checks `--version`, and re-runs the smoke on the same native/musl matrix. Use it
to re-validate an existing release without re-cutting it.

## PR install proof

PR CI uses `.github/workflows/e2e.yml` for the current checkout, not published
release assets. It builds a local binary, stages a release-shaped asset
directory, and runs the real `install.sh` in both plain and `--with-skills`
modes via `scripts/smoke-installer.sh`. The same workflow also runs the
fake-agent Wux smoke (`scripts/smoke-fake-agent-wux.sh`) to prove the compiled
CLI across a real Wux boundary without real model auth. Together, those checks
keep installer and Wux-boundary proof in the PR path without making GitHub
artifact storage a required dependency.
