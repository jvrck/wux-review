<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wux-review-icon-dark.svg">
    <img alt="wux-review" src="docs/assets/wux-review-icon.svg" width="120">
  </picture>
</p>

<h1 align="center">wux-review</h1>

<p align="center">Portable Claude + Codex dual review, executed through wux.</p>

`wux-review` runs two independent, full-lens reviews of the same diff and
returns one verdict. Diversity comes from the two model providers, not from
splitting the review into narrow jobs. It judges only: it never edits code.

## Install

**Binary (no Bun needed).** Anonymous — no GitHub authentication required:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash
```

The installer downloads the matching release asset and `SHA256SUMS`, verifies
the checksum, and atomically installs `wux-review` to `~/.local/bin` by default.
Add the bundled companion skill with:

```bash
curl -fsSL https://raw.githubusercontent.com/jvrck/wux-review/main/install.sh | bash -s -- --with-skills
```

## Prerequisites

The default observable path requires these commands on `PATH`:

- released [wux](https://github.com/jvrck/wux) `>= 2026.06.21.1` and `tmux`;
- authenticated Claude Code and Codex CLIs.

`gh` authentication is needed only when resolving a PR diff or posting review
comments. Each review consumes capacity from both configured model providers.
`--direct`, the explicit emergency transport rollback, needs only the Claude
and Codex CLIs.

## Quickstart

```bash
wux-review HEAD~1 --json
wux-review --pr 42 --post-to-pr 42 --json
```

`wux-review` accepts a git ref, range, or (when omitted) the working-tree diff.
It returns `0` for approve, `2` for block, and `1` for an execution error.

## How it works

Each run gives the same diff and lens set to independent Claude and Codex
headless legs. The consolidated verdict is **block** if either leg raises a
must-fix; otherwise it is **approve**. Nits never block. The worker owns the
fix and re-review loop; the tool does not merge or change code.

Observable Wux execution is structural: the shared pipeline selects it whenever
no transport is explicitly requested. Each unchanged headless leg runs in a
fresh `wux run shell` child and must publish an identity-validated atomic result
from its durable run directory. Missing or invalid evidence fails closed.
`--direct` runs the same contained reviewer argv without Wux as an explicit
emergency rollback; it does not change prompts, parsing, isolation, timeouts,
retries, or verdict semantics. `--inspect` remains a compatibility alias for
the observable default.

## Commands

| Command | What it does |
| --- | --- |
| `wux-review [<ref>]` | Review a ref, range, or working-tree diff. |
| `wux-review --pr <n>` | Review a pull request's diff. |
| `wux-review check` | Run the configured deterministic check. |
| `wux-review reconcile <id>` | Finalize an interrupted observable round without new model calls. |
| `wux-review mcp` | Start the `review_diff` MCP server. |
| `wux-review --direct` | Use the emergency direct-headless rollback. |

See [docs/commands.md](docs/commands.md) for the complete command reference,
including sessions, [the refutation protocol](docs/commands.md#refuting-a-finding),
and PR-comment upserts.

## Trust and data boundary

The reviewed repository, diff, project instructions, and agent extensions are
untrusted reviewer input. Both legs run in their own mode-0700 temporary
directory, never in the reviewed repository. Claude uses `--safe-mode`, an
empty built-in tool set, strict empty MCP configuration, disabled skills, and
no session persistence while retaining OAuth/keychain or API-key authentication.
Codex runs `-s read-only --ephemeral --ignore-rules` with a sanitized per-leg
`CODEX_HOME`: its configuration is reduced to model/provider selection, with
authentication material supplied separately.

The diff is intentionally sent to both configured model providers. The model
API is **not** a data-isolation boundary; this containment protects against
repository-driven mutation and ambient customization, not provider visibility.
See [docs/reviewer-threat-model.md](docs/reviewer-threat-model.md) for the
complete controls and their limits.

## Releases

Releases use CalVer (`YYYY.MM.DD`, with a `.N` suffix for same-day releases) and
ship standalone binaries with `SHA256SUMS` and a CycloneDX SBOM. See
[docs/releasing.md](docs/releasing.md) and
[docs/release-validation.md](docs/release-validation.md).

## Development

```bash
bun install
bun run typecheck
bun test
bun run src/index.ts --help
```

See [docs/running.md](docs/running.md) for runtime details and
[AGENTS.md](AGENTS.md) for project invariants.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for setup and contribution conventions, and [SECURITY.md](SECURITY.md) to report
vulnerabilities privately.

## License

[MIT](LICENSE) © Jim Vrckovski
