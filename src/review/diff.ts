import { WuxReviewError } from "../runtime/errors";
import { run as defaultRun, type Run } from "../runtime/exec";
import type { Target } from "./target";

export interface ReviewDiff {
  diff: string;
  files: string[];
  head?: string;
}

const DEFAULT_HEAD_WAIT_MS = 60_000;
const HEAD_POLL_MS = 1_000;
type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch the unified diff + changed-file list for a resolved target. `run` is
// injectable so the git/gh boundary can be mocked in tests.
//
// Every target resolves to the FULL cumulative change, never an incremental
// slice: the PR case is the full `base...head` diff (`gh pr diff`), the range case
// is a three-dot `base...HEAD` diff (`main...HEAD` — see target.ts), and the
// worktree case is HEAD + untracked, falling back to `base...HEAD`. This is
// session-independent by construction — `getDiff` takes no session state, so a
// `--session` re-review sees exactly the same full diff as the first review, and
// can never lose content from an earlier commit (#94). The prior-round findings a
// re-review threads into the prompt are context only (see prompt.ts / pipeline.ts);
// they do not narrow this diff.
export async function getDiff(target: Target, run: Run = defaultRun, pause: Sleep = sleep): Promise<ReviewDiff> {
  switch (target.kind) {
    case "pr": {
      // `gh pr diff <n>` is the full base...head diff for the PR — the complete
      // cumulative change across every commit on the branch, so a re-review sees
      // earlier-commit content (e.g. tests added in a prior commit) just like the
      // first review (#94).
      const expected = target.expectHead ?? await localExpectedHead(target.pr, run);
      const firstHead = await waitForHead(target.pr, expected, target.headWaitMs ?? DEFAULT_HEAD_WAIT_MS, run, pause);
      let fetched = await fetchPrDiff(target.pr, run);
      let finalHead = await prHead(target.pr, run);
      if (finalHead !== firstHead) {
        // A no-expectation review may follow one concurrent PR update. An explicit
        // expectation is stricter: a later push is not the caller's requested diff.
        if (expected !== undefined && finalHead !== expected) {
          throw headMismatch(target.pr, finalHead, expected);
        }
        // Only an unpinned review reaches this branch; refetch exactly once to
        // close the diff/name-list race, then reject a second move.
        const refetchHead = finalHead;
        fetched = await fetchPrDiff(target.pr, run);
        finalHead = await prHead(target.pr, run);
        if (finalHead !== (expected ?? refetchHead)) {
          throw headMismatch(target.pr, finalHead, expected ?? refetchHead);
        }
      }
      return { ...finalize(fetched.diff, splitLines(fetched.names)), head: finalHead };
    }
    case "range": {
      // A three-dot `base...HEAD` range (target.ts) is the full cumulative diff of
      // the branch against its merge-base — the local mirror of the PR's base...head.
      const diff = await gitDiff(run, [target.range]);
      const files = await gitNames(run, [target.range]);
      return finalize(diff, files);
    }
    case "worktree": {
      // Tracked changes (staged + unstaged) vs HEAD ...
      let diff = await gitDiff(run, ["HEAD"]);
      let files = await gitNames(run, ["HEAD"]);
      // ... plus brand-new untracked files, so a review never silently drops a
      // new file. Synthesized with `git diff --no-index` — no index mutation,
      // so the judges-only invariant holds.
      const untracked = splitNul(await gitOut(run, ["ls-files", "--others", "--exclude-standard", "-z"]));
      for (const file of untracked) {
        diff += await noIndexDiff(run, file);
        files.push(file);
      }
      // If the working tree is clean (nothing tracked or untracked), fall back
      // to the branch-vs-base diff when a remote base resolves.
      if (diff.trim() === "") {
        const base = await resolveBase(run);
        if (base) {
          diff = await gitDiff(run, [`${base}...HEAD`]);
          files = await gitNames(run, [`${base}...HEAD`]);
        }
      }
      return finalize(diff, files);
    }
  }
}

async function fetchPrDiff(pr: number, run: Run): Promise<{ diff: string; names: string }> {
  const diff = await capture(run, ["gh", "pr", "diff", String(pr)]);
  const names = await capture(run, ["gh", "pr", "diff", String(pr), "--name-only"]);
  return { diff, names };
}

