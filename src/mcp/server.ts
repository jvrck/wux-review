import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VerdictEnvelope } from "../review/consolidate";
import type { loadConfig } from "../review/config";
import type { Lens } from "../review/lenses";
import type { PostResult } from "../review/post";
import type { DualReviewResult, RunReviewersOptions } from "../review/reviewers";
import { VERSION } from "../version";
import { registerReviewDiff } from "./tools/review_diff";

// Injectable seam mirroring CliDeps, so the tool can be exercised over an
// in-memory transport without spawning live model sessions.
export interface McpDeps {
  runReviewers?: (diff: string, lenses: Lens[], options?: RunReviewersOptions) => Promise<DualReviewResult>;
  // `| void` keeps the pre-#100 `Promise<void>` seam backward-compatible; the MCP
  // tool ignores the return value (it only cares that the post ran).
  postToPr?: (pr: number, envelope: VerdictEnvelope) => Promise<PostResult[] | void>;
  loadConfig?: typeof loadConfig;
}

const INSTRUCTIONS =
  "wux-review MCP (Claude-side): one tool, review_diff — runs the Claude+Codex dual review of a diff " +
  "and returns the consolidated verdict envelope. Judges only; it never edits code. Codex callers use " +
  "the wux-review CLI (Codex's wux-MCP is Unsupported).";

export function createReviewMcpServer(deps: McpDeps = {}): McpServer {
  const server = new McpServer({ name: "wux-review", version: VERSION }, { instructions: INSTRUCTIONS });
  registerReviewDiff(server, deps);
  return server;
}

// Production entry: serve over stdio until the client disconnects. Tests use
// createReviewMcpServer + an in-memory transport instead.
//
// stdio IS the JSON-RPC channel, so nothing here may write to process.stdout.
// The SDK's StdioServerTransport does not observe stdin EOF, so — like wux's
// `mcp` command — we also resolve on stdin end/close; otherwise a client that
// closes the pipe leaves the server hung (busy-reading the closed stdin).
export async function startMcpServer(deps: McpDeps = {}): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createReviewMcpServer(deps);
  const transport = new StdioServerTransport();

  const closed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Install before connect so an immediate disconnect during startup isn't missed.
    server.server.onclose = finish;
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });

  await server.connect(transport);
  await closed;
  await server.close().catch(() => undefined);
}
