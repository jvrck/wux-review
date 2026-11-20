import { WuxReviewError } from "../runtime/errors";
import { run as defaultRun, type Run, type RunResult } from "../runtime/exec";
import type { Target } from "./target";

export interface ReviewDiff {
  diff: string;
  files: string[];
  head?: string;
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
      if (target.expectedHead !== undefined) {
        await waitForExpectedHead(target.pr, target.expectedHead, target.headWaitMs ?? 60_000, run);
      }
      // `gh pr diff <n>` is the full base...head diff for the PR — the complete
      // cumulative change across every commit on the branch, so a re-review sees
      // earlier-commit content (e.g. tests added in a prior commit) just like the
      // first review (#94).
      const command = ["gh", "pr", "diff", String(target.pr)];
      const result = await run(command);
      if (result.code !== 0) {
        if (isLargePrDiffError(result.stderr)) {
          return localPrDiff(target.pr, run);
        }
        throw captureError(command, result.stderr, result.code);
      }
      const diff = result.stdout;
      const names = await capture(run, ["gh", "pr", "diff", String(target.pr), "--name-only"]);
      if (target.expectedHead !== undefined) {
        const head = await readPrHead(target.pr, run);
        if (head !== target.expectedHead) {
          throw headMismatch(target.pr, head, target.expectedHead);
        }
        return { ...finalize(diff, splitLines(names)), head };
      }
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

async function waitForExpectedHead(pr: number, expected: string, waitMs: number, run: Run): Promise<void> {
  const deadline = Date.now() + Math.max(0, waitMs);
  let actual = await readPrHead(pr, run);
  while (actual !== expected) {
    if (Date.now() >= deadline) throw headMismatch(pr, actual, expected);
    await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    actual = await readPrHead(pr, run);
  }
}

async function readPrHead(pr: number, run: Run): Promise<string> {
  const raw = await capture(run, ["gh", "pr", "view", String(pr), "--json", "headRefOid"]);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new WuxReviewError(`gh pr view ${pr}: invalid JSON response`); }
  if (typeof value !== "object" || value === null || !isObjectId((value as { headRefOid?: unknown }).headRefOid)) {
    throw new WuxReviewError(`gh pr view ${pr}: missing valid head commit information`);
  }
  return (value as { headRefOid: string }).headRefOid;
}

function headMismatch(pr: number, actual: string, expected: string): WuxReviewError {
  return new WuxReviewError(`PR #${pr} head is ${actual}, expected ${expected}; push may not have landed`);
}

interface PrRefs {
  baseRefOid: string;
  headRefOid: string;
  baseRefName: string;
}

interface FallbackGit {
  run: Run;
  noLazyFetch: boolean;
}

const MIN_NO_LAZY_FETCH_GIT = [2, 45, 0] as const;

function isLargePrDiffError(stderr: string): boolean {
  return /the diff exceeded the maximum number of (?:files|lines)|HTTP 406:\s*Diff too large/i.test(stderr);
}

