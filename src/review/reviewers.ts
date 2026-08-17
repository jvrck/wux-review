import { randomUUID } from "node:crypto";
import { defaultBackends } from "../backends";
import { errorDetail, WuxReviewError } from "../runtime/errors";
import type { Lens } from "./lenses";
import { buildReviewerPrompt, parseReport } from "./prompt";
import type {
  Finding,
  LegExecutionEvidence,
  ObservableLifecycleState,
  RefutationEntry,
  ReviewerName,
  ReviewResult,
} from "./types";

// A backend runs one reviewer: it is handed the prompt and returns the
// reviewer's raw output. The headless backends (`claude -p` / `codex exec`) are
// the production path; tests inject mocks so no live model is called in CI.
export type Backend = (prompt: string, opts: BackendOptions) => Promise<string>;

export interface BackendOptions {
  sessionName: string;
  model?: string;
  cwd?: string;
  // Session mode (interactive wux backend only): reuse a live session and keep
  // it running for the next re-review. The default headless legs are one-shot
  // and ignore this — each round is a fresh, bounded review of the current diff.
  persist?: boolean;
  // Direct transport is the explicit emergency rollback. Omission selects the
  // strict observable Wux transport and its fail-closed result validation.
  direct?: boolean;
  // Observable identity. The explicit direct-headless path ignores these
  // fields; the adapter records each successful Wux launch through the
  // callback, including separate Codex retry attempts.
  reviewId?: string;
  round?: number;
  reviewer?: ReviewerName;
  recordPreparedChild?: (
    childName: string,
    attempt: number,
  ) => void | Promise<void>;
  recordEvidence?: (evidence: LegExecutionEvidence) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface Reviewers {
  claude: Backend;
  codex: Backend;
}

export interface RunReviewersOptions {
  models?: { claude?: string; codex?: string };
  backends?: Reviewers;
  // Stable id used to name each leg's temp files (and any session mode).
  sessionId?: string;
  cwd?: string;
  // Session mode (`--session`): forwarded to the interactive backend; the
  // default headless legs ignore it (one-shot, no live session to retain).
  persist?: boolean;
  // Direct transport is the explicit direct-headless rollback. Omission is the
  // strict observable Wux transport for every caller, including low-level ones.
  direct?: boolean;
  // 1-based review round, used by the observable child name and durable result
  // identity. Defaults to 1 for direct runReviewers callers.
  round?: number;
  // Configurable safe prefix for observable Wux child names. The environment
  // fallback is WUX_REVIEW_OBSERVABLE_PREFIX, then "wuxr".
  observablePrefix?: string;
  // Injectable execution nonce for deterministic tests. Production generates
  // a fresh nonce for every observable invocation so a failed round or reused
  // session id never collides with durable children from an earlier execution.
  observableExecutionId?: string;
  signal?: AbortSignal;
  prepareObservableRound?: (round: {
    reviewId: string;
    round: number;
    executionId: string;
    claudeChildName: string;
    codexChildName: string;
  }) => Promise<void>;
  recordObservablePreparedChild?: (
    reviewer: ReviewerName,
    childName: string,
    attempt: number,
  ) => void | Promise<void>;
  recordObservableEvidence?: (evidence: LegExecutionEvidence) => void | Promise<void>;
  finishObservableRound?: (
    state: ObservableLifecycleState,
    diagnostic?: string,
    cleanupPending?: boolean,
  ) => Promise<void>;
  // On a `--session` re-review, each leg's OWN prior-round findings — never the
  // other leg's, so the two reviewers stay independent. Fed into that leg's prompt
  // so it reviews incrementally against the current diff instead of context-free
  // (#91). Absent on the default one-shot path, which is unchanged.
  priorFindings?: { claude?: Finding[]; codex?: Finding[] };
  // Each leg's OWN refutation ledger (#101), shown to that leg before it reviews so
  // a re-raise of a refuted finding is a deliberate act against known counter-
  // evidence. Per-leg, so reviewer independence holds. Absent → prompt unchanged.
  refutationLedger?: { claude?: RefutationEntry[]; codex?: RefutationEntry[] };
}

export interface DualReviewResult {
  sessionId: string;
  claude: ReviewResult;
  codex: ReviewResult;
  evidence?: { claude: LegExecutionEvidence[]; codex: LegExecutionEvidence[] };
}

// Spawn both reviewers — Claude and Codex — in parallel and independently, each
// fed the SAME diff and the SAME full lens set. Both are required: if either
// fails to run or returns unparseable output, the whole review fails (no
// self-grading, no silent half-review).
export async function runReviewers(
  diff: string,
  lenses: Lens[],
  options: RunReviewersOptions = {},
): Promise<DualReviewResult> {
  // The core prompt (diff + full lens set + output contract) is identical for
  // both legs — diversity comes from the two models. On a `--session` re-review
  // each leg additionally gets its OWN prior findings threaded in, so the prompts
  // differ only by that per-leg context (legs stay independent). With no prior
  // findings (the default one-shot path) both prompts are byte-identical.
  const claudePrompt = buildReviewerPrompt(diff, lenses, options.priorFindings?.claude, "claude", options.refutationLedger?.claude);
  const codexPrompt = buildReviewerPrompt(diff, lenses, options.priorFindings?.codex, "codex", options.refutationLedger?.codex);
  // No separate preflight: the observable wrapper gates Wux availability at
  // launch, while the explicit direct path needs only the headless subprocesses.
  const backends = options.backends ?? defaultBackends();
  const sessionId = validateSessionId(options.sessionId ?? defaultSessionId());
  const round = options.round ?? 1;
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new WuxReviewError(`invalid review round: ${round}`);
  }
  const observable = options.direct !== true;
  const observablePrefix = observable
    ? validateObservablePrefix(options.observablePrefix ?? process.env.WUX_REVIEW_OBSERVABLE_PREFIX ?? "wuxr")
    : "wuxr";
  const observableExecutionId = observable
    ? validateObservableExecutionId(options.observableExecutionId ?? randomUUID().replaceAll("-", "").slice(0, 8))
    : "";
  const evidence = {
    claude: [] as LegExecutionEvidence[],
    codex: [] as LegExecutionEvidence[],
  };
  const claudeSessionName = observable
    ? observableSessionName(observablePrefix, sessionId, round, "claude", observableExecutionId)
    : sessionName(sessionId, "claude");
  const codexSessionName = observable
    ? observableSessionName(observablePrefix, sessionId, round, "codex", observableExecutionId)
    : sessionName(sessionId, "codex");

