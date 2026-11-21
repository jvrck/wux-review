import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff } from "../../src/review/diff";
import type { Run, RunResult } from "../../src/runtime/exec";

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 128): RunResult => ({ code, stdout: "", stderr });
// NUL-terminated output, the shape of `git ... -z`.
const z = (...parts: string[]): RunResult => ok(parts.map((p) => `${p}\0`).join(""));

// Build a mock runner from a map of "joined command" -> RunResult.
function mockRun(table: Record<string, RunResult>): Run {
  return async (cmd: string[], stdin?: string) => {
    const key = cmd.join(" ");
    if (key === "git cat-file --batch-check") {
      return ok((stdin ?? "").split("\n").filter(Boolean).map((objectId) => `${objectId} blob 4\n`).join(""));
    }
    if (!(key in table)) {
      throw new Error(`unexpected command: ${key}`);
    }
    return table[key]!;
  };
}

const SAMPLE_DIFF = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
const PR_REFS = {
  baseRefOid: "0123456789abcdef0123456789abcdef01234567",
  headRefOid: "89abcdef0123456789abcdef0123456789abcdef",
  baseRefName: "main",
};
const EXPECTED_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const MOVED_HEAD = "1111111111111111111111111111111111111111";
const SECOND_MOVED_HEAD = "2222222222222222222222222222222222222222";
const BASE_BLOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_BLOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GITLINK_ONE = "cccccccccccccccccccccccccccccccccccccccc";
const GITLINK_TWO = "dddddddddddddddddddddddddddddddddddddddd";

