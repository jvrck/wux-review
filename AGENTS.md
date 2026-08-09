# AGENTS.md — wux-review

Contract for any agent (Claude or Codex) working in this repo. wux-review is a
portable Claude+Codex **dual-review** CLI, built **on** [wux](https://github.com/jvrck/wux)
and mirroring its conventions.

## What this tool is
`wux-review <ref>` runs the Claude+Codex dual review of a diff *inside wux* and
returns one consolidated verdict. It productizes wux's manual `dual-review`
skill. It runs **on** wux (`wux run claude` / `wux run codex` under the hood) —
it is not part of wux, and wux stays frozen.

## Design invariants (never violate)
- **Judges only — never edits code.** The worker owns the fix + the loop;
  wux-review only reports.
- **Always runs BOTH reviewers** (Claude + Codex). The reviewer is never the
  instance that wrote the code — no self-grading.
- **Diversity comes from the two models**, not split jobs — both reviewers run
  the *full* lens set; neither is pigeonholed.
- **Mechanics = fixed code; lenses = config.**
- **verdict = block** iff *either* reviewer raises a must-fix; **nits never block.**
- **Observable Wux execution is the default.** `--direct` is an explicit
  emergency transport rollback; it must not change prompts or verdict semantics.
- Built **on** wux; wux stays frozen + sharp.

## Code conventions (mirror wux)
- Bun + TypeScript, strict `tsc` (`bun run typecheck`).
- 2-space indent, LF, final newline, no trailing whitespace.
- `node:` prefix for Node builtins; `import type` for type-only imports.
- `WuxReviewError` for expected, user-facing failures (clean message + non-zero
  exit). Never leak a stack trace for an expected error.
- **CalVer** versions (`YYYY.MM.DD[.N]`), stamped via `WUX_REVIEW_VERSION`.
- Tests via `bun test`.

## Process (every PR)
- **Squash-merge only.**
- **Claude + Codex dual-review on every PR** — a must-fix blocks merge.
- Every PR adds user-facing notes under `## Unreleased` in `CHANGELOG.md`
  when it changes user-visible behavior.
- Never merge, push a release tag, or cut a release without explicit human
  authorization.
- No `Co-Authored-By` lines in commits.

## Checks
```bash
bun install
bun run typecheck
bun test
```