  if (!observable) {
    const [claude, codex] = await Promise.all([
      invoke("claude", backends.claude, claudePrompt, {
        sessionName: claudeSessionName,
        model: options.models?.claude,
        cwd: options.cwd,
        persist: options.persist,
        direct: true,
      }),
      invoke("codex", backends.codex, codexPrompt, {
        sessionName: codexSessionName,
        model: options.models?.codex,
        cwd: options.cwd,
        persist: options.persist,
        direct: true,
      }),
    ]);
    return { sessionId, claude, codex };
  }
  if (options.signal?.aborted) {
    throw Object.assign(
      new WuxReviewError(
        `observable round ${sessionId} interrupted before child launch`,
      ),
      { state: "interrupted" as const },
    );
  }
  await options.prepareObservableRound?.({
    reviewId: sessionId,
    round,
    executionId: observableExecutionId,
    claudeChildName: claudeSessionName,
    codexChildName: codexSessionName,
  });

  const abort = new AbortController();
  const forwardParentAbort = () => {
    if (!abort.signal.aborted) {
      abort.abort("parent-interrupted");
    }
  };
  if (options.signal?.aborted) {
    forwardParentAbort();
  } else {
    options.signal?.addEventListener("abort", forwardParentAbort, { once: true });
  }
  let primaryError: unknown;
  const run = async (
    reviewer: ReviewerName,
    backend: Backend,
    prompt: string,
    backendOptions: BackendOptions,
  ): Promise<ReviewResult> => {
    try {
      return await invoke(reviewer, backend, prompt, backendOptions);
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
      if (!abort.signal.aborted) abort.abort("sibling-failed");
      throw error;
    }
  };

