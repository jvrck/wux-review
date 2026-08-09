# CLAUDE.md

**[AGENTS.md](./AGENTS.md) is the source of truth** for this repo's invariants,
conventions, and process. Read it first. The essentials, restated for quick
reference:

## Design invariants
- Judges only — **never edits code**. The worker owns the fix + the loop.
- **Always runs both reviewers** (Claude + Codex); the reviewer is never the
  instance that wrote the code (no self-grading).
- Diversity from the two models, not split jobs — both run the full lens set.
- Mechanics = code; lenses = config.
- `verdict = block` iff either reviewer raises a must-fix; nits never block.
- Observable Wux execution is the default; `--direct` is the emergency
  transport rollback and must preserve prompts and verdict semantics.
- Built **on** wux; wux stays frozen.

## Conventions
Bun + TypeScript, strict `tsc`; 2-space indent, LF, final newline; `node:`
prefix for builtins; `import type` for type-only imports; `WuxReviewError` for
expected failures; CalVer stamped via `WUX_REVIEW_VERSION`; `bun test`.

## Process
Squash-merge only; Claude+Codex dual-review every PR (must-fix blocks merge);
add user-facing notes under `## Unreleased` with behavior changes; never merge,
push a release tag, or cut a release without explicit human authorization; no
`Co-Authored-By` in commits.

## Checks
```bash
bun install && bun run typecheck && bun test
```
