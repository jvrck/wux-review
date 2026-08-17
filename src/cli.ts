import { startMcpServer } from "./mcp/server";
import { loadConfig as defaultLoadConfig } from "./review/config";
import { resolveCheck, runCheck as defaultRunCheck } from "./review/check";
import type { VerdictEnvelope } from "./review/consolidate";
import type { Lens } from "./review/lenses";
import { postToPr as defaultPostToPr, type PostResult } from "./review/post";
import { runReview } from "./review/pipeline";
import {
  reconcileReview as defaultReconcileReview,
  type ReconcileOutcome,
} from "./review/observable-recovery";
import { parseRefutations } from "./review/refutation";
import { exitCodeFor, renderHuman, renderJson } from "./review/render";
import { skillsCommand } from "./skills/show";
import type { DualReviewResult, RunReviewersOptions } from "./review/reviewers";
import { endSession as defaultEndSession } from "./review/session";
import type { Refutation } from "./review/types";
import { WuxReviewError } from "./runtime/errors";
import { VERSION } from "./version";

// The review execution is injectable so the end-to-end CLI can be exercised
// without spawning live model sessions.
export interface CliDeps {
  runReviewers?: (diff: string, lenses: Lens[], options?: RunReviewersOptions) => Promise<DualReviewResult>;
  // Returns each leg's posted comment (for the CLI signal); `| void` keeps the
  // pre-#100 `Promise<void>` seam backward-compatible — a void-returning stub still
  // typechecks, and the CLI defaults a missing result to [] (no signal, no crash).
  postToPr?: (pr: number, envelope: VerdictEnvelope) => Promise<PostResult[] | void>;
  endSession?: (sessionId: string) => Promise<void>;
  loadConfig?: typeof defaultLoadConfig;
  runCheck?: (commands: string[]) => Promise<number>;
  reconcileReview?: (reviewId: string) => Promise<ReconcileOutcome>;
}

// The documented v1 surface. Handlers for the review pipeline and the `mcp`
// subcommand are stubbed here and land in later issues (#4–#7, #10); this
// bootstrap wires argument parsing, help/version, and the error path so every
// later issue has a stable entry point to build on.
const HELP = `wux-review ${VERSION}

Portable Claude+Codex dual-review CLI, built on wux.

Usage:
  wux-review [<ref>]                        Review a diff: a git ref (HEAD~1), a range (main..HEAD),
                                            or — when <ref> is omitted — the working tree.
  wux-review --pr <n>                       Review a PR's diff
  wux-review check                          Run the deterministic check (.wux-review.yml check:)
  wux-review reconcile <review-id>          Finalize an interrupted observable round
  wux-review mcp                            Start the MCP server (review_diff tool)
  wux-review skills show wux-review         Print the bundled wux-review skill
  wux-review --help | --version

Options:
  --pr <n>            Review pull request <n> instead of a local ref.
  --lenses <list>     Comma-separated lens set override (default: the v1 lens set).
  --post-to-pr <n>    Also post the consolidated findings as a comment on PR <n>.
  --session <id>      Use a stable id for the run. A re-review with the same id is
                      context-aware: each leg is fed its own prior-round findings
                      and reviews the current diff incrementally, so resolved
                      findings are not re-raised and an approval is not flipped by
                      a subjective point. Clear the state with --end-session.
  --end-session       Tear down any sessions for --session <id> and exit (cleanup).
  --refutations <f>   JSON file of findings the worker has refuted with evidence.
                      Each is recorded in the --session refutation ledger, shown to
                      the leg each round; a refuted must-fix re-raised without a new
                      repro is demoted to advisory + tagged persistent-unproven.
  --direct            Emergency rollback: run both reviewer processes directly,
                      without observable Wux children (verdict semantics unchanged).
  --inspect           Compatibility alias for the default observable execution.
  --json              Machine-readable output (default when stdout is not a TTY).
  --no-json           Force the human-readable renderer.
  -h, --help          Show this help.
  -v, --version       Show the version.`;

export interface ReviewOptions {
  ref?: string;
  pr?: number;
  lenses?: string[];
  postToPr?: number;
  session?: string;
  endSession?: boolean;
  direct: boolean;
  refutations?: string;
  json: boolean;
}

