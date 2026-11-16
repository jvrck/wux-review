import { WuxReviewError } from "../runtime/errors";
import { run as defaultRun, type Run } from "../runtime/exec";
import type { Target } from "./target";

export interface ReviewDiff {
  diff: string;
  files: string[];
}

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
export async function getDiff(target: Target, run: Run = defaultRun): Promise<ReviewDiff> {
  switch (target.kind) {
    case "pr": {
      // `gh pr diff <n>` is the full base...head diff for the PR — the complete
      // cumulative change across every commit on the branch, so a re-review sees
      // earlier-commit content (e.g. tests added in a prior commit) just like the
      // first review (#94).
      const command = ["gh", "pr", "diff", String(target.pr)];
      const result = await run(command);
      if (result.code !== 0) {
        if (isPrDiffTooLarge(result.stderr)) {
          return getLocalPrDiff(target.pr, run);
        }
        throw captureError(command, result.stderr, result.code);
      }
      const diff = result.stdout;
      const names = await capture(run, ["gh", "pr", "diff", String(target.pr), "--name-only"]);
      return finalize(diff, splitLines(names));
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

interface PrRefs {
  baseRefOid: string;
  headRefOid: string;
  baseRefName: string;
}

const NO_LAZY_GIT = ["env", "GIT_NO_LAZY_FETCH=1", "git"];

function isPrDiffTooLarge(stderr: string): boolean {
  const detail = stderr.toLowerCase();
  return (
    detail.includes("maximum number of files") ||
    detail.includes("too_large") ||
    (detail.includes("http 406") && detail.includes("diff") && detail.includes("exceed"))
  );
}

async function getLocalPrDiff(pr: number, run: Run): Promise<ReviewDiff> {
  const refs = await getPrRefs(pr, run);
  for (const sha of [refs.baseRefOid, refs.headRefOid]) {
    await requireLocalObject(pr, refs, sha, `${sha}^{commit}`, run);
  }

  const mergeBaseCommand = ["merge-base", refs.baseRefOid, refs.headRefOid];
  const mergeBase = await noLazyGit(run, mergeBaseCommand);
  if (mergeBase.code !== 0) {
    if (mergeBase.code !== 1) {
      throw captureNoLazyError(mergeBaseCommand, mergeBase.stderr, mergeBase.code);
    }
    const shallowCommand = ["rev-parse", "--is-shallow-repository"];
    const shallow = await noLazyGit(run, shallowCommand);
    if (shallow.code !== 0) {
      throw captureNoLazyError(shallowCommand, shallow.stderr, shallow.code);
    }
    if (shallow.stdout.trim() === "true") {
      throw new WuxReviewError(
        `PR #${pr} is too large for gh pr diff and its merge base isn't available locally; run: git fetch --unshallow`,
      );
    }
    throw new WuxReviewError(
      `PR #${pr} is too large for gh pr diff and ${refs.baseRefOid} and ${refs.headRefOid} have unrelated histories locally`,
    );
  }

  const range = `${refs.baseRefOid}...${refs.headRefOid}`;
  await requireLocalRangeObjects(pr, refs, range, run);
  process.stderr.write(
    `wux-review: PR #${pr} exceeds GitHub's diff size limit; reviewing ${range} from local git\n`,
  );
  return finalize(await noLazyGitDiff(run, [range]), await noLazyGitNames(run, [range]));
}

async function requireLocalRangeObjects(pr: number, refs: PrRefs, range: string, run: Run): Promise<void> {
  const raw = await noLazyGitOut(run, ["diff", "--no-ext-diff", "--no-renames", "--raw", "-z", range]);
  const objectIds = new Set<string>();
  for (const entry of raw.split("\0")) {
    const match = /^:[0-7]+ [0-7]+ ([0-9a-f]+) ([0-9a-f]+) /.exec(entry);
    if (match) {
      objectIds.add(match[1]!);
      objectIds.add(match[2]!);
    }
  }
  for (const objectId of objectIds) {
    if (!/^0+$/.test(objectId)) {
      await requireLocalObject(pr, refs, objectId, objectId, run, range);
    }
  }
}

async function requireLocalObject(
  pr: number,
  refs: PrRefs,
  objectId: string,
  objectExpression: string,
  run: Run,
  range?: string,
): Promise<void> {
  const command = ["cat-file", "-e", objectExpression];
  const object = await noLazyGit(run, command);
  if (object.code === 0) return;
  if (isMissingObject(object.stderr, objectExpression)) {
    const subject = range ? `objects required for ${range}` : objectId;
    throw new WuxReviewError(
      `PR #${pr} is too large for gh pr diff and ${subject} isn't available locally; ${fetchHint(pr, refs)}`,
    );
  }
  throw captureNoLazyError(command, object.stderr, object.code);
}

function isMissingObject(stderr: string, objectExpression: string): boolean {
  const detail = stderr.toLowerCase();
  return (
    detail.includes(`not a valid object name ${objectExpression.toLowerCase()}`) ||
    detail.includes(`could not fetch ${objectExpression.toLowerCase()} from promisor remote`)
  );
}

function fetchHint(pr: number, refs: PrRefs): string {
  return `run: git fetch origin ${shellQuote(refs.baseRefName)} ${shellQuote(`pull/${pr}/head`)}`;
}

async function getPrRefs(pr: number, run: Run): Promise<PrRefs> {
  const command = ["gh", "pr", "view", String(pr), "--json", "baseRefOid,headRefOid,baseRefName"];
  const text = await capture(run, command);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WuxReviewError(`gh pr view ${pr}: invalid JSON response`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WuxReviewError(`gh pr view ${pr}: missing base or head commit information`);
  }
  const { baseRefOid, headRefOid, baseRefName } = parsed as Record<string, unknown>;
  if (
    typeof baseRefOid !== "string" ||
    typeof headRefOid !== "string" ||
    typeof baseRefName !== "string" ||
    !isObjectId(baseRefOid) ||
    !isObjectId(headRefOid)
  ) {
    throw new WuxReviewError(`gh pr view ${pr}: missing valid base or head commit information`);
  }
  return { baseRefOid, headRefOid, baseRefName };
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

async function noLazyGitDiff(run: Run, args: string[]): Promise<string> {
  return noLazyGitOut(run, ["-c", "core.quotePath=false", "diff", ...args]);
}

// Changed-file list, NUL-separated (`-z`) with `core.quotePath=false`, so paths
// containing spaces, newlines, or non-ASCII bytes survive intact rather than
// being C-quoted or split on the wrong boundary.
async function gitNames(run: Run, args: string[]): Promise<string[]> {
  return splitNul(await gitOut(run, ["diff", "-z", "--name-only", ...args]));
}

async function noLazyGitNames(run: Run, args: string[]): Promise<string[]> {
  return splitNul(await noLazyGitOut(run, ["-c", "core.quotePath=false", "diff", "-z", "--name-only", ...args]));
}

async function gitOut(run: Run, args: string[]): Promise<string> {
  return capture(run, ["git", "-c", "core.quotePath=false", ...args]);
}

async function noLazyGitOut(run: Run, args: string[]): Promise<string> {
  const result = await noLazyGit(run, args);
  if (result.code !== 0) {
    throw captureNoLazyError(args, result.stderr, result.code);
  }
  return result.stdout;
}

async function noLazyGit(run: Run, args: string[]): Promise<Awaited<ReturnType<Run>>> {
  return run([...NO_LAZY_GIT, ...args]);
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
    throw captureError(cmd, result.stderr, result.code);
  }
  return result.stdout;
}

function captureError(cmd: string[], stderr: string, code: number): WuxReviewError {
  const detail = stderr.trim() || `exit ${code}`;
  return new WuxReviewError(`${cmd.join(" ")}: ${detail}`);
}

function captureNoLazyError(args: string[], stderr: string, code: number): WuxReviewError {
  return captureError(["git", ...args], stderr, code);
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
