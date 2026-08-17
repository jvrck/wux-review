import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, parseReviewArgs, runCli } from "../src/cli";
import type { Finding, ReviewerName, ReviewResult } from "../src/review/types";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

// Drive runCli in-process with injected reviewers (no live model), capturing
// stdout/stderr and running against a temp repo for diff/config resolution.
async function callCli(
  argv: string[],
  cwd: string,
  deps: CliDeps,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origCwd = process.cwd();
  process.chdir(cwd);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(argv, deps);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.chdir(origCwd);
  }
}

interface Capture {
  lenses: string[];
  models?: { claude?: string; codex?: string };
  sessionId?: string;
  persist?: boolean;
  direct?: boolean;
}

function fakeReviewers(
  claudeFindings: Finding[],
  codexFindings: Finding[],
  capture?: Capture,
): NonNullable<CliDeps["runReviewers"]> {
  const verdictOf = (findings: Finding[]) => (findings.some((x) => x.severity === "must-fix") ? "block" : "approve");
  const mk = (reviewer: ReviewerName, findings: Finding[]): ReviewResult => ({ reviewer, findings, verdict: verdictOf(findings) });
  return async (_diff, lenses, options) => {
    if (capture) {
      capture.lenses = lenses.map((l) => l.name);
      capture.models = options?.models;
      capture.sessionId = options?.sessionId;
      capture.persist = options?.persist;
      capture.direct = options?.direct;
    }
    if (options?.direct !== true) {
      const sessionId = options!.sessionId ?? "test-session";
      const round = options!.round ?? 1;
      await options!.prepareObservableRound?.({
        reviewId: sessionId,
        round,
        executionId: "fakeexec",
        claudeChildName: `wuxr-${sessionId}-r${round}-xfakeexec-claude`,
        codexChildName: `wuxr-${sessionId}-r${round}-xfakeexec-codex`,
      });
    }
    return {
      sessionId: options?.sessionId ?? "test-session",
      claude: mk("claude", claudeFindings),
      codex: mk("codex", codexFindings),
    };
  };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  lens: "correctness",
  file: "x.ts",
  line: 1,
  severity: "must-fix",
  finding: "bug",
  ...over,
});

