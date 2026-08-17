import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewMcpServer, type McpDeps } from "../src/mcp/server";
import type { Finding, ReviewerName, ReviewResult } from "../src/review/types";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wuxr-mcp-"));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "."); git("commit", "-qm", "first");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git("add", "."); git("commit", "-qm", "second");
  return dir;
}

const mk = (reviewer: ReviewerName, findings: Finding[]): ReviewResult => ({
  reviewer,
  findings,
  verdict: findings.some((x) => x.severity === "must-fix") ? "block" : "approve",
});

function fakeReviewers(claude: Finding[], codex: Finding[]): NonNullable<McpDeps["runReviewers"]> {
  return async (_diff, _lenses, options) => {
    const sessionId = options?.sessionId ?? "s";
    const round = options?.round ?? 1;
    if (options?.direct !== true) {
      await options!.prepareObservableRound?.({
        reviewId: sessionId,
        round,
        executionId: "fakeexec",
        claudeChildName: `wuxr-${sessionId}-r${round}-xfakeexec-claude`,
        codexChildName: `wuxr-${sessionId}-r${round}-xfakeexec-codex`,
      });
    }
    return {
      sessionId,
      claude: mk("claude", claude),
      codex: mk("codex", codex),
    };
  };
}

const must = (over: Partial<Finding> = {}): Finding => ({
  lens: "correctness",
  file: "a.txt",
  line: 1,
  severity: "must-fix",
  finding: "bug",
  ...over,
});

async function withServer<T>(deps: McpDeps, fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createReviewMcpServer(deps);
  const client = new Client({ name: "wux-review-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!.text);

describe("review_diff MCP server", () => {
  test("exposes exactly the review_diff tool", async () => {
    await withServer({ loadConfig: async () => ({}) }, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(["review_diff"]);
    });
  });

  test("runs the shared pipeline and returns the verdict envelope", async () => {
    const dir = gitRepo();
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await withServer(
        { loadConfig: async () => ({}), runReviewers: fakeReviewers([], [must()]) },
        async (client) => {
          const result = await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1" } });
          const env = JSON.parse(textOf(result));
          expect(env.verdict).toBe("block");
          expect(env.must_fix).toHaveLength(1);
          expect(env.reviewers).toEqual({ claude: "approve", codex: "block" });
        },
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("selects observable execution by default", async () => {
    const dir = gitRepo();
    const prevCwd = process.cwd();
    process.chdir(dir);
    let direct: boolean | undefined;
    const reviewers = fakeReviewers([], []);
    try {
      await withServer(
        {
          loadConfig: async () => ({}),
          runReviewers: async (diff, lenses, options) => {
            direct = options?.direct;
            return reviewers(diff, lenses, options);
          },
        },
        async (client) => {
          await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1" } });
        },
      );
      expect(direct).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes via renderJson — the in-memory perReviewer aid never leaks into the MCP envelope", async () => {
    const dir = gitRepo();
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // Same finding, different severities: claude nice-fix, codex must-fix.
      const shared = { lens: "security", file: "a.txt", line: 1, finding: "validate" };
      await withServer(
        {
          loadConfig: async () => ({}),
          runReviewers: fakeReviewers([{ ...shared, severity: "nice-fix" }], [{ ...shared, severity: "must-fix" }]),
        },
        async (client) => {
          const result = await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1" } });
          const text = textOf(result);
          expect(text).not.toContain("perReviewer"); // matches the CLI --json envelope exactly
          const env = JSON.parse(text);
          expect(env.verdict).toBe("block"); // consolidated max still blocks
          expect(env.must_fix).toHaveLength(1);
          expect(Object.keys(env)).toEqual(["verdict", "must_fix", "nice_fix", "nits", "reviewers", "session"]);
        },
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("posts to a PR when post_to_pr is given (additive)", async () => {
    const dir = gitRepo();
    const prevCwd = process.cwd();
    process.chdir(dir);
    let posted: { pr: number; verdict: string } | undefined;
    try {
      await withServer(
        {
          loadConfig: async () => ({}),
          runReviewers: fakeReviewers([], []),
          postToPr: async (pr, env) => {
            posted = { pr, verdict: env.verdict };
            return [
              { reviewer: "claude", url: "https://x/1", round: env.round ?? 1 },
              { reviewer: "codex", url: "https://x/2", round: env.round ?? 1 },
            ];
          },
        },
        async (client) => {
          await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1", post_to_pr: 7 } });
        },
      );
      expect(posted).toEqual({ pr: 7, verdict: "approve" });
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a post_to_pr failure is swallowed; the review still succeeds", async () => {
    const dir = gitRepo();
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await withServer(
        {
          loadConfig: async () => ({}),
          runReviewers: fakeReviewers([], []),
          postToPr: async () => {
            throw new Error("gh exploded");
          },
        },
        async (client) => {
          const result = await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1", post_to_pr: 7 } });
          expect(result.isError).toBeFalsy();
          expect(JSON.parse(textOf(result)).verdict).toBe("approve");
        },
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ref + pr together is reported as a tool error", async () => {
    await withServer({ loadConfig: async () => ({}) }, async (client) => {
      const result = await client.callTool({ name: "review_diff", arguments: { ref: "HEAD~1", pr: 7 } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not both");
    });
  });
});