// Entry point. Returns the process exit code. Expected (WuxReviewError) failures
// become a clean stderr line + exit 1; a clean review returns 0 (approve) or 2
// (block).
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (err) {
    if (err instanceof WuxReviewError) {
      process.stderr.write(`wux-review: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  // Help and version take precedence over everything else.
  if (argv.some((a) => a === "-h" || a === "--help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (argv.some((a) => a === "-v" || a === "--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // `mcp` is a subcommand, recognized only in first position: serve the
  // review_diff tool over stdio until the client disconnects.
  if (argv[0] === "mcp") {
    if (argv.length > 1) {
      throw new WuxReviewError(`mcp takes no arguments (got: ${argv.slice(1).join(" ")})`);
    }
    await startMcpServer({ runReviewers: deps.runReviewers, postToPr: deps.postToPr });
    return 0;
  }

  // `skills show <name>` prints a bundled skill (used by install.sh --with-skills).
  if (argv[0] === "skills") {
    process.stdout.write(skillsCommand(argv.slice(1)));
    return 0;
  }

  // `check` runs the repo's configured deterministic check (the `check:` key in
  // .wux-review.yml, default `bun run typecheck && bun test`) and exits with its
  // status — a portable build/test gate, separate from the AI review verdict.
  if (argv[0] === "check") {
    if (argv.length > 1) {
      throw new WuxReviewError(`check takes no arguments (got: ${argv.slice(1).join(" ")})`);
    }
    const config = await (deps.loadConfig ?? defaultLoadConfig)();
    const commands = resolveCheck(config);
    process.stderr.write(`wux-review: check — ${commands.join(" ; ")}\n`);
    return await (deps.runCheck ?? defaultRunCheck)(commands);
  }

  if (argv[0] === "reconcile") {
    const parsed = parseReconcileArgs(argv.slice(1));
    const outcome = await (deps.reconcileReview ?? defaultReconcileReview)(parsed.reviewId);
    if ("kind" in outcome) {
      process.stdout.write(parsed.json
        ? `${JSON.stringify(outcome)}\n`
        : `wux-review: observable round ${outcome.reviewId} terminal cleanup completed; the original ${outcome.state} round remains terminal and replacement reviews are unblocked\n`
      );
      return 0;
    }
    process.stdout.write(`${parsed.json ? renderJson(outcome) : renderHuman(outcome)}\n`);
    return exitCodeFor(outcome);
  }

  const opts = parseReviewArgs(argv);

  // `--end-session` is a cleanup-and-exit: stop the two sessions and do nothing else.
  if (opts.endSession) {
    if (opts.session === undefined) {
      throw new WuxReviewError("--end-session requires --session <id>");
    }
    if (
      opts.ref !== undefined ||
      opts.pr !== undefined ||
      opts.lenses !== undefined ||
      opts.postToPr !== undefined ||
      opts.refutations !== undefined
    ) {
      throw new WuxReviewError(
        "--end-session only stops the session; it cannot be combined with review arguments (<ref>, --pr, --lenses, --post-to-pr, --refutations)",
      );
    }
    await (deps.endSession ?? defaultEndSession)(opts.session);
    process.stdout.write(`wux-review: ended session ${opts.session}\n`);
    return 0;
  }

  // The refutation ledger lives in the session state and is only meaningful across
  // rounds, so `--refutations` requires `--session` — and this keeps a one-shot
  // review from demoting a blocker on its first pass (a blocker is accepted in
  // round 1; demotion is a re-review action) (#101).
  if (opts.refutations !== undefined && opts.session === undefined) {
    throw new WuxReviewError("--refutations requires --session <id> (the refutation ledger is session-scoped)");
  }
  // Load the worker's refutations file (#101), if given, before the review so a
  // malformed file fails fast with a typed error (it's explicit operator input).
  const refutations = opts.refutations !== undefined ? await loadRefutations(opts.refutations) : undefined;

  const interrupt = opts.direct !== true ? new AbortController() : undefined;
  const interruptParent = () => interrupt?.abort("parent-interrupted");
  if (interrupt !== undefined) {
    process.once("SIGINT", interruptParent);
    process.once("SIGTERM", interruptParent);
  }
  let envelope: VerdictEnvelope;
  try {
    envelope = await runReview(
      {
        ref: opts.ref,
        pr: opts.pr,
        lenses: opts.lenses,
        session: opts.session,
        direct: opts.direct,
        refutations,
        signal: interrupt?.signal,
      },
      { runReviewers: deps.runReviewers },
    );
  } finally {
    if (interrupt !== undefined) {
      process.removeListener("SIGINT", interruptParent);
      process.removeListener("SIGTERM", interruptParent);
    }
  }
  process.stdout.write(`${opts.json ? renderJson(envelope) : renderHuman(envelope)}\n`);

  // Optional, additive: post the findings to a PR. The verdict has already been
  // emitted above, so a post failure is a warning — it must NOT change the
  // review's exit code (which reflects the verdict, not the side effect).
  if (opts.postToPr !== undefined) {
    const postToPr = deps.postToPr ?? defaultPostToPr;
    try {
      // Default to [] so a postToPr that resolves without results (e.g. a
      // void-returning injected stub) can never turn a successful post into a CLI
      // crash on `.length` — the signal is simply skipped.
      const posted = (await postToPr(opts.postToPr, envelope)) ?? [];
      // Positive posted-verdict signal (#100): the per-leg comments are upserted in
      // place, so the PR's comment count never changes to signal a fresh verdict.
      // This line names the round and both comment URLs so a driving session gets a
      // definitive "verdict posted (round N)" without polling the PR. It goes to
      // stderr, not stdout, so it never corrupts the machine-readable --json verdict.
      if (posted.length > 0) {
        const round = posted[0]!.round;
        const legs = posted.map((p) => `${p.reviewer} ${p.url}`).join(" · ");
        process.stderr.write(`wux-review: verdict posted (round ${round}) — ${legs}\n`);
      }
    } catch (err) {
      const message = err instanceof WuxReviewError ? err.message : (err as Error).message;
      process.stderr.write(`wux-review: --post-to-pr failed (verdict unaffected): ${message}\n`);
    }
  }
  return exitCodeFor(envelope);
}

function parseReconcileArgs(argv: string[]): {
  reviewId: string;
  json: boolean;
} {
  let reviewId: string | undefined;
  let json = !process.stdout.isTTY;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--no-json") {
      json = false;
    } else if (arg.startsWith("-")) {
      throw new WuxReviewError(`unknown reconcile option: ${arg}`);
    } else if (reviewId === undefined) {
      reviewId = arg;
    } else {
      throw new WuxReviewError(`reconcile takes one review id (unexpected: ${arg})`);
    }
  }
  if (reviewId === undefined) {
    throw new WuxReviewError("reconcile requires <review-id>");
  }
  return { reviewId, json };
}

export function parseReviewArgs(argv: string[]): ReviewOptions {
  const opts: ReviewOptions = { direct: false, json: !process.stdout.isTTY };
  let executionMode: "observable" | "direct" | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--pr":
        opts.pr = intValue(argv, ++i, "--pr");
        break;
      case "--lenses": {
        const lenses = value(argv, ++i, "--lenses")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (lenses.length === 0) {
          throw new WuxReviewError("--lenses requires at least one lens");
        }
        opts.lenses = lenses;
        break;
      }
      case "--post-to-pr":
        opts.postToPr = intValue(argv, ++i, "--post-to-pr");
        break;
      case "--session":
        opts.session = value(argv, ++i, "--session");
        break;
      case "--refutations":
        opts.refutations = value(argv, ++i, "--refutations");
        break;
      case "--end-session":
        opts.endSession = true;
        break;
      case "--inspect":
        if (executionMode === "direct") {
          throw new WuxReviewError("--inspect and --direct are mutually exclusive");
        }
        executionMode = "observable";
        opts.direct = false;
        break;
      case "--direct":
        if (executionMode === "observable") {
          throw new WuxReviewError("--inspect and --direct are mutually exclusive");
        }
        executionMode = "direct";
        opts.direct = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--no-json":
        opts.json = false;
        break;
      case "--":
        // End of options: every remaining argument is positional, even if it
        // starts with `-`, so a ref like `-weird` can still be reviewed.
        for (let j = i + 1; j < argv.length; j++) {
          setRef(opts, argv[j]);
        }
        i = argv.length;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new WuxReviewError(`unknown option: ${arg}`);
        }
        setRef(opts, arg);
    }
    i++;
  }
  // A local ref and `--pr` are mutually exclusive review targets.
  if (opts.ref !== undefined && opts.pr !== undefined) {
    throw new WuxReviewError("provide either a <ref> or --pr <n>, not both");
  }
  // A bare invocation (neither <ref> nor --pr) is the documented "working tree"
  // review target — the default mode, resolved in #4. An empty options set is
  // therefore valid, not a usage error.
  return opts;
}

// Read + parse the `--refutations` file (#101). A missing file or malformed JSON is
// a typed, fail-fast error (explicit operator input, not best-effort state).
async function loadRefutations(path: string): Promise<Refutation[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new WuxReviewError(`--refutations: file not found: ${path}`);
  }
  return parseRefutations(await file.text());
}

function setRef(opts: ReviewOptions, ref: string): void {
  if (opts.ref !== undefined) {
    throw new WuxReviewError(`unexpected extra argument: ${ref}`);
  }
  opts.ref = ref;
}

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("-")) {
    throw new WuxReviewError(`${flag} requires a value`);
  }
  return v;
}

function intValue(argv: string[], i: number, flag: string): number {
  const raw = value(argv, i, flag);
  // Base-10 digits only: rejects `0x10`, `1e3`, `+5`, whitespace-padded, and
  // non-numeric values that `Number()` would otherwise coerce.
  if (!/^[0-9]+$/.test(raw)) {
    throw new WuxReviewError(`${flag} requires a positive integer, got "${raw}"`);
  }
  const n = Number(raw);
  if (n <= 0 || !Number.isSafeInteger(n)) {
    throw new WuxReviewError(`${flag} requires a positive integer, got "${raw}"`);
  }
  return n;
}
