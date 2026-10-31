# Changelog

Release notes in this file are human-curated and user-facing. Keep each release
section focused on behavior, operations, compatibility, and upgrade impact rather
than duplicating the full PR log.

CalVer: release headings are `YYYY.MM.DD`, with a `.N` micro suffix for multiple
releases on the same day. The top `## Unreleased` section accumulates notes as
PRs land; cutting a release renames it to the CalVer heading and opens a fresh
`## Unreleased`.

## Unreleased

### Added

- **Large-PR local fallback.** When GitHub declines a pull-request diff because
  it exceeds the file limit, wux-review now reviews the equivalent local
  `base...head` range if both commits are already available. It never fetches
  automatically and prints the required fetch command when either commit is
  absent.

- **Discoverable lens configuration.** `--help`, command documentation, MCP
  documentation, and the bundled skill now name the default lenses and explain
  `.wux-review.yml`. Use `default` in a lens list to include the built-in set
  before adding repository-specific lenses. The `default` lens name is reserved,
  so an `extra_lenses` entry with that name is rejected.

- **Structured issue authoring.** New Task, Bug, and Feature templates disable
  blank issues and pre-fill the required issue format. Contribution guidance now
  describes the title, section, scope, and private security-reporting rules.

## 2026.10.26

### Fixed

- **Tolerant reviewer findings.** `file: null` or an omitted file now renders as
  `(general)`, and `repro: null` is treated as absent. Unknown report and
  finding keys are discarded with a stderr notice, while malformed reports and
  invalid verdict fields still fail closed. Observable rounds that failed only
  while parsing retained findings, including parse-only rounds journaled by
  2026.10.19, can now be reconciled from their stored evidence after upgrading
  without new model calls.

### Security

- **Dependency security refresh.** Pinned the transitive `body-parser` package
  to its fixed release for the current high-severity decompression error
  advisory (CVE-2026-111181).

## 2026.10.19

### Fixed

- **Recorded end-session cleanup.** `--end-session` now stops the exact
  observable reviewer children recorded for its session (including Codex retry
  attempts), reports stopped/already-gone/failed children, and clears the
  session state plus observable round journal only after successful cleanup.

- **Fail-closed Codex reviews.** Codex legs now reject sandbox and turn errors,
  or a run with no completed command, instead of approving empty findings. Their
  private `CODEX_HOME` now lives in a mode-`0700` per-user state directory so
  Codex 0.162+ can start its sandbox. Codex approvals on affected hosts since
  that release should be treated as unreliable.

- **Legacy observable Codex evidence.** Interrupted Codex legs recorded by an
  older binary without an execution signal now reconcile as failed and must be
  re-run.

### Upgrade notes

- **Reconcile interrupted rounds before upgrading.** Reconcile an interrupted
  observable round with the old binary before installing this version. The new
  cleanup guard rejects pre-upgrade temporary cleanup directories rather than
  widening its authority; if the old binary cannot reconcile the round, remove
  that old directory manually. Reconcile with the same `XDG_STATE_HOME` that
  created the round.

### Security

- **Dependency security refresh.** Updated the MCP SDK and its resolved
  `fast-uri` and `proxy-addr` dependencies to remediate current advisories, and
  refreshed `actions/checkout` and `actions/upload-artifact`. Supersedes
  Dependabot PRs #13 and #14.

## 2026.08.17

- **Verified Darwin releases.** Darwin ARM64 release binaries are now explicitly
  ad-hoc signed on macOS and must pass signature verification before upload,
  native validation, checksum generation, and publication.
- **Dependabot remediation.** Bun dependencies and GitHub Actions now receive
  grouped weekly patch/minor maintenance PRs, while eligible vulnerability fixes
  are proposed immediately and routine major upgrades remain deliberate work.
- **Structural observable default.** The shared pipeline, reviewer layer, and
  headless backends now select observable Wux execution when no transport is
  specified. Direct execution requires the explicit `--direct` rollback, with
  prompts, retries, timeouts, session/refutation behavior, JSON, posting, and
  verdict semantics unchanged. MCP intentionally remains observable-only; use
  the CLI when an emergency direct rollback is required.
- **Programmatic transport rename.** Exported `inspect` fields on `ReviewInput`,
  `RunReviewersOptions`, and `BackendOptions` are now `direct`. This is a
  source-compatible-breaking rename for programmatic callers: update option
  objects before upgrading, because a runtime object that still supplies
  `inspect` is ignored and therefore selects the new observable default.

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
