# Building

wux-review is a Bun + TypeScript project (mirrors `wux`).

## Prerequisites
- [Bun](https://bun.sh) `>= 1.3.9`.

## Common tasks
```bash
bun install              # install dependencies (uses the text bun.lock)
bun run typecheck        # strict tsc --noEmit
bun test                 # bun test
bun run src/index.ts ... # run from source
bun run build            # compile a local binary to dist/wux-review
```

## Compiling a binary
`bun run build` produces an unstamped dev binary (`--version` → `0.0.0-dev`).
Release binaries are cross-compiled and **CalVer-stamped** by the release
workflow via `bun build --compile --target=<target> --define
'process.env.WUX_REVIEW_VERSION="<tag>"'` — see [releasing.md](./releasing.md).

## Conventions
Strict `tsc`; 2-space indent, LF, final newline; `node:` prefix for builtins;
`import type` for type-only imports; `WuxReviewError` for expected failures. See
[`AGENTS.md`](../AGENTS.md).
