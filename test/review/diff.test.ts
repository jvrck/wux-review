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

describe("getDiff", () => {
  test("pr target waits for its expected head and records the reviewed SHA", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("abc123\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    const { diff, files, head } = await getDiff({ kind: "pr", pr: 42, expectHead: "abc123" }, run);
    expect(diff).toBe(SAMPLE_DIFF);
    expect(files).toEqual(["x.ts"]);
    expect(head).toBe("abc123");
  });

  test("compares expected heads case-insensitively", async () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const run = mockRun({
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok(`${sha}\n`),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42, expectHead: sha.toUpperCase() }, run)).resolves.toMatchObject({ head: sha });
  });

  test("polls until GitHub exposes the expected pushed head", async () => {
    const heads = ["old", "expected", "expected"];
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid --jq .headRefOid") return ok(`${heads.shift()}\n`);
      if (key === "gh pr diff 42") return ok(SAMPLE_DIFF);
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };
    const pauses: number[] = [];
    await expect(getDiff({ kind: "pr", pr: 42, expectHead: "expected" }, run, async (ms) => { pauses.push(ms); })).resolves.toMatchObject({ head: "expected" });
    expect(pauses).toEqual([1_000]);
  });

  test("fails loudly without fetching a diff when the expected head never appears", async () => {
    const run: Run = async (cmd) => {
      if (cmd.join(" ") === "gh pr view 42 --json headRefOid --jq .headRefOid") return ok("old\n");
      throw new Error(`must not fetch: ${cmd.join(" ")}`);
    };
    await expect(getDiff({ kind: "pr", pr: 42, expectHead: "expected", headWaitMs: 0 }, run)).rejects.toThrow(
      "PR #42 head is old, expected expected; push may not have landed",
    );
  });

  test("defaults the expectation to local HEAD when checked out on the PR branch", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefName,headRepository": ok('{"headRefName":"feature","headRepository":{"nameWithOwner":"owner/repo"}}\n'),
      "git branch --show-current": ok("feature\n"),
      "git config --get branch.feature.remote": ok("origin\n"),
      "git remote get-url origin": ok("git@example.invalid:owner/repo.git\n"),
      "git rev-parse HEAD": ok("abc123\n"),
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("abc123\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "abc123" });
  });

  test("does not infer a fork PR expectation from a same-named local branch", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefName,headRepository": ok('{"headRefName":"patch","headRepository":{"nameWithOwner":"fork/repo"}}\n'),
      "git branch --show-current": ok("patch\n"),
      "git config --get branch.patch.remote": ok("origin\n"),
      "git remote get-url origin": ok("git@example.invalid:upstream/repo.git\n"),
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("forkhead\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "forkhead" });
  });

  test("falls back to an unpinned PR review outside a Git checkout", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefName,headRepository": ok('{"headRefName":"feature","headRepository":{"nameWithOwner":"owner/repo"}}\n'),
      "git branch --show-current": fail("not a git repository", 128),
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("head\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "head" });
  });

  test("falls back to an unpinned review when GitHub local-head metadata fails", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefName,headRepository": ok("not json\n"),
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("head\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "head" });
  });

  test("falls back to an unpinned review when GitHub local-head lookup exits non-zero", async () => {
    const run = mockRun({
      "gh pr view 42 --json headRefName,headRepository": fail("temporary API failure", 1),
      "gh pr view 42 --json headRefOid --jq .headRefOid": ok("head\n"),
      "gh pr diff 42": ok(SAMPLE_DIFF),
      "gh pr diff 42 --name-only": ok("x.ts\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "head" });
  });

  test("refetches once if an unpinned PR head moves during the two diff calls", async () => {
    const heads = ["one", "two", "two"];
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefName,headRepository") return ok('{"headRefName":"other","headRepository":{"nameWithOwner":"owner/repo"}}\n');
      if (key === "git branch --show-current") return ok("feature\n");
      if (key === "gh pr view 42 --json headRefOid --jq .headRefOid") return ok(`${heads.shift()}\n`);
      if (key === "gh pr diff 42") return ok(SAMPLE_DIFF);
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).resolves.toMatchObject({ head: "two" });
  });

  test("rejects an explicitly pinned head that moves during diff fetch", async () => {
    const heads = ["expected", "new-head"];
    const run: Run = async (cmd) => {
      const key = cmd.join(" ");
      if (key === "gh pr view 42 --json headRefOid --jq .headRefOid") return ok(`${heads.shift()}\n`);
      if (key === "gh pr diff 42") return ok(SAMPLE_DIFF);
      if (key === "gh pr diff 42 --name-only") return ok("x.ts\n");
      throw new Error(`unexpected command: ${key}`);
    };
    await expect(getDiff({ kind: "pr", pr: 42, expectHead: "expected" }, run)).rejects.toThrow(
      "PR #42 head is new-head, expected expected; push may not have landed",
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
