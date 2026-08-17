# Changelog

Release notes in this file are human-curated and user-facing. Keep each release
section focused on behavior, operations, compatibility, and upgrade impact rather
than duplicating the full PR log.

CalVer: release headings are `YYYY.MM.DD`, with a `.N` micro suffix for multiple
releases on the same day. The top `## Unreleased` section accumulates notes as
PRs land; cutting a release renames it to the CalVer heading and opens a fresh
`## Unreleased`.

## Unreleased

- **Structural observable default.** The shared pipeline, reviewer layer, and
  headless backends now select observable Wux execution when no transport is
  specified. Direct execution requires the explicit `--direct` rollback, with
  prompts, retries, timeouts, session/refutation behavior, JSON, posting, and
  verdict semantics unchanged. MCP intentionally remains observable-only; use
  the CLI when an emergency direct rollback is required.

## 2026.08.09

Initial public release.

`wux-review` runs a Claude+Codex dual review of a diff inside
[wux](https://github.com/jvrck/wux) and returns one consolidated verdict.

### Added

- **Dual review with one verdict.** Both reviewers always run and receive the
  same diff and the same full lens set; the verdict is `block` if *either*
  raises a must-fix, otherwise `approve`. Nits never block. Exit codes are `0`
  for approve, `2` for block and `1` for an error.
- **Judges only.** The tool reports findings and never edits code.
- **Observable Wux execution by default.** Each reviewer runs in a durable,
  inspectable Wux child and must return an identity-validated `result.json`;
  pane text never drives the verdict, and missing or invalid evidence fails
  closed. `--direct` is an explicit emergency transport rollback that preserves
  prompts, parsing, timeouts, retries and verdict semantics.
- **Session-aware re-review.** `--session <id>` feeds each leg its own prior
  findings so resolved points are not re-raised, and
  `wux-review reconcile <id>` finalizes an interrupted round without calling
  either model again.
- **Refutation protocol.** `--refutations <file>` records findings you have
  falsified, shows them to the raising leg every round, and demotes a refuted
  must-fix that is re-raised without new runnable proof to advisory tagged
  `persistent-unproven` — demoted, never deleted.
- **PR posting.** `--post-to-pr <n>` maintains exactly one comment per reviewer,
  updated in place across rounds.
- **MCP server.** `wux-review mcp` exposes the review as a `review_diff` tool.
- **Anonymous installation.** `install.sh` downloads public release assets over
  plain HTTPS, verifies `SHA256SUMS`, and atomically replaces the installed
  binary only after verification succeeds. No GitHub authentication is required.
- **Untrusted-diff containment.** Both reviewer legs run in their own
  mode-`0700` temporary directory rather than the reviewed repository, with
  ambient project instructions, hooks, plugins, skills, MCP servers and
  built-in tools disabled, while preserving supported authentication and
  explicit model selection. See
  [docs/reviewer-threat-model.md](docs/reviewer-threat-model.md) for the
  controls and their limits — the diff is intentionally sent to both model
  providers, and the model API is not a data-isolation boundary.
- **Validated releases.** Every release is built as a draft, natively smoked on
  Linux x64, Linux ARM64, Darwin ARM64 and Linux x64 musl, scanned for
  vulnerable dependencies with a CycloneDX SBOM, and checked for the exact
  asset set before it is published.
