# Contributing to wux-review

Thanks for your interest in wux-review. It is a small Bun + TypeScript CLI that
runs an independent Claude and Codex review of a diff through wux. Issues and
pull requests are welcome.

## Development

You need [Bun](https://bun.sh) `>= 1.3.9`. Running the default observable path
and its complete integration coverage also needs `tmux` and a compatible
[wux](https://github.com/jvrck/wux) installation.

```bash
bun install
bun run typecheck
bun test
bun run src/index.ts --help
```

See [docs/running.md](docs/running.md) for runtime requirements and
[AGENTS.md](AGENTS.md) for the design invariants and coding conventions.

## Pull requests

- Keep each PR focused on one logical change.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit and
  PR titles (`feat:`, `fix:`, `chore:`, `docs:`).
- Run `bun run typecheck` and `bun test` before opening a PR.
- Update public documentation with behavior changes and add a user-facing entry
  under `## Unreleased` in `CHANGELOG.md`.
- Preserve the reviewer contract: wux-review judges only, always runs both
  reviewers, and a must-fix from either reviewer blocks the verdict.

## Bugs and security issues

Open a [GitHub issue](https://github.com/jvrck/wux-review/issues) for bugs or
feature requests. For vulnerabilities, follow [SECURITY.md](SECURITY.md) and
report privately rather than opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