const MAXIMUM_FILES_RESPONSE = await Bun.file(
  new URL("../fixtures/gh-pr-diff-maximum-files.stderr", import.meta.url),
).text();
const DIRECT_TOO_LARGE_RESPONSE = await Bun.file(
  new URL("../fixtures/gh-pr-diff-too-large.stderr", import.meta.url),
).text();
// GitHub's documented line-limit wording. A live response was not available
// when this fixture was added, so this remains a literal compatibility probe.
const MAXIMUM_LINES_RESPONSE = "HTTP 406: the diff exceeded the maximum number of lines\n";

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr: writes.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function captureStderrError(fn: () => Promise<unknown>): Promise<{ error: unknown; stderr: string }> {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    throw new Error("expected rejection");
  } catch (error) {
    return { error, stderr: writes.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function localGitRun(root: string, refs: typeof PR_REFS, calls?: string[][]): Run {
  return async (cmd, stdin?: string) => {
    calls?.push(cmd);
    if (cmd.join(" ") === "gh pr diff 42") return fail(DIRECT_TOO_LARGE_RESPONSE, 1);
    if (cmd.join(" ") === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") {
      return ok(JSON.stringify(refs));
    }
    const process = Bun.spawn(cmd, {
      cwd: root,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { code, stdout, stderr };
  };
}

function partialCloneFallbackRun(version: string): { batchInputs: string[]; calls: string[][]; run: Run } {
  const batchInputs: string[] = [];
  const calls: string[][] = [];
  const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
  return {
    calls,
    run: async (cmd, stdin?: string) => {
      calls.push(cmd);
      const key = cmd.join(" ");
      if (key === "gh pr diff 42") return fail(DIRECT_TOO_LARGE_RESPONSE, 1);
      if (key === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") return ok(JSON.stringify(PR_REFS));
      if (key === "git config --get extensions.partialClone") return ok("origin\n");
      if (key === "git --version") return ok(`git version ${version}\n`);
      if (key === `git --no-lazy-fetch cat-file -e ${PR_REFS.baseRefOid}^{commit}`) return ok("");
      if (key === `git --no-lazy-fetch cat-file -e ${PR_REFS.headRefOid}^{commit}`) return ok("");
      if (key === `git --no-lazy-fetch merge-base ${PR_REFS.baseRefOid} ${PR_REFS.headRefOid}`) {
        return ok(`${PR_REFS.baseRefOid}\n`);
      }
      if (key === `git --no-lazy-fetch -c core.quotePath=false diff --raw --no-abbrev -z ${range}`) {
        return ok(`:100644 100644 ${BASE_BLOB} ${HEAD_BLOB} M\0x.ts\0`);
      }
      if (key === "git --no-lazy-fetch cat-file --batch-check") {
        batchInputs.push(stdin ?? "");
        return ok(`${BASE_BLOB} blob 4\n${HEAD_BLOB} blob 4\n`);
      }
      if (key === `git --no-lazy-fetch -c core.quotePath=false diff ${range}`) return ok(SAMPLE_DIFF);
      throw new Error(`unexpected command: ${key}`);
    },
    batchInputs,
  };
}

function missingObjectIds(root: string): string[] {
  return git(root, ["--no-lazy-fetch", "rev-list", "--objects", "--missing=print", "HEAD"])
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1))
    .sort();
}

function installedGitAtLeast(major: number, minor: number): boolean {
  const result = Bun.spawnSync(["git", "--version"], { stdout: "pipe" });
  const match = /^git version (\d+)\.(\d+)/.exec(result.stdout.toString());
  return match !== null && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}

function largePrFallbackRun(
  stderr: string,
  raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`,
  diff = SAMPLE_DIFF,
): Run {
  const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
  return mockRun({
    "gh pr diff 42": fail(stderr, 1),
    "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
    "git config --get extensions.partialClone": fail("", 1),
    "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
    "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
    "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
    "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": ok(`${PR_REFS.baseRefOid}\n`),
    [`git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`]: ok(raw),
    [`git -c core.quotePath=false diff ${range}`]: ok(diff),
  });
}

describe("getDiff", () => {
  test("waits for an expected PR head before reading its diff", async () => {
    const heads = [PR_REFS.headRefOid, PR_REFS.headRefOid, EXPECTED_HEAD];
    const calls: string[] = [];
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      calls.push(key);
      if (key === "gh pr view 42 --json headRefOid") {
        return ok(JSON.stringify({ headRefOid: heads.shift() ?? EXPECTED_HEAD }));
      }
      if (key === "gh pr diff 42") return ok(SAMPLE_DIFF);
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };

    const result = await getDiff({ kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD } as never, run);
    expect(result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts"], head: EXPECTED_HEAD });
    expect(calls.filter((call) => call === "gh pr view 42 --json headRefOid")).toHaveLength(4);
  });

  test("never reads a PR diff when its expected head does not arrive", async () => {
    let diffRead = false;
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid") return ok(JSON.stringify({ headRefOid: PR_REFS.headRefOid }));
      if (key.startsWith("gh pr diff")) diffRead = true;
      throw new Error(`unexpected command: ${key}`);
    };

    await expect(getDiff({ kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD, headWaitMs: 0 } as never, run))
      .rejects.toThrow(`PR #42 head is ${PR_REFS.headRefOid}, expected ${EXPECTED_HEAD}; push may not have landed`);
    expect(diffRead).toBe(false);
  });

  test("uses an injected clock while waiting for a late expected PR head", async () => {
    const heads = [PR_REFS.headRefOid, PR_REFS.headRefOid, EXPECTED_HEAD, EXPECTED_HEAD];
    const sleeps: number[] = [];
    let now = 1_000;
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid") {
        return ok(JSON.stringify({ headRefOid: heads.shift() ?? EXPECTED_HEAD }));
      }
      if (key === "gh pr diff 42") return ok(SAMPLE_DIFF);
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };
    const getDiffWithClock = getDiff as unknown as (
      target: { kind: "pr"; pr: number; expectedHead: string; headWaitMs: number },
      run: Run,
      clock: { now: () => number; sleep: (ms: number) => Promise<void> },
    ) => ReturnType<typeof getDiff>;

    const result = await getDiffWithClock(
      { kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD, headWaitMs: 600 },
      run,
      {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    expect(result.head).toBe(EXPECTED_HEAD);
    expect(sleeps).toEqual([250, 250]);
  });

  test("refetches once when the PR head moves during fetch and returns only the refetched diff", async () => {
    const heads = [EXPECTED_HEAD, MOVED_HEAD, MOVED_HEAD];
    let diffReads = 0;
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid") {
        return ok(JSON.stringify({ headRefOid: heads.shift() ?? MOVED_HEAD }));
      }
      if (key === "gh pr diff 42") {
        diffReads += 1;
        return ok(diffReads === 1 ? "first diff\n" : "refetched diff\n");
      }
      if (key === "gh pr diff 42 --name-only") return ok(diffReads === 1 ? "first.ts\n" : "second.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };

    const result = await getDiff({ kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD }, run);
    expect(result).toEqual({ diff: "refetched diff\n", files: ["second.ts"], head: MOVED_HEAD });
    expect(diffReads).toBe(2);
  });

  test("fails after a second PR head move instead of reviewing an inconsistent diff", async () => {
    const heads = [EXPECTED_HEAD, MOVED_HEAD, SECOND_MOVED_HEAD];
    let diffReads = 0;
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid") {
        return ok(JSON.stringify({ headRefOid: heads.shift() ?? SECOND_MOVED_HEAD }));
      }
      if (key === "gh pr diff 42") {
        diffReads += 1;
        return ok(`${diffReads}\n`);
      }
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };

    await expect(getDiff({ kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD }, run)).rejects.toThrow(
      `PR #42 head is ${SECOND_MOVED_HEAD}, expected ${MOVED_HEAD}; push may not have landed`,
    );
    expect(diffReads).toBe(2);
  });

  test("pins the large-PR fallback range and recorded head to the expected SHA", async () => {
    const refs = { ...PR_REFS, headRefOid: EXPECTED_HEAD };
    const range = `${refs.baseRefOid}...${EXPECTED_HEAD}`;
    const calls: string[] = [];
    const base = largePrFallbackRun(DIRECT_TOO_LARGE_RESPONSE);
    const run: Run = async (cmd, stdin) => {
      const key = cmd.join(" ");
      calls.push(key);
      if (key === "gh pr view 42 --json headRefOid") return ok(JSON.stringify({ headRefOid: EXPECTED_HEAD }));
      if (key === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") return ok(JSON.stringify(refs));
      if (key.includes(PR_REFS.headRefOid)) {
        return base(cmd.map((part) => part.replace(EXPECTED_HEAD, PR_REFS.headRefOid)), stdin);
      }
      if (key === `git cat-file -e ${EXPECTED_HEAD}^{commit}`) return ok("");
      if (key === `git merge-base ${refs.baseRefOid} ${EXPECTED_HEAD}`) return ok(`${refs.baseRefOid}\n`);
      if (key === `git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`) {
        return ok(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`);
      }
      if (key === `git -c core.quotePath=false diff ${range}`) return ok(SAMPLE_DIFF);
      return base(cmd, stdin);
    };

    const result = await captureStderr(() => getDiff({ kind: "pr", pr: 42, expectedHead: EXPECTED_HEAD }, run));
    expect(result.result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts"], head: EXPECTED_HEAD });
    expect(calls).toContain(`git -c core.quotePath=false diff ${range}`);
    expect(calls.some((call) => call.includes(PR_REFS.headRefOid))).toBe(false);
  });

  test("pr target shells out to gh pr diff", async () => {
    const run = mockRun({
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    const { diff, files } = await getDiff({ kind: "pr", pr: 42 }, run);
    expect(diff).toBe(SAMPLE_DIFF);
    expect(files).toEqual(["x.ts"]);
  });

  // Fixtures captured on 2026-11-16 with:
  // gh pr diff 348381 -R microsoft/vscode
  // That public PR had 375 changed files. Keep both observed GitHub 406 error
  // shapes pinned so a response-format change cannot silently disable fallback.
  test("large PR GitHub error forms fall back to local base...head", async () => {
    for (const stderr of [MAXIMUM_FILES_RESPONSE, DIRECT_TOO_LARGE_RESPONSE, MAXIMUM_LINES_RESPONSE]) {
      const { result, stderr: notice } = await captureStderr(() =>
        getDiff({ kind: "pr", pr: 42 }, largePrFallbackRun(stderr)));
      expect(result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts"] });
      expect(notice).toContain("exceeds GitHub's diff size limit");
      expect(notice).toContain(`reviewing ${PR_REFS.baseRefOid}...${PR_REFS.headRefOid} from local git`);
    }
  });

  test("large PR fallback parses raw -z entries positionally", async () => {
    const raw = [
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100`,
      "before-name.ts",
      "renamed.ts",
      `:100644 100644 ${"c".repeat(40)} ${"d".repeat(40)} C100`,
      "copy-source.ts",
      "copied.ts",
      `:100644 100644 ${"e".repeat(40)} ${"f".repeat(40)} M`,
      "later.ts",
    ].join("\0") + "\0";
    const { files } = await getDiff(
      { kind: "pr", pr: 42 },
      largePrFallbackRun(DIRECT_TOO_LARGE_RESPONSE, raw),
    );
    expect(files).toEqual(["renamed.ts", "copied.ts", "later.ts"]);
  });

  test("fetch hints use a qualified base ref that works for normal and option-like branches", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-fetch-hint-"));
    try {
      for (const branch of ["main", "-weird"]) {
        const source = join(root, `source-${branch === "main" ? "main" : "weird"}`);
        const origin = join(root, `origin-${branch === "main" ? "main" : "weird"}.git`);
        const consumer = join(root, `consumer-${branch === "main" ? "main" : "weird"}`);
        git(root, ["init", "-q", source]);
        git(source, ["config", "user.email", "test@example.com"]);
        git(source, ["config", "user.name", "Test"]);
        writeFileSync(join(source, "x.txt"), "base\n");
        git(source, ["add", "x.txt"]);
        git(source, ["commit", "-qm", "base"]);
        const base = git(source, ["rev-parse", "HEAD"]).trim();
        writeFileSync(join(source, "x.txt"), "head\n");
        git(source, ["commit", "-am", "head", "-q"]);
        const head = git(source, ["rev-parse", "HEAD"]).trim();
        git(root, ["init", "--bare", "-q", origin]);
        git(source, ["remote", "add", "origin", origin]);
        git(source, ["push", "-q", "origin", `${base}:refs/heads/${branch}`, `${head}:refs/pull/42/head`]);
        git(root, ["init", "-q", consumer]);
        git(consumer, ["remote", "add", "origin", origin]);

        const refs = { baseRefOid: base, headRefOid: head, baseRefName: branch };
        let message = "";
        try {
          await getDiff({ kind: "pr", pr: 42 }, localGitRun(consumer, refs));
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        const hint = message.slice(message.indexOf("run: ") + "run: ".length);
        expect(hint).toBe(`git fetch origin 'refs/heads/${branch}' 'pull/42/head'`);
        expect(Bun.spawnSync(["/bin/sh", "-c", hint], { cwd: consumer }).exitCode).toBe(0);
        expect(git(consumer, ["cat-file", "-e", `${base}^{commit}`])).toBe("");
        expect(git(consumer, ["cat-file", "-e", `${head}^{commit}`])).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fallback errors before its notice when the local diff is empty", async () => {
    const run = largePrFallbackRun(
      DIRECT_TOO_LARGE_RESPONSE,
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`,
      "",
    );
    const { error, stderr } = await captureStderrError(() => getDiff({ kind: "pr", pr: 42 }, run));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("nothing to review");
    expect(stderr).toBe("");
  });

  test("raw parser and partial-clone config failures fail closed", async () => {
    for (const raw of ["not metadata\0", `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0`]) {
      await expect(getDiff({ kind: "pr", pr: 42 }, largePrFallbackRun(DIRECT_TOO_LARGE_RESPONSE, raw))).rejects.toThrow(
        /malformed|incomplete/,
      );
    }
    const configFailure = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("fatal: config read failure", 2),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, configFailure)).rejects.toThrow("config read failure");
  });

  test("partial clones on Git 2.45 run every fallback command with --no-lazy-fetch", async () => {
    const { batchInputs, calls, run } = partialCloneFallbackRun("2.45.0");
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toEqual({ diff: SAMPLE_DIFF, files: ["x.ts"] });
    const traversal = calls.slice(4);
    expect(traversal.every((command) => command[0] === "git" && command[1] === "--no-lazy-fetch")).toBe(true);
    expect(traversal.map((command) => command.join(" ")).sort()).toEqual([
      ["git", "--no-lazy-fetch", "cat-file", "-e", `${PR_REFS.baseRefOid}^{commit}`],
      ["git", "--no-lazy-fetch", "cat-file", "-e", `${PR_REFS.headRefOid}^{commit}`],
      ["git", "--no-lazy-fetch", "merge-base", PR_REFS.baseRefOid, PR_REFS.headRefOid],
      ["git", "--no-lazy-fetch", "-c", "core.quotePath=false", "diff", "--raw", "--no-abbrev", "-z", `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`],
      ["git", "--no-lazy-fetch", "cat-file", "--batch-check"],
      ["git", "--no-lazy-fetch", "-c", "core.quotePath=false", "diff", `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`],
    ].map((command) => command.join(" ")).sort());
    expect(batchInputs).toEqual([`${BASE_BLOB}\n${HEAD_BLOB}\n`]);
  });

  test("the batch pre-check skips gitlink IDs while reviewing a gitlink add and update", async () => {
    const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
    const batchInputs: string[] = [];
    const run: Run = async (cmd, stdin?: string) => {
      const key = cmd.join(" ");
      if (key === "gh pr diff 42") return fail(DIRECT_TOO_LARGE_RESPONSE, 1);
      if (key === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") return ok(JSON.stringify(PR_REFS));
      if (key === "git config --get extensions.partialClone") return fail("", 1);
      if (key === "git config --type=bool --get-regexp ^remote\\..*\\.promisor$") return fail("", 1);
      if (key === `git cat-file -e ${PR_REFS.baseRefOid}^{commit}`) return ok("");
      if (key === `git cat-file -e ${PR_REFS.headRefOid}^{commit}`) return ok("");
      if (key === `git merge-base ${PR_REFS.baseRefOid} ${PR_REFS.headRefOid}`) return ok(`${PR_REFS.baseRefOid}\n`);
      if (key === `git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`) {
        return ok([
          `:000000 160000 ${"0".repeat(40)} ${GITLINK_ONE} A`, "deps/added",
          `:160000 160000 ${GITLINK_ONE} ${GITLINK_TWO} M`, "deps/updated",
          `:100644 100644 ${BASE_BLOB} ${HEAD_BLOB} M`, "x.ts",
        ].join("\0") + "\0");
      }
      if (key === "git cat-file --batch-check") {
        batchInputs.push(stdin ?? "");
        return ok(`${BASE_BLOB} blob 4\n${HEAD_BLOB} blob 4\n`);
      }
      if (key === `git -c core.quotePath=false diff ${range}`) return ok(SAMPLE_DIFF);
      throw new Error(`unexpected command: ${key}`);
    };
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toEqual({
      diff: SAMPLE_DIFF,
      files: ["deps/added", "deps/updated", "x.ts"],
    });
    expect(batchInputs).toEqual([`${BASE_BLOB}\n${HEAD_BLOB}\n`]);
  });

  test("the batch pre-check retains the regular side of gitlink type changes", async () => {
    const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
    for (const [metadata, blob] of [
      [`:100644 160000 ${BASE_BLOB} ${GITLINK_ONE} T`, BASE_BLOB],
      [`:160000 100644 ${GITLINK_TWO} ${HEAD_BLOB} T`, HEAD_BLOB],
    ]) {
      const batchInputs: string[] = [];
      const run: Run = async (cmd, stdin?: string) => {
        const key = cmd.join(" ");
        if (key === "gh pr diff 42") return fail(DIRECT_TOO_LARGE_RESPONSE, 1);
        if (key === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") return ok(JSON.stringify(PR_REFS));
        if (key === "git config --get extensions.partialClone") return fail("", 1);
        if (key === "git config --type=bool --get-regexp ^remote\\..*\\.promisor$") return fail("", 1);
        if (key === `git cat-file -e ${PR_REFS.baseRefOid}^{commit}`) return ok("");
        if (key === `git cat-file -e ${PR_REFS.headRefOid}^{commit}`) return ok("");
        if (key === `git merge-base ${PR_REFS.baseRefOid} ${PR_REFS.headRefOid}`) return ok(`${PR_REFS.baseRefOid}\n`);
        if (key === `git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`) return ok(`${metadata}\0changed-path\0`);
        if (key === "git cat-file --batch-check") {
          batchInputs.push(stdin ?? "");
          return ok(`${blob} blob 4\n`);
        }
        if (key === `git -c core.quotePath=false diff ${range}`) return ok(SAMPLE_DIFF);
        throw new Error(`unexpected command: ${key}`);
      };
      await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toEqual({ diff: SAMPLE_DIFF, files: ["changed-path"] });
      expect(batchInputs).toEqual([`${blob}\n`]);
    }
  });

  test("a partial clone on Git 2.44 fails before fallback traversal", async () => {
    const calls: string[][] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd);
      const key = cmd.join(" ");
      if (key === "gh pr diff 42") return fail(DIRECT_TOO_LARGE_RESPONSE, 1);
      if (key === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") return ok(JSON.stringify(PR_REFS));
      if (key === "git config --get extensions.partialClone") return fail("", 1);
      if (key === "git config --type=bool --get-regexp ^remote\\..*\\.promisor$") return ok("remote.origin.promisor true\n");
      if (key === "git --version") return ok("git version 2.44.4\n");
      throw new Error(`unexpected command: ${key}`);
    };
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "this partial clone needs Git 2.45 or newer to avoid lazy fetching",
    );
    expect(calls).toHaveLength(5);
  });

  // Git v2.45 introduced --no-lazy-fetch; older Git is covered by the mocked
  // fail-closed test above rather than this real partial-clone integration test.
  test.skipIf(!installedGitAtLeast(2, 45))("a missing partial-clone blob receives a fetch hint without lazy fetching", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-partial-clone-"));
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    try {
      git(root, ["init", "-q", "-b", "main", source]);
      git(source, ["config", "user.email", "test@example.com"]);
      git(source, ["config", "user.name", "Test"]);
      writeFileSync(join(source, "x.txt"), "base\n");
      git(source, ["add", "x.txt"]);
      git(source, ["commit", "-qm", "base"]);
      const baseRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(source, "x.txt"), "head\n");
      git(source, ["commit", "-am", "head", "-q"]);
      const headRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      git(root, ["clone", "-q", "--bare", source, remote]);
      git(remote, ["config", "uploadpack.allowFilter", "true"]);
      const clone = join(root, "clone-blob-none");
      git(root, ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${remote}`, clone]);
      const before = missingObjectIds(clone);
      expect(before.length).toBeGreaterThan(0);
      const calls: string[][] = [];
      let message = "";
      try {
        await getDiff(
          { kind: "pr", pr: 42 },
          localGitRun(clone, { baseRefOid, headRefOid, baseRefName: "main" }, calls),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("run: git fetch origin 'refs/heads/main' 'pull/42/head'");
      const traversal = calls.filter((cmd) => cmd[0] === "git" && cmd[1] !== "config" && cmd[1] !== "--version");
      expect(traversal.length).toBeGreaterThan(0);
      expect(traversal.every((cmd) => cmd[1] === "--no-lazy-fetch")).toBe(true);
      expect(calls.filter((cmd) => cmd.join(" ").endsWith("cat-file --batch-check"))).toHaveLength(1);
      expect(missingObjectIds(clone)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!installedGitAtLeast(2, 45))("a tree-filter partial clone does not lazy-fetch during fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-partial-tree-"));
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const clone = join(root, "clone-tree-zero");
    try {
      git(root, ["init", "-q", "-b", "main", source]);
      git(source, ["config", "user.email", "test@example.com"]);
      git(source, ["config", "user.name", "Test"]);
      writeFileSync(join(source, "x.txt"), "base\n");
      git(source, ["add", "x.txt"]);
      git(source, ["commit", "-qm", "base"]);
      const baseRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(source, "x.txt"), "head\n");
      git(source, ["commit", "-am", "head", "-q"]);
      const headRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      git(root, ["clone", "-q", "--bare", source, remote]);
      git(remote, ["config", "uploadpack.allowFilter", "true"]);
      git(root, ["clone", "-q", "--filter=tree:0", "--no-checkout", `file://${remote}`, clone]);
      const before = missingObjectIds(clone);
      expect(before.length).toBeGreaterThan(0);
      const calls: string[][] = [];
      let message = "";
      try {
        await getDiff(
          { kind: "pr", pr: 42 },
          localGitRun(clone, { baseRefOid, headRefOid, baseRefName: "main" }, calls),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("run: git fetch origin 'refs/heads/main' 'pull/42/head'");
      const traversal = calls.filter((cmd) => cmd[0] === "git" && cmd[1] !== "config" && cmd[1] !== "--version");
      expect(traversal.length).toBeGreaterThan(0);
      expect(traversal.every((cmd) => cmd[1] === "--no-lazy-fetch")).toBe(true);
      expect(calls.filter((cmd) => cmd.join(" ").endsWith("cat-file --batch-check"))).toHaveLength(1);
      expect(missingObjectIds(clone)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!installedGitAtLeast(2, 45))("gitlink type changes pre-check regular blobs in a partial clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-gitlink-transition-"));
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const clone = join(root, "clone-blob-none");
    try {
      git(root, ["init", "-q", "-b", "main", source]);
      git(source, ["config", "user.email", "test@example.com"]);
      git(source, ["config", "user.name", "Test"]);
      writeFileSync(join(source, "file-to-link"), "base file\n");
      git(source, ["add", "file-to-link"]);
      git(source, ["update-index", "--add", "--cacheinfo", `160000,${GITLINK_ONE},link-to-file`]);
      git(source, ["commit", "-qm", "base"]);
      const baseRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      git(source, ["update-index", "--add", "--cacheinfo", `160000,${GITLINK_TWO},file-to-link`]);
      writeFileSync(join(source, "link-to-file"), "head file\n");
      git(source, ["add", "link-to-file"]);
      git(source, ["commit", "-qm", "head"]);
      const headRefOid = git(source, ["rev-parse", "HEAD"]).trim();
      git(root, ["clone", "-q", "--bare", source, remote]);
      git(remote, ["config", "uploadpack.allowFilter", "true"]);
      git(root, ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${remote}`, clone]);
      const before = missingObjectIds(clone);
      expect(before.length).toBeGreaterThan(0);
      const calls: string[][] = [];
      let message = "";
      try {
        await getDiff(
          { kind: "pr", pr: 42 },
          localGitRun(clone, { baseRefOid, headRefOid, baseRefName: "main" }, calls),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("run: git fetch origin 'refs/heads/main' 'pull/42/head'");
      expect(calls.filter((cmd) => cmd.join(" ").endsWith("cat-file --batch-check"))).toHaveLength(1);
      expect(missingObjectIds(clone)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupt range object preserves the batch-check diagnostic", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-corrupt-object-"));
    try {
      git(root, ["init", "-q", "-b", "main", "."]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);
      writeFileSync(join(root, "x.txt"), "base\n");
      git(root, ["add", "x.txt"]);
      git(root, ["commit", "-qm", "base"]);
      const baseRefOid = git(root, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(root, "x.txt"), "head\n");
      git(root, ["commit", "-am", "head", "-q"]);
      const headRefOid = git(root, ["rev-parse", "HEAD"]).trim();
      const blob = git(root, ["rev-parse", "HEAD:x.txt"]).trim();
      const objectPath = join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      chmodSync(objectPath, 0o600);
      writeFileSync(objectPath, "corrupt");

      let message = "";
      try {
        await getDiff(
          { kind: "pr", pr: 42 },
          localGitRun(root, { baseRefOid, headRefOid, baseRefName: "main" }),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/inflate|unable to unpack/i);
      expect(message).not.toContain("run: git fetch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a boolean-false promisor setting permits the unchanged non-partial fallback", async () => {
    const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
    const run = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": ok("remote.origin.promisor false\n"),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": ok(`${PR_REFS.baseRefOid}\n`),
      [`git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`]: ok(
        `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`,
      ),
      [`git -c core.quotePath=false diff ${range}`]: ok(SAMPLE_DIFF),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toEqual(
      { diff: SAMPLE_DIFF, files: ["x.ts"] },
    );
  });

  test("missing local commits provide a fetch hint without fetching", async () => {
    const run = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": fail("fatal: not a valid object name", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "run: git fetch origin 'refs/heads/main' 'pull/42/head'",
    );
  });

  test("other git failures and gh diff errors retain their original detail", async () => {
    await expect(getDiff({ kind: "pr", pr: 42 }, mockRun({
      "gh pr diff 42": fail("authentication failed", 1),
    }))).rejects.toThrow("gh pr diff 42: authentication failed");

    const brokenStore = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": fail("fatal: not a git repository", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, brokenStore)).rejects.toThrow(
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}: fatal: not a git repository",
    );
  });

  test("invalid PR metadata and unexpected merge-base failures fail loudly", async () => {
    const invalid = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok("not JSON"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, invalid)).rejects.toThrow("invalid JSON response");

    const incomplete = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify({ baseRefOid: PR_REFS.baseRefOid })),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, incomplete)).rejects.toThrow(
      "missing valid base or head commit information",
    );

    const mergeFailure = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": fail("fatal: corrupt commit graph", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, mergeFailure)).rejects.toThrow("fatal: corrupt commit graph");
  });

  test("missing merge history distinguishes shallow and unrelated repositories", async () => {
    const common = {
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --type=bool --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": fail("", 1),
    };
    const shallow = mockRun({
      ...common,
      "git rev-parse --is-shallow-repository": ok("true\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, shallow)).rejects.toThrow(
      "run: git fetch --unshallow",
    );

    const unrelated = mockRun({
      ...common,
      "git rev-parse --is-shallow-repository": ok("false\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, unrelated)).rejects.toThrow(
      "have unrelated histories locally",
    );
  });

  test("range target uses git diff with stable path encoding (-z, quotePath off)", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff main...HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only main...HEAD": z("x.ts", "sub/y.ts"),
    });
    const result = await getDiff({ kind: "range", range: "main...HEAD" }, run);
    expect(result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts", "sub/y.ts"] });
  });

  test("preserves exact path content (spaces, non-ASCII, no trim) via NUL split", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff main...HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only main...HEAD": z(" leading.ts", "trailing .ts", "café.ts"),
    });
    const { files } = await getDiff({ kind: "range", range: "main...HEAD" }, run);
    expect(files).toEqual([" leading.ts", "trailing .ts", "café.ts"]);
  });

  test("worktree uses tracked changes plus untracked files", async () => {
    const untrackedDiff = "diff --git a/new.ts b/new.ts\nnew file mode 100644\n";
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only HEAD": z("x.ts"),
      "git -c core.quotePath=false ls-files --others --exclude-standard -z": z("new.ts"),
      "git -c core.quotePath=false diff --no-index -- /dev/null new.ts": { code: 1, stdout: untrackedDiff, stderr: "" },
    });
    const result = await getDiff({ kind: "worktree" }, run);
    expect(result.files).toEqual(["x.ts", "new.ts"]);
    expect(result.diff).toContain("new.ts");
    expect(result.head).toBeUndefined();
  });

  test("worktree falls back to branch-vs-base when tracked + untracked are empty", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD": ok(""),
      "git -c core.quotePath=false diff -z --name-only HEAD": ok(""),
      "git -c core.quotePath=false ls-files --others --exclude-standard -z": ok(""),
      // origin/HEAD resolves to a FULLY-QUALIFIED remote ref, used verbatim in the
      // diff so a local branch/tag named `origin/main` can never shadow it.
      "git symbolic-ref --quiet refs/remotes/origin/HEAD": ok("refs/remotes/origin/main\n"),
      "git -c core.quotePath=false diff refs/remotes/origin/main...HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only refs/remotes/origin/main...HEAD": z("x.ts"),
    });
    const { files } = await getDiff({ kind: "worktree" }, run);
    expect(files).toEqual(["x.ts"]);
  });

  test("worktree branch-vs-base resolves the REMOTE base on a fresh checkout with no local base branch", async () => {
    // origin/HEAD isn't set (shallow CI checkout) and there is no origin/main —
    // only origin/master. The base must still resolve against the remote, with no
    // local base branch involved, via an exact remote-ref existence check.
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD": ok(""),
      "git -c core.quotePath=false diff -z --name-only HEAD": ok(""),
      "git -c core.quotePath=false ls-files --others --exclude-standard -z": ok(""),
      "git symbolic-ref --quiet refs/remotes/origin/HEAD": fail("", 1),
      "git show-ref --verify --quiet refs/remotes/origin/main": fail("", 1),
      "git show-ref --verify --quiet refs/remotes/origin/master": ok(""),
      "git -c core.quotePath=false diff refs/remotes/origin/master...HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only refs/remotes/origin/master...HEAD": z("x.ts"),
    });
    const { files } = await getDiff({ kind: "worktree" }, run);
    expect(files).toEqual(["x.ts"]);
  });

  test("worktree branch-vs-base falls back to origin/main when origin/HEAD is unset", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD": ok(""),
      "git -c core.quotePath=false diff -z --name-only HEAD": ok(""),
      "git -c core.quotePath=false ls-files --others --exclude-standard -z": ok(""),
      "git symbolic-ref --quiet refs/remotes/origin/HEAD": fail("", 1),
      "git show-ref --verify --quiet refs/remotes/origin/main": ok(""),
      "git -c core.quotePath=false diff refs/remotes/origin/main...HEAD": ok(SAMPLE_DIFF),
      "git -c core.quotePath=false diff -z --name-only refs/remotes/origin/main...HEAD": z("x.ts"),
    });
    const { files } = await getDiff({ kind: "worktree" }, run);
    expect(files).toEqual(["x.ts"]);
  });

  test("clean tree with no resolvable remote base errors as nothing to review", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD": ok(""),
      "git -c core.quotePath=false diff -z --name-only HEAD": ok(""),
      "git -c core.quotePath=false ls-files --others --exclude-standard -z": ok(""),
      "git symbolic-ref --quiet refs/remotes/origin/HEAD": fail("", 1),
      "git show-ref --verify --quiet refs/remotes/origin/main": fail("", 1),
      "git show-ref --verify --quiet refs/remotes/origin/master": fail("", 1),
    });
    await expect(getDiff({ kind: "worktree" }, run)).rejects.toThrow("nothing to review");
  });

  test("an empty range diff errors as nothing to review", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff HEAD...HEAD": ok(""),
      "git -c core.quotePath=false diff -z --name-only HEAD...HEAD": ok(""),
    });
    await expect(getDiff({ kind: "range", range: "HEAD...HEAD" }, run)).rejects.toThrow("nothing to review");
  });

  test("a git failure surfaces as a WuxReviewError with the stderr detail", async () => {
    const run = mockRun({
      "git -c core.quotePath=false diff bogus...HEAD": fail("fatal: bad revision 'bogus...HEAD'"),
    });
    await expect(getDiff({ kind: "range", range: "bogus...HEAD" }, run)).rejects.toThrow("bad revision");
  });
});
