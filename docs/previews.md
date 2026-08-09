# Previews

`.github/workflows/preview.yml` builds throwaway preview binaries for a PR (or a
`workflow_dispatch` ref) so a change can be tried before release.

It typechecks + tests, then cross-compiles the four targets
(`wux-review-{linux-x64,linux-arm64,darwin-arm64,linux-x64-musl}`) stamped with a
`0.0.0-preview.<short-sha>` version, writes `SHA256SUMS`, and uploads them as a
build artifact (`wux-review-preview-<short-sha>`, 14-day retention). Preview
builds are never published as releases.

`Build preview artifacts` is intentionally **non-required** at the PR merge gate
while Actions artifact quota behavior is noisy. It is a convenience build for
trying a change, not part of the required branch-protection set.
