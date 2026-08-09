import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  createClaudeHeadlessBackend,
  createCodexHeadlessBackend,
  type HeadlessBackendDeps,
  type HeadlessRunOptions,
  type HeadlessRunResult,
} from "../src/backends/headless";
import { consolidate, type VerdictEnvelope } from "../src/review/consolidate";
import { DEFAULT_LENSES } from "../src/review/lenses";
import { renderAgentComment } from "../src/review/post";
import { exitCodeFor, renderJson } from "../src/review/render";
import { runReviewers, type Reviewers } from "../src/review/reviewers";
import { createSessionStore } from "../src/review/session-state";
import type { SessionState } from "../src/review/types";

const fixturePath = new URL("./fixtures/wux-review/2026.07.28/compatibility.json", import.meta.url).pathname;
const fixture = await Bun.file(fixturePath).json() as {
  release: string;
  approve: { json: VerdictEnvelope; exit: number; comments: Record<"claude" | "codex", string> };
  block: { json: VerdictEnvelope; exit: number; comments: Record<"claude" | "codex", string> };
  sessionState: SessionState;
  timeouts: Record<"claude" | "codex", string>;
  cleanup: Record<"claude" | "codex", string[]>;
};

const APPROVE = '```json\n{"findings":[]}\n```';
const BLOCK =
  '```json\n{"findings":[{"lens":"correctness","file":"src/x.ts","line":7,' +
  '"severity":"must-fix","finding":"off by one","repro":"bun test test/x.test.ts"}]}\n```';
const AT = "2026-07-28T00:00:00Z";