async function localExpectedHead(pr: number, run: Run): Promise<string | undefined> {
  // This is an optional convenience only. Every local-git failure deliberately
  // falls back to an unpinned PR review, preserving non-checkout use.
  const details = await capture(run, ["gh", "pr", "view", String(pr), "--json", "headRefName,headRepository"]);
  let remote: { headRefName?: unknown; headRepository?: { nameWithOwner?: unknown } | null };
  try {
    remote = JSON.parse(details) as { headRefName?: unknown; headRepository?: { nameWithOwner?: unknown } | null };
  } catch {
    throw new WuxReviewError(`PR #${pr}: gh returned invalid head metadata`);
  }
  if (typeof remote.headRefName !== "string" || typeof remote.headRepository?.nameWithOwner !== "string") {
    return undefined;
  }
  const branch = await tryCapture(run, ["git", "branch", "--show-current"]);
  if (branch?.trim() === "" || branch?.trim() !== remote.headRefName) return undefined;
  const upstream = await tryCapture(run, ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const remoteName = upstream?.trim().split("/")[0];
  if (remoteName === undefined || remoteName === "") return undefined;
  const remoteUrl = await tryCapture(run, ["git", "remote", "get-url", remoteName]);
  if (remoteUrl === undefined || repositoryFromRemoteUrl(remoteUrl.trim()) !== remote.headRepository.nameWithOwner.toLowerCase()) {
    return undefined;
  }
  const local = await tryCapture(run, ["git", "rev-parse", "HEAD"]);
  return local?.trim() || undefined;
}

async function tryCapture(run: Run, cmd: string[]): Promise<string | undefined> {
  const result = await run(cmd);
  return result.code === 0 ? result.stdout : undefined;
}

function repositoryFromRemoteUrl(url: string): string | undefined {
  const matched = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return matched?.[1]?.toLowerCase();
}

async function waitForHead(pr: number, expected: string | undefined, timeoutMs: number, run: Run, pause: Sleep): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let actual = await prHead(pr, run);
  while (expected !== undefined && actual !== expected) {
    if (Date.now() >= deadline) throw headMismatch(pr, actual, expected);
    await pause(Math.min(HEAD_POLL_MS, Math.max(0, deadline - Date.now())));
    actual = await prHead(pr, run);
  }
  return actual;
}

async function prHead(pr: number, run: Run): Promise<string> {
  const head = (await capture(run, ["gh", "pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"])).trim();
  if (head === "") throw new WuxReviewError(`PR #${pr}: GitHub returned no head SHA`);
  return head;
}

function headMismatch(pr: number, actual: string, expected: string): WuxReviewError {
  return new WuxReviewError(`PR #${pr} head is ${actual}, expected ${expected}; push may not have landed`);
}

function finalize(diff: string, files: string[]): ReviewDiff {
  if (diff.trim() === "") {
    throw new WuxReviewError("nothing to review");
  }
  return { diff, files };
}

async function gitDiff(run: Run, args: string[]): Promise<string> {
  return gitOut(run, ["diff", ...args]);
}

// Changed-file list, NUL-separated (`-z`) with `core.quotePath=false`, so paths
// containing spaces, newlines, or non-ASCII bytes survive intact rather than
// being C-quoted or split on the wrong boundary.
async function gitNames(run: Run, args: string[]): Promise<string[]> {
  return splitNul(await gitOut(run, ["diff", "-z", "--name-only", ...args]));
}

async function gitOut(run: Run, args: string[]): Promise<string> {
  return capture(run, ["git", "-c", "core.quotePath=false", ...args]);
}

// `git diff --no-index` exits 1 when the inputs differ (which is always, here:
// /dev/null vs a real file), so 0 and 1 are both success — only a higher code
// is a real failure.
async function noIndexDiff(run: Run, file: string): Promise<string> {
  const result = await run(["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", "/dev/null", file]);
  if (result.code > 1) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new WuxReviewError(`git diff --no-index ${file}: ${detail}`);
  }
  return result.stdout;
}

async function capture(run: Run, cmd: string[]): Promise<string> {
  const result = await run(cmd);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new WuxReviewError(`${cmd.join(" ")}: ${detail}`);
  }
  return result.stdout;
}

function splitNul(out: string): string[] {
  return out.split("\0").filter((entry) => entry !== "");
}

function splitLines(out: string): string[] {
  return out.split("\n").filter((line) => line !== "");
}

// The remote-tracking base ref (e.g. origin/main), mirroring wux's
// dual-review.sh. It resolves against the REMOTE only — never a local base
// branch — so a branch review works on a fresh checkout where the base exists
// only as `origin/*`. Prefer the remote's own default branch (origin/HEAD); when
// that symbolic ref isn't set (common on shallow CI checkouts) fall back to the
// usual default-branch names, using whichever the remote actually has. Returns
// undefined when none resolve, so a repo without a remote degrades cleanly.
async function resolveBase(run: Run): Promise<string | undefined> {
  // origin/HEAD points at the remote default, e.g. refs/remotes/origin/main.
  // Return the FULLY-QUALIFIED ref (don't strip to `origin/main`): the shorthand
  // is ambiguous — a local branch or tag named `origin/main` would shadow the
  // remote-tracking ref in `git diff origin/main...HEAD`.
  const sym = await run(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim() !== "") {
    return sym.stdout.trim();
  }
  // `show-ref --verify` matches the exact full ref only (no disambiguation), so a
  // local branch/tag can never be mistaken for the remote-tracking base.
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    const found = await run(["git", "show-ref", "--verify", "--quiet", ref]);
    if (found.code === 0) {
      return ref;
    }
  }
  return undefined;
}
