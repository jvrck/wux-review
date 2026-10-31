---
name: Task
about: Specify one focused unit of maintenance work
title: 'feat|fix|docs|chore|test|ci: <action-oriented title>'
labels: ''
---

<!--
Write this issue so a coding agent can do the work without asking questions.
See CONTRIBUTING.md for the issue format.
One unit of work per issue. Security vulnerabilities go through SECURITY.md, not a public issue.
-->

## Summary

<!-- What problem or opportunity does this work address? -->

## Goal

<!-- State the intended outcome. -->

## Current State

<!-- Verify at `<sha>` (`main`, tag `<tag>`), with file and line references. -->

## Implementation Details

<!-- Describe the approach and relevant design choices. -->

## Files Likely Affected

| File | Change |
| --- | --- |
| `src/...` | Explain the expected change. |

<!-- CLI or MCP changes also update docs/commands.md, docs/mcp.md, and CHANGELOG.md. -->

## Dependencies

<!-- List prerequisite issues or say None. -->

## Constraints/Non-Goals

<!-- Name applicable AGENTS.md invariants: judges only; both reviewers run; either must-fix blocks. Preserve exit codes 0 approve, 2 block, 1 error. -->

## Acceptance Criteria

- [ ] Define an observable completed behavior.

## Verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
# Add focused tests and any manual check required for this task.
```