function transportBackend(kind: "claude" | "codex", report: string): ReturnType<typeof createClaudeHeadlessBackend> {
  const files = new Map<string, string>();
  const live = new Set<string>();
  const tmpDir = "/tmp/compat";
  const claudeEnvelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: report,
  });

  const run = async (cmd: string[], opts: HeadlessRunOptions): Promise<HeadlessRunResult> => {
    if (cmd.join(" ") === "wux --local status --json") {
      return { code: 0, stdout: "[]", stderr: "", timedOut: false };
    }
    if (cmd.includes("run") && cmd.includes("shell")) {
      const name = cmd[cmd.indexOf("--name") + 1]!;
      live.add(name);
      files.set(
        `/evidence/${name}/events.jsonl`,
        `${JSON.stringify({ type: "create", at: AT, run: name })}\n`,
      );
      return { code: 0, stdout: JSON.stringify({ name, backend: "shell" }), stderr: "", timedOut: false };
    }
    if (cmd.includes("read")) {
      const name = cmd[cmd.indexOf("read") + 1]!;
      if (!live.has(name)) {
        return {
          code: 1,
          stdout: "",
          stderr: "tmux session is not running",
          timedOut: false,
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ name, runDir: `/evidence/${name}`, lines: [] }),
        stderr: "",
        timedOut: false,
      };
    }
    if (cmd.includes("stop")) {
      const name = cmd[cmd.indexOf("stop") + 1]!;
      live.delete(name);
      const path = `/evidence/${name}/events.jsonl`;
      files.set(
        path,
        `${files.get(path) ?? ""}${JSON.stringify({
          type: "stop",
          at: AT,
          run: name,
          by: opts.env?.USER === undefined
            ? "compat@fixture"
            : `${opts.env.USER}@fixture`,
        })}\n`,
      );
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (cmd[0] === "claude") {
      return { code: 0, stdout: claudeEnvelope, stderr: "", timedOut: false };
    }
    if (cmd[0] === "codex") {
      const outPath = cmd[cmd.indexOf("-o") + 1]!;
      files.set(outPath, report);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
  const writeFile = async (path: string, content: string) => {
    files.set(path, content);
    if (path.endsWith("-observable-ready")) {
      const stem = path.slice(0, -"-observable-ready".length);
      files.set(`${stem}-observable-stdout`, kind === "claude" ? claudeEnvelope : "");
      files.set(`${stem}-observable-stderr`, "");
      files.set(`${stem}-observable-done`, "0");
      const args = [...files.entries()].find(([key]) => key === `${stem}-observable-args`)?.[1]?.split("\0") ?? [];
      const outputIndex = args.indexOf("-o");
      if (outputIndex >= 0) files.set(args[outputIndex + 1]!, report);
    }
    const releaseMarker = "-observable-release-";
    const releaseIndex = path.indexOf(releaseMarker);
    if (releaseIndex !== -1) {
      const stem = path.slice(0, releaseIndex);
      const generation = path.slice(releaseIndex + releaseMarker.length);
      files.set(
        `${stem}-observable-released-${generation}`,
        content.trim(),
      );
      live.delete(basename(stem));
    }
  };
  const deps: Partial<HeadlessBackendDeps> = {
    run,
    mkdir: async () => {},
    rm: async (path) => void files.delete(path),
    writeFile,
    readFile: async (path) => files.get(path),
    sleep: async () => {},
    tmpDir,
    isolateCodexHome: false,
    codexRetries: 0,
    warn: () => {},
    observable: {
      mkdir: async () => {},
      writePrivateFile: async (path, content) => void files.set(path, content),
      rm: async (path) => void files.delete(path),
      writeFile,
      readFile: async (path) => files.get(path),
      snapshotSize: async (path) => {
        const raw = files.get(path);
        return raw === undefined ? undefined : Buffer.byteLength(raw);
      },
      readChunk: async (path, offset, maxBytes) => {
        const bytes = Buffer.from(files.get(path) ?? "");
        return bytes.subarray(offset, offset + maxBytes);
      },
      appendFile: async (path, content) => {
        files.set(path, `${files.get(path) ?? ""}${content}`);
      },
      rename: async (from, to) => {
        const content = files.get(from);
        if (content === undefined) throw new Error(`missing ${from}`);
        files.set(to, content);
        files.delete(from);
      },
      sleep: async () => {},
      now: () => AT,
      resultId: () => `${kind}-result`,
      tmpDir,
      pollIntervalMs: 1,
    },
  };
  return kind === "claude" ? createClaudeHeadlessBackend(deps) : createCodexHeadlessBackend(deps);
}

async function envelopeFor(
  mode: "direct" | "observable",
  scenario: "approve" | "block",
): Promise<VerdictEnvelope> {
  const reports = scenario === "approve"
    ? { claude: APPROVE, codex: APPROVE }
    : { claude: APPROVE, codex: BLOCK };
  const backends: Reviewers = {
    claude: transportBackend("claude", reports.claude),
    codex: transportBackend("codex", reports.codex),
  };
  const round = scenario === "approve" ? 1 : 2;
  const result = await runReviewers("diff", DEFAULT_LENSES, {
    backends,
    sessionId: `compat-${scenario}`,
    round,
    inspect: mode === "observable",
  });
  const envelope = consolidate(result.claude, result.codex, result.sessionId);
  envelope.round = round;
  return envelope;
}

function comments(envelope: VerdictEnvelope): Record<"claude" | "codex", string> {
  return {
    claude: `<!-- dual-review:claude -->\n\n${renderAgentComment(envelope, "claude", AT)}`,
    codex: `<!-- dual-review:codex -->\n\n${renderAgentComment(envelope, "codex", AT)}`,
  };
}

describe("released 2026.07.28 compatibility fixtures", () => {
  test("direct-headless approve/block JSON, exits, and per-reviewer comment markers/bodies stay frozen", async () => {
    expect(fixture.release).toBe("2026.07.28");
    for (const scenario of ["approve", "block"] as const) {
      const envelope = await envelopeFor("direct", scenario);
      expect(JSON.parse(renderJson(envelope))).toEqual(fixture[scenario].json);
      expect(exitCodeFor(envelope)).toBe(fixture[scenario].exit);
      expect(comments(envelope)).toEqual(fixture[scenario].comments);
    }
  });

  test("candidate observable transport produces the same frozen JSON/comments/exits", async () => {
    for (const scenario of ["approve", "block"] as const) {
      const envelope = await envelopeFor("observable", scenario);
      expect(JSON.parse(renderJson(envelope))).toEqual(fixture[scenario].json);
      expect(exitCodeFor(envelope)).toBe(fixture[scenario].exit);
      expect(comments(envelope)).toEqual(fixture[scenario].comments);
    }
  });

  test("released session-state shape remains readable and byte-shape compatible", async () => {
    const files = new Map([["/state/compat.json", JSON.stringify(fixture.sessionState)]]);
    const store = createSessionStore({
      stateDir: "/state",
      readFile: async (path) => files.get(path),
      writeFile: async (path, content) => void files.set(path, content),
      rename: async (from, to) => {
        const content = files.get(from);
        if (content === undefined) throw new Error(`missing ${from}`);
        files.set(to, content);
        files.delete(from);
      },
      mkdir: async () => {},
      rm: async (path) => void files.delete(path),
    });
    expect(await store.load("compat")).toEqual(fixture.sessionState);
  });

  test("released direct timeout errors and cleanup paths stay frozen", async () => {
    const cleanup: Record<"claude" | "codex", string[]> = { claude: [], codex: [] };
    const common: Partial<HeadlessBackendDeps> = {
      run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
      mkdir: async () => {},
      writeFile: async () => {},
      readFile: async () => APPROVE,
      sleep: async () => {},
      tmpDir: "/tmp/compat",
      timeoutMs: 60_000,
      claudeTimeoutMs: 60_000,
      timeoutPerKbMs: 1000,
      claudeTimeoutPerKbMs: 1000,
      maxTimeoutMs: 600_000,
      claudeMaxTimeoutMs: 600_000,
      isolateCodexHome: false,
      codexRetries: 0,
      warn: () => {},
    };
    const prompt = "x".repeat(10 * 1024);
    let claudeError = "";
    try {
      await createClaudeHeadlessBackend({
        ...common,
        rm: async (path) => void cleanup.claude.push(path),
      })(prompt, { sessionName: "wuxr-compat-claude" });
    } catch (err) {
      claudeError = (err as Error).message;
    }
    let codexError = "";
    try {
      await createCodexHeadlessBackend({
        ...common,
        rm: async (path) => void cleanup.codex.push(path),
      })(prompt, { sessionName: "wuxr-compat-codex" });
    } catch (err) {
      codexError = (err as Error).message;
    }
    expect(claudeError).toBe(fixture.timeouts.claude);
    expect(codexError).toBe(fixture.timeouts.codex);
    expect([...new Set(cleanup.claude)].sort()).toEqual([...fixture.cleanup.claude].sort());
    expect([...new Set(cleanup.codex)].sort()).toEqual([...fixture.cleanup.codex].sort());
  });
});