async function localPrDiff(pr: number, run: Run): Promise<ReviewDiff> {
  const refs = await getPrRefs(pr, run);
  const git = await createFallbackGit(pr, run);
  for (const sha of [refs.baseRefOid, refs.headRefOid]) {
    await requireLocalCommit(pr, refs, sha, git);
  }

  const mergeBaseCommand = ["merge-base", refs.baseRefOid, refs.headRefOid];
  const mergeBase = await fallbackGit(git, mergeBaseCommand);
  if (mergeBase.code !== 0) {
    if (mergeBase.code === 1) {
      const shallowCommand = ["rev-parse", "--is-shallow-repository"];
      const shallow = await fallbackGit(git, shallowCommand);
      if (shallow.code !== 0) {
        throw captureFallbackError(git, shallowCommand, shallow.stderr, shallow.code);
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
    throw captureFallbackError(git, mergeBaseCommand, mergeBase.stderr, mergeBase.code);
  }

  const range = `${refs.baseRefOid}...${refs.headRefOid}`;
  const rawCommand = ["-c", "core.quotePath=false", "diff", "--raw", "--no-abbrev", "-z", range];
  const rawResult = await fallbackGit(git, rawCommand);
  if (rawResult.code !== 0) {
    const missing = missingObjectIds(rawResult.stderr);
    if (missing.size > 0) {
      await requireLocalRangeObjects(pr, refs, range, missing, git);
    }
    throw captureFallbackError(git, rawCommand, rawResult.stderr, rawResult.code);
  }
  const raw = rawResult.stdout;
  const { files, objectIds } = parseRawPrDiff(raw);
  await requireLocalRangeObjects(pr, refs, range, objectIds, git);
  const reviewDiff = finalize(await fallbackGitDiff(git, [range]), files);
  process.stderr.write(
    `wux-review: PR #${pr} exceeds GitHub's diff size limit; reviewing ${range} from local git\n`,
  );
  return reviewDiff;
}

async function getPrRefs(pr: number, run: Run): Promise<PrRefs> {
  const raw = await capture(run, [
    "gh",
    "pr",
    "view",
    String(pr),
    "--json",
    "baseRefOid,headRefOid,baseRefName",
  ]);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WuxReviewError(`gh pr view ${pr}: invalid JSON response`);
  }
  if (
    typeof value !== "object"
    || value === null
    || !isObjectId((value as Partial<PrRefs>).baseRefOid)
    || !isObjectId((value as Partial<PrRefs>).headRefOid)
    || typeof (value as Partial<PrRefs>).baseRefName !== "string"
    || (value as Partial<PrRefs>).baseRefName === ""
  ) {
    throw new WuxReviewError(`gh pr view ${pr}: missing valid base or head commit information`);
  }
  return value as PrRefs;
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

async function createFallbackGit(pr: number, run: Run): Promise<FallbackGit> {
  if (!(await isPartialClone(run))) {
    return { run, noLazyFetch: false };
  }
  const version = await gitVersion(run);
  if (!atLeast(version, MIN_NO_LAZY_FETCH_GIT)) {
    throw new WuxReviewError(
      `PR #${pr} is too large for gh pr diff and this partial clone needs Git 2.45 or newer to avoid lazy fetching`,
    );
  }
  return { run, noLazyFetch: true };
}

async function isPartialClone(run: Run): Promise<boolean> {
  const extensionArgs = ["config", "--get", "extensions.partialClone"];
  const extension = await run(["git", ...extensionArgs]);
  if (extension.code === 0 && extension.stdout.trim() !== "") {
    return true;
  }
  if (extension.code !== 0 && extension.code !== 1) {
    throw captureError(["git", ...extensionArgs], extension.stderr, extension.code);
  }

  const promisorArgs = ["config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"];
  const promisor = await run(["git", ...promisorArgs]);
  if (promisor.code !== 0 && promisor.code !== 1) {
    throw captureError(["git", ...promisorArgs], promisor.stderr, promisor.code);
  }
  return promisor.code === 0 && promisor.stdout.split("\n").some((line) => line.trim().endsWith(" true"));
}

async function gitVersion(run: Run): Promise<readonly [number, number, number]> {
  const command = ["git", "--version"];
  const result = await run(command);
  if (result.code !== 0) throw captureError(command, result.stderr, result.code);
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout.trim());
  if (!match) {
    throw new WuxReviewError(`cannot determine Git version from: ${result.stdout.trim() || "empty output"}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! !== minimum[index]!) return version[index]! > minimum[index]!;
  }
  return true;
}

async function requireLocalCommit(pr: number, refs: PrRefs, sha: string, git: FallbackGit): Promise<void> {
  const command = ["cat-file", "-e", `${sha}^{commit}`];
  const result = await fallbackGit(git, command);
  if (result.code === 0) return;
  if (!/not a valid object|invalid object|bad object|unknown revision|could not fetch .+ from promisor remote/i.test(result.stderr)) {
    throw captureFallbackError(git, command, result.stderr, result.code);
  }
  const fetch = `git fetch origin ${shellQuote(`refs/heads/${refs.baseRefName}`)} ${shellQuote(`pull/${pr}/head`)}`;
  throw new WuxReviewError(
    `PR #${pr} is too large for gh pr diff and ${sha} isn't available locally; run: ${fetch}`,
  );
}

function parseRawPrDiff(raw: string): { files: string[]; objectIds: Set<string> } {
  const fields = splitNul(raw);
  const files: string[] = [];
  const objectIds = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index++];
    if (metadata === undefined || !metadata.startsWith(":")) {
      throw new WuxReviewError("git diff --raw returned malformed NUL-delimited output");
    }
    const status = metadata.split(" ").at(-1) ?? "";
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount) {
      throw new WuxReviewError("git diff --raw returned incomplete NUL-delimited paths");
    }
    index += pathCount;
    files.push(paths[paths.length - 1]!);

    const objects = /^:([0-7]+) ([0-7]+) ([0-9a-f]+) ([0-9a-f]+) /.exec(metadata);
    // Gitlink object IDs belong to a submodule's object store, not this
    // checkout, so checking them here would reject an otherwise reviewable PR.
    if (objects) {
      for (const [mode, objectId] of [[objects[1]!, objects[3]!], [objects[2]!, objects[4]!]]) {
        if (mode !== "160000" && !/^0+$/.test(objectId)) objectIds.add(objectId);
      }
    }
  }
  return { files, objectIds };
}

