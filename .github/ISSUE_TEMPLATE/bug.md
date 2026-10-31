---
name: Bug
about: Report a reproducible defect with a complete fix contract
title: 'fix: <action-oriented title>'
labels: bug
---

<!--
Write this issue so a coding agent can do the work without asking questions.
See CONTRIBUTING.md for the issue format.
One unit of work per issue. Security vulnerabilities go through SECURITY.md, not a public issue.
-->

## Summary

<!-- State the defect and its impact. -->

## Goal

<!-- State the fixed behavior. -->

## Current State

<!-- Verify at `<sha>` (`main`, tag `<tag>`), with file and line references. -->

**Observed:**

<!-- What happens now? -->

**Expected:**

<!-- What should happen? -->

**Reproduction:**

```bash
# Add a minimal command sequence that demonstrates the defect.
```

## Implementation Details

<!-- Explain the likely cause and the intended repair. -->

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

- [ ] Reproduction no longer triggers the bug.
- [ ] Regression test added.

## Verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
# Add the focused regression test and manual reproduction check.
```