  const settled = await Promise.allSettled([
    run("claude", backends.claude, claudePrompt, {
      sessionName: claudeSessionName,
      model: options.models?.claude,
      cwd: options.cwd,
      persist: options.persist,
      direct: options.direct,
      reviewId: sessionId,
      round,
      reviewer: "claude",
      signal: abort.signal,
      recordPreparedChild: (childName, attempt) =>
        options.recordObservablePreparedChild?.("claude", childName, attempt),
      recordEvidence: async (record) => {
        upsertObservableEvidence(evidence.claude, record);
        await options.recordObservableEvidence?.(record);
      },
    }),
    run("codex", backends.codex, codexPrompt, {
      sessionName: codexSessionName,
      model: options.models?.codex,
      cwd: options.cwd,
      persist: options.persist,
      direct: options.direct,
      reviewId: sessionId,
      round,
      reviewer: "codex",
      signal: abort.signal,
      recordPreparedChild: (childName, attempt) =>
        options.recordObservablePreparedChild?.("codex", childName, attempt),
      recordEvidence: async (record) => {
        upsertObservableEvidence(evidence.codex, record);
        await options.recordObservableEvidence?.(record);
      },
    }),
  ]);
  options.signal?.removeEventListener("abort", forwardParentAbort);

  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) {
    const error = primaryError ?? failed.reason;
    const cleanupFailure = settled.find(
      (result) => result.status === "rejected"
        && result.reason instanceof Error
        && "cleanupPending" in result.reason
        && result.reason.cleanupPending === true,
    );
    const cleanupPending = cleanupFailure !== undefined;
    const journalError = cleanupFailure?.status === "rejected"
      ? cleanupFailure.reason
      : error;
    // A terminal cleanup obligation must stay in a schema-valid terminal
    // failure state even when a parent interrupt races the leg rejection.
    // Parent interruption still controls ordinary failures, but it cannot
    // erase the exact-child cleanup evidence that blocks replacement launch.
    const state = cleanupPending
      ? cleanupPendingStateOf(journalError)
      : lifecycleStateOf(journalError, abort.signal.reason);
    await options.finishObservableRound?.(
      state,
      errorDetail(journalError),
      cleanupPending,
    ).catch(() => undefined);
    if (cleanupPending && journalError !== error) {
      throw new WuxReviewError(
        `${errorDetail(error)}; sibling terminal cleanup failed: ${errorDetail(journalError)}; run \`wux-review reconcile ${sessionId}\` before another observable review`,
      );
    }
    throw error;
  }
  if (options.signal?.aborted) {
    const error = Object.assign(
      new WuxReviewError(
        `observable round ${sessionId} interrupted after child collection; reconcile the existing evidence`,
      ),
      { state: "interrupted" as const },
    );
    await options.finishObservableRound?.("interrupted", error.message)
      .catch(() => undefined);
    throw error;
  }
  await options.finishObservableRound?.("completed");
  const fulfilled = settled.filter(
    (result): result is PromiseFulfilledResult<ReviewResult> =>
      result.status === "fulfilled",
  );
  const claude = fulfilled[0]!.value;
  const codex = fulfilled[1]!.value;

  return {
    sessionId,
    claude,
    codex,
    evidence,
  };
}

function lifecycleStateOf(
  error: unknown,
  abortReason: unknown,
): ObservableLifecycleState {
  if (abortReason === "parent-interrupted") return "interrupted";
  if (
    error instanceof Error
    && "state" in error
    && [
      "failed",
      "timed_out",
      "tainted",
      "interrupted",
    ].includes(String(error.state))
  ) {
    return error.state as ObservableLifecycleState;
  }
  return "failed";
}

function cleanupPendingStateOf(error: unknown): ObservableLifecycleState {
  const state = lifecycleStateOf(error, undefined);
  return state === "interrupted" ? "failed" : state;
}

function upsertObservableEvidence(
  entries: LegExecutionEvidence[],
  record: LegExecutionEvidence,
): void {
  const index = entries.findIndex((entry) => entry.attempt === record.attempt);
  if (index === -1) {
    entries.push(record);
  } else {
    entries[index] = record;
  }
}

export function sessionName(sessionId: string, reviewer: ReviewerName): string {
  return `wuxr-${sessionId}-${reviewer}`;
}

export function observableSessionName(
  prefix: string,
  sessionId: string,
  round: number,
  reviewer: ReviewerName,
  executionId?: string,
): string {
  const execution = executionId === undefined ? "" : `-x${validateObservableExecutionId(executionId)}`;
  return `${validateObservablePrefix(prefix)}-${validateSessionId(sessionId)}-r${round}${execution}-${reviewer}`;
}

// A session id flows into both `wux --name` and temp-file paths
// (`${tmpDir}/${session}-prompt.md`), so it must be free of path separators and
// other metacharacters. The default id is safe; this guards an explicit
// `--session` override (#9) that carries user input.
export function validateSessionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new WuxReviewError(`invalid session id: "${id}" (use 1–64 letters, digits, "_" or "-", starting alphanumeric)`);
  }
  return id;
}

export function validateObservablePrefix(prefix: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(prefix)) {
    throw new WuxReviewError(
      `invalid observable prefix: "${prefix}" (use 1–32 letters, digits, "_" or "-", starting alphanumeric)`,
    );
  }
  return prefix;
}

export function validateObservableExecutionId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(id)) {
    throw new WuxReviewError(
      `invalid observable execution id: "${id}" (use 1–16 letters, digits, "_" or "-", starting alphanumeric)`,
    );
  }
  return id;
}

async function invoke(
  reviewer: ReviewerName,
  backend: Backend,
  prompt: string,
  opts: BackendOptions,
): Promise<ReviewResult> {
  let raw: string;
  try {
    raw = await backend(prompt, opts);
  } catch (err) {
    if (err instanceof WuxReviewError) {
      throw err;
    }
    throw new WuxReviewError(`${reviewer} reviewer failed to run: ${(err as Error).message}`);
  }
  return parseReport(reviewer, raw);
}

// A short, filesystem/tmux-safe id. Date-based so concurrent runs don't collide;
// session mode (#9) passes an explicit id to reuse sessions.
function defaultSessionId(): string {
  return Date.now().toString(36);
}