function missingObjectIds(stderr: string): Set<string> {
  const objectIds = new Set<string>();
  for (const pattern of [
    /unable to read tree \(([0-9a-f]{40,64})\)/gi,
    /(?:not a valid object name|invalid object name|bad object|unknown revision) ([0-9a-f]{40,64})/gi,
    /could not fetch ([0-9a-f]{40,64}) from promisor remote/gi,
  ]) {
    for (const match of stderr.matchAll(pattern)) objectIds.add(match[1]!);
  }
  return objectIds;
}

async function requireLocalRangeObjects(
  pr: number,
  refs: PrRefs,
  range: string,
  objectIds: Set<string>,
  git: FallbackGit,
): Promise<void> {
  if (objectIds.size === 0) return;
  const command = ["cat-file", "--batch-check"];
  const input = `${Array.from(objectIds).join("\n")}\n`;
  const result = await fallbackGit(git, command, input);
  if (result.stderr.trim() !== "") {
    throw captureFallbackError(git, command, result.stderr, result.code);
  }
  if (result.code !== 0) {
    throw captureFallbackError(git, command, result.stderr, result.code);
  }
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== objectIds.size || lines.some((line) => !objectIds.has(line.split(" ")[0]!))) {
    throw new WuxReviewError("git cat-file --batch-check returned unexpected object output");
  }
  const missing = lines.some((line) => {
    const match = /^([0-9a-f]+) missing$/i.exec(line);
    return match !== null && objectIds.has(match[1]!);
  });
  if (missing) {
    const fetch = `git fetch origin ${shellQuote(`refs/heads/${refs.baseRefName}`)} ${shellQuote(`pull/${pr}/head`)}`;
    throw new WuxReviewError(
      `PR #${pr} is too large for gh pr diff and objects required for ${range} aren't available locally; run: ${fetch}`,
    );
  }
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

async function fallbackGitDiff(git: FallbackGit, args: string[]): Promise<string> {
  return fallbackGitOut(git, ["diff", ...args]);
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

async function fallbackGitOut(git: FallbackGit, args: string[]): Promise<string> {
  const result = await fallbackGit(git, ["-c", "core.quotePath=false", ...args]);
  if (result.code !== 0) {
    throw captureFallbackError(git, ["-c", "core.quotePath=false", ...args], result.stderr, result.code);
  }
  return result.stdout;
}

// Git v2.45 introduced --no-lazy-fetch; see its release notes:
// https://github.com/git/git/blob/v2.45.0/Documentation/RelNotes/2.45.0.adoc
async function fallbackGit(git: FallbackGit, args: string[], stdin?: string): Promise<RunResult> {
  const prefix = git.noLazyFetch ? ["git", "--no-lazy-fetch"] : ["git"];
  return git.run([...prefix, ...args], stdin);
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

function captureFallbackError(git: FallbackGit, args: string[], stderr: string, code: number): WuxReviewError {
  const prefix = git.noLazyFetch ? ["git", "--no-lazy-fetch"] : ["git"];
  return captureError([...prefix, ...args], stderr, code);
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
