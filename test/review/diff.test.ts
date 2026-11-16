import { describe, expect, test } from "bun:test";
import { getDiff } from "../../src/review/diff";
import type { Run, RunResult } from "../../src/runtime/exec";

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 128): RunResult => ({ code, stdout: "", stderr });
// NUL-terminated output, the shape of `git ... -z`.
const z = (...parts: string[]): RunResult => ok(parts.map((p) => `${p}\0`).join(""));

// Build a mock runner from a map of "joined command" -> RunResult.
function mockRun(table: Record<string, RunResult>): Run {
  return async (cmd: string[]) => {
    const key = cmd.join(" ");
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

const MAXIMUM_FILES_RESPONSE = await Bun.file(
  new URL("../fixtures/gh-pr-diff-maximum-files.stderr", import.meta.url),
).text();
const DIRECT_TOO_LARGE_RESPONSE = await Bun.file(
  new URL("../fixtures/gh-pr-diff-too-large.stderr", import.meta.url),
).text();

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

function largePrFallbackRun(stderr: string): Run {
  const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
  return mockRun({
    "gh pr diff 42": fail(stderr, 1),
    "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
    "git config --get extensions.partialClone": fail("", 1),
    "git config --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
    "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
    "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
    "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": ok(`${PR_REFS.baseRefOid}\n`),
    [`git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`]: ok(
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`,
    ),
    [`git -c core.quotePath=false diff ${range}`]: ok(SAMPLE_DIFF),
  });
}

describe("getDiff", () => {
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
    for (const stderr of [MAXIMUM_FILES_RESPONSE, DIRECT_TOO_LARGE_RESPONSE]) {
      const { result, stderr: notice } = await captureStderr(() =>
        getDiff({ kind: "pr", pr: 42 }, largePrFallbackRun(stderr)));
      expect(result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts"] });
      expect(notice).toContain(
        `reviewing ${PR_REFS.baseRefOid}...${PR_REFS.headRefOid} from local git`,
      );
    }
  });

  test("large PR fallback parses raw -z entries positionally", async () => {
    const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
    const run = largePrFallbackRun(DIRECT_TOO_LARGE_RESPONSE);
    const expected = `git -c core.quotePath=false diff --raw --no-abbrev -z ${range}`;
    const positional = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": ok(`${PR_REFS.baseRefOid}\n`),
      [expected]: ok(
        `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0:100644 100644 ${"c".repeat(40)} ${"d".repeat(40)}.ts\0`,
      ),
      [`git -c core.quotePath=false diff ${range}`]: ok(SAMPLE_DIFF),
    });
    expect(run).toBeDefined();
    const { files } = await getDiff({ kind: "pr", pr: 42 }, positional);
    expect(files).toEqual([`:100644 100644 ${"c".repeat(40)} ${"d".repeat(40)}.ts`]);
  });

  test("partial clones fail closed before fallback traversal", async () => {
    const run = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": ok("origin\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "partial clones aren't supported for the large-PR fallback yet",
    );
  });

  test("a promisor remote also fails closed before fallback traversal", async () => {
    const run = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --get-regexp ^remote\\..*\\.promisor$": ok("remote.origin.promisor true\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "partial clones aren't supported for the large-PR fallback yet",
    );
  });

  test("missing local commits provide a fetch hint without fetching", async () => {
    const run = mockRun({
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": fail("fatal: not a valid object name", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "run: git fetch origin 'main' 'pull/42/head'",
    );
  });

  test("missing merge history distinguishes shallow and unrelated repositories", async () => {
    const common = {
      "gh pr diff 42": fail(DIRECT_TOO_LARGE_RESPONSE, 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get extensions.partialClone": fail("", 1),
      "git config --get-regexp ^remote\\..*\\.promisor$": fail("", 1),
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
    const { files } = await getDiff({ kind: "range", range: "main...HEAD" }, run);
    expect(files).toEqual(["x.ts", "sub/y.ts"]);
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
    const { diff, files } = await getDiff({ kind: "worktree" }, run);
    expect(files).toEqual(["x.ts", "new.ts"]);
    expect(diff).toContain("new.ts");
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
