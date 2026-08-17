import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { postToPr as defaultPostToPr } from "../../review/post";
import { runReview } from "../../review/pipeline";
import { renderJson } from "../../review/render";
import type { McpDeps } from "../server";

// The single MCP tool: a thin wrapper over the same review pipeline the CLI
// uses (no duplicated review logic). It returns the consolidated verdict
// envelope as JSON text, serialized through the same `renderJson` the CLI uses
// so the MCP and CLI `--json` payloads stay identical (and in-memory-only aids
// like per-reviewer severities never leak into the envelope).
export function registerReviewDiff(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "review_diff",
    {
      title: "dual-review a diff",
      description:
        "Run the Claude+Codex dual review of a code change and return the consolidated verdict envelope " +
        "(verdict, must_fix, nice_fix, nits, reviewers, session). Reviews a git ref/range, the working tree " +
        "(omit ref), or a pull request (pr); optionally posts the findings to a PR. Judges only — it never " +
        "edits code; the worker owns the fix loop and merge gate.",
      inputSchema: {
        ref: z.string().min(1).optional(),
        pr: z.number().int().positive().optional(),
        lenses: z.array(z.string().min(1)).min(1).optional(),
        post_to_pr: z.number().int().positive().optional(),
        session: z.string().min(1).optional(),
      },
    },
    async ({ ref, pr, lenses, post_to_pr, session }) => {
      const envelope = await runReview(
        { ref, pr, lenses, session },
        { runReviewers: deps.runReviewers, loadConfig: deps.loadConfig },
      );

      if (post_to_pr !== undefined) {
        try {
          await (deps.postToPr ?? defaultPostToPr)(post_to_pr, envelope);
        } catch (err) {
          // Additive: a PR-post failure does not fail the review. stderr is safe
          // (stdout is the JSON-RPC channel); this keeps parity with the CLI.
          process.stderr.write(`wux-review mcp: post_to_pr failed (verdict unaffected): ${(err as Error).message}\n`);
        }
      }

      return { content: [{ type: "text" as const, text: renderJson(envelope) }] };
    },
  );
}
