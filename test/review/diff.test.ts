import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff } from "../../src/review/diff";
import type { Run, RunResult } from "../../src/runtime/exec";

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 128): RunResult => ({ code, stdout: "", stderr });
const missing = (object: string): RunResult => fail(`fatal: Not a valid object name ${object}`, 128);
// NUL-terminated output, the shape of `git ... -z`.
const z = (...parts: string[]): RunResult => ok(parts.map((p) => `${p}\0`).join(""));

// Build a mock runner from a map of "joined command" -> RunResult.
function mockRun(table: Record<string, RunResult>): Run {
  return async (cmd: string[]) => {
    const key = (cmd[0] === "git" && cmd[1] === "--no-lazy-fetch" ? ["git", ...cmd.slice(2)] : cmd).join(" ");
    if (key in table) return table[key]!;
    if (key === "git config --get extensions.partialClone" || key === "git config --get-regexp ^remote\\..*\\.promisor$") {
      return fail("", 1);
    }
    if (key === "git --version") return ok("git version 2.45.0\n");
    throw new Error(`unexpected command: ${key}`);
  };
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function missingObjectIds(root: string): string[] {
  return git(root, ["rev-list", "--objects", "--missing=print", "HEAD"])
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1))
    .sort();
}

function realGitRun(root: string, refs: typeof PR_REFS): Run {
  return async (cmd) => {
    if (cmd.join(" ") === "gh pr diff 42") {
      return fail("HTTP 406: the diff exceeded the maximum number of files", 1);
    }
    if (cmd.join(" ") === "gh pr view 42 --json baseRefOid,headRefOid,baseRefName") {
      return ok(JSON.stringify(refs));
    }
    const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
}

const SAMPLE_DIFF = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
const PR_REFS = {
  baseRefOid: "0123456789abcdef0123456789abcdef01234567",
  headRefOid: "89abcdef0123456789abcdef0123456789abcdef",
  baseRefName: "main",
};
const BASE_BLOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_BLOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

  test("too-large PR diffs fall back to the complete matching local range", async () => {
    const range = `${PR_REFS.baseRefOid}...${PR_REFS.headRefOid}`;
    const run = mockRun({
      "gh pr diff 42": fail("HTTP 406: the diff exceeded the maximum number of files", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": ok("0123456789abcdef0123456789abcdef01234567\n"),
      [`git diff --no-ext-diff --no-renames --raw -z ${range}`]: ok(`:100644 100644 ${BASE_BLOB} ${HEAD_BLOB} M\0x.ts\0`),
      [`git cat-file -e ${BASE_BLOB}`]: ok(""),
      [`git cat-file -e ${HEAD_BLOB}`]: ok(""),
      [`git -c core.quotePath=false diff ${range}`]: ok(SAMPLE_DIFF),
      [`git -c core.quotePath=false diff -z --name-only ${range}`]: z("x.ts", "sub/y.ts"),
    });

    const { result, stderr } = await captureStderr(() => getDiff({ kind: "pr", pr: 42 }, run));
    expect(result).toEqual({ diff: SAMPLE_DIFF, files: ["x.ts", "sub/y.ts"] });
    expect(stderr).toContain(`reviewing ${range} from local git`);
  });

  test("large-PR fallback never lazily fetches promised blobs from a partial clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "wuxr-partial-clone-"));
    const source = join(root, "source");
    const remote = join(root, "remote");
    try {
      git(root, ["init", "-q", "-b", "main", source]);
      git(source, ["config", "user.email", "test@example.com"]);
      git(source, ["config", "user.name", "Test"]);
      writeFileSync(join(source, "x.txt"), "old\n");
      git(source, ["add", "x.txt"]);
      git(source, ["commit", "-qm", "base"]);
      writeFileSync(join(source, "x.txt"), "new\n");
      git(source, ["commit", "-am", "head", "-q"]);
      git(root, ["clone", "-q", "--bare", source, remote]);
      git(remote, ["config", "uploadpack.allowFilter", "true"]);
      const refs = {
        baseRefOid: git(source, ["rev-parse", "HEAD^"]).trim(),
        headRefOid: git(source, ["rev-parse", "HEAD"]).trim(),
        baseRefName: "main",
      };
      for (const filter of ["blob:none", "tree:0"]) {
        const clone = join(root, `clone-${filter.replace(":", "-")}`);
        git(root, ["clone", "-q", `--filter=${filter}`, "--no-checkout", `file://${remote}`, clone]);
        const before = missingObjectIds(clone);
        expect(before.length).toBeGreaterThan(0);

        await expect(getDiff({ kind: "pr", pr: 42 }, realGitRun(clone, refs))).rejects.toThrow(
          "run: git fetch origin 'main' 'pull/42/head'",
        );
        expect(missingObjectIds(clone)).toEqual(before);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partial clones fail closed when Git lacks --no-lazy-fetch", async () => {
    const run = mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git config --get-regexp ^remote\\..*\\.promisor$": ok("remote.origin.promisor true\n"),
      "git --version": ok("git version 2.44.4\n"),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "this partial clone requires Git 2.45 or newer to avoid lazy fetching",
    );
  });

  test("other gh PR diff failures retain their original error", async () => {
    const run = mockRun({ "gh pr diff 42": fail("authentication failed", 1) });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "gh pr diff 42: authentication failed",
    );
  });

  test("an unrelated HTTP 406 does not trigger a local fallback", async () => {
    const run = mockRun({ "gh pr diff 42": fail("HTTP 406: unsupported media type", 1) });
    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "gh pr diff 42: HTTP 406: unsupported media type",
    );
  });

  test("missing local PR commits give the required fetch command without fetching", async () => {
    const run = mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": missing("0123456789abcdef0123456789abcdef01234567^{commit}"),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "PR #42 is too large for gh pr diff and 0123456789abcdef0123456789abcdef01234567 isn't available locally; run: git fetch origin 'main' 'pull/42/head'",
    );
  });

  test("a missing local PR head gives the same fetch command", async () => {
    const run = mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": missing("89abcdef0123456789abcdef0123456789abcdef^{commit}"),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "PR #42 is too large for gh pr diff and 89abcdef0123456789abcdef0123456789abcdef isn't available locally; run: git fetch origin 'main' 'pull/42/head'",
    );
  });

  test("malformed PR metadata and non-hex object IDs fail before local git", async () => {
    const runFor = (metadata: string): Run => mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(metadata),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, runFor("not json"))).rejects.toThrow("invalid JSON response");
    await expect(getDiff({ kind: "pr", pr: 42 }, runFor(JSON.stringify({ baseRefOid: 1 })))).rejects.toThrow(
      "missing valid base or head commit information",
    );
    await expect(getDiff({ kind: "pr", pr: 42 }, runFor(JSON.stringify({ ...PR_REFS, headRefOid: "not-hex" })))).rejects.toThrow(
      "missing valid base or head commit information",
    );
  });

  test("non-missing cat-file failures retain their real git error", async () => {
    const run = mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": fail("fatal: not a git repository", 128),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow("fatal: not a git repository");
  });

  test("fetch hints quote shell-sensitive base branch names", async () => {
    const refs = { ...PR_REFS, baseRefName: "topic;$(echo unsafe)'quote" };
    const run = mockRun({
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(refs)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": missing("0123456789abcdef0123456789abcdef01234567^{commit}"),
    });

    await expect(getDiff({ kind: "pr", pr: 42 }, run)).rejects.toThrow(
      "git fetch origin 'topic;$(echo unsafe)'\\''quote' 'pull/42/head'",
    );
  });

  test("unavailable merge history gives a runnable shallow-clone hint or an unrelated-history error", async () => {
    const common = {
      "gh pr diff 42": fail("too_large", 1),
      "gh pr view 42 --json baseRefOid,headRefOid,baseRefName": ok(JSON.stringify(PR_REFS)),
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": ok(""),
      "git cat-file -e 89abcdef0123456789abcdef0123456789abcdef^{commit}": ok(""),
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": fail("", 1),
    };
    const shallow = mockRun({
      ...common,
      "git rev-parse --is-shallow-repository": ok("true\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, shallow)).rejects.toThrow("run: git fetch --unshallow");

    const unrelated = mockRun({
      ...common,
      "git rev-parse --is-shallow-repository": ok("false\n"),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, unrelated)).rejects.toThrow("have unrelated histories locally");

    const unknownShallowState = mockRun({
      ...common,
      "git rev-parse --is-shallow-repository": fail("fatal: not a git repository", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, unknownShallowState)).rejects.toThrow("fatal: not a git repository");

    const broken = mockRun({
      ...common,
      "git merge-base 0123456789abcdef0123456789abcdef01234567 89abcdef0123456789abcdef0123456789abcdef": fail("fatal: corrupt commit graph", 128),
    });
    await expect(getDiff({ kind: "pr", pr: 42 }, broken)).rejects.toThrow("fatal: corrupt commit graph");
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
