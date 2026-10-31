---
name: Feature
about: Specify a user-facing capability with an implementation-ready contract
title: 'feat: <action-oriented title>'
labels: enhancement
---

<!--
Write this issue so a coding agent can do the work without asking questions.
Follow the Issue Authoring Guide:
https://github.com/jvrck-labs/fspec/blob/main/docs/ISSUE_AUTHORING_GUIDE.md
One unit of work per issue. Security vulnerabilities go through SECURITY.md, not a public issue.
-->

## Summary

<!-- Describe the user need and proposed capability. -->

## Goal

<!-- State the user-visible outcome. -->

## Current State

<!-- Verify at `<sha>` (`main`, tag `<tag>`), with file and line references. -->

## Implementation Details

<!-- Describe the intended design and relevant interfaces. -->

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
# Add focused tests and any manual check required for this feature.
```
