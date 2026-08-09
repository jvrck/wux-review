# MCP

wux-review ships a thin MCP wrapper so Claude-side agents can call the dual
review as a tool. All substance stays in the CLI pipeline — the MCP server is a
shim over the same `runReview` the CLI uses (no duplicated review logic).

## Running
```bash
wux-review mcp
```
Starts a stdio MCP server exposing exactly one tool, `review_diff`, and serves
until the client disconnects. MCP reviews use the same observable-default
pipeline as the CLI; the CLI-only `--direct` flag is the emergency rollback.

For Claude Code, configure the server as a local stdio MCP server and make the
server process start in the project being reviewed. Claude Code provides
`CLAUDE_PROJECT_DIR` to local stdio servers, so the command can use it to make
working-tree review targets resolve from the intended repository:

```json
{
  "mcpServers": {
    "wux-review": {
      "type": "stdio",
      "command": "/bin/sh",
      "args": [
        "-lc",
        "cd \"${CLAUDE_PROJECT_DIR:-$PWD}\" && exec wux-review mcp"
      ]
    }
  }
}
```

## The tool: `review_diff`
Input (all optional):

| Field | Meaning |
|-------|---------|
| `ref` | A git ref (`HEAD~1`) or range (`main..HEAD`). Omit to review the working tree. Mutually exclusive with `pr`. |
| `pr` | Review pull request number `pr`. |
| `lenses` | Array of lens names overriding the set for this run. |
| `post_to_pr` | Also post the consolidated findings to this PR (additive; a post failure does not fail the review). |
| `session` | Re-review in the durable session `session` (retained context). |

Returns the consolidated **verdict envelope** as JSON text:
`{ verdict, must_fix, nice_fix, nits, reviewers, session }`. It **judges only** —
it never edits code; the worker owns the fix loop and the merge gate.

On a blocked review, the MCP call succeeds and the returned envelope has
`"verdict": "block"` plus non-empty `must_fix`. There is no CLI-style exit `2`
inside the MCP tool result; agent callers should inspect the envelope and treat
that verdict as review-blocked.

To preserve evidence from a Claude Code caller, run with stream JSON output and
allow the exact MCP tool name:

```bash
MAX_MCP_OUTPUT_TOKENS=50000 \
claude -p \
  --strict-mcp-config \
  --mcp-config ./mcp-wux-review.json \
  --output-format stream-json \
  --verbose \
  --allowedTools mcp__wux-review__review_diff \
  'Call the MCP tool mcp__wux-review__review_diff exactly once with empty arguments {}. Return only JSON summarizing verdict, must_fix_count, reviewers, and session.' \
  > claude-mcp-review.jsonl
```

Epic 2 proof exercised this path from Claude Code against the seeded
`correctness_block` case. The stream transcript showed:

```json
{
  "tool_called": true,
  "parse_ok": true,
  "verdict": "block",
  "must_fix_count": 3,
  "reviewers": {
    "claude": "block",
    "codex": "block"
  }
}
```

## Claude-side only
The MCP wrapper is **Claude-side**. Codex's wux-MCP is flagged `Unsupported`, so
**Codex callers use the CLI** (`wux-review …`). Codex as a *reviewer* is
unaffected — that runs via the wux-session path inside the tool, independent of
how the review was invoked.