// A throwaway git repo with two commits, so ref/range/worktree resolution is
// deterministic and independent of the CI checkout depth.
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wuxr-"));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
    }
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

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env?: Record<string, string>, cwd?: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("--help prints usage covering every documented flag and exits 0", async () => {
  const { code, stdout } = await run(["--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("wux-review");
  for (const flag of ["--pr", "--lenses", "--post-to-pr", "--session", "--end-session", "--direct", "--inspect", "--json"]) {
    expect(stdout).toContain(flag);
  }
});

test("--version prints the version and exits 0", async () => {
  const { code, stdout } = await run(["--version"]);
  expect(code).toBe(0);
  // Mirror the CLI's `||` fallback so a set-but-empty env var doesn't desync the assertion.
  expect(stdout.trim()).toBe(process.env.WUX_REVIEW_VERSION || "0.0.0-dev");
});

test("--version honors the WUX_REVIEW_VERSION stamp", async () => {
  const { code, stdout } = await run(["--version"], { WUX_REVIEW_VERSION: "2026.06.12" });
  expect(code).toBe(0);
  expect(stdout.trim()).toBe("2026.06.12");
});

test("--version falls back to the dev sentinel when WUX_REVIEW_VERSION is empty", async () => {
  const { code, stdout } = await run(["--version"], { WUX_REVIEW_VERSION: "" });
  expect(code).toBe(0);
  expect(stdout.trim()).toBe("0.0.0-dev");
});

test("an unknown flag fails with a clean WuxReviewError message and non-zero exit", async () => {
  const { code, stdout, stderr } = await run(["--bogus"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("unknown option: --bogus");
  expect(stderr).not.toContain("at "); // no raw stack trace for an expected error
  expect(stdout).toBe("");
});

test("a flag missing its value fails cleanly", async () => {
  const { code, stderr } = await run(["--pr"]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("--pr requires");
});

// The `mcp` subcommand starts a stdio MCP server (it blocks on stdin), so the
// tool is exercised over an in-memory transport in test/mcp.test.ts. Here we
// only check the early arg-validation path, which fails before any blocking.
test("the mcp subcommand rejects trailing arguments", async () => {
  const { code, stderr } = await run(["mcp", "HEAD~1"]);
  expect(code).toBe(1);
  expect(stderr).toContain("mcp takes no arguments");
});

describe("reconcile subcommand", () => {
  test("renders an existing zero-call recovery verdict with normal exit semantics", async () => {
    let seen: string | undefined;
    const { code, stdout } = await callCli(
      ["reconcile", "recover-1", "--json"],
      process.cwd(),
      {
        reconcileReview: async (reviewId) => {
          seen = reviewId;
          return {
            verdict: "approve",
            must_fix: [],
            nice_fix: [],
            nits: [],
            reviewers: { claude: "approve", codex: "approve" },
            session: reviewId,
            round: 2,
          };
        },
      },
    );
    expect(seen).toBe("recover-1");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "approve",
      session: "recover-1",
    });
  });

  test("reports cleanup-only reconciliation as a typed successful outcome", async () => {
    const { code, stdout, stderr } = await callCli(
      ["reconcile", "recover-cleanup", "--json"],
      process.cwd(),
      {
        reconcileReview: async (reviewId) => ({
          kind: "terminal-cleanup-completed",
          reviewId,
          state: "failed",
          diagnostic: "terminal cleanup retry completed",
        }),
      },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      kind: "terminal-cleanup-completed",
      reviewId: "recover-cleanup",
      state: "failed",
      diagnostic: "terminal cleanup retry completed",
    });
  });

  test("requires exactly one review id and rejects unknown options cleanly", async () => {
    const missing = await callCli(["reconcile"], process.cwd(), {});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("reconcile requires <review-id>");

    const extra = await callCli(["reconcile", "a", "b"], process.cwd(), {});
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("takes one review id");

    const unknown = await callCli(["reconcile", "a", "--post"], process.cwd(), {});
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown reconcile option");
  });
});

describe("review pipeline (in-process, injected reviewers)", () => {
  test("a clean review prints the approve envelope and exits 0 (--json)", async () => {
    const dir = gitRepo();
    try {
      const { code, stdout } = await callCli(["HEAD~1", "--json"], dir, { runReviewers: fakeReviewers([], []) });
      expect(code).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.verdict).toBe("approve");
      expect(env.must_fix).toEqual([]);
      expect(env.reviewers).toEqual({ claude: "approve", codex: "approve" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a must-fix from either reviewer blocks and exits 2", async () => {
    const dir = gitRepo();
    try {
      const { code, stdout } = await callCli(["HEAD~1", "--json"], dir, {
        runReviewers: fakeReviewers([], [finding({ file: "a.txt", finding: "off by one" })]),
      });
      expect(code).toBe(2);
      const env = JSON.parse(stdout);
      expect(env.verdict).toBe("block");
      expect(env.must_fix).toHaveLength(1);
      expect(env.must_fix[0].raised_by).toEqual(["codex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-json renders the human verdict", async () => {
    const dir = gitRepo();
    try {
      const { code, stdout } = await callCli(["HEAD~1", "--no-json"], dir, { runReviewers: fakeReviewers([], []) });
      expect(code).toBe(0);
      expect(stdout).toContain("APPROVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI selects observable execution by default and --direct selects the rollback", async () => {
    const dir = gitRepo();
    try {
      const observable: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--json"], dir, {
        runReviewers: fakeReviewers([], [], observable),
      });
      expect(observable.direct).toBe(false);

      const direct: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--direct", "--json"], dir, {
        runReviewers: fakeReviewers([], [], direct),
      });
      expect(direct.direct).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config lenses + reviewer model pinning reach the reviewers", async () => {
    const dir = gitRepo();
    try {
      writeFileSync(
        join(dir, ".wux-review.yml"),
        "lenses:\n  - security\n  - clarity\nreviewers:\n  claude:\n    model: claude-x\n  codex:\n    model: gpt-x\n",
      );
      const cap: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--json"], dir, { runReviewers: fakeReviewers([], [], cap) });
      expect(cap.lenses).toEqual(["security", "clarity"]);
      expect(cap.models).toEqual({ claude: "claude-x", codex: "gpt-x" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--lenses overrides config, and the config is found from a subdirectory", async () => {
    const dir = gitRepo();
    try {
      writeFileSync(join(dir, ".wux-review.yml"), "lenses:\n  - security\n");
      mkdirSync(join(dir, "sub"));
      const fromRoot: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--json"], join(dir, "sub"), { runReviewers: fakeReviewers([], [], fromRoot) });
      expect(fromRoot.lenses).toEqual(["security"]); // repo-root config found from sub/

      const overridden: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--lenses", "correctness", "--json"], dir, {
        runReviewers: fakeReviewers([], [], overridden),
      });
      expect(overridden.lenses).toEqual(["correctness"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--post-to-pr posts the verdict after rendering, additively (exit still reflects the verdict)", async () => {
    const dir = gitRepo();
    let posted: { pr: number; verdict: string } | undefined;
    try {
      const { code, stdout, stderr } = await callCli(["HEAD~1", "--json", "--post-to-pr", "42"], dir, {
        runReviewers: fakeReviewers([], [finding({ file: "a.txt" })]), // a must-fix -> block
        postToPr: async (pr, env) => {
          posted = { pr, verdict: env.verdict };
          return [
            { reviewer: "claude", url: "https://github.com/o/r/pull/42#c1", round: env.round ?? 1 },
            { reviewer: "codex", url: "https://github.com/o/r/pull/42#c2", round: env.round ?? 1 },
          ];
        },
      });
      expect(code).toBe(2); // verdict unchanged by posting
      expect(JSON.parse(stdout).verdict).toBe("block");
      expect(posted).toEqual({ pr: 42, verdict: "block" });
      // The posted-verdict signal (round + both comment URLs) lands on stderr so it
      // never corrupts the --json verdict on stdout (#100).
      expect(stderr).toContain("verdict posted (round 1)");
      expect(stderr).toContain("claude https://github.com/o/r/pull/42#c1");
      expect(stderr).toContain("codex https://github.com/o/r/pull/42#c2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a void-returning injected postToPr is tolerated (no signal, no crash) — pre-#100 seam compat", async () => {
    const dir = gitRepo();
    let called = false;
    try {
      const { code, stderr } = await callCli(["HEAD~1", "--json", "--post-to-pr", "42"], dir, {
        runReviewers: fakeReviewers([], []), // approve -> exit 0
        // A stub returning Promise<void>, as a pre-#100 embedder would have written.
        postToPr: async () => {
          called = true;
        },
      });
      expect(called).toBe(true);
      expect(code).toBe(0); // verdict unaffected
      expect(stderr).not.toContain("verdict posted"); // no results → signal skipped, not a crash
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a --post-to-pr failure is a warning, not a change to the verdict's exit code", async () => {
    const dir = gitRepo();
    try {
      const { code, stderr } = await callCli(["HEAD~1", "--json", "--post-to-pr", "42"], dir, {
        runReviewers: fakeReviewers([], []), // approve -> exit 0
        postToPr: async () => {
          throw new Error("gh exploded");
        },
      });
      expect(code).toBe(0); // verdict's exit code preserved despite the post failure
      expect(stderr).toContain("--post-to-pr failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--session enables session mode (persist) with that id; without it persist is off", async () => {
    const dir = gitRepo();
    try {
      const withSession: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--json", "--session", "my-sess"], dir, { runReviewers: fakeReviewers([], [], withSession) });
      expect(withSession.sessionId).toBe("my-sess");
      expect(withSession.persist).toBe(true);

      const noSession: Capture = { lenses: [] };
      await callCli(["HEAD~1", "--json"], dir, { runReviewers: fakeReviewers([], [], noSession) });
      expect(noSession.persist).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--end-session stops the sessions and exits without reviewing", async () => {
    const dir = gitRepo();
    let ended: string | undefined;
    let reviewed = false;
    try {
      const { code, stdout } = await callCli(["--session", "my-sess", "--end-session"], dir, {
        endSession: async (id) => {
          ended = id;
        },
        runReviewers: async () => {
          reviewed = true;
          throw new Error("should not review");
        },
      });
      expect(code).toBe(0);
      expect(ended).toBe("my-sess");
      expect(reviewed).toBe(false);
      expect(stdout).toContain("ended session my-sess");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--end-session without --session is a clean error", async () => {
    const dir = gitRepo();
    try {
      const { code, stderr } = await callCli(["--end-session"], dir, {});
      expect(code).toBe(1);
      expect(stderr).toContain("--end-session requires --session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--end-session rejects being combined with review arguments", async () => {
    const dir = gitRepo();
    let ended = false;
    try {
      const { code, stderr } = await callCli(["HEAD~1", "--session", "s", "--end-session"], dir, {
        endSession: async () => {
          ended = true;
        },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("cannot be combined with review arguments");
      expect(ended).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing to review errors before reaching the reviewers (exit 1)", async () => {
    const dir = gitRepo();
    let called = false;
    try {
      const { code, stderr } = await callCli(["HEAD"], dir, {
        runReviewers: async () => {
          called = true;
          throw new Error("should not run");
        },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("nothing to review");
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--refutations reads the worker's file and threads it into the per-leg ledger (#101)", async () => {
    const dir = gitRepo();
    try {
      const refPath = join(dir, "refutes.json");
      writeFileSync(
        refPath,
        JSON.stringify([{ reviewer: "codex", file: "a.ts", line: 1, lens: "security", finding: "wrong", evidence: "node -e ok; CI green" }]),
      );
      let seenLedger: { claude?: unknown[]; codex?: { evidence: string }[] } | undefined;
      await callCli(["HEAD~1", "--json", "--session", "sref", "--refutations", refPath], dir, {
        runReviewers: async (_diff, _lenses, options) => {
          seenLedger = options?.refutationLedger;
          if (options?.direct !== true) {
            await options!.prepareObservableRound?.({
              reviewId: options!.sessionId ?? "sref",
              round: options!.round ?? 1,
              executionId: "fakeexec",
              claudeChildName: "wuxr-sref-r1-xfakeexec-claude",
              codexChildName: "wuxr-sref-r1-xfakeexec-codex",
            });
          }
          return {
            sessionId: "sref",
            claude: { reviewer: "claude", findings: [], verdict: "approve" },
            codex: { reviewer: "codex", findings: [], verdict: "approve" },
          };
        },
      });
      expect(seenLedger?.codex?.[0]?.evidence).toBe("node -e ok; CI green");
      expect(seenLedger?.claude).toEqual([]); // refutation scoped to codex only
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed --refutations file is a clean error before reviewing (#101)", async () => {
    const dir = gitRepo();
    let called = false;
    try {
      writeFileSync(join(dir, "bad.json"), "{not json");
      const { code, stderr } = await callCli(["HEAD~1", "--session", "s", "--refutations", join(dir, "bad.json")], dir, {
        runReviewers: async () => {
          called = true;
          throw new Error("should not run");
        },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("could not parse JSON");
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing --refutations file is a clean error", async () => {
    const dir = gitRepo();
    try {
      const { code, stderr } = await callCli(["HEAD~1", "--session", "s", "--refutations", join(dir, "nope.json")], dir, {
        runReviewers: fakeReviewers([], []),
      });
      expect(code).toBe(1);
      expect(stderr).toContain("file not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--refutations without --session is a clean error (the ledger is session-scoped) (#101)", async () => {
    const dir = gitRepo();
    let called = false;
    try {
      writeFileSync(join(dir, "r.json"), "[]");
      const { code, stderr } = await callCli(["HEAD~1", "--refutations", join(dir, "r.json")], dir, {
        runReviewers: async () => {
          called = true;
          throw new Error("should not run");
        },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("--refutations requires --session");
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Direct unit tests of the parser — cheaper than spawning and they cover the
// branches the process-level tests can't observe yet (no review output exists).
describe("parseReviewArgs", () => {
  test("parses a ref plus flags", () => {
    const o = parseReviewArgs([
      "main..HEAD",
      "--lenses",
      "correctness, security",
      "--no-json",
      "--session",
      "s1",
      "--post-to-pr",
      "42",
    ]);
    expect(o.ref).toBe("main..HEAD");
    expect(o.lenses).toEqual(["correctness", "security"]);
    expect(o.json).toBe(false);
    expect(o.session).toBe("s1");
    expect(o.postToPr).toBe(42);
  });

  test("--json forces JSON output", () => {
    expect(parseReviewArgs(["--json", "HEAD~1"]).json).toBe(true);
  });

  test("observable execution is default; --direct rolls back and --inspect remains an alias", () => {
    expect(parseReviewArgs([]).direct).toBe(false);
    expect(parseReviewArgs(["--inspect"]).direct).toBe(false);
    expect(parseReviewArgs(["--direct"]).direct).toBe(true);
    expect(() => parseReviewArgs(["--direct", "--inspect"])).toThrow("mutually exclusive");
    expect(() => parseReviewArgs(["--inspect", "--direct"])).toThrow("mutually exclusive");
  });

  test("--refutations captures the file path (#101)", () => {
    expect(parseReviewArgs(["--refutations", "refutes.json"]).refutations).toBe("refutes.json");
    expect(parseReviewArgs([]).refutations).toBeUndefined();
    expect(() => parseReviewArgs(["--refutations"])).toThrow("--refutations requires a value");
  });

  test("a bare invocation (no ref, no --pr) is valid — the working-tree mode", () => {
    const o = parseReviewArgs([]);
    expect(o.ref).toBeUndefined();
    expect(o.pr).toBeUndefined();
  });

  test("rejects an empty --lenses override", () => {
    expect(() => parseReviewArgs(["--lenses", ""])).toThrow("at least one lens");
    expect(() => parseReviewArgs(["--lenses", " , "])).toThrow("at least one lens");
  });

  test("--pr accepts a positive integer and rejects everything else", () => {
    expect(parseReviewArgs(["--pr", "7"]).pr).toBe(7);
    for (const bad of ["0", "-1", "abc", "0x10", "1e3", "+5", "3.5", " 5 "]) {
      expect(() => parseReviewArgs(["--pr", bad])).toThrow();
    }
  });

  test("treats -- as end of options (ref may then start with -)", () => {
    expect(parseReviewArgs(["--", "-weird-ref"]).ref).toBe("-weird-ref");
  });

  test("rejects unknown options and extra positionals", () => {
    expect(() => parseReviewArgs(["--bogus"])).toThrow("unknown option: --bogus");
    expect(() => parseReviewArgs(["a", "b"])).toThrow("unexpected extra argument");
  });

  test("rejects a ref combined with --pr (mutually exclusive targets)", () => {
    expect(() => parseReviewArgs(["HEAD~1", "--pr", "7"])).toThrow("not both");
    expect(() => parseReviewArgs(["--pr", "7", "HEAD~1"])).toThrow("not both");
  });

  test("rejects a flag missing its value", () => {
    expect(() => parseReviewArgs(["--session"])).toThrow("requires a value");
    expect(() => parseReviewArgs(["--pr", "--json"])).toThrow("requires a value");
  });
});

describe("check subcommand", () => {
  test("runs the resolved check commands and exits with their status", async () => {
    let received: string[] | undefined;
    const { code } = await callCli(["check"], process.cwd(), {
      loadConfig: async () => ({ check: ["pytest -q"] }),
      runCheck: async (cmds) => {
        received = cmds;
        return 7;
      },
    });
    expect(received).toEqual(["pytest -q"]);
    expect(code).toBe(7);
  });

  test("uses the Bun default when no check is configured", async () => {
    let received: string[] | undefined;
    const { code } = await callCli(["check"], process.cwd(), {
      loadConfig: async () => ({}),
      runCheck: async (cmds) => {
        received = cmds;
        return 0;
      },
    });
    expect(received).toEqual(["bun run typecheck && bun test"]);
    expect(code).toBe(0);
  });

  test("rejects extra arguments", async () => {
    const { code, stderr } = await callCli(["check", "oops"], process.cwd(), {});
    expect(code).toBe(1);
    expect(stderr).toContain("check takes no arguments");
  });
});
